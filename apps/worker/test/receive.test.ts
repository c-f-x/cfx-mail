import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfx-mail/db";
import {
  attachment,
  domain,
  mailbox,
  mailboxMember,
  message,
  redirect,
  systemConfig,
  thread,
  user,
} from "@cfx-mail/db/schema";
import { Perm } from "@cfx-mail/shared/permissions";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/mail/receive.ts";
import { markMailboxPurge } from "../src/mailbox-purge.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const ADDRESS = "me@example.com";

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM attachment"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox_member"),
    e.DB.prepare("DELETE FROM redirect"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
  await e.BLOBS.delete([
    ...(await blobKeys("raw/")),
    ...(await blobKeys("att/")),
    ...(await blobKeys("plain/")),
  ]);
}

async function blobKeys(prefix: string): Promise<string[]> {
  return (await e.BLOBS.list({ prefix })).objects.map((o) => o.key);
}

// The real binding with one method made to fail: the only way to force a
// storage error midway through a delivery.
function faulty<T extends object>(target: T, method: string, fail: (arg: string) => boolean): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop);
      if (typeof value !== "function") return value;
      if (prop !== method) return value.bind(t);
      return (arg: string, ...rest: unknown[]) => {
        if (fail(arg)) throw new Error(`${method} failed`);
        return value.call(t, arg, ...rest);
      };
    },
  });
}

async function seed(): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
  await db.insert(mailbox).values({
    id: MAILBOX_ID,
    domainId: DOMAIN_ID,
    localPart: "me",
    type: "personal",
    ownerUserId: OWNER_ID,
  });
}

interface StubMessage extends ForwardableEmailMessage {
  rejected?: string;
}

function stubInbound(opts: {
  from: string;
  to: string;
  raw?: string;
  stream?: { body: ReadableStream<Uint8Array>; size: number };
}): StubMessage {
  const raw = opts.raw ?? "From: x\r\nTo: y\r\nSubject: t\r\n\r\nbody\r\n";
  const stream = opts.stream?.body ?? new Response(raw).body;
  if (!stream) throw new Error("no stream");
  const stub = {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    raw: stream,
    rawSize: opts.stream?.size ?? raw.length,
    rejected: undefined as string | undefined,
    setReject(reason: string) {
      this.rejected = reason;
    },
    async forward() {},
    async reply() {},
  };
  return stub as unknown as StubMessage;
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
  await seed();
});

describe("handleInbound — bounce-loop protection", () => {
  it("rejects when envelope sender equals envelope recipient", async () => {
    const msg = stubInbound({ from: ADDRESS, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Sender equals recipient");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(0);
  });

  it("rejects when sender and recipient differ only in case/whitespace", async () => {
    const msg = stubInbound({ from: " ME@Example.com ", to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Sender equals recipient");
  });

  it("does not reject a normal inbound from a different sender", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();
  });
});

describe("handleInbound — plus/sub-addressing", () => {
  it("routes hi+tag@ to the hi@ mailbox and stores the full envelope recipient", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "me+newsletter@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredTo).toBe("me+newsletter@example.com");
  });

  it("matches the base local part case-insensitively", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "ME+Tag@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
  });

  it("rejects when the base local part has no mailbox", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "nobody+tag@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");
  });
});

