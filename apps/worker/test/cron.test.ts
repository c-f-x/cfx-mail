import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfx-mail/db";
import { attachment, domain, mailbox, message, thread, user } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/mail/receive.ts";
import { markMailboxPurge } from "../src/mailbox-purge.ts";
import { runCronOffline } from "./support/cron.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const EXPIRED_ID = "mailbox-expired";
const FRESH_ID = "mailbox-fresh";
const PERSONAL_ID = "mailbox-personal";

const EXPIRED_RAW = `raw/${EXPIRED_ID}/msg-1.eml`;
const EXPIRED_ATT = `att/msg-1/0-file.txt`;
const FRESH_RAW = `raw/${FRESH_ID}/msg-2.eml`;
const PERSONAL_RAW = `raw/${PERSONAL_ID}/msg-3.eml`;

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM attachment"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox_member"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
  await Promise.all(
    [EXPIRED_RAW, EXPIRED_ATT, FRESH_RAW, PERSONAL_RAW].map((key) => e.BLOBS.delete(key)),
  );
}

async function seed(now: Date): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
  await db.insert(mailbox).values([
    {
      id: EXPIRED_ID,
      domainId: DOMAIN_ID,
      localPart: "expired",
      type: "temp",
      ownerUserId: OWNER_ID,
      expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
    },
    {
      id: FRESH_ID,
      domainId: DOMAIN_ID,
      localPart: "fresh",
      type: "temp",
      ownerUserId: OWNER_ID,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
    {
      id: PERSONAL_ID,
      domainId: DOMAIN_ID,
      localPart: "me",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
  ]);

  await db.insert(thread).values([
    { id: "thread-expired", mailboxId: EXPIRED_ID },
    { id: "thread-fresh", mailboxId: FRESH_ID },
    { id: "thread-personal", mailboxId: PERSONAL_ID },
  ]);

  await db.insert(message).values([
    {
      id: "msg-1",
      mailboxId: EXPIRED_ID,
      threadId: "thread-expired",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: EXPIRED_RAW,
    },
    {
      id: "msg-2",
      mailboxId: FRESH_ID,
      threadId: "thread-fresh",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: FRESH_RAW,
    },
    {
      id: "msg-3",
      mailboxId: PERSONAL_ID,
      threadId: "thread-personal",
      direction: "in",
      fromAddr: "s@example.com",
      rawR2Key: PERSONAL_RAW,
    },
  ]);

  await db.insert(attachment).values({
    id: "att-1",
    messageId: "msg-1",
    filename: "file.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    r2Key: EXPIRED_ATT,
  });

  await e.BLOBS.put(EXPIRED_RAW, "raw-expired");
  await e.BLOBS.put(EXPIRED_ATT, "hello");
  await e.BLOBS.put(FRESH_RAW, "raw-fresh");
  await e.BLOBS.put(PERSONAL_RAW, "raw-personal");
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (!acc.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    const timed = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const result = await Promise.race([reader.read(), timed]);
    if (result === null) throw new Error(`timed out waiting for ${needle}; got: ${acc}`);
    if (result.done) throw new Error(`stream ended before ${needle}; got: ${acc}`);
    acc += decoder.decode(result.value, { stream: true });
  }
  return acc;
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
});

describe("runCron — temp mailbox GC", () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  afterEach(async () => {
    const toClose = readers.splice(0, readers.length);
    await Promise.all(toClose.map((r) => r.cancel().catch(() => undefined)));
  });

  it("deletes expired temp mailboxes, their R2 blobs, and broadcasts mailbox_expired", async () => {
    const now = new Date();
    await seed(now);

    const stub = e.USER_HUB.get(e.USER_HUB.idFromName(OWNER_ID));
    const res = await stub.fetch("https://hub/subscribe");
    if (!res.body) throw new Error("subscribe returned no body");
    const reader = res.body.getReader();
    readers.push(reader);

    await runCronOffline(e, now);

    const remaining = await db.query.mailbox.findMany();
    const remainingIds = new Set(remaining.map((m) => m.id));
    expect(remainingIds.has(EXPIRED_ID)).toBe(false);
    expect(remainingIds.has(FRESH_ID)).toBe(true);
    expect(remainingIds.has(PERSONAL_ID)).toBe(true);

    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-1") })).toBeUndefined();
    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-expired") }),
    ).toBeUndefined();
    expect(
      await db.query.attachment.findFirst({ where: eq(attachment.id, "att-1") }),
    ).toBeUndefined();

    expect(await e.BLOBS.head(EXPIRED_RAW)).toBeNull();
    expect(await e.BLOBS.head(EXPIRED_ATT)).toBeNull();
    expect(await e.BLOBS.head(FRESH_RAW)).not.toBeNull();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();

    const received = await readUntil(reader, "event: mailbox_expired");
    expect(received).toContain(`"mailboxId":"${EXPIRED_ID}"`);
  });

  it("is a no-op when no temp mailboxes are expired", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(mailbox)
      .set({ expiresAt: new Date(now.getTime() + 60 * 60 * 1000) })
      .where(eq(mailbox.id, EXPIRED_ID));

    await runCronOffline(e, now);

    const remaining = await db.query.mailbox.findMany();
    expect(remaining).toHaveLength(3);
    expect(await e.BLOBS.head(EXPIRED_RAW)).not.toBeNull();
    expect(await e.BLOBS.head(EXPIRED_ATT)).not.toBeNull();
  });

  it("leaves non-temp mailboxes with a past expiresAt alone", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(mailbox)
      .set({ expiresAt: new Date(now.getTime() - 60 * 60 * 1000) })
      .where(eq(mailbox.id, PERSONAL_ID));

    await runCronOffline(e, now);

    const personal = await db.query.mailbox.findFirst({ where: eq(mailbox.id, PERSONAL_ID) });
    expect(personal).toBeDefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();
  });
});

