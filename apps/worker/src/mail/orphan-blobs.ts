import type { DB } from "@cfmail/db";
import { user } from "@cfmail/db/schema";
import { like, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { avatarKey } from "./blob-keys.ts";

// Composer uploads and avatars are written to R2 before anything in D1 points
// at them, and R2 has no cascade, so an upload whose draft is gone or an avatar
// nobody shows stays in the bucket. The cron's hourly sweep removes them.

// An upload is written before its draft is saved, and an avatar before the
// profile is. An object younger than this may still be about to be referred to.
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// Pages of 1000 keys listed per prefix per sweep. Bounds the subrequests of
// one tick; a bucket with more waits for the next sweep, which starts over.
const MAX_PAGES = 10;

/** Delete composer uploads no draft refers to and avatars no user shows, once past the grace period. */
export async function sweepOrphanBlobs(env: Env, db: DB, now: Date): Promise<void> {
  const cutoff = now.getTime() - ORPHAN_GRACE_MS;

  const uploads = await listOlderThan(env, "draft/", cutoff);
  if (uploads.length) {
    const referenced = await referencedUploads(db);
    await deleteKeys(
      env,
      uploads.filter((k) => !referenced.has(k)),
    );
  }

  const avatars = await listOlderThan(env, "avatar/", cutoff);
  if (avatars.length) {
    const shown = await shownAvatars(db);
    await deleteKeys(
      env,
      avatars.filter((k) => !shown.has(k)),
    );
  }
}

async function listOlderThan(env: Env, prefix: string, cutoff: number): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
    const res = await env.BLOBS.list({ prefix, cursor, limit: 1000 });
    for (const obj of res.objects) {
      if (obj.uploaded.getTime() < cutoff) keys.push(obj.key);
    }
    if (!res.truncated) return keys;
    cursor = res.cursor;
  }
  console.error("orphan_sweep_truncated", { prefix, pages: MAX_PAGES });
  return keys;
}

// Every key a draft holds: its attachments, and those of a scheduled send.
async function referencedUploads(db: DB): Promise<Set<string>> {
  const rows = await db.all<{ k: string | null }>(sql`
    SELECT json_extract(j.value, '$.r2Key') AS k FROM draft, json_each(draft.attachments) AS j
    UNION
    SELECT json_extract(j.value, '$.r2Key') AS k
      FROM draft, json_each(draft.scheduled_payload, '$.attachments') AS j
  `);
  return new Set(rows.flatMap((r) => (r.k ? [r.k] : [])));
}

// The avatar route serves `avatar/<userId>/<id>` at `/api/avatar/<userId>/<id>`,
// and a user's `image` holds that URL.
const AVATAR_URL = /\/api\/avatar\/([a-z0-9-]+)\/([a-z0-9-]+)$/i;

async function shownAvatars(db: DB): Promise<Set<string>> {
  const rows = await db
    .select({ image: user.image })
    .from(user)
    .where(like(user.image, "%/api/avatar/%"));
  const keys = new Set<string>();
  for (const { image } of rows) {
    const m = image ? AVATAR_URL.exec(image) : null;
    if (m) keys.add(avatarKey(m[1]!, m[2]!));
  }
  return keys;
}

// R2 deletes up to 1000 keys per call.
async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    // eslint-disable-next-line no-await-in-loop -- one bounded batch at a time
    await env.BLOBS.delete(keys.slice(i, i + 1000));
  }
}
