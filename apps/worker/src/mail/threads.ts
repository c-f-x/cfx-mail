import type { DB } from "@cfx-mail/db";
import { message, thread } from "@cfx-mail/db/schema";
import { Flag } from "@cfx-mail/shared/flags";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { chunk, SQL_VARS_LIMIT } from "../lib/sql.ts";
import { normalizeSubject } from "./mime.ts";

// Same prefixes normalizeSubject strips — used to tell a reply ("Re: X") from a
// bare first-contact message whose subject merely happens to collide.
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i;

const SUBJECT_WINDOW_SECONDS = 60 * 60 * 24 * 7;
// In-Reply-To/References are attacker-controlled, so a header match into an
// existing thread is only honored when the thread is still recent. Beyond this
// a leaked Message-ID can't be replayed to graft into a dormant conversation.
const HEADER_MATCH_WINDOW_SECONDS = 60 * 60 * 24 * 180;

export interface ResolveThreadInput {
  mailboxId: string;
  subject: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  participants: { name?: string; address: string }[];
  // Sender of the message, used to corroborate a header-based join.
  fromAddr: string;
  // The message's own Message-ID. Replies stored before it filed themselves
  // under a thread keyed by this id, and the message joins them there.
  messageId?: string | null;
  // When the message was written, for history the owner imports. The header
  // window counts back from it, so old replies still find their parents. Live
  // mail leaves it unset and the window counts back from now: its Date header
  // is the sender's claim.
  asOf?: Date;
  // The List-Id the message came through. A reply through the list a thread
  // came from joins it even when its sender has not written there yet.
  listId?: string | null;
  // Skip the anti-spoofing corroboration check. Set for our own outbound mail,
  // whose In-Reply-To/References we generate and therefore trust.
  trustHeaders?: boolean;
  // False puts the message in a thread of its own, whatever its headers and
  // subject say. Set for unauthenticated mail scored as spam: its From and
  // reply headers are the sender's claim, and joining on them would let a
  // forgery sit in, or drag to Spam, a real conversation.
  joinExisting?: boolean;
}

export interface ResolveThreadResult {
  threadId: string;
  // The message was spliced into a pre-existing thread on an In-Reply-To /
  // References header match.
  joinedByHeader: boolean;
  // This call inserted the thread row. A caller that then fails to store the
  // message removes it again, so no empty thread is left behind.
  created: boolean;
}

