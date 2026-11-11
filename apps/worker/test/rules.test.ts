import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfx-mail/db";
import {
  domain,
  folder,
  label,
  mailbox,
  message,
  messageLabel,
  type RuleAction,
  type RuleCondition,
  redirect,
  rule,
  thread,
  threadFolder,
  user,
} from "@cfx-mail/db/schema";
import { Flag } from "@cfx-mail/shared/flags";
import { createRule } from "@cfx-mail/shared/schemas";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/mail/receive.ts";

const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

let db: ReturnType<typeof makeDB>;

const OWNER_ID = "user-owner";
const DOMAIN_ID = "domain-1";
const MAILBOX_ID = "mailbox-1";
const ADDRESS = "me@example.com";
const LABEL_ID = "label-1";
const FOLDER_ID = "folder-1";
const SENDER = "stranger@elsewhere.com";

async function reset(): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM thread_folder"),
    e.DB.prepare("DELETE FROM message_label"),
    e.DB.prepare("DELETE FROM message"),
    e.DB.prepare("DELETE FROM thread"),
    e.DB.prepare("DELETE FROM rule_send_log"),
    e.DB.prepare("DELETE FROM rule"),
    e.DB.prepare("DELETE FROM label"),
    e.DB.prepare("DELETE FROM folder"),
    e.DB.prepare("DELETE FROM mailbox"),
    e.DB.prepare("DELETE FROM domain"),
    e.DB.prepare("DELETE FROM user"),
  ]);
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
    // Isolate rule behaviour from the spam filter.
    spamFilter: "off",
  });
  await db.insert(label).values({ id: LABEL_ID, mailboxId: MAILBOX_ID, name: "Newsletters" });
  await db.insert(folder).values({ id: FOLDER_ID, userId: OWNER_ID, name: "Archive" });
}

async function addRule(opts: {
  name: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  conditionMode?: "all" | "any";
  priority?: number;
}): Promise<void> {
  await db.insert(rule).values({
    id: `rule-${opts.name}`,
    mailboxId: MAILBOX_ID,
    createdBy: OWNER_ID,
    name: opts.name,
    conditions: opts.conditions,
    conditionMode: opts.conditionMode ?? "all",
    actions: opts.actions,
    priority: opts.priority ?? 0,
  });
}

interface StubMessage extends ForwardableEmailMessage {
  rejected?: string;
}

function stubInbound(opts: { from: string; to: string; raw?: string }): StubMessage {
  const raw =
    opts.raw ??
    [`From: Stranger <${opts.from}>`, `To: Me <${opts.to}>`, `Subject: Hello`, ``, `body`, ``].join(
      "\r\n",
    );
  const stream = new Response(raw).body;
  if (!stream) throw new Error("no stream");
  const stub = {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    raw: stream,
    rawSize: raw.length,
    rejected: undefined as string | undefined,
    setReject(reason: string) {
      this.rejected = reason;
    },
    async forward() {},
    async reply() {},
  };
  return stub as unknown as StubMessage;
}

