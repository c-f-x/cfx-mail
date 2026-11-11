import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfx-mail/db";
import { domain, mailbox, message, thread, user } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { bumpThread, resolveThreadId } from "../src/mail/threads.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const OTHER_MAILBOX_ID = "mailbox-2";

async function seed(): Promise<void> {
  await db.insert(user).values({ id: OWNER_ID, name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: DOMAIN_ID, name: "example.com" });
  await db.insert(mailbox).values([
    {
      id: MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "a",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
    {
      id: OTHER_MAILBOX_ID,
      domainId: DOMAIN_ID,
      localPart: "b",
      type: "personal",
      ownerUserId: OWNER_ID,
    },
  ]);
}

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("resolveThreadId", () => {
  // Seed an existing thread with a stored ancestor message. `from` becomes a
  // known participant so a reply from that address corroborates the join.
  async function seedThread(opts: {
    from: string;
    lastMsgAt?: Date;
    parentId?: string;
    subject?: string;
  }): Promise<string> {
    const threadId = crypto.randomUUID();
    await db.insert(thread).values({
      id: threadId,
      mailboxId: MAILBOX_ID,
      subject: opts.subject ?? "Hello",
      subjectNorm: (opts.subject ?? "Hello").toLowerCase(),
      lastMsgAt: opts.lastMsgAt ?? new Date(),
      msgCount: 1,
      participants: [{ address: opts.from }],
    });
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "in",
      messageIdHdr: opts.parentId ?? "<parent@example.com>",
      fromAddr: opts.from,
      subject: opts.subject ?? "Hello",
    });
    return threadId;
  }

  const subjectOf = async (id: string) => {
    const th = await db.query.thread.findFirst({ where: eq(thread.id, id) });
    return th && `${th.subject}|${th.subjectNorm}`;
  };

  // Delivery finds the thread, then stores the message with the thread update
  // that carries the message's subject, none for an out-of-office reply
  // (ingest.ts, send.ts).
  async function deliverWithSubject(input: Parameters<typeof resolveThreadId>[1]): Promise<string> {
    const { threadId } = await resolveThreadId(db, input);
    const subject = input.autoReply ? "" : input.subject;
    await bumpThread(db, threadId, new Date(), input.participants, 0, false, subject);
    return threadId;
  }

  it("a thread that started without a subject takes the first one a reply brings", async () => {
    const threadId = await seedThread({ from: "x@example.com", subject: "" });
    const reply = {
      mailboxId: MAILBOX_ID,
      subject: "Re: Lunch plans",
      inReplyTo: "<parent@example.com>",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };
    expect(await deliverWithSubject(reply)).toBe(threadId);
    expect(await subjectOf(threadId)).toBe("Re: Lunch plans|lunch plans");

    await deliverWithSubject({ ...reply, subject: "Re: Something else" });
    expect(await subjectOf(threadId)).toBe("Re: Lunch plans|lunch plans");
  });

  it("an out-of-office reply never names a thread", async () => {
    const threadId = await seedThread({ from: "x@example.com", subject: "" });
    await deliverWithSubject({
      mailboxId: MAILBOX_ID,
      subject: "Réponse automatique\u00a0: Wohnung Düdingen",
      autoReply: true,
      inReplyTo: "<parent@example.com>",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(await subjectOf(threadId)).toBe("|");
  });

  it("a reply with a different subject does not rename a thread that has one", async () => {
    const threadId = await seedThread({ from: "x@example.com" });
    await deliverWithSubject({
      mailboxId: MAILBOX_ID,
      subject: "New topic",
      inReplyTo: "<parent@example.com>",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(await subjectOf(threadId)).toBe("Hello|hello");
  });

  it("reuses an existing thread when a known participant replies to a stored ancestor", async () => {
    const threadId = await seedThread({ from: "x@example.com" });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });

    expect(resolved.threadId).toBe(threadId);
    expect(resolved.joinedByHeader).toBe(true);
  });

  it("resolves a reply whose References chain is longer than D1's parameter cap", async () => {
    // Long mailing-list threads carry well over 100 ids. The stored ancestor
    // sits late in the chain, past the first lookup chunk.
    const threadId = await seedThread({ from: "x@example.com" });
    const references = Array.from({ length: 150 }, (_, i) => `<r${i}@list.test>`);
    references[120] = "<parent@example.com>";

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<r149@list.test>",
      references,
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });

    expect(resolved.threadId).toBe(threadId);
    expect(resolved.joinedByHeader).toBe(true);
  });

  it("does not splice into a thread when the sender is not a participant", async () => {
    // Attacker learns a Message-ID and forges In-Reply-To to graft in.
    const threadId = await seedThread({ from: "victim@example.com" });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "attacker@evil.test" }],
      fromAddr: "attacker@evil.test",
    });

    expect(resolved.threadId).not.toBe(threadId);
    expect(resolved.joinedByHeader).toBe(false);
  });

  it("does not splice into a stale thread even for a known participant", async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365); // ~1 year
    const threadId = await seedThread({ from: "x@example.com", lastMsgAt: old });

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });

    expect(resolved.threadId).not.toBe(threadId);
  });

  it("concurrent resolves with the same parent collapse to one thread", async () => {
    const input = {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };

    const [a, b, c] = await Promise.all([
      resolveThreadId(db, input),
      resolveThreadId(db, input),
      resolveThreadId(db, input),
    ]);

    expect(a.threadId).toBe(b.threadId);
    expect(b.threadId).toBe(c.threadId);

    const rows = await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.threadId);
  });

  it("different mailboxes with the same parent get different thread ids", async () => {
    const base = {
      subject: "Re: Hello",
      inReplyTo: "<orphan@example.com>",
      references: ["<orphan@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };

    const a = await resolveThreadId(db, { ...base, mailboxId: MAILBOX_ID });
    const b = await resolveThreadId(db, { ...base, mailboxId: OTHER_MAILBOX_ID });

    expect(a.threadId).not.toBe(b.threadId);
  });

  it("creates a new thread when no headers and no recent subject match", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Other",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(a.threadId).not.toBe(b.threadId);
  });

  it("falls back to the subject window when no headers are present", async () => {
    const a = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    // Store a message so the thread keeps its lastMsgAt fresh.
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId: a.threadId,
      direction: "in",
      fromAddr: "x@example.com",
      subject: "Hello",
    });
    const b = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    });
    expect(b.threadId).toBe(a.threadId);
  });

  // The mailbox's own address is a participant of every thread and a recipient
  // of every inbound message, so it cannot be what ties a message to a thread.
  const OWN = "a@example.com";

  async function seedConversation(): Promise<string> {
    const threadId = crypto.randomUUID();
    await db.insert(thread).values({
      id: threadId,
      mailboxId: MAILBOX_ID,
      subjectNorm: "invoice 4411",
      lastMsgAt: new Date(),
      msgCount: 1,
      participants: [{ address: "alice@example.org" }, { address: OWN }],
    });
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "in",
      messageIdHdr: "<invoice@example.org>",
      fromAddr: "alice@example.org",
      subject: "Invoice 4411",
    });
    return threadId;
  }

  it("does not join on subject when the sender is a stranger to the thread", async () => {
    const threadId = await seedConversation();

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Invoice 4411",
      participants: [{ address: "mallory@evil.test" }, { address: OWN }],
      fromAddr: "mallory@evil.test",
    });

    expect(resolved.threadId).not.toBe(threadId);
    expect(resolved.created).toBe(true);
  });

  it("joins on subject when the sender already takes part in the thread", async () => {
    const threadId = await seedConversation();

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Invoice 4411",
      participants: [{ address: "Alice@Example.org" }, { address: OWN }],
      fromAddr: "Alice@Example.org",
    });

    expect(resolved.threadId).toBe(threadId);
  });

  it("joins our own reply on subject through a shared recipient", async () => {
    const threadId = await seedConversation();

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Invoice 4411",
      participants: [{ address: "alias@example.com" }, { address: "alice@example.org" }],
      fromAddr: "alias@example.com",
      trustHeaders: true,
    });

    expect(resolved.threadId).toBe(threadId);
  });

  it("starts a new thread when told not to join, whatever the headers say", async () => {
    const threadId = await seedConversation();

    const resolved = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Invoice 4411",
      inReplyTo: "<invoice@example.org>",
      references: ["<invoice@example.org>"],
      participants: [{ address: "alice@example.org" }, { address: OWN }],
      fromAddr: "alice@example.org",
      joinExisting: false,
    });

    expect(resolved.threadId).not.toBe(threadId);
    expect(resolved.joinedByHeader).toBe(false);
    expect(resolved.created).toBe(true);

    // A second such message does not land in the first one's thread either.
    const again = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Invoice 4411",
      inReplyTo: "<invoice@example.org>",
      references: ["<invoice@example.org>"],
      participants: [{ address: "alice@example.org" }, { address: OWN }],
      fromAddr: "alice@example.org",
      joinExisting: false,
    });
    expect(again.threadId).not.toBe(resolved.threadId);
  });

  // Resolve a message and store it in the thread it was given.
  async function deliver(input: Parameters<typeof resolveThreadId>[1] & { messageId: string }) {
    const resolved = await resolveThreadId(db, input);
    await db.insert(message).values({
      id: crypto.randomUUID(),
      mailboxId: MAILBOX_ID,
      threadId: resolved.threadId,
      direction: "in",
      messageIdHdr: input.messageId,
      fromAddr: input.fromAddr,
      subject: input.subject,
    });
    return resolved;
  }

  const ROOT = "<root@alice.test>";

  it("files a message with the replies that were stored before it", async () => {
    const reply = await deliver({
      mailboxId: MAILBOX_ID,
      subject: "Re: Plans",
      messageId: "<reply@bob.test>",
      inReplyTo: ROOT,
      references: [ROOT],
      participants: [
        { address: "bob@bob.test" },
        { address: "alice@alice.test" },
        { address: OWN },
      ],
      fromAddr: "bob@bob.test",
    });

    const root = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Plans",
      messageId: ROOT,
      participants: [{ address: "alice@alice.test" }, { address: OWN }],
      fromAddr: "alice@alice.test",
    });

    expect(root.threadId).toBe(reply.threadId);
    expect(root.created).toBe(false);
  });

  it("does not let a stranger join stored replies by reusing the Message-ID they answer", async () => {
    const reply = await deliver({
      mailboxId: MAILBOX_ID,
      subject: "Re: Plans",
      messageId: "<reply@bob.test>",
      inReplyTo: ROOT,
      references: [ROOT],
      participants: [
        { address: "bob@bob.test" },
        { address: "alice@alice.test" },
        { address: OWN },
      ],
      fromAddr: "bob@bob.test",
    });

    const forged = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Plans",
      messageId: ROOT,
      participants: [{ address: "mallory@evil.test" }, { address: OWN }],
      fromAddr: "mallory@evil.test",
    });

    expect(forged.threadId).not.toBe(reply.threadId);
    expect(forged.created).toBe(true);
  });

  it("does not let a stranger's reply into a conversation filed under its root's own key", async () => {
    const root = await deliver({
      mailboxId: MAILBOX_ID,
      subject: "Plans",
      messageId: ROOT,
      participants: [{ address: "alice@alice.test" }, { address: OWN }],
      fromAddr: "alice@alice.test",
    });

    const stranger = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Plans",
      messageId: "<graft@evil.test>",
      inReplyTo: ROOT,
      references: [ROOT],
      participants: [{ address: "mallory@evil.test" }, { address: OWN }],
      fromAddr: "mallory@evil.test",
    });
    expect(stranger.threadId).not.toBe(root.threadId);

    // A participant's reply still joins.
    const alice = await resolveThreadId(db, {
      mailboxId: MAILBOX_ID,
      subject: "Re: Plans",
      messageId: "<again@alice.test>",
      inReplyTo: ROOT,
      references: [ROOT],
      participants: [{ address: "alice@alice.test" }, { address: OWN }],
      fromAddr: "alice@alice.test",
    });
    expect(alice.threadId).toBe(root.threadId);
    expect(alice.joinedByHeader).toBe(true);
  });

  describe("mailing lists", () => {
    const LIST = "dev.lists.test";
    const post = (from: string, listId: string | null) => ({
      mailboxId: MAILBOX_ID,
      subject: "Re: Plans",
      messageId: `<${from}@post.test>`,
      inReplyTo: ROOT,
      references: [ROOT],
      participants: [{ address: from }, { address: "dev@lists.test" }],
      fromAddr: from,
      listId,
    });
    const rootOf = (listId: string | null) => ({
      mailboxId: MAILBOX_ID,
      subject: "Plans",
      messageId: ROOT,
      participants: [{ address: "alice@alice.test" }, { address: "dev@lists.test" }],
      fromAddr: "alice@alice.test",
      listId,
    });

    it("lets a list member who has not written yet join a conversation of the same list", async () => {
      const root = await deliver(rootOf(LIST));
      const reply = await resolveThreadId(db, post("ben@members.test", LIST));
      expect(reply.threadId).toBe(root.threadId);
    });

    it("files a list post with list replies that were stored before it", async () => {
      const reply = await deliver(post("ben@members.test", LIST));
      const root = await resolveThreadId(db, rootOf(LIST));
      expect(root.threadId).toBe(reply.threadId);
    });

    it("does not let a List-Id header into a conversation that is not list mail", async () => {
      const root = await deliver(rootOf(null));
      const forged = await resolveThreadId(db, post("mallory@evil.test", LIST));
      expect(forged.threadId).not.toBe(root.threadId);
    });

    it("does not let a post from another list into the conversation", async () => {
      const root = await deliver(rootOf(LIST));
      const other = await resolveThreadId(db, post("mallory@evil.test", "other.lists.test"));
      expect(other.threadId).not.toBe(root.threadId);
    });

    it("still needs a recent conversation", async () => {
      const root = await deliver(rootOf(LIST));
      const late = await resolveThreadId(db, {
        ...post("ben@members.test", LIST),
        asOf: new Date(Date.now() + 181 * 86_400_000),
      });
      expect(late.threadId).not.toBe(root.threadId);
    });
  });

  it("counts the header window back from an imported message's own date", async () => {
    const lastMsgAt = new Date("2023-03-01T00:00:00Z");
    const threadId = await seedThread({ from: "x@example.com", lastMsgAt });
    const reply = {
      mailboxId: MAILBOX_ID,
      subject: "Re: Hello",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      participants: [{ address: "x@example.com" }],
      fromAddr: "x@example.com",
    };
    const daysAfter = (n: number) => new Date(lastMsgAt.getTime() + n * 86_400_000);

    expect((await resolveThreadId(db, { ...reply, asOf: daysAfter(2) })).threadId).toBe(threadId);
    // Imported history keeps the window: a reply written long after the
    // conversation went quiet does not reopen it.
    expect((await resolveThreadId(db, { ...reply, asOf: daysAfter(181) })).threadId).not.toBe(
      threadId,
    );
  });
});

