import { attachment, message, thread } from "@cfx-mail/db/schema";
import { Flag } from "@cfx-mail/shared/flags";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mailboxesRoutes } from "../../src/api/mailboxes.ts";
import { MAX_EMAIL_BYTES } from "../../src/mail/ingest.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { MAILBOX_ID, OTHER_MAILBOX_ID, owner, seedBase } from "../support/seed.ts";

// The import route stores one exported message per request. These tests send real
// .eml bytes through the real route and read back every table and blob it wrote.
// Joining imported messages into one conversation is a separate concern and is
// not tested here: each test imports messages with different subjects.

const ATT_TEXT = "hello attachment";
const ATT_B64 = "aGVsbG8gYXR0YWNobWVudA==";
// The seeded group mailbox "team" on example.com.
const OWN_ADDRESS = "team@example.com";

function eml(
  opts: {
    from?: string;
    subject?: string;
    messageId?: string | null;
    date?: string;
    withAttachment?: boolean;
    body?: string;
  } = {},
): string {
  const {
    from = "Sender <sender@elsewhere.test>",
    subject = "Quarterly report",
    messageId = "<import-1@elsewhere.test>",
    date = "Tue, 02 Jan 2024 10:30:00 +0000",
    withAttachment = false,
    body = "Please find the numbers below.",
  } = opts;
  const head = [
    `From: ${from}`,
    `To: Team <${OWN_ADDRESS}>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "MIME-Version: 1.0",
  ];
  if (!withAttachment) {
    return [...head, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
  }
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "--BOUND",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    ATT_B64,
    "--BOUND--",
    "",
  ].join("\r\n");
}

async function importEml(
  raw: string | ArrayBuffer,
  mailboxId = MAILBOX_ID,
  query = "",
): Promise<Response> {
  return Promise.resolve(
    mountApp(mailboxesRoutes, owner).request(
      `/${mailboxId}/import${query}`,
      { method: "POST", body: raw, headers: { "content-type": "message/rfc822" } },
      e,
    ),
  );
}

type Imported = { messageId: string; threadId: string; duplicate: boolean };

async function importOk(raw: string, mailboxId = MAILBOX_ID, query = ""): Promise<Imported> {
  const res = await importEml(raw, mailboxId, query);
  expect(res.status).toBe(200);
  return (await res.json()) as Imported;
}

const messageRow = (id: string) => db().query.message.findFirst({ where: eq(message.id, id) });
const threadRow = (id: string) => db().query.thread.findFirst({ where: eq(thread.id, id) });

async function counts(): Promise<{
  messages: number;
  threads: number;
  attachments: number;
  blobs: number;
}> {
  const [messages, threads, attachments, blobs] = await Promise.all([
    db().query.message.findMany(),
    db().query.thread.findMany(),
    db().query.attachment.findMany(),
    e.BLOBS.list(),
  ]);
  return {
    messages: messages.length,
    threads: threads.length,
    attachments: attachments.length,
    blobs: blobs.objects.length,
  };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  const keys = (await e.BLOBS.list()).objects.map((o) => o.key);
  if (keys.length) await e.BLOBS.delete(keys);
});

describe("POST /:id/import: a successful import", () => {
  it("stores the message, its raw blob, its thread and its attachment", async () => {
    const raw = eml({ withAttachment: true });
    const res = await importEml(raw);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Imported;
    expect(body.duplicate).toBe(false);
    expect(body.messageId).toBeTruthy();
    expect(body.threadId).toBeTruthy();

    // The message row.
    const row = await messageRow(body.messageId);
    expect(row).toMatchObject({
      mailboxId: MAILBOX_ID,
      threadId: body.threadId,
      direction: "in",
      fromAddr: "sender@elsewhere.test",
      fromName: "Sender",
      subject: "Quarterly report",
      deliveredTo: OWN_ADDRESS,
      sizeBytes: new TextEncoder().encode(raw).byteLength,
    });
    expect(row?.messageIdHdr).toContain("import-1@elsewhere.test");
    expect(row?.bodyText).toContain("Please find the numbers below.");
    // The Date header decides when the mail counts as received, not the import time.
    expect(row?.receivedAt?.toISOString()).toBe("2024-01-02T10:30:00.000Z");
    expect(row?.sentAt).toBeNull();
    // Imported mail is filed as read, so it does not inflate unread badges.
    expect((row?.flags ?? 0) & Flag.SEEN).toBe(Flag.SEEN);

    // The raw blob is the exact bytes that were posted.
    expect(row?.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/[0-9a-f-]+\\.eml$`));
    const blob = await e.BLOBS.get(row!.rawR2Key!);
    expect(await blob?.text()).toBe(raw);

    // The thread row.
    const t = await threadRow(body.threadId);
    expect(t).toMatchObject({
      mailboxId: MAILBOX_ID,
      msgCount: 1,
      unreadCount: 0,
      trashed: false,
      spam: false,
    });
    expect(t?.participants.map((p) => p.address)).toContain("sender@elsewhere.test");

    // The attachment row and its blob.
    const atts = await db().query.attachment.findMany({
      where: eq(attachment.messageId, body.messageId),
    });
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: ATT_TEXT.length,
      inline: false,
      r2Key: `att/${body.messageId}/0-notes.txt`,
    });
    expect(await (await e.BLOBS.get(atts[0]!.r2Key))?.text()).toBe(ATT_TEXT);

    // Nothing else was written.
    expect(await counts()).toEqual({ messages: 1, threads: 1, attachments: 1, blobs: 2 });
  });

  it("refuses the same Message-ID a second time and writes nothing more", async () => {
    const raw = eml({ withAttachment: true });
    const first = await importOk(raw);
    const before = await counts();

    const res = await importEml(raw);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true });
    expect(await counts()).toEqual(before);
    expect(await db().query.message.findMany()).toMatchObject([{ id: first.messageId }]);
  });

  // The web importer sends many messages at once, and a retry can overlap
  // the request it repeats.
  it.each([
    ["received", "Sender <sender@elsewhere.test>"],
    ["sent", `Team <${OWN_ADDRESS}>`],
  ])("stores a %s message once when two imports of it arrive together", async (_, from) => {
    const raw = eml({ from, withAttachment: true });

    const responses = await Promise.all([importEml(raw), importEml(raw)]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { duplicate: boolean }[];
    expect(bodies.filter((b) => b.duplicate)).toHaveLength(1);
    expect(await counts()).toEqual({ messages: 1, threads: 1, attachments: 1, blobs: 2 });
  });

  it("treats the same Message-ID in another mailbox as new mail", async () => {
    const raw = eml();
    const first = await importOk(raw, MAILBOX_ID);
    const second = await importOk(raw, OTHER_MAILBOX_ID);

    expect(second.duplicate).toBe(false);
    expect(second.messageId).not.toBe(first.messageId);
    expect((await messageRow(second.messageId))?.mailboxId).toBe(OTHER_MAILBOX_ID);
    expect((await counts()).messages).toBe(2);
  });

  it("files mail the mailbox itself sent as outbound", async () => {
    const { messageId, threadId } = await importOk(
      eml({ from: `Team <${OWN_ADDRESS}>`, subject: "Sent by us", messageId: "<out-1@x.test>" }),
    );

    const row = await messageRow(messageId);
    expect(row).toMatchObject({ direction: "out", deliveredTo: null, receivedAt: null });
    expect(row?.sentAt?.toISOString()).toBe("2024-01-02T10:30:00.000Z");
    expect((row?.flags ?? 0) & Flag.SENT).toBe(Flag.SENT);
    expect((await threadRow(threadId))?.unreadCount).toBe(0);
  });

  it("stores a message that has no Message-ID header", async () => {
    const { messageId } = await importOk(eml({ messageId: null, subject: "No id" }));
    expect((await messageRow(messageId))?.messageIdHdr).toBeNull();
  });
});