describe("runCron — trash retention purge", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("purges threads trashed past the retention window, with their blobs", async () => {
    const now = new Date();
    await seed(now);

    // thread-personal trashed 31 days ago → purged.
    await db
      .update(thread)
      .set({ trashed: true, trashedAt: new Date(now.getTime() - 31 * DAY) })
      .where(eq(thread.id, "thread-personal"));
    // thread-fresh trashed 5 days ago → kept.
    await db
      .update(thread)
      .set({ trashed: true, trashedAt: new Date(now.getTime() - 5 * DAY) })
      .where(eq(thread.id, "thread-fresh"));

    await runCronOffline(e, now);

    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-personal") }),
    ).toBeUndefined();
    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-3") })).toBeUndefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).toBeNull();

    expect(await db.query.thread.findFirst({ where: eq(thread.id, "thread-fresh") })).toBeDefined();
    expect(await e.BLOBS.head(FRESH_RAW)).not.toBeNull();
  });

  it("leaves trashed threads with a null trashedAt alone", async () => {
    const now = new Date();
    await seed(now);

    await db
      .update(thread)
      .set({ trashed: true, trashedAt: null })
      .where(eq(thread.id, "thread-personal"));

    await runCronOffline(e, now);

    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-personal") }),
    ).toBeDefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).not.toBeNull();
  });
});

describe("runCron — service mailbox retention", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const SVC_ID = "mailbox-svc";
  const OLD_RAW = `raw/${SVC_ID}/old.eml`;
  const NEW_RAW = `raw/${SVC_ID}/new.eml`;

  async function seedService(now: Date): Promise<void> {
    await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
    await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
    await db.insert(mailbox).values({
      id: SVC_ID,
      domainId: DOMAIN_ID,
      localPart: "svc",
      type: "service",
      ownerUserId: OWNER_ID,
    });
    await db.insert(thread).values([
      { id: "svc-old", mailboxId: SVC_ID, lastMsgAt: new Date(now.getTime() - 31 * DAY) },
      { id: "svc-new", mailboxId: SVC_ID, lastMsgAt: new Date(now.getTime() - DAY) },
    ]);
    await db.insert(message).values([
      {
        id: "svc-msg-old",
        mailboxId: SVC_ID,
        threadId: "svc-old",
        direction: "in",
        fromAddr: "s@example.com",
        rawR2Key: OLD_RAW,
      },
      {
        id: "svc-msg-new",
        mailboxId: SVC_ID,
        threadId: "svc-new",
        direction: "in",
        fromAddr: "s@example.com",
        rawR2Key: NEW_RAW,
      },
    ]);
    await e.BLOBS.put(OLD_RAW, "raw-old");
    await e.BLOBS.put(NEW_RAW, "raw-new");
  }

  afterEach(async () => {
    await Promise.all([OLD_RAW, NEW_RAW].map((key) => e.BLOBS.delete(key)));
  });

  it("purges service threads older than the retention window, with their blobs", async () => {
    const now = new Date();
    await seedService(now);

    await runCronOffline(e, now);

    expect(await db.query.thread.findFirst({ where: eq(thread.id, "svc-old") })).toBeUndefined();
    expect(
      await db.query.message.findFirst({ where: eq(message.id, "svc-msg-old") }),
    ).toBeUndefined();
    expect(await e.BLOBS.head(OLD_RAW)).toBeNull();

    expect(await db.query.thread.findFirst({ where: eq(thread.id, "svc-new") })).toBeDefined();
    expect(await e.BLOBS.head(NEW_RAW)).not.toBeNull();
  });
});