describe("handleInbound — full pipeline", () => {
  const MEMBER_ID = "user-member";
  const SENDER_ADDR = "sender@elsewhere.com";
  const SENDER_FORMATTED = `Sender <${SENDER_ADDR}>`;
  const MSG_ID_HDR = "<integ-1@elsewhere.com>";
  const ATT_BYTES = "hello attachment";
  const ATT_B64 = "aGVsbG8gYXR0YWNobWVudA==";
  const RAW_EML = [
    `From: ${SENDER_FORMATTED}`,
    `To: Me <${ADDRESS}>`,
    `Subject: Integration Test`,
    `Message-ID: ${MSG_ID_HDR}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="BOUND"`,
    ``,
    `--BOUND`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hello from integration test.`,
    ``,
    `--BOUND`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Disposition: attachment; filename="notes.txt"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    ATT_B64,
    ``,
    `--BOUND--`,
    ``,
  ].join("\r\n");

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  async function subscribe(userId: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const stub = e.USER_HUB.get(e.USER_HUB.idFromName(userId));
    const res = await stub.fetch("https://hub/subscribe");
    if (!res.body) throw new Error("subscribe returned no body");
    const reader = res.body.getReader();
    readers.push(reader);
    return reader;
  }

  beforeEach(async () => {
    await db.insert(user).values({ id: MEMBER_ID, name: "Member", email: "member@example.com" });
    await db.insert(mailboxMember).values({
      mailboxId: MAILBOX_ID,
      userId: MEMBER_ID,
      perms: Perm.READ,
    });
  });

  afterEach(async () => {
    const toClose = readers.splice(0, readers.length);
    await Promise.all(toClose.map((r) => r.cancel().catch(() => undefined)));
  });

  it("persists message + thread + attachment + raw blob and broadcasts to owner and members", async () => {
    const ownerReader = await subscribe(OWNER_ID);
    const memberReader = await subscribe(MEMBER_ID);

    const msg = stubInbound({ from: SENDER_ADDR, to: ADDRESS, raw: RAW_EML });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const msgs = await db.query.message.findMany({
      where: eq(message.mailboxId, MAILBOX_ID),
    });
    expect(msgs).toHaveLength(1);
    const row = msgs[0]!;
    expect(row.direction).toBe("in");
    expect(row.subject).toBe("Integration Test");
    expect(row.fromAddr).toBe(SENDER_ADDR);
    expect(row.fromName).toBe("Sender");
    expect(row.messageIdHdr).toBe(MSG_ID_HDR);
    expect(row.toAddrs).toEqual([{ name: "Me", address: ADDRESS }]);
    expect(row.snippet).toBe("Hello from integration test.");
    expect(row.sizeBytes).toBe(new TextEncoder().encode(RAW_EML).byteLength);
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/[0-9a-f-]+\\.eml$`));
    expect(row.receivedAt).toBeInstanceOf(Date);
    expect(row.sentAt).toBeNull();

    const threads = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(row.threadId);
    expect(threads[0]!.subjectNorm).toBe("integration test");
    expect(threads[0]!.msgCount).toBe(1);
    expect(threads[0]!.unreadCount).toBe(1);

    const atts = await db.query.attachment.findMany({ where: eq(attachment.messageId, row.id) });
    expect(atts).toHaveLength(1);
    const att = atts[0]!;
    expect(att.filename).toBe("notes.txt");
    expect(att.contentType).toBe("text/plain");
    expect(att.sizeBytes).toBe(ATT_BYTES.length);
    expect(att.r2Key).toBe(`att/${row.id}/0-notes.txt`);
    expect(att.inline).toBe(false);

    const rawBlob = await e.BLOBS.get(row.rawR2Key!);
    expect(rawBlob).not.toBeNull();
    expect(rawBlob!.httpMetadata?.contentType).toBe("message/rfc822");
    expect(await rawBlob!.text()).toBe(RAW_EML);

    const attBlob = await e.BLOBS.get(att.r2Key);
    expect(attBlob).not.toBeNull();
    expect(await attBlob!.text()).toBe(ATT_BYTES);

    await Promise.all([
      readUntil(ownerReader, "event: new_message"),
      readUntil(memberReader, "event: new_message"),
    ]);
  });
});