describe("POST /:id/import: state hints", () => {
  it("keeps the message unread when seen=0, and counts it on the thread", async () => {
    const { messageId, threadId } = await importOk(eml(), MAILBOX_ID, "?seen=0");
    expect(((await messageRow(messageId))?.flags ?? 0) & Flag.SEEN).toBe(0);
    expect((await threadRow(threadId))?.unreadCount).toBe(1);
  });

  it("stars the message when starred=1", async () => {
    const { messageId } = await importOk(eml(), MAILBOX_ID, "?starred=1");
    expect(((await messageRow(messageId))?.flags ?? 0) & Flag.STARRED).toBe(Flag.STARRED);
  });

  it("moves the thread to trash when trashed=1, stamped with the message date", async () => {
    const { threadId } = await importOk(eml(), MAILBOX_ID, "?trashed=1");
    const t = await threadRow(threadId);
    expect(t).toMatchObject({ trashed: true, spam: false });
    expect(t?.trashedAt?.toISOString()).toBe("2024-01-02T10:30:00.000Z");
  });

  it("moves the thread to spam when spam=1", async () => {
    const { threadId } = await importOk(eml(), MAILBOX_ID, "?spam=1");
    expect(await threadRow(threadId)).toMatchObject({ trashed: false, spam: true });
  });

  it("lets trash win when both trashed=1 and spam=1 are given", async () => {
    const { threadId } = await importOk(eml(), MAILBOX_ID, "?trashed=1&spam=1");
    expect(await threadRow(threadId)).toMatchObject({ trashed: true, spam: false });
  });
});

describe("POST /:id/import: what it does not store", () => {
  it("skips a fragment with no subject, no body and no attachment", async () => {
    const fragment = ["From: x@y.test", "To: team@example.com", "", ""].join("\r\n");
    const res = await importEml(fragment);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true });
    expect(await counts()).toEqual({ messages: 0, threads: 0, attachments: 0, blobs: 0 });
  });

  it("413s a message over the size cap and writes nothing", async () => {
    const res = await importEml(new ArrayBuffer(MAX_EMAIL_BYTES + 1));

    expect(res.status).toBe(413);
    expect(await counts()).toEqual({ messages: 0, threads: 0, attachments: 0, blobs: 0 });
  });

  it("403s a mailbox that does not exist, as it does one the caller cannot reach", async () => {
    const res = await importEml(eml(), "no-such-mailbox");
    expect(res.status).toBe(403);
    expect(await counts()).toEqual({ messages: 0, threads: 0, attachments: 0, blobs: 0 });
  });
});