export async function resolveThreadId(
  db: DB,
  input: ResolveThreadInput,
): Promise<ResolveThreadResult> {
  if (input.joinExisting === false) return insertThread(db, input);

  const headerIds = [
    ...(input.references ?? []),
    ...(input.inReplyTo ? [input.inReplyTo] : []),
  ].filter(Boolean);
  // Message-ID to the thread it is stored in, for every header id we hold.
  let byHeader = new Map<string | null, string>();

  if (headerIds.length) {
    // One parameter is taken by the mailbox id.
    const headerHits = (
      await Promise.all(
        chunk(headerIds, SQL_VARS_LIMIT - 1).map((ids) =>
          db.query.message.findMany({
            where: and(eq(message.mailboxId, input.mailboxId), inArray(message.messageIdHdr, ids)),
            columns: { messageIdHdr: true, threadId: true },
          }),
        ),
      )
    ).flat();
    // A header match alone is forgeable: anyone who learns a Message-ID (from a
    // reply, NDR, or list archive) can send In-Reply-To: <that-id> to graft
    // into the thread. Require a corroborating signal — the sender is already a
    // participant of the matched thread and the thread is recent — before
    // trusting the splice. Otherwise fall through and treat it as new mail.
    byHeader = new Map(headerHits.map((h) => [h.messageIdHdr, h.threadId]));
    // Keep header order so the earliest-referenced thread wins the tie.
    const candidates = [
      ...new Set(headerIds.map((mid) => byHeader.get(mid)).filter((t): t is string => !!t)),
    ];
    if (candidates.length) {
      // Our own outbound mail is trusted; inbound must be corroborated.
      if (input.trustHeaders) {
        return { threadId: candidates[0]!, joinedByHeader: true, created: false };
      }
      const corroborated = await corroboratedThreadIds(db, candidates, input);
      const hit = candidates.find((tid) => corroborated.has(tid));
      if (hit) return { threadId: hit, joinedByHeader: true, created: false };
    }
  }

  const norm = normalizeSubject(input.subject);
  // When we have a header chain, derive a deterministic thread id from the
  // chain root. Two concurrent inbounds with the same parent then collide on
  // the same id instead of each inserting a fresh random-UUID thread. This only
  // ever creates/joins a thread keyed by the (forgeable) root id — it never
  // splices into a victim's pre-existing thread, so no corroboration is needed.
  // The one exception is a root stored under its own key (see the end of this
  // function): that thread is the root's conversation, and it already failed
  // corroboration above.
  const rootHeader = input.references?.[0] ?? input.inReplyTo ?? null;
  if (rootHeader) {
    const id = await deriveThreadId(input.mailboxId, rootHeader);
    if (byHeader.get(rootHeader) !== id) {
      const created = await insertKeyedThread(db, id, input);
      return { threadId: id, joinedByHeader: false, created };
    }
  }

  // Subject is the weakest, most error-prone signal: it only ever rescues a
  // reply whose client stripped In-Reply-To/References. Gate it so it can only
  // *join* when the message actually looks like a reply — it carries reply
  // headers, or its raw subject had a Re:/Fwd: prefix. Otherwise a bare
  // first-contact email (e.g. two separate "Welcome to Bitwarden!" signups)
  // would wrongly merge with an unrelated message that shares a subject.
  const looksLikeReply =
    !!input.inReplyTo || !!input.references?.length || REPLY_PREFIX.test(input.subject);
  if (norm && looksLikeReply) {
    const since = new Date(Date.now() - SUBJECT_WINDOW_SECONDS * 1000);
    const hits = await db.query.thread.findMany({
      where: and(
        eq(thread.mailboxId, input.mailboxId),
        eq(thread.subjectNorm, norm),
        gte(thread.lastMsgAt, since),
      ),
      orderBy: desc(thread.lastMsgAt),
      columns: { id: true, participants: true },
    });
    // Require the sender to already take part in the thread, so two unrelated
    // "Re: meeting" threads from different people in the same week don't
    // collapse into one, and a stranger cannot write into a conversation by
    // guessing its subject. Any shared address will not do for inbound mail:
    // the mailbox's own address is on both sides of every comparison. Our own
    // outbound mail has no such sender to check, so it joins on a shared
    // recipient.
    const addrs = new Set(
      (input.trustHeaders ? input.participants.map((p) => p.address) : [input.fromAddr])
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    );
    const hit = hits.find((h) =>
      (h.participants ?? []).some((p) => addrs.has(p.address.trim().toLowerCase())),
    );
    if (hit) return { threadId: hit.id, joinedByHeader: false, created: false };
  }

  // A message with its own Message-ID takes the thread keyed by that id, the
  // same key its replies derive from their chain root above. Whichever of a
  // message and its reply is stored first, even in parallel, the other then
  // lands in the same thread. Replies stored first are not proof that this
  // message belongs with them, though: anyone can send mail that reuses a
  // known Message-ID. So joining an existing thread needs the same
  // corroboration as a header match.
  if (input.messageId) {
    const id = await deriveThreadId(input.mailboxId, input.messageId);
    if (await insertKeyedThread(db, id, input)) {
      return { threadId: id, joinedByHeader: false, created: true };
    }
    if (input.trustHeaders || (await corroboratedThreadIds(db, [id], input)).has(id)) {
      return { threadId: id, joinedByHeader: false, created: false };
    }
  }

  return insertThread(db, input);
}

// Create the thread row under a derived id, or find it already there. Returns
// whether this call created it.
async function insertKeyedThread(db: DB, id: string, input: ResolveThreadInput): Promise<boolean> {
  const inserted = await db
    .insert(thread)
    .values({
      id,
      mailboxId: input.mailboxId,
      subjectNorm: normalizeSubject(input.subject),
      lastMsgAt: new Date(),
      msgCount: 0,
      participants: input.participants,
      unreadCount: 0,
      listId: input.listId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: thread.id });
  return inserted.length > 0;
}

async function insertThread(db: DB, input: ResolveThreadInput): Promise<ResolveThreadResult> {
  const id = crypto.randomUUID();
  await db.insert(thread).values({
    id,
    mailboxId: input.mailboxId,
    subjectNorm: normalizeSubject(input.subject),
    lastMsgAt: new Date(),
    msgCount: 0,
    participants: input.participants,
    unreadCount: 0,
    listId: input.listId ?? null,
  });
  return { threadId: id, joinedByHeader: false, created: true };
}

// A header match is only trusted when the inbound sender is already a known
// participant of the matched thread (participant signal) and the thread is
// still recent (recency signal), counted back from `asOf` when the message is
// imported history. Either missing → don't splice. On a mailing list most
// posters have not written in the thread before, so a message through the
// thread's own list counts as a participant: the header is forgeable, but it
// only opens list threads, which any list member can post to anyway. Batched over
// all candidates so a long References chain stays one query, not one per row.
async function corroboratedThreadIds(
  db: DB,
  threadIds: string[],
  input: ResolveThreadInput,
): Promise<Set<string>> {
  const from = input.fromAddr.trim().toLowerCase();
  if (!from) return new Set();
  const rows = (
    await Promise.all(
      chunk(threadIds, SQL_VARS_LIMIT).map((ids) =>
        db.query.thread.findMany({
          where: inArray(thread.id, ids),
          columns: { id: true, participants: true, lastMsgAt: true, listId: true },
        }),
      ),
    )
  ).flat();
  const cutoff = (input.asOf?.getTime() ?? Date.now()) - HEADER_MATCH_WINDOW_SECONDS * 1000;
  const ok = new Set<string>();
  for (const t of rows) {
    if (t.lastMsgAt.getTime() < cutoff) continue;
    if (input.listId && t.listId === input.listId) ok.add(t.id);
    else if ((t.participants ?? []).some((p) => p.address.trim().toLowerCase() === from)) {
      ok.add(t.id);
    }
  }
  return ok;
}

