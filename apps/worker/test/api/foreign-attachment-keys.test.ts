import { draft } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { draftsRoutes } from "../../src/api/drafts.ts";
import { messagesRoutes } from "../../src/api/messages.ts";
import type { AppBindings, Env } from "../../src/env.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { MAILBOX_ID, OUTSIDER_ID, OWNER_ID, owner, seedBase } from "../support/seed.ts";

// A user may only attach files from their own upload namespace, `draft/<userId>/`.
// Anything else in the bucket (another user's upload, a stored attachment, raw
// mail) must never be read into an outgoing message. These tests drive the real
// send and schedule routes with such keys and check that the request is refused
// and that nothing was sent, scheduled or copied.

const SECRET = "another user's private bytes";
const OTHER_USERS_UPLOAD = `draft/${OUTSIDER_ID}/${crypto.randomUUID()}-secret.txt`;
const STORED_ATTACHMENT = "att/some-message-id/0-report.pdf";
const RAW_MAIL = `raw/${MAILBOX_ID}/sent/some-message.eml`;
// Shares a prefix with the owner's id but is not the owner's namespace.
const LOOKALIKE = `draft/${OWNER_ID}-evil/${crypto.randomUUID()}-x.txt`;
const OWN_UPLOAD = `draft/${OWNER_ID}/${crypto.randomUUID()}-mine.txt`;

const att = (r2Key: string) => ({ r2Key, filename: "file.txt", contentType: "text/plain" });

const sendBody = (attachments: unknown[]) => ({
  mailboxId: MAILBOX_ID,
  to: [{ address: "recipient@elsewhere.test" }],
  subject: "Hi",
  text: "hello",
  attachments,
});

function post(app: Hono<AppBindings>, path: string, body: unknown, env: Env): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
      env,
    ),
  );
}

// The EMAIL binding has no local simulation, so tests swap in a spy.
function emailSpy() {
  const send = vi.fn(async () => ({ messageId: "platform-mid" }));
  return { send, env: { ...e, EMAIL: { send } } as unknown as Env };
}

async function clearBlobs(): Promise<void> {
  const keys = (await e.BLOBS.list()).objects.map((o) => o.key);
  if (keys.length) await e.BLOBS.delete(keys);
}

async function blobKeys(): Promise<string[]> {
  return (await e.BLOBS.list()).objects.map((o) => o.key).toSorted();
}

const FOREIGN_KEYS = [
  ["another user's upload", OTHER_USERS_UPLOAD],
  ["a stored attachment", STORED_ATTACHMENT],
  ["raw mail", RAW_MAIL],
  ["a key that only shares the owner's id as a prefix", LOOKALIKE],
] as const;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await clearBlobs();
  await Promise.all(
    [OTHER_USERS_UPLOAD, STORED_ATTACHMENT, RAW_MAIL, LOOKALIKE, OWN_UPLOAD].map((key) =>
      e.BLOBS.put(key, key === OWN_UPLOAD ? "mine" : SECRET),
    ),
  );
});

const messagesApp = () => mountApp(messagesRoutes, owner);
const draftsApp = () => mountApp(draftsRoutes, owner);
const sendAt = () => Date.now() + 10 * 60_000;

async function seedDraft(): Promise<string> {
  const id = `draft-${crypto.randomUUID()}`;
  await db().insert(draft).values({ id, mailboxId: MAILBOX_ID, userId: OWNER_ID });
  return id;
}

const row = (id: string) => db().query.draft.findFirst({ where: eq(draft.id, id) });

describe("POST /api/messages/send with attachment keys", () => {
  it.each(FOREIGN_KEYS)("refuses %s and sends nothing", async (_name, key) => {
    const before = await blobKeys();
    const { send, env } = emailSpy();

    const res = await post(messagesApp(), "/send", sendBody([att(key)]), env);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid attachment key" });
    expect(send).not.toHaveBeenCalled();
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await db().query.thread.findMany()).toHaveLength(0);
    // No copy was made into the new message's namespace, and nothing was deleted.
    expect(await blobKeys()).toEqual(before);
  });

  it("refuses the whole send when only one of several keys is foreign", async () => {
    const before = await blobKeys();
    const { send, env } = emailSpy();

    const res = await post(
      messagesApp(),
      "/send",
      sendBody([att(OWN_UPLOAD), att(OTHER_USERS_UPLOAD)]),
      env,
    );

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await blobKeys()).toEqual(before);
  });

  it("sends the caller's own upload (control)", async () => {
    const { send, env } = emailSpy();

    const res = await post(messagesApp(), "/send", sendBody([att(OWN_UPLOAD)]), env);

    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db().query.message.findMany()).toHaveLength(1);
  });
});

describe("POST /api/drafts/:id/schedule with attachment keys", () => {
  it.each(FOREIGN_KEYS)("refuses %s and schedules nothing", async (_name, key) => {
    const id = await seedDraft();
    const before = await blobKeys();
    const { send, env } = emailSpy();

    const res = await post(
      draftsApp(),
      `/${id}/schedule`,
      { sendAt: sendAt(), payload: sendBody([att(key)]) },
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid attachment key" });
    const after = await row(id);
    expect(after?.scheduledFor).toBeNull();
    expect(after?.scheduledPayload).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await blobKeys()).toEqual(before);
  });

  it("refuses the whole schedule when only one of several keys is foreign", async () => {
    const id = await seedDraft();
    const { env } = emailSpy();

    const res = await post(
      draftsApp(),
      `/${id}/schedule`,
      { sendAt: sendAt(), payload: sendBody([att(OWN_UPLOAD), att(OTHER_USERS_UPLOAD)]) },
      env,
    );

    expect(res.status).toBe(400);
    expect((await row(id))?.scheduledPayload).toBeNull();
  });

  it("schedules the caller's own upload (control)", async () => {
    const id = await seedDraft();
    const { env } = emailSpy();

    const res = await post(
      draftsApp(),
      `/${id}/schedule`,
      { sendAt: sendAt(), payload: sendBody([att(OWN_UPLOAD)]) },
      env,
    );

    expect(res.status).toBe(200);
    const after = await row(id);
    expect(after?.scheduledFor).not.toBeNull();
    expect(after?.scheduledPayload?.attachments?.map((a) => a.r2Key)).toEqual([OWN_UPLOAD]);
  });
});

describe("DELETE /api/drafts/:id with a stale foreign attachment key", () => {
  it("deletes the caller's own upload and leaves everyone else's bytes alone", async () => {
    const id = `draft-${crypto.randomUUID()}`;
    // A row that somehow holds foreign keys, as a data fix or an older build could leave.
    await db()
      .insert(draft)
      .values({
        id,
        mailboxId: MAILBOX_ID,
        userId: OWNER_ID,
        attachments: [OWN_UPLOAD, OTHER_USERS_UPLOAD, STORED_ATTACHMENT, RAW_MAIL, LOOKALIKE].map(
          (r2Key) => ({ r2Key, filename: "f.txt", contentType: "text/plain", sizeBytes: 1 }),
        ),
      });

    const res = await mountApp(draftsRoutes, owner).request(`/${id}`, { method: "DELETE" }, e);

    expect(res.status).toBe(200);
    expect(await e.BLOBS.head(OWN_UPLOAD)).toBeNull();
    const survivors = await Promise.all(
      [OTHER_USERS_UPLOAD, STORED_ATTACHMENT, RAW_MAIL, LOOKALIKE].map((key) => e.BLOBS.head(key)),
    );
    expect(survivors.every((o) => o !== null)).toBe(true);
    expect(await db().query.draft.findFirst({ where: eq(draft.id, id) })).toBeUndefined();
  });
});
