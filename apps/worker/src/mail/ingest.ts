import type { DB } from "@cfmail/db";
import type { PgpKeyEvent, PgpVerify } from "@cfmail/db/enums";
import { attachment, message, thread } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { splitMessageIds } from "@cfmail/shared/schemas";
import { and, DrizzleQueryError, eq, notExists } from "drizzle-orm";
import type { Env } from "../env.ts";
import { chunk, SQL_VARS_LIMIT } from "../lib/sql.ts";
import { attachmentKey, plainMessageKey, rawMessageKey } from "./blob-keys.ts";
import {
  addrsToText,
  bodyForIndex,
  extractListId,
  extractUnsubscribe,
  type ParsedEmail,
  parseMime,
  snippet,
} from "./mime.ts";
import type { AuthResult, SpamEvaluation } from "./spam.ts";
import { resolveThreadId, threadBumpValues } from "./threads.ts";

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
// Bound parameters per attachment row, for chunking the multi-row insert.
const ATTACHMENT_COLUMNS = 8;

const utf8Encoder = new TextEncoder();

export interface IngestOptions {
  mailboxId: string;
  raw: ArrayBuffer;
  // Pre-parsed message — callers that already parsed (e.g. import, to infer
  // direction/date) pass it to avoid a second parse. Otherwise we parse here.
  parsed?: ParsedEmail;
  direction: "in" | "out";
  deliveredTo: string | null;
  flags: number;
  receivedAt: Date | null;
  sentAt: Date | null;
  // Spam evaluation result, or null to skip spam fields and auto-filing (import).
  spam: SpamEvaluation | null;
  // A matched markSpam rule files the thread to Spam regardless of the spam
  // verdict or new/existing-thread heuristic (explicit user intent).
  forceSpam?: boolean;
  // Live delivery (the `email` handler) vs. historical import. A live message
  // resurfaces a trashed thread; import must not resurrect old trash.
  live?: boolean;
  // Gateway PGP (invariant 7). When `raw` is ciphertext we keep it at rawR2Key
  // as evidence and store the decrypted .eml (`pgp.plainRaw`) at plainR2Key, which
  // the body endpoint serves. `parsed` should already reflect the plaintext body.
  pgp?: {
    encrypted: boolean;
    signed: boolean;
    verify: PgpVerify | null;
    signedBy: string | null;
    keyEvent?: PgpKeyEvent | null;
    plainRaw?: Uint8Array;
  };
}

export interface IngestResult {
  messageId: string;
  threadId: string;
  isNewThread: boolean;
  joinedByHeader: boolean;
}

// What one ingest has written outside its final batch: the state to take back
// when a later step fails.
interface Written {
  blobKeys: string[];
  // Set only when this ingest inserted the thread row.
  threadId: string | null;
}

// Shared core behind both the live `email` handler and the import endpoint:
// archive raw to R2, parse, resolve a thread, insert the message + attachments,
// and bump thread metadata. Notifications and envelope/mailbox resolution stay
// with the callers. All-or-nothing: on any failure the blobs and the thread row
// this call created are removed before the error is rethrown, so a sender's
// retry starts from a clean slate.
export async function ingestRaw(env: Env, db: DB, opts: IngestOptions): Promise<IngestResult> {
  const written: Written = { blobKeys: [], threadId: null };
  try {
    return await store(env, db, opts, written);
  } catch (err) {
    await undo(env, db, written);
    throw err;
  }
}

async function undo(env: Env, db: DB, written: Written): Promise<void> {
  try {
    if (written.blobKeys.length) await env.BLOBS.delete(written.blobKeys);
    if (written.threadId) {
      // Another delivery may have joined the thread since; keep it then.
      await db
        .delete(thread)
        .where(
          and(
            eq(thread.id, written.threadId),
            eq(thread.msgCount, 0),
            notExists(
              db
                .select({ id: message.id })
                .from(message)
                .where(eq(message.threadId, written.threadId)),
            ),
          ),
        );
    }
  } catch (err) {
    // The ingest failure is the error to surface; a failed cleanup only leaves
    // an orphan to find. Attachment keys hold filenames, so log the raw key only.
    console.error("ingest_undo_failed", {
      rawKey: written.blobKeys[0] ?? null,
      blobs: written.blobKeys.length,
      threadId: written.threadId,
      error: errorText(err),
    });
  }
}