describe("bumpThread — trash resurfacing", () => {
  async function seedTrashed(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(thread).values({
      id,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt: new Date("2024-01-01T00:00:00Z"),
      msgCount: 1,
      participants: [{ address: "x@example.com" }],
      trashed: true,
      trashedAt: new Date("2024-01-01T00:00:00Z"),
    });
    return id;
  }

  it("resurfaces a trashed thread when untrash is set (live delivery / reply)", async () => {
    const id = await seedTrashed();
    await bumpThread(
      db,
      id,
      new Date("2024-02-02T00:00:00Z"),
      [{ address: "x@example.com" }],
      1,
      true,
    );

    const th = (await db.query.thread.findFirst({ where: eq(thread.id, id) }))!;
    expect(th.trashed).toBe(false);
    expect(th.trashedAt).toBeNull();
    expect(th.msgCount).toBe(2);
    expect(th.unreadCount).toBe(1);
  });

  it("leaves a trashed thread trashed when untrash is not set (import)", async () => {
    const id = await seedTrashed();
    await bumpThread(db, id, new Date("2024-02-02T00:00:00Z"), [{ address: "x@example.com" }], 0);

    const th = (await db.query.thread.findFirst({ where: eq(thread.id, id) }))!;
    expect(th.trashed).toBe(true);
    expect(th.trashedAt).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(th.msgCount).toBe(2);
  });

  it("does not touch trash state on a non-trashed thread", async () => {
    const id = crypto.randomUUID();
    await db.insert(thread).values({
      id,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt: new Date("2024-01-01T00:00:00Z"),
      msgCount: 1,
      participants: [{ address: "x@example.com" }],
    });
    await bumpThread(
      db,
      id,
      new Date("2024-02-02T00:00:00Z"),
      [{ address: "x@example.com" }],
      1,
      true,
    );

    const th = (await db.query.thread.findFirst({ where: eq(thread.id, id) }))!;
    expect(th.trashed).toBe(false);
    expect(th.trashedAt).toBeNull();
  });
});