describe("handleInbound — redirects", () => {
  const TARGET_ID = "mailbox-target";

  beforeEach(async () => {
    await db.insert(mailbox).values({
      id: TARGET_ID,
      domainId: DOMAIN_ID,
      localPart: "target",
      type: "personal",
      ownerUserId: OWNER_ID,
    });
    await db.insert(redirect).values({
      id: "redirect-1",
      domainId: DOMAIN_ID,
      localPart: "alias",
      targetMailboxId: TARGET_ID,
    });
  });

  it("delivers mail for an alias into its target mailbox", async () => {
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "alias@example.com" });
    await handleInbound(msg, e);

    expect(msg.rejected).toBeUndefined();
    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, TARGET_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredTo).toBe("alias@example.com");
  });

  it("rejects mail for an alias whose target mailbox is being deleted", async () => {
    await markMailboxPurge(db, TARGET_ID, "delete");

    const msg = stubInbound({ from: "someone@elsewhere.com", to: "alias@example.com" });
    await handleInbound(msg, e);

    expect(msg.rejected).toBe("Address not found");
    expect(await db.query.message.findMany()).toHaveLength(0);
    expect(await db.query.thread.findMany()).toHaveLength(0);
    expect(await blobKeys("raw/")).toEqual([]);
  });

  describe("the domain catch-all", () => {
    beforeEach(async () => {
      await db.insert(redirect).values({
        id: "redirect-catch-all",
        domainId: DOMAIN_ID,
        localPart: "*",
        targetMailboxId: TARGET_ID,
      });
    });

    it("takes mail for an address nothing else receives", async () => {
      const msg = stubInbound({ from: "someone@elsewhere.com", to: "anyone@example.com" });
      await handleInbound(msg, e);

      expect(msg.rejected).toBeUndefined();
      const rows = await db.query.message.findMany({ where: eq(message.mailboxId, TARGET_ID) });
      expect(rows.map((r) => r.deliveredTo)).toEqual(["anyone@example.com"]);
    });

    // Replies to a no-reply address are bounces, auto-replies and mistakes.
    it.each(["noreply", "no-reply", "No_Reply", "do-not-reply", "donotreply", "noreply+tag"])(
      "bounces mail for %s@ instead of catching it",
      async (local) => {
        const msg = stubInbound({ from: "someone@elsewhere.com", to: `${local}@example.com` });
        await handleInbound(msg, e);

        expect(msg.rejected).toBe("Address not found");
        expect(await db.query.message.findMany()).toHaveLength(0);
      },
    );

    it("still delivers a no-reply address someone set up on purpose", async () => {
      await db.insert(redirect).values({
        id: "redirect-noreply",
        domainId: DOMAIN_ID,
        localPart: "noreply",
        targetMailboxId: TARGET_ID,
      });
      const msg = stubInbound({ from: "someone@elsewhere.com", to: "noreply@example.com" });
      await handleInbound(msg, e);

      expect(msg.rejected).toBeUndefined();
    });
  });
});

