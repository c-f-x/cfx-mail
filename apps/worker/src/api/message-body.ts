import type { DB } from "@cfx-mail/db";
import { attachment, type message } from "@cfx-mail/db/schema";
import type { AttachmentDto, MessageBodyDto } from "@cfx-mail/shared/responses";
import { inArray } from "drizzle-orm";
import { getOrCreateAuthSecret } from "../config.ts";
import type { Env } from "../env.ts";
import { bytesToB64url } from "../lib/encoding.ts";
import { chunk, SQL_VARS_LIMIT } from "../lib/sql.ts";
import { extractCalendar } from "../mail/calendar.ts";
import { bareCid, proxyRemoteContent, rewriteInlineCids } from "../mail/img-proxy.ts";
import { parseMime } from "../mail/mime.ts";
import { sanitizeEmailHtml } from "../mail/sanitize.ts";
import { getTrackerRules, stripTrackers } from "../mail/trackers.ts";

// Rendering a stored message body for the reader. GET /api/messages/:id/body
// serves one message and GET /api/threads/:id/bodies several of one thread;
// both go through `renderBodies`, so they serve the same bytes for a message.

// Cached privately but always revalidated. The raw `.eml` never changes once
// stored, so the message id names the content. It is revalidated rather than
// cached outright: a browser cache that answers without asking would keep
// serving the mail after sign-out or after the user's access to the mailbox
// was removed. Routes check access before they answer 304.
export const REVALIDATE = "private, no-cache";

// True when an If-None-Match header names `etag` (or is "*"), ignoring weak
// validators.
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((v) => {
    const tag = v.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

export const bodyEtag = (messageId: string) => `"body-${messageId}"`;

// One ETag for a set of messages, whatever their order.
export async function bodiesEtag(messageIds: string[]): Promise<string> {
  const names = new TextEncoder().encode(messageIds.toSorted().join(","));
  const digest = await crypto.subtle.digest("SHA-256", names);
  return `"bodies-${bytesToB64url(digest.slice(0, 18))}"`;
}

type BodySource = Pick<typeof message.$inferSelect, "id" | "plainR2Key" | "rawR2Key">;

export type BodyResult =
  | { ok: true; body: MessageBodyDto }
  | { ok: false; reason: "not found" | "blob missing" };

// Messages parsed at the same time. Each holds its whole `.eml` in memory while
// it is parsed, attachments included.
const PARALLEL_PARSES = 6;

// The rendered body of each message, keyed by id. The caller has already
// checked that the user may read every message given.
export async function renderBodies(
  env: Env,
  db: DB,
  msgs: BodySource[],
): Promise<Map<string, BodyResult>> {
  const attsByMessage = await attachmentsOf(
    db,
    msgs.map((m) => m.id),
  );
  // Read once per request, and only when some message has HTML.
  let trackerRules: ReturnType<typeof getTrackerRules> | undefined;
  let authSecret: Promise<string> | undefined;

  async function render(msg: BodySource): Promise<BodyResult> {
    // For decrypted inbound mail the plaintext lives at plainR2Key; the original
    // ciphertext stays at rawR2Key (served by /:id/raw). Prefer plaintext here.
    const bodyKey = msg.plainR2Key ?? msg.rawR2Key;
    if (!bodyKey) return { ok: false, reason: "not found" };
    const obj = await env.BLOBS.get(bodyKey);
    if (!obj) return { ok: false, reason: "blob missing" };
    const parsed = await parseMime(await obj.arrayBuffer());
    const atts = attsByMessage.get(msg.id) ?? [];

    // Remote images are routed through `/proxy-image` so opening a message
    // never leaks the reader's IP to the sender (tracking pixels); inline `cid:`
    // images are rewritten to the same-origin attachment route so they render.
    let html: string | null = null;
    let trackersBlocked = 0;
    if (parsed.html) {
      trackerRules ??= getTrackerRules(db);
      authSecret ??= getOrCreateAuthSecret(env, db);
      // Known beacons and invisible pixels are dropped before proxying so the
      // request is never made at all — the proxy only hides who made it.
      ({ html, blocked: trackersBlocked } = await stripTrackers(parsed.html, await trackerRules));
      html = await proxyRemoteContent(html, await authSecret);
      const cidMap = new Map(
        atts.filter((a) => a.contentId).map((a) => [bareCid(a.contentId!), a.id]),
      );
      html = await rewriteInlineCids(html, msg.id, cidMap);
      // Server-side defense-in-depth: strip script-capable elements/attributes
      // before serving. Best-effort — the client sanitizer stays primary.
      html = await sanitizeEmailHtml(html);
    }
    return {
      ok: true,
      body: {
        html,
        text: parsed.text ?? null,
        attachments: atts,
        calendar: extractCalendar(parsed),
        trackersBlocked,
      },
    };
  }

  const out = new Map<string, BodyResult>();
  const queue = [...msgs];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // eslint-disable-next-line no-await-in-loop -- a fixed number of workers share the queue
      out.set(next.id, await render(next));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARSES, msgs.length) }, worker));
  return out;
}

async function attachmentsOf(db: DB, messageIds: string[]): Promise<Map<string, AttachmentDto[]>> {
  const byMessage = new Map<string, AttachmentDto[]>();
  for (const ids of chunk(messageIds, SQL_VARS_LIMIT)) {
    // eslint-disable-next-line no-await-in-loop -- one query per chunk of ids
    const rows = await db
      .select({
        messageId: attachment.messageId,
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        inline: attachment.inline,
        contentId: attachment.contentId,
      })
      .from(attachment)
      .where(inArray(attachment.messageId, ids));
    for (const { messageId, ...att } of rows) {
      const list = byMessage.get(messageId);
      if (list) list.push(att);
      else byMessage.set(messageId, [att]);
    }
  }
  return byMessage;
}