describe("runCron — pending mailbox purge", () => {
  const HOUR = 60 * 60 * 1000;

  // seed() gives PERSONAL_ID one thread with one message and one raw blob. Age
  // the thread so it predates any purge requested in the test, and keep the
  // temp-mailbox GC out of the way so it does not share the drain budget.
  async function seedPersonal(now: Date): Promise<void> {
    await seed(now);
    await db
      .update(thread)
      .set({ lastMsgAt: new Date(now.getTime() - HOUR) })
      .where(eq(thread.id, "thread-personal"));
    await db
      .update(mailbox)
      .set({ expiresAt: new Date(now.getTime() + HOUR) })
      .where(eq(mailbox.id, EXPIRED_ID));
  }

  const personalThreads = () =>
    db.query.thread.findMany({ where: eq(thread.mailboxId, PERSONAL_ID), columns: { id: true } });
  const personalMailbox = () => db.query.mailbox.findFirst({ where: eq(mailbox.id, PERSONAL_ID) });

  it("drains a delete-pending mailbox across ticks, then drops the mailbox", async () => {
    const now = new Date();
    await seedPersonal(now);
    // 1,050 more threads: over one tick's budget of 1,000.
    const ids = Array.from({ length: 1050 }, (_, i) => `bulk-${i}`);
    const rows: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) rows.push(ids.slice(i, i + 50));
    await e.DB.batch(
      rows.map((part) =>
        e.DB.prepare(
          `INSERT INTO thread (id, mailbox_id) VALUES ${part.map(() => "(?, ?)").join(", ")}`,
        ).bind(...part.flatMap((id) => [id, PERSONAL_ID])),
      ),
    );
    await markMailboxPurge(db, PERSONAL_ID, "delete");

    await runCronOffline(e, now);
    expect(await personalThreads()).toHaveLength(51);
    expect((await personalMailbox())?.pendingPurge).toBe("delete");

    await runCronOffline(e, now);
    expect(await personalThreads()).toHaveLength(0);
    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-3") })).toBeUndefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).toBeNull();
    expect(await personalMailbox()).toBeUndefined();
    // Other mailboxes are untouched.
    expect(await db.query.thread.findFirst({ where: eq(thread.id, "thread-fresh") })).toBeDefined();
    expect(await e.BLOBS.head(FRESH_RAW)).not.toBeNull();
  });

  it("empties a mailbox but keeps mail that arrived after the empty was requested", async () => {
    const now = new Date();
    await seedPersonal(now);
    await markMailboxPurge(db, PERSONAL_ID, "empty");

    // The mailbox still receives while it waits for the drain.
    const raw = "From: sender@elsewhere.com\r\nTo: me@example.com\r\nSubject: Late\r\n\r\nbody\r\n";
    const inbound = {
      from: "sender@elsewhere.com",
      to: "me@example.com",
      headers: new Headers(),
      raw: new Response(raw).body,
      rawSize: raw.length,
      setReject() {},
      async forward() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage;
    await handleInbound(inbound, e);
    const late = (
      await db.query.message.findMany({ where: eq(message.mailboxId, PERSONAL_ID) })
    ).find((m) => m.id !== "msg-3")!;

    await runCronOffline(e, new Date());

    // What was there when the empty was requested is gone, blobs included.
    expect(
      await db.query.thread.findFirst({ where: eq(thread.id, "thread-personal") }),
    ).toBeUndefined();
    expect(await db.query.message.findFirst({ where: eq(message.id, "msg-3") })).toBeUndefined();
    expect(await e.BLOBS.head(PERSONAL_RAW)).toBeNull();

    // The later mail is whole.
    expect(await db.query.message.findFirst({ where: eq(message.id, late.id) })).toBeDefined();
    const kept = await db.query.thread.findFirst({ where: eq(thread.id, late.threadId) });
    expect(kept?.msgCount).toBe(1);
    expect(await e.BLOBS.head(late.rawR2Key!)).not.toBeNull();
    await e.BLOBS.delete(late.rawR2Key!);

    const mb = await personalMailbox();
    expect(mb?.pendingPurge).toBeNull();
    expect(mb?.purgeStartedAt).toBeNull();
  });

  it("treats a pending empty with no start time as starting at the first drain", async () => {
    const now = new Date();
    await seedPersonal(now);
    await db
      .update(mailbox)
      .set({ pendingPurge: "empty", purgeStartedAt: null })
      .where(eq(mailbox.id, PERSONAL_ID));

    await runCronOffline(e, now);

    expect(await personalThreads()).toHaveLength(0);
    expect(await e.BLOBS.head(PERSONAL_RAW)).toBeNull();
    expect((await personalMailbox())?.pendingPurge).toBeNull();
  });
});