// Blobs go first, then every row in one batch: D1 commits a batch as a unit, so
// a message can never exist without its attachment rows or thread counters.
async function store(
  env: Env,
  db: DB,
  opts: IngestOptions,
  written: Written,
): Promise<IngestResult> {
  const { mailboxId, raw, spam } = opts;
  const size = raw.byteLength;

  const parsed = opts.parsed ?? (await parseMime(raw));
  const messageId = crypto.randomUUID();

  const rawKey = rawMessageKey(mailboxId, crypto.randomUUID());
  written.blobKeys.push(rawKey);
  await env.BLOBS.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });

  // For decrypted inbound mail, archive the plaintext .eml separately; the body
  // endpoint reads it while the original ciphertext stays at rawKey.
  let plainKey: string | null = null;
  if (opts.pgp?.plainRaw) {
    plainKey = plainMessageKey(mailboxId, crypto.randomUUID());
    written.blobKeys.push(plainKey);
    await env.BLOBS.put(plainKey, opts.pgp.plainRaw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
  }

  const attachments = (parsed.attachments ?? []).map((att, idx) => {
    const bytes =
      typeof att.content === "string"
        ? utf8Encoder.encode(att.content)
        : new Uint8Array(att.content);
    return {
      bytes,
      row: {
        id: crypto.randomUUID(),
        messageId,
        filename: att.filename ?? `file-${idx}`,
        contentType: att.mimeType ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
        r2Key: attachmentKey(messageId, idx, att.filename ?? `file-${idx}`),
        inline: att.disposition === "inline",
        contentId: att.contentId ?? null,
      },
    };
  });
  written.blobKeys.push(...attachments.map((a) => a.row.r2Key));
  // Let every put settle before failing, so cleanup cannot race a late write.
  const puts = await Promise.allSettled(
    attachments.map(async (a) =>
      env.BLOBS.put(a.row.r2Key, a.bytes, { httpMetadata: { contentType: a.row.contentType } }),
    ),
  );
  const failedPut = puts.find((p) => p.status === "rejected");
  if (failedPut) throw failedPut.reason;

  const toAddrs = (parsed.to ?? []).map((a) => normalizeAddr(a));
  const ccAddrs = (parsed.cc ?? []).map((a) => normalizeAddr(a));
  const fromAddr = parsed.from?.address ?? "";
  const fromName = parsed.from?.name ?? undefined;

  const fromParticipant: { name?: string; address: string } = { address: fromAddr };
  if (fromName) fromParticipant.name = fromName;
  const participants = [fromParticipant, ...toAddrs, ...ccAddrs].filter((p) => p.address);

  // Both headers are msg-id lists; In-Reply-To gets one column, so keep the
  // first id. Splitting here is what lets threading match them at all, and what
  // keeps the chain a later reply copies out of this row valid.
  const references = parsed.references ? splitMessageIds(parsed.references) : null;
  const inReplyTo = parsed.inReplyTo ? (splitMessageIds(parsed.inReplyTo)[0] ?? null) : null;
  const at = opts.receivedAt ?? opts.sentAt ?? new Date();
  const { threadId, joinedByHeader, created } = await resolveThreadId(db, {
    mailboxId,
    subject: parsed.subject ?? "",
    inReplyTo,
    references,
    participants,
    fromAddr,
    messageId: parsed.messageId ?? null,
    listId: extractListId(parsed),
    // Imported history is threaded as of its own date; live mail as of now.
    asOf: opts.live ? undefined : at,
    // Our own outbound mail is trusted; imported "out" copies likewise carry
    // headers we don't need to corroborate against a spoofing sender.
    trustHeaders: opts.direction === "out",
    // Unauthenticated spam gets a thread of its own, so it can be filed under
    // Spam without touching the conversation it claims to belong to.
    joinExisting: !(spam?.folderSpam && !isAuthenticated(spam.auth)),
  });
  if (created) written.threadId = threadId;

  const existingThread = await db.query.thread.findFirst({
    where: eq(thread.id, threadId),
    columns: { msgCount: true },
  });
  const isNewThread = (existingThread?.msgCount ?? 0) === 0;

  // A brand-new thread is auto-filed under Spam — never yank an existing
  // legitimate conversation into the spam folder over a single message. Only a
  // user's own markSpam rule (forceSpam) flags a thread that already holds
  // mail. Import passes spam=null, so nothing is ever filed.
  const fileSpam = !!opts.forceSpam || (!!spam?.folderSpam && isNewThread);

  const bodyIndex = bodyForIndex(parsed.text, parsed.html);
  const unsub = extractUnsubscribe(parsed);

  // Unread badge only moves for inbound mail that arrives unseen.
  const unreadDelta = opts.direction === "in" && !(opts.flags & Flag.SEEN) ? 1 : 0;
  const bump = threadBumpValues(at, participants, unreadDelta, !!opts.live);

  const insertMessage = db.insert(message).values({
    id: messageId,
    mailboxId,
    threadId,
    direction: opts.direction,
    messageIdHdr: parsed.messageId ?? null,
    inReplyTo,
    references,
    fromName: fromName ?? null,
    fromAddr,
    deliveredTo: opts.deliveredTo,
    toAddrs,
    ccAddrs: ccAddrs.length ? ccAddrs : null,
    bccAddrs: null,
    subject: parsed.subject ?? "",
    snippet: snippet(bodyIndex),
    bodyText: bodyIndex,
    toText: addrsToText([...toAddrs, ...ccAddrs]),
    flags: opts.flags,
    receivedAt: opts.receivedAt,
    sentAt: opts.sentAt,
    rawR2Key: rawKey,
    sizeBytes: size,
    spamVerdict: spam?.verdict ?? null,
    spamScore: spam?.score ?? null,
    spamReasons: spam?.reasons.length ? spam.reasons : null,
    spamAuth: spam ? spam.auth : null,
    listUnsubscribe: unsub.listUnsubscribe,
    listUnsubscribePost: unsub.listUnsubscribePost,
    pgpEncrypted: opts.pgp?.encrypted ?? false,
    pgpSigned: opts.pgp?.signed ?? false,
    pgpVerify: opts.pgp?.verify ?? null,
    pgpSignedBy: opts.pgp?.signedBy ?? null,
    pgpKeyEvent: opts.pgp?.keyEvent ?? null,
    plainR2Key: plainKey,
  });

  const attachmentRows = attachments.map((a) => a.row);
  await db.batch([
    insertMessage,
    ...chunk(attachmentRows, Math.floor(SQL_VARS_LIMIT / ATTACHMENT_COLUMNS)).map((rows) =>
      db.insert(attachment).values(rows),
    ),
    db
      .update(thread)
      .set({ ...bump, ...(fileSpam ? { spam: true } : {}) })
      .where(eq(thread.id, threadId)),
  ]);

  return { messageId, threadId, isNewThread, joinedByHeader };
}

// Drizzle's query errors print every bound parameter, which here means the
// subject, snippet and body. Log the driver's own message instead.
export function errorText(err: unknown): string {
  const cause = err instanceof DrizzleQueryError && err.cause ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}

// The sender is authenticated when DMARC passes, or both SPF and DKIM pass.
// Unauthenticated mail is treated as potentially forged for spam-filing.
export function isAuthenticated(auth: AuthResult): boolean {
  return auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass");
}

function normalizeAddr(a: { name?: string; address?: string }): { name?: string; address: string } {
  const out: { name?: string; address: string } = { address: a.address ?? "" };
  if (a.name) out.name = a.name;
  return out;
}
