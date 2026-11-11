import { makeDB } from "@cfmail/db";
import { domain, mailbox, message, thread } from "@cfmail/db/schema";
import type { SendMessageInput } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { runCron } from "../../src/cron.ts";
import type { Env } from "../../src/env.ts";
import { handleInbound } from "../../src/mail/receive.ts";
import { sendFromMailbox } from "../../src/mail/send.ts";
import { applyMigrationsOnce, db, e, resetDb } from "../support/app.ts";
import { countingD1, type StatementCount } from "../support/count-statements.ts";
import { runCronOffline } from "../support/cron.ts";
import { call, createUser, type Jar, signIn } from "../support/session.ts";

// DATABASE STATEMENT BUDGETS
//
// How many SQL statements one request or job sends to D1. Each is counted
// exactly by wrapping `env.DB` (support/count-statements.ts), so the numbers
// are the same on every run and on every machine. A statement inside a batch
// counts as one statement.
//
// HTTP routes run through the real app (`buildApi()`) with a real signed-in
// session, so the session statements are counted too. In these tests
// AUTH_SECRET is not set, so every request first reads the session-signing
// secret from system_config; production with the secret set sends one
// statement fewer.
//
// Each limit is the count measured on 2026-10-09 (master at 1e89edd) plus
// about 10 percent, and at least one statement. The measured count is written
// next to the limit so a reviewer sees the headroom.
//
// A failure lists the SQL that ran. If the growth is intended, raise the limit
// below and say why in the commit.

const FILE = "apps/worker/test/budgets/statements.test.ts";
const PASSWORD = "correct-horse-battery";
const app = buildApi();

interface World {
  jar: Jar;
  userId: string;
  /** Three mailboxes owned by the signed-in user. */
  mailboxIds: [string, string, string];
}

const A = "mailbox-a";
const B = "mailbox-b";
const C = "mailbox-c";
const THREADS_PER_MAILBOX = 55; // more than one page of 50

const RAW_EML = [
  "From: Sender <sender@elsewhere.test>",
  "To: Owner <a@example.com>",
  "Subject: Quarterly report",
  "Message-ID: <body-fixture@elsewhere.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello, here are the notes from today.",
  "",
].join("\r\n");

// A signed-in owner of three mailboxes with 55 threads each (more than one page
// of 50). Five of mailbox A's threads are about an invoice, for the search.
async function seedWorld(): Promise<World> {
  const userId = await createUser("owner@example.com", PASSWORD);
  const { jar } = await signIn(app, "owner@example.com", PASSWORD);
  const d = db();
  await d.insert(domain).values({ id: "domain-1", name: "example.com", lastCheckedAt: new Date() });
  await d.batch([
    d
      .insert(mailbox)
      .values({ id: A, domainId: "domain-1", localPart: "a", type: "group", ownerUserId: userId }),
    d
      .insert(mailbox)
      .values({ id: B, domainId: "domain-1", localPart: "b", type: "group", ownerUserId: userId }),
    d
      .insert(mailbox)
      .values({ id: C, domainId: "domain-1", localPart: "c", type: "group", ownerUserId: userId }),
  ]);
  const base = Math.floor(Date.now() / 1000) - 100_000;
  for (const mb of [A, B, C]) {
    const rows = Array.from({ length: THREADS_PER_MAILBOX }, (_, i) => {
      const id = `${mb}-t${i}`;
      const at = new Date((base + i * 60) * 1000);
      const subject = mb === A && i < 5 ? `Invoice ${i}` : `Quarterly report ${i}`;
      return [
        d.insert(thread).values({
          id,
          mailboxId: mb,
          subjectNorm: subject.toLowerCase(),
          lastMsgAt: at,
          msgCount: 1,
          unreadCount: 1,
        }),
        d.insert(message).values({
          id: `${id}-m`,
          mailboxId: mb,
          threadId: id,
          direction: "in",
          fromAddr: "sender@elsewhere.test",
          fromName: "Sender",
          subject,
          snippet: "Hello there",
          receivedAt: at,
        }),
      ] as const;
    }).flat();
    // eslint-disable-next-line no-await-in-loop -- three mailboxes, one after another
    await d.batch(rows as unknown as [(typeof rows)[number], ...(typeof rows)[number][]]);
  }
  return { jar, userId, mailboxIds: [A, B, C] };
}

const conversationAt = (i: number) => new Date((Math.floor(Date.now() / 1000) - 50_000 + i) * 1000);

