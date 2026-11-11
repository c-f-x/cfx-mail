import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { attachment, domain, mailbox, message, thread, user } from "@cfmail/db/schema";
import { Flag } from "@cfmail/shared/flags";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { ingestRaw, isAuthenticated } from "../src/mail/ingest.ts";
import type { SpamEvaluation } from "../src/mail/spam.ts";

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
  });
}

function eml(
  opts: {
    from?: string;
    to?: string;
    subject?: string;
    messageId?: string;
    body?: string;
    headers?: string[];
  } = {},
): ArrayBuffer {
  const lines = [
    `From: ${opts.from ?? `Sender <sender@elsewhere.com>`}`,
    `To: ${opts.to ?? `Me <${ADDRESS}>`}`,
    `Subject: ${opts.subject ?? "Imported"}`,
  ];
  if (opts.messageId) lines.push(`Message-ID: ${opts.messageId}`);
  if (opts.headers) lines.push(...opts.headers);
  lines.push("", opts.body ?? "Hello from an import.", "");
  return new TextEncoder().encode(lines.join("\r\n")).buffer as ArrayBuffer;
}

// Defaults matching the import endpoint: no spam evaluation, explicit direction.
function importOpts(over: Partial<Parameters<typeof ingestRaw>[2]> = {}) {
  return {
    mailboxId: MAILBOX_ID,
    raw: eml(),
    direction: "in" as const,
    deliveredTo: null,
    flags: 0,
    receivedAt: new Date("2024-01-02T03:04:05Z"),
    sentAt: null,
    spam: null as SpamEvaluation | null,
    ...over,
  };
}

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  db = makeDB(e.DB);
});

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ingestRaw — inbound import", () => {
  it("stores an inbound message, archives the raw blob, and bumps the thread", async () => {
    const res = await ingestRaw(e, db, importOpts());
    expect(res.isNewThread).toBe(true);

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.direction).toBe("in");
    expect(row.subject).toBe("Imported");
    expect(row.fromAddr).toBe("sender@elsewhere.com");
    expect(row.receivedAt).toEqual(new Date("2024-01-02T03:04:05Z"));
    expect(row.sentAt).toBeNull();
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/[0-9a-f-]+\\.eml$`));

    const blob = await e.BLOBS.get(row.rawR2Key!);
    expect(blob).not.toBeNull();
    expect(blob!.httpMetadata?.contentType).toBe("message/rfc822");

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.msgCount).toBe(1);
    expect(th.lastMsgAt).toEqual(new Date("2024-01-02T03:04:05Z"));
  });

  it("splits a comma-separated References header and keeps one In-Reply-To id", async () => {
    await ingestRaw(
      e,
      db,
      importOpts({
        raw: eml({
          messageId: "<child@elsewhere.com>",
          headers: [
            "References: <root@example.com>,<mid@outlook.com>",
            "In-Reply-To: Sender <mid@outlook.com>",
          ],
        }),
      }),
    );

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.references).toEqual(["<root@example.com>", "<mid@outlook.com>"]);
    expect(row.inReplyTo).toBe("<mid@outlook.com>");
  });

  it("counts an unseen inbound message as unread", async () => {
    await ingestRaw(e, db, importOpts({ flags: 0 }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(1);
  });

  it("does not count a SEEN inbound message as unread", async () => {
    await ingestRaw(e, db, importOpts({ flags: Flag.SEEN }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(0);
  });
});

describe("ingestRaw — outbound import", () => {
  it("stores an outbound message with sentAt and never bumps unread", async () => {
    await ingestRaw(
      e,
      db,
      importOpts({
        raw: eml({ from: `Me <${ADDRESS}>`, to: "Friend <friend@elsewhere.com>" }),
        direction: "out",
        receivedAt: null,
        sentAt: new Date("2024-05-06T07:08:09Z"),
      }),
    );

    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.direction).toBe("out");
    expect(row.sentAt).toEqual(new Date("2024-05-06T07:08:09Z"));
    expect(row.receivedAt).toBeNull();

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.unreadCount).toBe(0);
    expect(th.lastMsgAt).toEqual(new Date("2024-05-06T07:08:09Z"));
  });
});

describe("ingestRaw — spam=null (import never files or scores)", () => {
  it("leaves all spam fields null and never auto-files to Spam", async () => {
    await ingestRaw(e, db, importOpts({ spam: null }));
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBeNull();
    expect(row.spamScore).toBeNull();
    expect(row.spamReasons).toBeNull();
    expect(row.spamAuth).toBeNull();

    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(false);
  });

  it("auto-files a brand-new thread when spam.folderSpam is set", async () => {
    const spam: SpamEvaluation = {
      verdict: "spam",
      score: 9,
      reasons: ["dmarc=fail"],
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
      folderSpam: true,
      reject: null,
    };
    await ingestRaw(e, db, importOpts({ spam }));
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.spam).toBe(true);
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    expect(row.spamVerdict).toBe("spam");
  });
});

describe("ingestRaw — attachments", () => {
  const RAW = [
    `From: Sender <sender@elsewhere.com>`,
    `To: Me <${ADDRESS}>`,
    `Subject: With attachment`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="B"`,
    ``,
    `--B`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body`,
    `--B`,
    `Content-Type: application/pdf; name="weird name!.pdf"`,
    `Content-Disposition: attachment; filename="weird name!.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    `aGVsbG8=`,
    `--B--`,
    ``,
  ].join("\r\n");

  it("stores attachments to R2 with a sanitized filename in the key", async () => {
    await ingestRaw(
      e,
      db,
      importOpts({ raw: new TextEncoder().encode(RAW).buffer as ArrayBuffer }),
    );
    const row = (await db.query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) }))[0]!;
    const atts = await db.query.attachment.findMany({ where: eq(attachment.messageId, row.id) });
    expect(atts).toHaveLength(1);
    const att = atts[0]!;
    expect(att.filename).toBe("weird name!.pdf"); // original kept on the row
    expect(att.r2Key).toBe(`att/${row.id}/0-weird_name_.pdf`); // sanitized in the key
    expect(await (await e.BLOBS.get(att.r2Key))!.text()).toBe("hello");
  });
});