describe("handleInbound — storage is all-or-nothing", () => {
  const SENDER = "sender@elsewhere.com";
  const MSG_ID = "<once@elsewhere.com>";

  function eml(opts: { messageId?: string | null; attachment?: boolean } = {}): string {
    const lines = [`From: Sender <${SENDER}>`, `To: Me <${ADDRESS}>`, `Subject: Once`];
    if (opts.messageId !== null) lines.push(`Message-ID: ${opts.messageId ?? MSG_ID}`);
    if (!opts.attachment) return [...lines, ``, `body`, ``].join("\r\n");
    return [
      ...lines,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="B"`,
      ``,
      `--B`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `body`,
      `--B`,
      `Content-Type: application/pdf; name="a.pdf"`,
      `Content-Disposition: attachment; filename="a.pdf"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      `aGVsbG8=`,
      `--B--`,
      ``,
    ].join("\r\n");
  }

  const messages = () => db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
  const threads = () => db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });

  async function expectNothingStored(): Promise<void> {
    expect(await messages()).toHaveLength(0);
    expect(await db.query.attachment.findMany()).toHaveLength(0);
    expect(await threads()).toHaveLength(0);
    expect(await blobKeys("raw/")).toEqual([]);
    expect(await blobKeys("att/")).toEqual([]);
  }

  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a sender's retry of the same message without storing it twice", async () => {
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw: eml() }), e);
    const retry = stubInbound({ from: SENDER, to: ADDRESS, raw: eml() });
    await handleInbound(retry, e);

    expect(retry.rejected).toBeUndefined();
    expect(await messages()).toHaveLength(1);
    expect(await blobKeys("raw/")).toHaveLength(1);
    const th = await threads();
    expect(th).toHaveLength(1);
    expect(th[0]!.msgCount).toBe(1);
    expect(th[0]!.unreadCount).toBe(1);
  });

  it("stores one copy when the same message is delivered twice at the same instant", async () => {
    const raw = eml({ attachment: true });
    const copies = [
      stubInbound({ from: SENDER, to: ADDRESS, raw }),
      stubInbound({ from: SENDER, to: ADDRESS, raw }),
    ];
    await Promise.all(copies.map((copy) => handleInbound(copy, e)));

    expect(copies.map((copy) => copy.rejected)).toEqual([undefined, undefined]);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(await blobKeys("raw/")).toEqual([rows[0]!.rawR2Key]);
    expect(await blobKeys("att/")).toEqual([`att/${rows[0]!.id}/0-a.pdf`]);
    expect(await db.query.attachment.findMany()).toHaveLength(1);
    const th = await threads();
    expect(th).toHaveLength(1);
    expect(th[0]!.msgCount).toBe(1);
    expect(th[0]!.unreadCount).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("stores the same Message-ID again when it arrives at another address", async () => {
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw: eml() }), e);
    await handleInbound(stubInbound({ from: SENDER, to: "me+list@example.com", raw: eml() }), e);
    expect(await messages()).toHaveLength(2);
  });

  it("never dedupes mail that has no Message-ID", async () => {
    const raw = eml({ messageId: null });
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), e);
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), e);
    expect(await messages()).toHaveLength(2);
  });

  it("leaves nothing behind when an attachment cannot be stored, and the retry is delivered once", async () => {
    const raw = eml({ attachment: true });
    const broken = { ...e, BLOBS: faulty(e.BLOBS, "put", (key) => key.startsWith("att/")) };

    await expect(
      handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), broken),
    ).rejects.toThrow("put failed");
    await expectNothingStored();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("inbound_failed", {
      step: "store",
      mailboxId: MAILBOX_ID,
      messageIdHdr: MSG_ID,
      error: "put failed",
    });

    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), e);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(await db.query.attachment.findMany()).toHaveLength(1);
    const th = await threads();
    expect(th).toHaveLength(1);
    expect(th[0]!.msgCount).toBe(1);
    expect(th[0]!.unreadCount).toBe(1);
    expect(await blobKeys("raw/")).toEqual([rows[0]!.rawR2Key]);
    expect(await blobKeys("att/")).toEqual([`att/${rows[0]!.id}/0-a.pdf`]);
  });

  it("leaves nothing behind when the message row cannot be written", async () => {
    const raw = eml({ attachment: true });
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.startsWith('insert into "message"')),
    };

    await expect(
      handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), broken),
    ).rejects.toThrow("prepare failed");
    await expectNothingStored();
  });

  it("keeps a thread that already holds mail when a reply to it cannot be stored", async () => {
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw: eml() }), e);
    const reply = [
      `From: Sender <${SENDER}>`,
      `To: Me <${ADDRESS}>`,
      `Subject: Re: Once`,
      `Message-ID: <twice@elsewhere.com>`,
      `In-Reply-To: ${MSG_ID}`,
      ``,
      `body`,
      ``,
    ].join("\r\n");
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.startsWith('insert into "message"')),
    };

    await expect(
      handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw: reply }), broken),
    ).rejects.toThrow("prepare failed");

    const th = await threads();
    expect(th).toHaveLength(1);
    expect(th[0]!.msgCount).toBe(1);
    expect(await messages()).toHaveLength(1);
    expect(await blobKeys("raw/")).toHaveLength(1);
  });

  it("does not log the query parameters of a failed insert", async () => {
    // A real D1 failure, because Drizzle's own error text carries every bound
    // value, body included.
    await e.DB.prepare(
      "CREATE TRIGGER test_reject_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    ).run();
    try {
      await expect(
        handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw: eml() }), e),
      ).rejects.toThrow("disk full");
    } finally {
      await e.DB.prepare("DROP TRIGGER test_reject_message").run();
    }

    await expectNothingStored();
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("inbound_failed");
    expect(logged).not.toContain("Once");
    expect(logged).not.toContain(SENDER);
  });

  it("delivers when the member lookup after storing fails", async () => {
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.includes('from "mailbox_member"')),
    };
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw: eml() });

    await handleInbound(msg, broken);

    expect(msg.rejected).toBeUndefined();
    expect(await messages()).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(
      "inbound_post_store_failed",
      expect.objectContaining({ step: "members", mailboxId: MAILBOX_ID }),
    );
  });

  it("delivers with no spam verdict when spam scoring fails", async () => {
    // Scoring reads the Spamhaus key from system_config before anything else.
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.includes('"system_config"')),
    };
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw: eml() });

    await handleInbound(msg, broken);

    expect(msg.rejected).toBeUndefined();
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spamVerdict).toBeNull();
    expect(rows[0]!.spamScore).toBeNull();
    expect((await threads())[0]!.spam).toBe(false);
    expect(errors).toHaveBeenCalledWith("inbound_spam_failed", {
      mailboxId: MAILBOX_ID,
      messageIdHdr: MSG_ID,
      error: "prepare failed",
    });
  });

  it("delivers, and logs it, when capturing the sender's PGP key fails", async () => {
    await db.update(mailbox).set({ pgpMode: "sign" }).where(eq(mailbox.id, MAILBOX_ID));
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.includes('"contact_key"')),
    };
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw: eml() });

    await handleInbound(msg, broken);

    expect(msg.rejected).toBeUndefined();
    expect(await messages()).toHaveLength(1);
    expect(errors.mock.calls).toEqual([
      [
        "inbound_pgp_key_capture_failed",
        { mailboxId: MAILBOX_ID, messageIdHdr: MSG_ID, error: "prepare failed" },
      ],
    ]);
  });

  it("logs a failed deferred step instead of swallowing it", async () => {
    const broken = {
      ...e,
      DB: faulty(e.DB, "prepare", (query) => query.startsWith('update "reminder"')),
    };
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw: eml() });

    await handleInbound(msg, broken);

    expect(await messages()).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith("inbound_deferred_failed", {
      what: "cancel_reminders",
      error: "prepare failed",
    });
  });

  it("rejects a message over the size cap instead of throwing", async () => {
    const MIB = 1024 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 26) controller.enqueue(new Uint8Array(MIB));
        else controller.close();
      },
    });
    const msg = stubInbound({ from: SENDER, to: ADDRESS, stream: { body, size: 26 * MIB } });

    await handleInbound(msg, e);

    expect(msg.rejected).toBe("Message too large");
    await expectNothingStored();
  });

  it("rejects a message the parser refuses instead of throwing", async () => {
    // Nesting past the parser's limit can never be read; a throw would leave the
    // sender retrying, or bounce it with no reason.
    let part = "Content-Type: text/plain\r\n\r\nhi";
    for (let i = 0; i < 300; i++) {
      part = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${part}\r\n--b${i}--`;
    }
    const raw = `From: ${SENDER}\r\nTo: ${ADDRESS}\r\nSubject: deep\r\n${part}\r\n`;
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleInbound(msg, e);

    expect(msg.rejected).toBe("Message could not be read");
    expect(logged).toHaveBeenCalledWith(
      "inbound_unreadable",
      expect.objectContaining({ mailboxId: MAILBOX_ID }),
    );
    logged.mockRestore();
    await expectNothingStored();
  });

  it("rejects a message that turns out larger than it said, instead of throwing", async () => {
    const MIB = 1024 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 26) controller.enqueue(new Uint8Array(MIB));
        else controller.close();
      },
    });
    // Declares 1 MiB, delivers 26.
    const msg = stubInbound({ from: SENDER, to: ADDRESS, stream: { body, size: MIB } });

    await handleInbound(msg, e);

    expect(msg.rejected).toBe("Message too large");
    await expectNothingStored();
  });

  it("stores PGP mail undecrypted when the mailbox key cannot be unwrapped", async () => {
    await db
      .update(mailbox)
      .set({
        pgpMode: "sign_encrypt",
        pgpPrivateKeyWrapped: "not-a-blob",
        pgpPassphraseWrapped: "not-a-blob",
      })
      .where(eq(mailbox.id, MAILBOX_ID));
    const raw = [
      `From: Sender <${SENDER}>`,
      `To: Me <${ADDRESS}>`,
      `Subject: Secret`,
      `Message-ID: ${MSG_ID}`,
      ``,
      `-----BEGIN PGP MESSAGE-----`,
      ``,
      `wcBMA0000000000000AQgAnotreallyciphertext`,
      `-----END PGP MESSAGE-----`,
      ``,
    ].join("\r\n");
    const msg = stubInbound({ from: SENDER, to: ADDRESS, raw });

    await handleInbound(msg, e);

    expect(msg.rejected).toBeUndefined();
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pgpEncrypted).toBe(false);
    expect(rows[0]!.plainR2Key).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "inbound_pgp_failed",
      expect.objectContaining({ mailboxId: MAILBOX_ID, messageIdHdr: MSG_ID }),
    );
  });
});

describe("handleInbound — service mailboxes", () => {
  async function seedService(mode: "duplex" | "send"): Promise<void> {
    await db.insert(mailbox).values({
      id: "mailbox-svc",
      domainId: DOMAIN_ID,
      localPart: "svc",
      type: "service",
      ownerUserId: OWNER_ID,
      serviceMode: mode,
      spamFilter: "off",
    });
  }

  it("hard-bounces inbound to a send-only service mailbox", async () => {
    await seedService("send");
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "svc@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Send-only address");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, "mailbox-svc") });
    expect(rows).toHaveLength(0);
  });

  it("stores inbound to a duplex service mailbox for polling", async () => {
    await seedService("duplex");
    const msg = stubInbound({ from: "someone@elsewhere.com", to: "svc@example.com" });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, "mailbox-svc") });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe("in");
  });
});

describe("handleInbound — spam filtering (default standard level)", () => {
  const SENDER = "stranger@elsewhere.com";

  function eml(
    authResults: string | null,
    extra: { subject?: string; body?: string } = {},
  ): string {
    const lines = [`From: Stranger <${SENDER}>`, `To: Me <${ADDRESS}>`];
    if (authResults) lines.push(`Authentication-Results: ${authResults}`);
    lines.push(
      `Subject: ${extra.subject ?? "Hi there"}`,
      ``,
      extra.body ?? "A normal message body.",
      ``,
    );
    return lines.join("\r\n");
  }

  it("files DMARC-failing mail into Spam with a verdict and reasons", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("spam");
    expect(row.spamReasons?.length).toBeGreaterThan(0);

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(true);
  });

  it("leaves fully authenticated mail clean in the inbox", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("clean");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });

  it("marks partially authenticated mail (no DMARC) suspicious but keeps it in the inbox", async () => {
    const msg = stubInbound({
      from: SENDER,
      to: ADDRESS,
      raw: eml("mx.cloudflare.net; spf=pass; dkim=none; dmarc=none"),
    });
    await handleInbound(msg, e);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("suspicious");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });
});

describe("handleInbound — one-time codes", () => {
  const SENDER = "noreply@login.elsewhere.com";

  function codeMail(dmarc: string, otpToken: string | null): string {
    const lines = [
      `From: Login <${SENDER}>`,
      `To: Me <${ADDRESS}>`,
      `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=${dmarc}`,
      "Subject: Your sign-in code",
    ];
    if (otpToken) lines.push(`OTP-Token: ${otpToken}`);
    lines.push("", "Your verification code is:", "", "482913", "", "It expires in 10 minutes.", "");
    return lines.join("\r\n");
  }

  async function deliver(raw: string) {
    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS, raw }), e);
    return (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
  }

  it("stores the code from the body, for the sender's domain", async () => {
    const row = await deliver(codeMail("pass", null));
    expect(row).toMatchObject({
      otpCode: "482913",
      otpDomain: "elsewhere.com",
      otpOrigin: null,
    });
  });

  it("binds the code to the site an authenticated OTP-Token header names", async () => {
    const row = await deliver(codeMail("pass", '"482913"; origin="https://auth.elsewhere.com"'));
    expect(row).toMatchObject({
      otpCode: "482913",
      otpDomain: "auth.elsewhere.com",
      otpOrigin: "https://auth.elsewhere.com",
    });
  });

  it("does not let mail that fails DMARC bind a code to a site", async () => {
    const row = await deliver(codeMail("fail", '"999111"; origin="https://auth.elsewhere.com"'));
    expect(row.otpCode).toBe("482913");
    expect(row.otpOrigin).toBeNull();
  });
});

describe("handleInbound — concurrent delivery", () => {
  it("counts every message when four replies to one thread arrive at once", async () => {
    const reply = (n: number) =>
      [
        `From: Sender <sender@elsewhere.com>`,
        `To: Me <${ADDRESS}>`,
        `Subject: Re: Plans`,
        `Message-ID: <reply-${n}@elsewhere.com>`,
        `References: <root@elsewhere.com>`,
        ``,
        `body ${n}`,
        ``,
      ].join("\r\n");

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        handleInbound(stubInbound({ from: "sender@elsewhere.com", to: ADDRESS, raw: reply(n) }), e),
      ),
    );

    expect(
      await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }),
    ).toHaveLength(4);
    const threads = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.msgCount).toBe(4);
    expect(threads[0]!.unreadCount).toBe(4);
  });

  it("lists every sender when six new ones reply to one thread at once", async () => {
    const senders = Array.from({ length: 6 }, (_, n) => `sender-${n}@elsewhere.com`);
    const reply = (from: string) =>
      [
        `From: ${from}`,
        `To: Me <${ADDRESS}>`,
        `Subject: Re: Plans`,
        `Message-ID: <reply-${from}>`,
        `References: <root@elsewhere.com>`,
        ``,
        `body`,
        ``,
      ].join("\r\n");

    await Promise.all(
      senders.map((from) => handleInbound(stubInbound({ from, to: ADDRESS, raw: reply(from) }), e)),
    );

    const threads = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.msgCount).toBe(6);
    expect(threads[0]!.participants.map((p) => p.address).toSorted()).toEqual([
      ADDRESS,
      ...senders,
    ]);
  });
});

describe("handleInbound — a conversation only its participants can extend", () => {
  const ALICE = "alice@partner.test";
  const PASS = "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass";
  const FAIL = "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail";
  const INVOICE_ID = "<invoice-4411@partner.test>";

  function eml(opts: { from: string; auth: string; subject: string; headers?: string[] }): string {
    return [
      `Authentication-Results: ${opts.auth}`,
      `From: <${opts.from}>`,
      `To: Me <${ADDRESS}>`,
      `Subject: ${opts.subject}`,
      ...(opts.headers ?? []),
      ``,
      `A normal message body.`,
      ``,
    ].join("\r\n");
  }

  async function deliver(envelopeFrom: string, raw: string): Promise<void> {
    const msg = stubInbound({ from: envelopeFrom, to: ADDRESS, raw });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();
  }

  // Alice's first message: one thread, in the inbox.
  async function seedInvoice(): Promise<string> {
    await deliver(
      ALICE,
      eml({
        from: ALICE,
        auth: PASS,
        subject: "Invoice 4411",
        headers: [`Message-ID: ${INVOICE_ID}`],
      }),
    );
    const th = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(th).toHaveLength(1);
    return th[0]!.id;
  }

  const threadOf = (id: string) => db.query.thread.findFirst({ where: eq(thread.id, id) });
  const messageFrom = async (addr: string, subject: string) =>
    (await db.query.message.findMany({ where: eq(message.fromAddr, addr) })).find(
      (m) => m.subject === subject,
    )!;

  it("gives a stranger's bare Re: its own thread", async () => {
    const invoice = await seedInvoice();

    await deliver(
      "mallory@evil.test",
      eml({ from: "mallory@evil.test", auth: PASS, subject: "Re: Invoice 4411" }),
    );

    const spliced = await messageFrom("mallory@evil.test", "Re: Invoice 4411");
    expect(spliced.threadId).not.toBe(invoice);
    expect((await threadOf(invoice))!.msgCount).toBe(1);
  });

  it("lets a participant's bare Re: join the conversation", async () => {
    const invoice = await seedInvoice();

    await deliver(ALICE, eml({ from: ALICE, auth: PASS, subject: "Re: Invoice 4411" }));

    expect((await messageFrom(ALICE, "Re: Invoice 4411")).threadId).toBe(invoice);
    expect((await threadOf(invoice))!.msgCount).toBe(2);
  });

  it("files a forged reply in its own spam thread and leaves the conversation alone", async () => {
    const invoice = await seedInvoice();

    // Knows one Message-ID and one participant address; cannot pass DMARC.
    await deliver(
      "bounce@evil.test",
      eml({
        from: ALICE,
        auth: FAIL,
        subject: "Re: Invoice 4411",
        headers: [`Message-ID: <forged@evil.test>`, `In-Reply-To: ${INVOICE_ID}`],
      }),
    );

    const forged = await messageFrom(ALICE, "Re: Invoice 4411");
    expect(forged.spamVerdict).toBe("spam");
    expect(forged.threadId).not.toBe(invoice);
    expect((await threadOf(forged.threadId))!.spam).toBe(true);

    const original = (await threadOf(invoice))!;
    expect(original.spam).toBe(false);
    expect(original.msgCount).toBe(1);
  });

  it("joins an authenticated reply from a participant", async () => {
    const invoice = await seedInvoice();

    await deliver(
      ALICE,
      eml({
        from: ALICE,
        auth: PASS,
        subject: "Re: Invoice 4411",
        headers: [`Message-ID: <reply@partner.test>`, `In-Reply-To: ${INVOICE_ID}`],
      }),
    );

    expect((await messageFrom(ALICE, "Re: Invoice 4411")).threadId).toBe(invoice);
    const original = (await threadOf(invoice))!;
    expect(original.spam).toBe(false);
    expect(original.msgCount).toBe(2);
  });

  it("names a conversation that started without a subject after the first reply that has one", async () => {
    await deliver(
      ALICE,
      eml({ from: ALICE, auth: PASS, subject: "", headers: [`Message-ID: ${INVOICE_ID}`] }),
    );
    const started = (
      await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) })
    )[0]!;
    expect(started.subjectNorm).toBe("");

    for (const [id, subject] of [
      ["<reply-1@partner.test>", "Re: Invoice 4411"],
      ["<reply-2@partner.test>", "Re: Something else"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- replies arrive one after the other
      await deliver(
        ALICE,
        eml({
          from: ALICE,
          auth: PASS,
          subject,
          headers: [`Message-ID: ${id}`, `In-Reply-To: ${INVOICE_ID}`],
        }),
      );
    }

    const named = (await threadOf(started.id))!;
    expect(named.msgCount).toBe(3);
    expect(named.subject).toBe("Re: Invoice 4411");
    expect(named.subjectNorm).toBe("invoice 4411");
  });

  it("stores a new conversation's subject as written", async () => {
    const invoice = await seedInvoice();
    expect((await threadOf(invoice))!.subject).toBe("Invoice 4411");
  });

  it("marks an out-of-office reply, which joins the conversation but never names it", async () => {
    await deliver(
      ALICE,
      eml({ from: ALICE, auth: PASS, subject: "", headers: [`Message-ID: ${INVOICE_ID}`] }),
    );
    await deliver(
      ALICE,
      eml({
        from: ALICE,
        auth: PASS,
        subject: "Automatic reply: Invoice 4411",
        headers: [
          `Message-ID: <ooo@partner.test>`,
          `In-Reply-To: ${INVOICE_ID}`,
          "Auto-Submitted: auto-replied",
        ],
      }),
    );

    const ooo = await messageFrom(ALICE, "Automatic reply: Invoice 4411");
    expect(ooo.autoReply).toBe(true);
    const th = (await threadOf(ooo.threadId))!;
    expect(th.msgCount).toBe(2);
    expect(th.subject).toBe("");
    expect(th.subjectNorm).toBe("");
    const first = await messageFrom(ALICE, "");
    expect(first.autoReply).toBe(false);
  });
});

describe("handleInbound — Spamhaus DQS", () => {
  const KEY = "testkey123456789";

  async function enableDqs(listings: Record<string, string[]>): Promise<void> {
    await db
      .insert(systemConfig)
      .values({ key: "spamhaus_dqs_key", value: KEY, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value: KEY } });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const name = new URL(String(input)).searchParams.get("name") ?? "";
      const subject = name.split(`.${KEY}.`)[0] ?? "";
      const zone = name.split(`.${KEY}.`)[1]?.split(".dq.")[0] ?? "";
      const codes = listings[`${subject}/${zone}`] ?? [];
      return Response.json({
        Status: codes.length ? 0 : 3,
        Answer: codes.map((data) => ({ name, type: 1, TTL: 60, data })),
      });
    });
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    await e.DB.prepare("DELETE FROM system_config WHERE key = 'spamhaus_dqs_key'").run();
  });

  // dmarc=pass by default: domain reputation still runs, the IP check doesn't,
  // so the ZEN case passes "none" to exercise it.
  const listedMail = (from: string, dmarc = "pass") =>
    stubInbound({
      from,
      to: ADDRESS,
      raw:
        `Received: from evil.test (unknown [199.168.89.90]) by mx.cloudflare.net\r\n` +
        `Authentication-Results: mx; spf=pass; dkim=pass; dmarc=${dmarc}\r\n` +
        `From: <${from}>\r\nTo: <${ADDRESS}>\r\nSubject: hi\r\n\r\nbody\r\n`,
    });

  // Only mail that fails DMARC is refused for a listed sender domain.
  it("rejects a DBL-listed sender without storing the message", async () => {
    await enableDqs({ "listed.test/dbl": ["127.0.1.2"] });
    const msg = listedMail("someone@listed.test", "fail");
    await handleInbound(msg, e);
    expect(msg.rejected).toMatch(/listed\.test is listed by Spamhaus \(DBL\)/);
    expect(await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) })).toEqual(
      [],
    );
  });

  it("rejects a ZEN-listed connecting host", async () => {
    await enableDqs({ "90.89.168.199/zen": ["127.0.0.2"] });
    const msg = listedMail("someone@clean.test", "none");
    await handleInbound(msg, e);
    expect(msg.rejected).toMatch(/199\.168\.89\.90 is listed by Spamhaus \(SBL\)/);
  });

  it("delivers mail that is listed nowhere", async () => {
    await enableDqs({});
    const msg = listedMail("someone@clean.test");
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();
    expect(
      await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }),
    ).toHaveLength(1);
  });
});