describe("bumpThread — counters and last activity", () => {
  async function seedThread(msgCount: number, lastMsgAt: Date): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(thread).values({
      id,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt,
      msgCount,
      unreadCount: msgCount,
      participants: [{ address: "x@example.com" }],
    });
    return id;
  }

  const read = async (id: string) =>
    (await db.query.thread.findFirst({ where: eq(thread.id, id) }))!;

  it("loses no update when several bumps run at once", async () => {
    const id = await seedThread(0, new Date());
    const at = new Date("2024-02-02T00:00:00Z");

    await Promise.all(
      ["a", "b", "c", "d"].map((who) =>
        bumpThread(db, id, at, [{ address: `${who}@example.com` }], 1),
      ),
    );

    const th = await read(id);
    expect(th.msgCount).toBe(4);
    expect(th.unreadCount).toBe(4);
  });

  it("never lets the unread count go below zero", async () => {
    const id = await seedThread(0, new Date());
    await bumpThread(db, id, new Date(), [], -1);
    expect((await read(id)).unreadCount).toBe(0);
  });

  it("gives a new thread the time of its first message, even one in the past", async () => {
    const id = await seedThread(0, new Date());
    await bumpThread(db, id, new Date("2024-02-02T00:00:00Z"), [], 0);
    expect((await read(id)).lastMsgAt).toEqual(new Date("2024-02-02T00:00:00Z"));
  });

  it("does not move last activity back when an older message is added", async () => {
    const id = await seedThread(1, new Date("2024-02-02T00:00:00Z"));
    await bumpThread(db, id, new Date("2024-01-01T00:00:00Z"), [], 0);
    expect((await read(id)).lastMsgAt).toEqual(new Date("2024-02-02T00:00:00Z"));

    await bumpThread(db, id, new Date("2024-03-03T00:00:00Z"), [], 0);
    expect((await read(id)).lastMsgAt).toEqual(new Date("2024-03-03T00:00:00Z"));
  });
});