describe("ingestRaw — trashed thread resurfacing", () => {
  // Ingest two messages that thread together via the subject window. Recent
  // dates keep the thread inside the 7-day window so the second joins it.
  const now = new Date();

  async function trashThe(threadId: string): Promise<void> {
    await db
      .update(thread)
      .set({ trashed: true, trashedAt: new Date() })
      .where(eq(thread.id, threadId));
  }

  it("a live inbound reply pulls a trashed thread back out of the trash", async () => {
    const first = await ingestRaw(
      e,
      db,
      importOpts({ raw: eml({ subject: "Project sync" }), receivedAt: now, live: true }),
    );
    await trashThe(first.threadId);

    const second = await ingestRaw(
      e,
      db,
      importOpts({ raw: eml({ subject: "Re: Project sync" }), receivedAt: now, live: true }),
    );
    expect(second.threadId).toBe(first.threadId);
    expect(second.isNewThread).toBe(false);

    const th = (await db.query.thread.findFirst({ where: eq(thread.id, first.threadId) }))!;
    expect(th.trashed).toBe(false);
    expect(th.trashedAt).toBeNull();
  });

  it("a historical import does not resurrect a trashed thread", async () => {
    const first = await ingestRaw(
      e,
      db,
      importOpts({ raw: eml({ subject: "Project sync" }), receivedAt: now, live: true }),
    );
    await trashThe(first.threadId);

    const second = await ingestRaw(
      e,
      db,
      importOpts({ raw: eml({ subject: "Re: Project sync" }), receivedAt: now }),
    );
    expect(second.threadId).toBe(first.threadId);

    const th = (await db.query.thread.findFirst({ where: eq(thread.id, first.threadId) }))!;
    expect(th.trashed).toBe(true);
  });
});