async function deriveThreadId(mailboxId: string, rootHeader: string): Promise<string> {
  const data = new TextEncoder().encode(`${mailboxId}\u0000${rootHeader}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Reconcile a thread's unread badge with its messages — inbound messages
// missing the SEEN flag. Call after toggling SEEN so list badges stay in sync
// (the receive path is the only other writer of unreadCount).
export async function recomputeThreadUnread(db: DB, threadId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.direction, "in"),
        sql`(${message.flags} & ${Flag.SEEN}) = 0`,
        // A trashed message shouldn't keep the thread's unread badge lit.
        sql`(${message.flags} & ${Flag.TRASH}) = 0`,
      ),
    );
  const n = rows[0]?.c ?? 0;
  await db.update(thread).set({ unreadCount: n }).where(eq(thread.id, threadId));
  return n;
}

// Reconcile a thread's cached aggregates with its surviving messages after one
// is permanently removed: message count, last-activity time, and unread badge.
// Participants aren't pruned — like bumpThread, the list only ever grows.
export async function recomputeThreadAfterMessageDelete(db: DB, threadId: string): Promise<void> {
  const rows = await db.select({ c: count() }).from(message).where(eq(message.threadId, threadId));
  const msgCount = rows[0]?.c ?? 0;

  // lastMsgAt drives list ordering; deleting the newest message must move it
  // back to the next survivor (mirrors bumpThread's sent/received timestamp).
  const latest = await db.query.message.findFirst({
    where: eq(message.threadId, threadId),
    orderBy: desc(message.createdAt),
    columns: { sentAt: true, receivedAt: true, createdAt: true },
  });
  const lastMsgAt = latest?.sentAt ?? latest?.receivedAt ?? latest?.createdAt;

  await db
    .update(thread)
    .set({ msgCount, ...(lastMsgAt ? { lastMsgAt } : {}) })
    .where(eq(thread.id, threadId));

  await recomputeThreadUnread(db, threadId);
}

export async function bumpThread(
  db: DB,
  threadId: string,
  at: Date,
  newParticipants: { name?: string; address: string }[],
  unreadDelta: number,
  untrash = false,
): Promise<void> {
  const values = threadBumpValues(at, newParticipants, unreadDelta, untrash);
  await db.update(thread).set(values).where(eq(thread.id, threadId));
}

// The comparable form of a participant's address, for a json_each row alias.
const address = (entry: string) => sql.raw(`lower(trim(${entry}.value ->> '$.address'))`);

// What one new message changes on its thread, as values for the caller's own
// UPDATE. The receive path puts that update in the batch that inserts the
// message, so the two commit together. Every value is computed by SQLite from
// the row as it is when the UPDATE runs, so deliveries that overlap each count
// and each add their participants. Threading lets a sender join a conversation
// only if the list names them, so an entry lost here would split the thread.
export function threadBumpValues(
  at: Date,
  newParticipants: { name?: string; address: string }[],
  unreadDelta: number,
  // A live new message (inbound delivery or our own reply) resurfaces a trashed
  // thread: trash is thread-wide, so without this a reply to a trashed
  // conversation would stay buried in Trash. Off for historical import, which
  // must not resurrect previously-trashed threads on re-import.
  untrash = false,
): SQLiteUpdateSetSource<typeof thread> {
  const seen = new Set<string>();
  const incoming = newParticipants.filter((p) => {
    const key = p.address.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const added = sql.param(incoming, thread.participants);
  const when = sql.param(at, thread.lastMsgAt);
  return {
    // A thread row is created stamped with the current time. Its first message
    // sets the real time, which for an import lies in the past; after that the
    // time only moves forward.
    lastMsgAt: sql`case when ${thread.msgCount} = 0 then ${when} else max(${thread.lastMsgAt}, ${when}) end`,
    msgCount: sql`${thread.msgCount} + 1`,
    unreadCount: sql`max(0, ${thread.unreadCount} + ${unreadDelta})`,
    // The stored entries, then each incoming address the list does not hold
    // yet, in message order. A stored entry keeps its name.
    ...(incoming.length
      ? {
          participants: sql`(
            select json_group_array(json(p.value) order by p.incoming, p.key)
            from (
              select o.value, o.key, 0 as incoming from json_each(${thread.participants}) o
              union all
              select n.value, n.key, 1 from json_each(${added}) n
              where not exists (
                select 1 from json_each(${thread.participants}) o
                where ${address("o")} = ${address("n")}
              )
            ) p
          )`,
        }
      : {}),
    ...(untrash ? { trashed: false, trashedAt: null } : {}),
  };
}
