#!/usr/bin/env node
// Times the read paths of a LOCAL worker seeded by scripts/seed-local.mjs.
//
//   node scripts/measure/api-latency.mjs [--seed /tmp/cfx-mail-seed.json] [--runs 7]
//
// Signs in as the seeded admin and calls each read path `--runs` times in a
// row. Reports the first call, the median and the worst, in milliseconds of
// client wall time (request sent to last byte read).
//
// It only issues GET requests plus one sign-in. It never calls a send path.
//
// D1 statement counts: the worker reports them only when it carries the
// temporary counting wrapper: a wrapper around env.DB in apps/worker/src/index.ts
// that counts the statements of a request carrying the header x-measure-d1 and
// answers with x-d1-statements and x-d1-calls. It is added only for a
// measurement and never committed. Without it those columns show "n/a".
/* eslint-disable no-await-in-loop -- runs are timed one after another on purpose */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "/tmp/cfx-mail-seed.json" },
    runs: { type: "string", default: "7" },
  },
});
const seed = JSON.parse(readFileSync(args.seed, "utf8"));
const BASE = new URL(seed.base);
if (!["localhost", "127.0.0.1"].includes(BASE.hostname)) throw new Error("local workers only");
const RUNS = Number(args.runs);

async function get(path, cookie) {
  const t0 = performance.now();
  const res = await fetch(new URL(path, BASE), {
    headers: { cookie, origin: BASE.origin, "x-measure-d1": "1" },
  });
  const body = await res.arrayBuffer();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${new TextDecoder().decode(body)}`);
  return {
    ms,
    bytes: body.byteLength,
    statements: res.headers.get("x-d1-statements"),
    calls: res.headers.get("x-d1-calls"),
    json: () => JSON.parse(new TextDecoder().decode(body)),
  };
}

const res = await fetch(new URL("/api/auth/sign-in/email", BASE), {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE.origin },
  body: JSON.stringify({ email: seed.admin.email, password: seed.admin.password }),
});
if (!res.ok) throw new Error(`sign in: HTTP ${res.status}`);
const cookie = res.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .filter((c) => c.includes("session_token"))
  .join("; ");

const team = seed.mailboxes.find((m) => m.address.startsWith("team@"));

// Find sample threads in the team inbox: the longest, the longest of at most
// 10 messages, and a single message.
const threads = [];
for (let cursor = null, page = 0; page < 20; page++) {
  const q = new URLSearchParams({ mailboxId: team.id, view: "inbox", limit: "200" });
  if (cursor) q.set("cursor", cursor);
  const r = (await get(`/api/threads?${q}`, cookie)).json();
  threads.push(...r.threads);
  cursor = r.nextCursor;
  if (!cursor) break;
}
const byCount = threads.toSorted((a, b) => b.msgCount - a.msgCount);
const longest = byCount[0];
const tenish = byCount.find((t) => t.msgCount <= 10);
const single = threads.find((t) => t.msgCount === 1);

async function threadWithBodies(id) {
  // What the reader does: the thread, then the message bodies in parallel
  // batches of up to 50 (MAX_BODIES_PER_REQUEST in packages/shared).
  const t0 = performance.now();
  const thread = await get(`/api/threads/${id}`, cookie);
  const ids = thread.json().messages.map((m) => m.id);
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  const bodies = await Promise.all(
    batches.map((b) => get(`/api/threads/${id}/bodies?ids=${b.join(",")}`, cookie)),
  );
  const sum = (k) => bodies.reduce((n, b) => n + Number(b[k] ?? 0), Number(thread[k] ?? 0));
  return {
    ms: performance.now() - t0,
    bytes: sum("bytes"),
    statements: thread.statements === null ? null : String(sum("statements")),
    calls: thread.calls === null ? null : String(sum("calls")),
  };
}

const firstTeam = (
  await get(`/api/threads?mailboxId=${team.id}&view=inbox&limit=50`, cookie)
).json();
const firstAll = (await get(`/api/threads?mailboxId=all&view=inbox&limit=50`, cookie)).json();

/** @type {[string, () => Promise<{ ms: number, bytes: number, statements?: number, calls?: number }>][]} */
const cases = [
  [
    "Inbox list, one mailbox, first page (50)",
    () => get(`/api/threads?mailboxId=${team.id}&view=inbox&limit=50`, cookie),
  ],
  [
    "Inbox list, one mailbox, next page",
    () =>
      get(
        `/api/threads?mailboxId=${team.id}&view=inbox&limit=50&cursor=${encodeURIComponent(firstTeam.nextCursor)}`,
        cookie,
      ),
  ],
  [
    "Inbox list, All, first page (50)",
    () => get(`/api/threads?mailboxId=all&view=inbox&limit=50`, cookie),
  ],
  [
    "Inbox list, All, next page",
    () =>
      get(
        `/api/threads?mailboxId=all&view=inbox&limit=50&cursor=${encodeURIComponent(firstAll.nextCursor)}`,
        cookie,
      ),
  ],
  ["Folder counts, one mailbox", () => get(`/api/threads/counts?mailboxId=${team.id}`, cookie)],
  ["Folder counts, All", () => get(`/api/threads/counts?mailboxId=all`, cookie)],
  ["Mailbox list", () => get(`/api/mailboxes`, cookie)],
  [`Open thread, 1 message, + body`, () => threadWithBodies(single.id)],
  [`Open thread, ${tenish.msgCount} messages, + all bodies`, () => threadWithBodies(tenish.id)],
  [
    `Open thread, ${longest.msgCount} messages (list), thread only`,
    () => get(`/api/threads/${longest.id}`, cookie),
  ],
  [
    `Open thread, ${longest.msgCount} messages (list), + all bodies`,
    () => threadWithBodies(longest.id),
  ],
  ['Search "invoice" (subject word)', () => get(`/api/search?q=invoice`, cookie)],
  [
    'Search "kubernetes migration" (two words)',
    () => get(`/api/search?q=kubernetes%20migration`, cookie),
  ],
  ['Search "shipment" (common body word)', () => get(`/api/search?q=shipment`, cookie)],
];

const median = (xs) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`Runs per call: ${RUNS}. Worker: ${BASE.origin}. Times in ms, client wall clock.\n`);
console.log("| Call | First | Median | Worst | Response size | D1 statements | D1 round trips |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const [name, fn] of cases) {
  const results = [];
  for (let i = 0; i < RUNS; i++) results.push(await fn());
  const ms = results.map((r) => r.ms);
  const last = results.at(-1);
  console.log(
    `| ${name} | ${ms[0].toFixed(1)} | ${median(ms).toFixed(1)} | ${Math.max(...ms).toFixed(1)} | ${(last.bytes / 1024).toFixed(1)} KiB | ${last.statements ?? "n/a"} | ${last.calls ?? "n/a"} |`,
  );
}