async function onlyMessage() {
  const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("handleInbound — rules engine", () => {
  it("applies a label when a from-condition matches", async () => {
    await addRule({
      name: "label-news",
      conditions: [{ field: "from", op: "contains", value: "stranger@" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBeUndefined();

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links.map((l) => l.labelId)).toEqual([LABEL_ID]);
  });

  it("still delivers when a label cannot be applied after the message is stored", async () => {
    await addRule({
      name: "label-news",
      conditions: [{ field: "from", op: "contains", value: "stranger@" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });
    // The real D1 binding, failing only the label insert.
    const brokenDb = new Proxy(e.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop !== "prepare") return value.bind(target);
        return (query: string) => {
          if (query.startsWith('insert into "message_label"')) throw new Error("label failed");
          return target.prepare(query);
        };
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, { ...e, DB: brokenDb });

    expect(msg.rejected).toBeUndefined();
    const row = await onlyMessage();
    expect(errors).toHaveBeenCalledWith("inbound_post_store_failed", {
      step: "rule_actions",
      mailboxId: MAILBOX_ID,
      messageId: row.id,
      error: "label failed",
    });
    errors.mockRestore();
  });

  it("forwards a matching message to the rule's address", async () => {
    await addRule({
      name: "forward-all",
      conditions: [{ field: "from", op: "contains", value: "stranger@" }],
      actions: [{ type: "forward", to: "elsewhere@forward.test" }],
    });
    const sent: { to: string }[] = [];
    const env = {
      ...e,
      EMAIL: { send: async (m: { to: string }) => void sent.push(m) },
    } as unknown as Env;

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, env);

    expect(msg.rejected).toBeUndefined();
    await onlyMessage();
    expect(sent.map((m) => m.to)).toEqual(["elsewhere@forward.test"]);
  });

  it("files the thread into the creator's folder on moveFolder", async () => {
    await addRule({
      name: "file-archive",
      conditions: [{ field: "subject", op: "contains", value: "hello" }],
      actions: [{ type: "moveFolder", folderId: FOLDER_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const filed = await db.query.threadFolder.findMany({
      where: eq(threadFolder.threadId, row.threadId),
    });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.userId).toBe(OWNER_ID);
    expect(filed[0]!.folderId).toBe(FOLDER_ID);
  });

  it("marks the message read and keeps the thread unread count at zero", async () => {
    await addRule({
      name: "auto-read",
      conditions: [{ field: "from", op: "endsWith", value: "@elsewhere.com" }],
      actions: [{ type: "markRead" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    expect(row.flags & Flag.SEEN).toBe(Flag.SEEN);
    const th = (await db.query.thread.findMany({ where: eq(thread.id, row.threadId) }))[0]!;
    expect(th.unreadCount).toBe(0);
  });

  it("files to spam on markSpam even for an authenticated new thread", async () => {
    await addRule({
      name: "spam-it",
      conditions: [{ field: "subject", op: "equals", value: "hello" }],
      actions: [{ type: "markSpam" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const th = (await db.query.thread.findMany({ where: eq(thread.id, row.threadId) }))[0]!;
    expect(th.spam).toBe(true);
  });

  it("hard-blocks (SMTP reject) and stores nothing", async () => {
    await addRule({
      name: "block",
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "hardBlock" }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);
    expect(msg.rejected).toBe("Address not found");

    const rows = await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
    expect(rows).toHaveLength(0);
  });

  it("does not act when conditions don't match", async () => {
    await addRule({
      name: "no-match",
      conditions: [{ field: "from", op: "contains", value: "nope@nowhere" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });

  it("requires all conditions in 'all' mode", async () => {
    await addRule({
      name: "all-mode",
      conditionMode: "all",
      conditions: [
        { field: "from", op: "contains", value: "stranger" },
        { field: "subject", op: "contains", value: "invoice" },
      ],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS }); // subject "Hello", no "invoice"
    await handleInbound(msg, e);

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });

  it("matches a regex condition as the rule schema accepted it, ignoring case", async () => {
    const { conditions } = createRule.parse({
      mailboxId: MAILBOX_ID,
      name: "label-regex",
      conditions: [{ field: "subject", op: "regex", value: "^h[ae]llo$" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });
    await addRule({
      name: "label-regex",
      conditions,
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    await handleInbound(stubInbound({ from: SENDER, to: ADDRESS }), e);

    const row = await onlyMessage();
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links.map((l) => l.labelId)).toEqual([LABEL_ID]);
  });

  it("delivers past a stored regex that does not compile, matching nothing", async () => {
    // Saved before the schema checked patterns.
    await addRule({
      name: "label-broken",
      conditions: [{ field: "subject", op: "regex", value: "h(ello" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    expect(msg.rejected).toBeUndefined();
    const row = await onlyMessage();
    expect(
      await db.query.messageLabel.findMany({ where: eq(messageLabel.messageId, row.id) }),
    ).toEqual([]);
  });

  it("stops at a stopProcessing rule before lower-priority rules run", async () => {
    await addRule({
      name: "first-stop",
      priority: 0,
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "markRead" }, { type: "stopProcessing" }],
    });
    await addRule({
      name: "second-label",
      priority: 1,
      conditions: [{ field: "from", op: "contains", value: "stranger" }],
      actions: [{ type: "applyLabel", labelId: LABEL_ID }],
    });

    const msg = stubInbound({ from: SENDER, to: ADDRESS });
    await handleInbound(msg, e);

    const row = await onlyMessage();
    expect(row.flags & Flag.SEEN).toBe(Flag.SEEN);
    const links = await db.query.messageLabel.findMany({
      where: eq(messageLabel.messageId, row.id),
    });
    expect(links).toHaveLength(0);
  });
});

describe("handleInbound — rule sends answer and relay only wanted mail", () => {
  const PASS = "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass";
  const FAIL = "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail";
  const ANY_SENDER: RuleCondition[] = [{ field: "from", op: "contains", value: "@" }];

  interface Sent {
    from: string;
    to: string;
    raw: string;
  }

  // The EMAIL binding has no local simulation, so collect what would be sent.
  // EmailMessage has no public accessor for its MIME; this key is where the
  // test runtime (Miniflare) keeps it.
  const RAW = "EmailMessage::raw";
  function capture(): { mailEnv: Env; sent: Sent[] } {
    const sent: Sent[] = [];
    const email = {
      send: async (m: { from: string; to: string; [RAW]: ReadableStream | string }) => {
        sent.push({ from: m.from, to: m.to, raw: await new Response(m[RAW]).text() });
      },
    };
    return { mailEnv: { ...e, EMAIL: email } as unknown as Env, sent };
  }

  function eml(opts: { auth?: string; headers?: string[] } = {}): string {
    return [
      ...(opts.auth ? [`Authentication-Results: ${opts.auth}`] : []),
      `From: Stranger <${SENDER}>`,
      `To: Me <${ADDRESS}>`,
      `Subject: Hello`,
      `Message-ID: <hello@elsewhere.com>`,
      ...(opts.headers ?? []),
      ``,
      `body`,
      ``,
    ].join("\r\n");
  }

  async function filter(level: "off" | "standard"): Promise<void> {
    await db.update(mailbox).set({ spamFilter: level }).where(eq(mailbox.id, MAILBOX_ID));
  }

  async function deliver(mailEnv: Env, raw: string, to = ADDRESS): Promise<void> {
    const msg = stubInbound({ from: SENDER, to, raw });
    await handleInbound(msg, mailEnv);
    expect(msg.rejected).toBeUndefined();
  }

  it("auto-replies to authenticated mail that is not spam", async () => {
    await filter("standard");
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ auth: PASS }));

    expect((await onlyMessage()).spamVerdict).toBe("clean");
    expect(sent.map((m) => m.to)).toEqual([SENDER]);
  });

  it("does not auto-reply to unauthenticated mail filed as spam", async () => {
    await filter("standard");
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ auth: FAIL }));

    expect((await onlyMessage()).spamVerdict).toBe("spam");
    expect(sent).toEqual([]);
  });

  // The spam filter decides what is filed as spam. Whether the sender is who
  // they claim is read from the receiving server's verdict either way.
  it("auto-replies to an authenticated sender with the spam filter off", async () => {
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ auth: PASS }));

    await onlyMessage();
    expect(sent.map((m) => m.to)).toEqual([SENDER]);
  });

  it("does not auto-reply to a sender that failed the check, with the spam filter off", async () => {
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ auth: FAIL }));

    await onlyMessage();
    expect(sent).toEqual([]);
  });

  it("does not forward mail filed as spam by the filter", async () => {
    await filter("standard");
    await addRule({
      name: "relay",
      conditions: ANY_SENDER,
      actions: [{ type: "forward", to: "elsewhere@forward.test" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ auth: FAIL }));

    expect((await onlyMessage()).spamVerdict).toBe("spam");
    expect(sent).toEqual([]);
  });

  it("does not forward mail a rule marks as spam", async () => {
    await addRule({
      name: "junk-and-relay",
      conditions: ANY_SENDER,
      actions: [{ type: "markSpam" }, { type: "forward", to: "elsewhere@forward.test" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml());

    await onlyMessage();
    expect(sent).toEqual([]);
  });

  it("stamps a forward with X-Loop, keeping the hops already on the message", async () => {
    await addRule({
      name: "relay",
      conditions: ANY_SENDER,
      actions: [{ type: "forward", to: "elsewhere@forward.test" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ headers: ["X-Loop: first@hop.test", "X-Loop: second@hop.test"] }));

    expect(sent.map((m) => m.to)).toEqual(["elsewhere@forward.test"]);
    expect(sent[0]!.raw).toMatch(
      /^X-Loop: me@example\.com, first@hop\.test, second@hop\.test\r?$/m,
    );
  });

  it("stores but does not forward a message that already passed through this mailbox", async () => {
    await addRule({
      name: "relay",
      conditions: ANY_SENDER,
      actions: [{ type: "forward", to: "elsewhere@forward.test" }],
    });
    const { mailEnv, sent } = capture();

    await deliver(mailEnv, eml({ headers: ["X-Loop: other@hop.test, ME@example.com"] }));

    await onlyMessage();
    expect(sent).toEqual([]);
  });

  describe("mail that arrives through an alias", () => {
    // An alias on the mailbox's own domain, and a catch-all on another domain.
    beforeEach(async () => {
      await db.insert(domain).values({ id: "domain-2", name: "other.test" });
      await db.insert(redirect).values([
        { id: "redirect-1", domainId: DOMAIN_ID, localPart: "alias", targetMailboxId: MAILBOX_ID },
        { id: "redirect-2", domainId: "domain-2", localPart: "*", targetMailboxId: MAILBOX_ID },
      ]);
    });

    it.each(["alias@example.com", "anyone@other.test"])(
      "forwards mail for %s from the mailbox's own address",
      async (to) => {
        await addRule({
          name: "relay",
          conditions: ANY_SENDER,
          actions: [{ type: "forward", to: "elsewhere@forward.test" }],
        });
        const { mailEnv, sent } = capture();

        await deliver(mailEnv, eml({ headers: ["X-Loop: first@hop.test"] }), to);

        expect((await onlyMessage()).deliveredTo).toBe(to);
        expect(sent.map((m) => [m.from, m.to])).toEqual([[ADDRESS, "elsewhere@forward.test"]]);
        expect(sent[0]!.raw).toMatch(/^From: <me@example\.com>\r?$/m);
        expect(sent[0]!.raw).toMatch(/^X-Loop: me@example\.com, first@hop\.test\r?$/m);
        expect(sent[0]!.raw).toMatch(/^Message-ID: <[^@>]+@example\.com>\r?$/m);
      },
    );

    it("auto-replies from the mailbox's own address", async () => {
      await filter("standard");
      await addRule({
        name: "away",
        conditions: ANY_SENDER,
        actions: [{ type: "autoReply", body: "I am away" }],
      });
      const { mailEnv, sent } = capture();

      await deliver(mailEnv, eml({ auth: PASS }), "alias@example.com");

      expect((await onlyMessage()).spamVerdict).toBe("clean");
      expect(sent.map((m) => [m.from, m.to])).toEqual([[ADDRESS, SENDER]]);
      expect(sent[0]!.raw).toMatch(/^From: <me@example\.com>\r?$/m);
    });

    it("does not forward a message that already passed through the mailbox", async () => {
      await addRule({
        name: "relay",
        conditions: ANY_SENDER,
        actions: [{ type: "forward", to: "elsewhere@forward.test" }],
      });
      const { mailEnv, sent } = capture();

      await deliver(mailEnv, eml({ headers: ["X-Loop: me@example.com"] }), "alias@example.com");

      await onlyMessage();
      expect(sent).toEqual([]);
    });

    it("keeps the base address for plus-addressed mail to the mailbox itself", async () => {
      await addRule({
        name: "relay",
        conditions: ANY_SENDER,
        actions: [{ type: "forward", to: "elsewhere@forward.test" }],
      });
      const { mailEnv, sent } = capture();

      await deliver(mailEnv, eml(), "me+tag@example.com");

      expect(sent.map((m) => m.from)).toEqual([ADDRESS]);
      expect(sent[0]!.raw).toMatch(/^X-Loop: me@example\.com\r?$/m);
    });
  });

  it("logs a forward the platform refuses, without the recipient", async () => {
    await addRule({
      name: "relay",
      conditions: ANY_SENDER,
      actions: [{ type: "forward", to: "elsewhere@forward.test" }],
    });
    const refusing = {
      ...e,
      EMAIL: { send: () => Promise.reject(new Error("quota exceeded")) },
    } as unknown as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await deliver(refusing, eml());

    await onlyMessage();
    expect(errors.mock.calls).toEqual([
      [
        "rule_send_failed",
        { mailboxId: MAILBOX_ID, ruleId: "rule-relay", error: "quota exceeded" },
      ],
    ]);
    errors.mockRestore();
  });

  // The rule_send_log row is the auto-reply throttle (one per sender per four
  // days) and the hourly cap's count. A send it does not record would go out
  // again on the next message, so a send that cannot be recorded is not made.
  it("does not auto-reply when the throttle cannot be recorded, and logs why", async () => {
    await filter("standard");
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const { mailEnv, sent } = capture();
    const unrecorded = {
      ...mailEnv,
      DB: new Proxy(e.DB, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (prop !== "prepare") return value.bind(target);
          return (query: string) => {
            if (query.startsWith('insert into "rule_send_log"')) throw new Error("log failed");
            return target.prepare(query);
          };
        },
      }),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await deliver(unrecorded, eml({ auth: PASS }));

    await onlyMessage();
    expect(sent).toEqual([]);
    expect(errors.mock.calls).toEqual([
      [
        "rule_send_log_failed",
        { mailboxId: MAILBOX_ID, ruleId: "rule-away", kind: "autoReply", error: "log failed" },
      ],
    ]);
    errors.mockRestore();
  });

  it("answers a sender once, and again after a refused auto-reply", async () => {
    await filter("standard");
    await addRule({
      name: "away",
      conditions: ANY_SENDER,
      actions: [{ type: "autoReply", body: "I am away" }],
    });
    const refusing = {
      ...e,
      EMAIL: { send: () => Promise.reject(new Error("quota exceeded")) },
    } as unknown as Env;
    const { mailEnv, sent } = capture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // Each copy goes to its own address, so none is a retry of another.
    await deliver(refusing, eml({ auth: PASS }), "me+1@example.com");
    await deliver(mailEnv, eml({ auth: PASS }), "me+2@example.com");
    await deliver(mailEnv, eml({ auth: PASS }), "me+3@example.com");

    expect(sent.map((m) => m.to)).toEqual([SENDER]);
    expect(await db.query.ruleSendLog.findMany()).toHaveLength(1);
    errors.mockRestore();
  });
});