describe("bumpThread — participants", () => {
  async function seedThread(participants: { name?: string; address: string }[]): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(thread).values({
      id,
      mailboxId: MAILBOX_ID,
      subjectNorm: "hello",
      lastMsgAt: new Date(),
      msgCount: 1,
      participants,
    });
    return id;
  }

  const participantsOf = async (id: string) =>
    (await db.query.thread.findFirst({ where: eq(thread.id, id) }))!.participants;

  it("keeps every new sender when several write at once", async () => {
    const id = await seedThread([{ name: "Me", address: "me@example.com" }]);
    const senders = Array.from({ length: 8 }, (_, n) => `sender-${n}@elsewhere.com`);

    await Promise.all(
      senders.map((address) =>
        bumpThread(db, id, new Date(), [{ address }, { address: "me@example.com" }], 1),
      ),
    );

    const stored = await participantsOf(id);
    expect(stored[0]).toEqual({ name: "Me", address: "me@example.com" });
    expect(stored.map((p) => p.address).toSorted()).toEqual(["me@example.com", ...senders]);
  });

  it("adds new addresses after the stored ones, in message order", async () => {
    const id = await seedThread([{ address: "a@example.com" }, { address: "b@example.com" }]);
    await bumpThread(
      db,
      id,
      new Date(),
      [
        { name: "Dee", address: "d@example.com" },
        { address: "b@example.com" },
        { address: "c@example.com" },
      ],
      0,
    );
    expect(await participantsOf(id)).toEqual([
      { address: "a@example.com" },
      { address: "b@example.com" },
      { name: "Dee", address: "d@example.com" },
      { address: "c@example.com" },
    ]);
  });

  it("does not add an address twice, whatever its case or padding", async () => {
    const id = await seedThread([{ name: "Ann", address: "Ann@Example.com" }]);
    await bumpThread(
      db,
      id,
      new Date(),
      [
        { name: "Someone Else", address: " ann@example.COM " },
        { address: "new@example.com" },
        { name: "Again", address: "NEW@example.com" },
      ],
      0,
    );
    expect(await participantsOf(id)).toEqual([
      { name: "Ann", address: "Ann@Example.com" },
      { address: "new@example.com" },
    ]);
  });

  it("leaves the list as it is when the message brings nobody new", async () => {
    const id = await seedThread([{ name: "Ann", address: "ann@example.com" }]);
    await bumpThread(db, id, new Date(), [], 0);
    await bumpThread(db, id, new Date(), [{ address: "ann@example.com" }], 0);
    expect(await participantsOf(id)).toEqual([{ name: "Ann", address: "ann@example.com" }]);
  });
});