// A thread of `n` messages in mailbox A, each with a stored body.
async function seedConversation(n: number): Promise<{ threadId: string; messageIds: string[] }> {
  const d = db();
  const threadId = `conv-${n}`;
  const messageIds = Array.from({ length: n }, (_, i) => `${threadId}-m${i}`);
  await d.insert(thread).values({
    id: threadId,
    mailboxId: A,
    subjectNorm: "conversation",
    lastMsgAt: conversationAt(n),
    msgCount: n,
  });
  const rows = messageIds.map((id, i) =>
    d.insert(message).values({
      id,
      mailboxId: A,
      threadId,
      direction: i % 2 === 0 ? "in" : "out",
      fromAddr: i % 2 === 0 ? "sender@elsewhere.test" : "a@example.com",
      subject: "Conversation",
      snippet: "Hello there",
      receivedAt: conversationAt(i),
      createdAt: conversationAt(i),
      rawR2Key: `raw/${A}/${id}.eml`,
    }),
  );
  await d.batch(rows as unknown as [(typeof rows)[number], ...(typeof rows)[number][]]);
  await Promise.all(messageIds.map((id) => e.BLOBS.put(`raw/${A}/${id}.eml`, RAW_EML)));
  return { threadId, messageIds };
}

// One GET through the real app, counted. The body is read so lazy work finishes.
async function get(w: World, path: string): Promise<StatementCount> {
  const { d1, count } = countingD1(e.DB);
  const res = await call(app, w.jar, "GET", path, undefined, { ...e, DB: d1 } as Env);
  expect(res.status, `GET ${path}`).toBe(200);
  await res.arrayBuffer();
  return count;
}

function emailBinding(): Env["EMAIL"] {
  return { send: async () => ({ messageId: "platform-mid" }) } as unknown as Env["EMAIL"];
}