describe("ingestRaw — threading an imported conversation", () => {
  // Alice writes to the mailbox and Bob, Bob answers, Alice answers him, and
  // the owner closes it. Each entry carries the headers a mail client writes.
  interface Mail {
    id: string;
    from: string;
    to: string;
    cc?: string;
    parents: string[];
    hoursIn: number;
  }
  const CONVERSATION: Mail[] = [
    {
      id: "<p@alice.test>",
      from: "Alice <alice@alice.test>",
      to: `Me <${ADDRESS}>`,
      cc: "bob@bob.test",
      parents: [],
      hoursIn: 0,
    },
    {
      id: "<r1@bob.test>",
      from: "Bob <bob@bob.test>",
      to: "alice@alice.test",
      cc: ADDRESS,
      parents: ["<p@alice.test>"],
      hoursIn: 1,
    },
    {
      id: "<r2@alice.test>",
      from: "Alice <alice@alice.test>",
      to: "bob@bob.test",
      cc: ADDRESS,
      parents: ["<p@alice.test>", "<r1@bob.test>"],
      hoursIn: 2,
    },
    {
      id: "<r3@example.com>",
      from: `Me <${ADDRESS}>`,
      to: "alice@alice.test, bob@bob.test",
      parents: ["<p@alice.test>", "<r1@bob.test>", "<r2@alice.test>"],
      hoursIn: 3,
    },
  ];

  // What the import endpoint passes for one exported message: its own date,
  // its direction from the From address, read, no spam evaluation, not live.
  function importOf(m: Mail, start: Date) {
    const when = new Date(start.getTime() + m.hoursIn * 3_600_000);
    const out = m.from.includes(ADDRESS);
    const headers = [`Date: ${when.toUTCString()}`];
    if (m.cc) headers.push(`Cc: ${m.cc}`);
    if (m.parents.length) {
      headers.push(`In-Reply-To: ${m.parents.at(-1)}`, `References: ${m.parents.join(" ")}`);
    }
    return importOpts({
      raw: eml({ from: m.from, to: m.to, subject: "Quarterly figures", messageId: m.id, headers }),
      direction: out ? "out" : "in",
      deliveredTo: out ? null : ADDRESS,
      flags: out ? Flag.SENT | Flag.SEEN : Flag.SEEN,
      receivedAt: out ? null : when,
      sentAt: out ? when : null,
    });
  }

  const RECENT = new Date(Date.now() - 3 * 86_400_000);
  // Well past the 180 days a header match is honoured for live mail.
  const OLD = new Date("2023-03-01T09:00:00Z");

  async function threadIds(): Promise<string[]> {
    const rows = await db.query.message.findMany({
      where: eq(message.mailboxId, MAILBOX_ID),
      columns: { threadId: true },
    });
    return [...new Set(rows.map((r) => r.threadId))];
  }

  it("files a parent imported after its reply in the reply's conversation", async () => {
    const [parent, reply] = CONVERSATION;
    await ingestRaw(e, db, importOf(reply!, RECENT));
    await ingestRaw(e, db, importOf(parent!, RECENT));

    expect(await threadIds()).toHaveLength(1);
  });

  it("keeps replies to mail older than 180 days with the mail they answer", async () => {
    for (const m of CONVERSATION) {
      // eslint-disable-next-line no-await-in-loop -- one at a time, in order, is the case
      await ingestRaw(e, db, importOf(m, OLD));
    }

    expect(await threadIds()).toHaveLength(1);
    const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
    expect(th.msgCount).toBe(CONVERSATION.length);
  });

  // The web importer sends 25 messages at once, so a reply is often stored
  // while, or before, the message it answers.
  it.each([
    ["a recent", "in order", RECENT, CONVERSATION],
    ["a recent", "newest first", RECENT, CONVERSATION.toReversed()],
    ["an old", "in order", OLD, CONVERSATION],
    ["an old", "newest first", OLD, CONVERSATION.toReversed()],
  ])(
    "keeps %s conversation together when imported in parallel, %s",
    async (_, __, start, mails) => {
      await Promise.all(mails.map((m) => ingestRaw(e, db, importOf(m, start))));

      expect(await threadIds()).toHaveLength(1);
      const th = (await db.query.thread.findMany({ where: eq(thread.mailboxId, MAILBOX_ID) }))[0]!;
      expect(th.msgCount).toBe(CONVERSATION.length);
    },
  );
});

describe("ingestRaw — threading a mailing-list conversation", () => {
  // On a list, each post comes from whoever writes next, addressed to the
  // list. Most posters have not written in the conversation before.
  const LIST = "dev.lists.test";
  const POSTS = ["ana", "ben", "cai", "dee"].map((name, i) => ({
    id: `<post${i}@lists.test>`,
    from: `${name}@members.test`,
    parents: Array.from({ length: i }, (_, j) => `<post${j}@lists.test>`),
  }));

  function postOf(p: (typeof POSTS)[number], live = false) {
    const headers = [`List-Id: Dev list <${LIST}>`, `Delivered-To: ${ADDRESS}`];
    if (p.parents.length) {
      headers.push(`In-Reply-To: ${p.parents.at(-1)}`, `References: ${p.parents.join(" ")}`);
    }
    return importOpts({
      raw: eml({
        from: p.from,
        to: `dev@lists.test`,
        subject: "Release plan",
        messageId: p.id,
        headers,
      }),
      deliveredTo: ADDRESS,
      receivedAt: new Date(),
      ...(live ? { live: true } : {}),
    });
  }

  async function threadCount(): Promise<number> {
    const rows = await db.query.message.findMany({
      where: eq(message.mailboxId, MAILBOX_ID),
      columns: { threadId: true },
    });
    return new Set(rows.map((r) => r.threadId)).size;
  }

  it.each([
    ["imported in order", POSTS, false],
    ["imported newest first", POSTS.toReversed(), false],
    ["delivered live in order", POSTS, true],
  ])("keeps posts from new members together when %s", async (_, posts, live) => {
    for (const p of posts) {
      // eslint-disable-next-line no-await-in-loop -- the order is the case
      await ingestRaw(e, db, postOf(p, live));
    }
    expect(await threadCount()).toBe(1);
  });

  it("keeps posts from new members together when imported in parallel", async () => {
    await Promise.all(POSTS.map((p) => ingestRaw(e, db, postOf(p))));
    expect(await threadCount()).toBe(1);
  });
});

describe("isAuthenticated", () => {
  it("trusts DMARC pass alone", () => {
    expect(isAuthenticated({ spf: "fail", dkim: "fail", dmarc: "pass" })).toBe(true);
  });

  it("trusts SPF+DKIM pass without DMARC", () => {
    expect(isAuthenticated({ spf: "pass", dkim: "pass", dmarc: "none" })).toBe(true);
  });

  it("does not trust SPF-only or DKIM-only", () => {
    expect(isAuthenticated({ spf: "pass", dkim: "fail", dmarc: "none" })).toBe(false);
    expect(isAuthenticated({ spf: "fail", dkim: "pass", dmarc: "none" })).toBe(false);
  });
});