// A message as the Cloudflare email handler receives it.
function inboundMail(id: string, refs: string[] = []): ForwardableEmailMessage {
  const raw = [
    "From: Sender <sender@elsewhere.test>",
    "To: Owner <a@example.com>",
    `Subject: ${refs.length ? "Re: " : ""}Planning notes`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    ...(refs.length
      ? [`In-Reply-To: <${refs.at(-1)}>`, `References: ${refs.map((r) => `<${r}>`).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello, here are the notes from today.",
    "",
  ].join("\r\n");
  return {
    from: "sender@elsewhere.test",
    to: "a@example.com",
    headers: new Headers(),
    raw: new Response(raw).body!,
    rawSize: raw.length,
    setReject(reason: string) {
      throw new Error(`rejected: ${reason}`);
    },
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

// Delivers one message and waits for the work it defers, like the runtime does.
async function deliver(msg: ForwardableEmailMessage, env: Env): Promise<void> {
  const deferred: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void deferred.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  await handleInbound(msg, env, ctx);
  await Promise.all(deferred);
}

// ---------------------------------------------------------------------------
// The budgets. Each `measure` returns the statements one call sent.

const openThread = (n: number) => async (w: World) => {
  const { threadId } = await seedConversation(n);
  return get(w, `/api/threads/${threadId}`);
};

const messageBody = async (w: World) => {
  const { messageIds } = await seedConversation(1);
  return get(w, `/api/messages/${messageIds[0]}/body`);
};

// The web app opens a conversation with one thread request and then fetches
// the bodies of the messages on screen in one more (message-card.tsx through
// lib/body-batcher.ts). This is the cost of that for 10 messages.
const openThreadLikeTheWebApp = async (w: World) => {
  const { threadId, messageIds } = await seedConversation(10);
  const total: StatementCount = { statements: 0, sql: [] };
  for (const path of [`/api/threads/${threadId}`, bodiesPath(threadId, messageIds)]) {
    // eslint-disable-next-line no-await-in-loop -- requests run one after another, as the count assumes
    const part = await get(w, path);
    total.statements += part.statements;
    total.sql.push(...part.sql);
  }
  return total;
};

const bodiesPath = (threadId: string, messageIds: string[]) =>
  `/api/threads/${threadId}/bodies?ids=${messageIds.join(",")}`;

const threadBodies = (n: number) => async (w: World) => {
  const { threadId, messageIds } = await seedConversation(n);
  return get(w, bodiesPath(threadId, messageIds));
};

const send = async (w: World) => {
  const { d1, count } = countingD1(e.DB);
  const env = { ...e, DB: d1, EMAIL: emailBinding() } as Env;
  const input = {
    mailboxId: A,
    to: [{ address: "recipient@elsewhere.test" }],
    subject: "Greetings",
    text: "hello there",
  } as SendMessageInput;
  await sendFromMailbox(env, makeDB(d1), w.userId, input);
  return count;
};

const inboundPlain = async () => {
  const { d1, count } = countingD1(e.DB);
  await deliver(inboundMail("plain@elsewhere.test"), { ...e, DB: d1 } as Env);
  return count;
};

const inboundJoiningThread = async () => {
  await deliver(inboundMail("parent@elsewhere.test"), e as Env);
  const { d1, count } = countingD1(e.DB);
  await deliver(inboundMail("reply@elsewhere.test", ["parent@elsewhere.test"]), {
    ...e,
    DB: d1,
  } as Env);
  // The case is only worth measuring if the reply really joined the thread.
  const rows = await db().select().from(thread).where(eq(thread.mailboxId, A));
  expect(rows.filter((t) => t.msgCount === 2)).toHaveLength(1);
  return count;
};

const idleCronTick = async () => {
  const now = new Date();
  // Marks the two network steps as not due and runs one tick to settle state.
  await runCronOffline(e, now);
  const { d1, count } = countingD1(e.DB);
  await runCron({ ...e, DB: d1 } as Env, new Date(now.getTime() + 60_000));
  return count;
};

interface Budget {
  name: string;
  limit: number;
  measure: (w: World) => Promise<StatementCount>;
}

const BUDGETS: Budget[] = [
  // Lists. Cost is flat: the page is one query, whatever the mailbox holds.
  {
    name: "inbox list, first page, one mailbox",
    limit: 6, // measured 5: secret, session, user, access check, list
    measure: (w) => get(w, `/api/threads?mailboxId=${A}&limit=50`),
  },
  {
    name: "inbox list, first page, All view (3 mailboxes)",
    limit: 6, // measured 5
    measure: (w) => get(w, "/api/threads?mailboxId=all&limit=50"),
  },
  {
    name: "thread counts, one mailbox",
    limit: 7, // measured 6
    measure: (w) => get(w, `/api/threads/counts?mailboxId=${A}`),
  },
  {
    name: "thread counts, All view (3 mailboxes)",
    limit: 7, // measured 6
    measure: (w) => get(w, "/api/threads/counts?mailboxId=all"),
  },
  {
    name: "search",
    limit: 7, // measured 6
    measure: (w) => get(w, "/api/search?q=invoice"),
  },

  // Reading. Neither opening a thread nor fetching its bodies grows with its
  // message count (see the growth tests below). The bodies are a second call;
  // the single-body route serves the composer's quoted message.
  { name: "open thread, 1 message", limit: 7, measure: openThread(1) }, // measured 6
  { name: "open thread, 10 messages", limit: 7, measure: openThread(10) }, // measured 6
  { name: "open thread, 50 messages", limit: 7, measure: openThread(50) }, // measured 6
  { name: "one message body", limit: 7, measure: messageBody }, // measured 6
  { name: "bodies of 1 message of a thread", limit: 8, measure: threadBodies(1) }, // measured 7
  { name: "bodies of 50 messages of a thread", limit: 8, measure: threadBodies(50) }, // measured 7
  {
    name: "open a 10-message thread the way the web app does (thread + its bodies)",
    limit: 15, // measured 13 (1 thread request of 6 + 1 bodies request of 7)
    measure: openThreadLikeTheWebApp,
  },

  // Writes and background work.
  { name: "send (sendFromMailbox)", limit: 7, measure: send }, // measured 6
  { name: "inbound delivery, plain", limit: 16, measure: inboundPlain }, // measured 14
  { name: "inbound delivery, joining a thread", limit: 17, measure: inboundJoiningThread }, // measured 15
  { name: "idle cron tick", limit: 11, measure: idleCronTick }, // measured 10
];

function overBudget(name: string, limit: number, count: StatementCount): string {
  const sql = count.sql.map((s, i) => `  ${i + 1}. ${s.replace(/\s+/g, " ").slice(0, 100)}`);
  return [
    `${name}: ${count.statements} D1 statements, limit ${limit}.`,
    ...sql,
    `If this growth is intended, raise the limit in ${FILE} and say why in the commit.`,
  ].join("\n");
}

beforeAll(applyMigrationsOnce);

let world: World;
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  world = await seedWorld();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const keys = (await e.BLOBS.list({ prefix: "raw/" })).objects.map((o) => o.key);
  await Promise.all(keys.map((key) => e.BLOBS.delete(key)));
});

describe("D1 statements per request", () => {
  it.each(BUDGETS.map((b) => [b.name, b] as const))("%s", async (_name, budget) => {
    const count = await budget.measure(world);
    expect(count.statements, overBudget(budget.name, budget.limit, count)).toBeLessThanOrEqual(
      budget.limit,
    );
  });

  it("opening a thread costs no more statements for 50 messages than for 1", async () => {
    const one = await openThread(1)(world);
    const fifty = await openThread(50)(world);
    expect(
      fifty.statements,
      `Opening a 50-message thread took ${fifty.statements} statements, a 1-message thread ${one.statements}. The cost now grows with message count. If this is intended, change this test in ${FILE} and say why in the commit.`,
    ).toBeLessThanOrEqual(one.statements);
  });

  it("fetching the bodies of 50 messages costs no more statements than of 1", async () => {
    const one = await threadBodies(1)(world);
    const fifty = await threadBodies(50)(world);
    expect(
      fifty.statements,
      `The bodies of 50 messages took ${fifty.statements} statements, of 1 message ${one.statements}. The cost now grows with message count. If this is intended, change this test in ${FILE} and say why in the commit.`,
    ).toBeLessThanOrEqual(one.statements);
  });
});
