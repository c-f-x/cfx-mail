#!/usr/bin/env node
// Fill a LOCAL worker with realistic, fictional mail for performance work.
//
//   node scripts/seed-local.mjs [--base http://localhost:8797] [--messages 5000]
//     [--concurrency 6] [--out /tmp/cfx-mail-seed.json]
//
// The setup token is read from SETUP_TOKEN in apps/worker/.dev.vars, the file
// the local worker reads it from.
//
// Everything goes through the worker's real HTTP API: first-run setup with the
// setup token, then domains, users, mailboxes, memberships, and one
// `POST /api/mailboxes/:id/import` per message (raw RFC 822). Nothing is sent:
// import stores mail, it never delivers it.
//
// Safety:
// - Refuses any base URL that is not localhost or 127.0.0.1.
// - Refuses to run twice: if the worker already has a user, it stops before
//   writing anything. Start from fresh local storage to seed again.
// - Uses only reserved names (*.example, *.test) for every address and link.
//
// The data is deterministic (seeded random numbers), so two fresh runs produce
// the same mail. The script prints the admin's sign-in and the ids of what it
// created, and writes them to --out for the measurement scripts. Imports run
// --concurrency at a time; with more than one, replies can be stored before
// their parent; threading then has to join them afterwards.
/* eslint-disable no-await-in-loop -- setup steps depend on each other and run in order */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:8797" },
    messages: { type: "string", default: "5000" },
    concurrency: { type: "string", default: "6" },
    out: { type: "string", default: "/tmp/cfx-mail-seed.json" },
  },
});

const BASE = new URL(args.base);
if (!["localhost", "127.0.0.1"].includes(BASE.hostname)) {
  console.error(`Refusing to seed ${BASE.origin}: only a local worker may be seeded.`);
  process.exit(1);
}
const ORIGIN = BASE.origin;
const TARGET = Number(args.messages);
const CONCURRENCY = Number(args.concurrency);
const DEV_VARS = new URL("../apps/worker/.dev.vars", import.meta.url);
let SETUP_TOKEN;
try {
  SETUP_TOKEN = readFileSync(DEV_VARS, "utf8")
    .match(/^SETUP_TOKEN=(.+)$/m)?.[1]
    ?.trim();
} catch {
  SETUP_TOKEN = undefined;
}
if (!SETUP_TOKEN) {
  console.error(
    "Put SETUP_TOKEN=<any value> in apps/worker/.dev.vars, then start the local worker.",
  );
  process.exit(1);
}

const PASSWORD = "local-seed-password-1";
const ADMIN = { email: "admin@alpha.example", name: "Ada Admin" };

// ── Deterministic random numbers (mulberry32) ────────────────────────────────
let state = 0x5eed1234;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function api(path, { method = "GET", cookie, json, body, headers = {} } = {}) {
  const payload = json ? JSON.stringify(json) : body;
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "manual",
  });
  return res;
}

async function ok(res, what) {
  if (res.ok) return res;
  throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
}

function sessionCookie(res) {
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  const session = cookies.filter((c) => c.includes("session_token"));
  if (session.length === 0) throw new Error("no session cookie in response");
  return session.join("; ");
}

async function signIn(email) {
  const res = await ok(
    await api("/api/auth/sign-in/email", { method: "POST", json: { email, password: PASSWORD } }),
    `sign in ${email}`,
  );
  return sessionCookie(res);
}

// ── Fictional content ────────────────────────────────────────────────────────
const FIRST = ["Mira", "Tomas", "Ines", "Kofi", "Lena", "Arjun", "Sofia", "Pavel", "Yuki", "Noor"];
const LAST = ["Halvorsen", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Silva", "Novak", "Reyes"];
const ORGS = ["northwind.example", "harbor.test", "lumen.example", "fjord.test", "quarry.example"];
const TOPICS = [
  "Invoice for September",
  "Quarterly planning notes",
  "Site visit on Thursday",
  "Draft contract, second pass",
  "Kubernetes migration status",
  "Photos from the workshop",
  "Budget review",
  "Hiring loop for the designer role",
  "Supplier delivery delayed",
  "Board meeting agenda",
  "Travel booking confirmation",
  "Newsletter layout feedback",
  "Server maintenance window",
  "Grant application checklist",
  "Garden project volunteers",
];
const WORDS = (
  "the a we will please find attached review update schedule meeting project team " +
  "budget invoice report draft proposal timeline client partner feedback question " +
  "thanks regards tomorrow next week morning afternoon numbers figures summary notes " +
  "design layout website server backup storage delivery shipment order payment"
).split(" ");

function sentence() {
  const n = between(6, 18);
  const words = Array.from({ length: n }, () => pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(" ")}.`;
}
function paragraphs(count) {
  return Array.from({ length: count }, () =>
    Array.from({ length: between(2, 5) }, sentence).join(" "),
  );
}

function person() {
  const first = pick(FIRST);
  const last = pick(LAST);
  return { name: `${first} ${last}`, address: `${first}.${last}@${pick(ORGS)}`.toLowerCase() };
}

// Base64 with 76-character lines, as mail clients write it.
function base64Lines(buf) {
  return buf.toString("base64").replace(/.{76}/g, "$&\r\n");
}

function attachmentBytes() {
  // Sizes spread evenly on a log scale between 10 KB and 2 MB.
  const size = Math.round(10_000 * 200 ** rand());
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4)
    buf.writeUInt32LE((rand() * 0xffffffff) >>> 0, Math.min(i, size - 4));
  return buf;
}

function rfc2822(date) {
  return date.toUTCString().replace("GMT", "+0000");
}

// One message as raw RFC 822 text. HTML mail carries a plain alternative,
// a remote image and a link, like most real newsletters and client mail.
function buildMessage({
  from,
  to,
  subject,
  date,
  messageId,
  inReplyTo,
  references,
  html,
  attach,
  list,
}) {
  const text = paragraphs(between(1, 4)).join("\r\n\r\n");
  const headers = [
    `From: ${from.name} <${from.address}>`,
    `To: ${to.name} <${to.address}>`,
    `Subject: ${subject}`,
    `Date: ${rfc2822(date)}`,
    `Message-ID: <${messageId}>`,
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    ...(references.length ? [`References: ${references.map((r) => `<${r}>`).join(" ")}`] : []),
    ...(list
      ? [`List-Id: <${list}>`, `List-Unsubscribe: <https://lists.example/unsubscribe/${list}>`]
      : []),
    "MIME-Version: 1.0",
  ];
  const alt = `alt-${messageId.split("@")[0]}`;
  const mixed = `mixed-${messageId.split("@")[0]}`;
  let bodyPart;
  if (html) {
    const htmlBody =
      `<html><body style="font-family:sans-serif"><table width="600"><tr><td>` +
      text
        .split("\r\n\r\n")
        .map((p) => `<p style="margin:0 0 12px">${p}</p>`)
        .join("") +
      `<p><a href="https://portal.example/item/${between(1, 99999)}">Open in portal</a></p>` +
      `<img src="https://images.example/banner/${between(1, 50)}.png" width="600" height="120" alt="">` +
      `</td></tr></table></body></html>`;
    bodyPart = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      `--${alt}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      htmlBody,
      `--${alt}--`,
    ].join("\r\n");
  } else {
    bodyPart = ["Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  }
  if (!attach) return `${headers.join("\r\n")}\r\n${bodyPart}\r\n`;
  const bytes = attachmentBytes();
  const name = `${pick(["report", "scan", "slides", "contract", "photo"])}-${between(1, 999)}.pdf`;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    bodyPart,
    `--${mixed}`,
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(bytes),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

// ── Plan: users, domains, mailboxes ──────────────────────────────────────────
const DOMAINS = ["alpha.example", "beta.example", "gamma.test"];
const USERS = [
  { email: "bo@alpha.example", name: "Bo Berg" },
  { email: "cai@beta.example", name: "Cai Chen" },
  { email: "dana@beta.example", name: "Dana Diaz" },
  { email: "eli@gamma.test", name: "Eli Engel" },
  { email: "fay@gamma.test", name: "Fay Ferreira" },
];
// weight = share of all messages. The admin can read the first six (owner or
// member), so the admin's "All" view spans most of the mail.
const MAILBOXES = [
  { local: "team", domain: 0, type: "group", owner: "admin", weight: 0.3 },
  { local: "admin", domain: 0, type: "personal", owner: "admin", weight: 0.12 },
  { local: "support", domain: 1, type: "group", owner: "admin", weight: 0.14 },
  { local: "billing", domain: 1, type: "group", owner: "admin", weight: 0.08 },
  { local: "press", domain: 2, type: "group", owner: "admin", weight: 0.06 },
  { local: "bo", domain: 0, type: "personal", owner: "bo@alpha.example", weight: 0.06 },
  { local: "cai", domain: 1, type: "personal", owner: "cai@beta.example", weight: 0.06 },
  { local: "dana", domain: 1, type: "personal", owner: "dana@beta.example", weight: 0.06 },
  { local: "eli", domain: 2, type: "personal", owner: "eli@gamma.test", weight: 0.06 },
  { local: "fay", domain: 2, type: "personal", owner: "fay@gamma.test", weight: 0.06 },
];
// Group mailbox members (user email -> read/write).
const MEMBERS = {
  team: ["bo@alpha.example", "cai@beta.example", "dana@beta.example"],
  support: ["cai@beta.example", "dana@beta.example", "eli@gamma.test"],
  billing: ["fay@gamma.test"],
  press: ["eli@gamma.test", "bo@alpha.example"],
};

// ── Threads ──────────────────────────────────────────────────────────────────
const YEAR_MS = 365 * 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

// Builds every message for one mailbox. Thread lengths are 1 to 10, skewed
// short; a few mailing-list threads run to 120 messages with full References.
function planMailbox(mb, address, count, idPrefix) {
  const out = [];
  let t = 0;
  const longThreads = mb.local === "team" ? 3 : mb.local === "support" ? 1 : 0;
  for (let l = 0; l < longThreads; l++) {
    const list = `dev-${l}.lists.example`;
    out.push(...planThread({ mb, address, idPrefix, t: t++, length: 120, list }));
  }
  while (out.length < count) {
    const length = Math.min(count - out.length, rand() < 0.55 ? 1 : between(2, 10));
    out.push(...planThread({ mb, address, idPrefix, t: t++, length }));
  }
  return out;
}

function planThread({ mb, address, idPrefix, t, length, list }) {
  const me = { name: mb.local, address };
  const other = person();
  const subject = list ? `[dev-list] ${pick(TOPICS)}` : pick(TOPICS);
  let date = new Date(NOW - Math.floor(rand() * YEAR_MS));
  const html = rand() < 0.5;
  const ids = [];
  const msgs = [];
  for (let i = 0; i < length; i++) {
    const outbound = !list && i % 2 === 1 && rand() < 0.7;
    const from = outbound ? me : list ? person() : other;
    const to = outbound ? other : me;
    const messageId = `${idPrefix}.${t}.${i}@${list ? "lists.example" : from.address.split("@")[1]}`;
    const raw = buildMessage({
      from,
      to,
      subject: i === 0 ? subject : `Re: ${subject}`,
      date,
      messageId,
      inReplyTo: ids.at(-1),
      references: [...ids],
      html,
      attach: rand() < 0.1,
      list,
    });
    // Recent inbound mail is partly unread, so the badges have something to count.
    const recent = NOW - date.getTime() < 30 * 24 * 3600 * 1000;
    msgs.push({ raw, seen: !(recent && !outbound && rand() < 0.5), starred: rand() < 0.03 });
    ids.push(messageId);
    date = new Date(date.getTime() + between(10, 60 * 24) * 60_000);
  }
  return msgs;
}

// ── Run ──────────────────────────────────────────────────────────────────────
async function main() {
  const status = await (await ok(await api("/api/bootstrap"), "bootstrap status")).json();
  if (!status.needsBootstrap) {
    console.error(
      "This worker already has users. Seed only fresh local storage; nothing was written.",
    );
    process.exit(1);
  }
  if (status.setupLocked) {
    console.error(
      "Setup is locked: the worker has no SETUP_TOKEN. Add it to apps/worker/.dev.vars.",
    );
    process.exit(1);
  }

  const boot = await ok(
    await api("/api/bootstrap", {
      method: "POST",
      json: { ...ADMIN, password: PASSWORD, setupToken: SETUP_TOKEN },
    }),
    "bootstrap",
  );
  const cookies = { admin: sessionCookie(boot) };

  const domainIds = [];
  for (const name of DOMAINS) {
    const res = await ok(
      await api("/api/domains", {
        method: "POST",
        cookie: cookies.admin,
        json: { name, allowedKinds: 3 },
      }),
      `domain ${name}`,
    );
    domainIds.push((await res.json()).id);
  }

  const userIds = {};
  const me = await (await ok(await api("/api/me", { cookie: cookies.admin }), "me")).json();
  userIds.admin = me.user.id;
  for (const u of USERS) {
    const res = await ok(
      await api("/api/users", {
        method: "POST",
        cookie: cookies.admin,
        json: { ...u, password: PASSWORD },
      }),
      `user ${u.email}`,
    );
    userIds[u.email] = (await res.json()).id;
  }

  const mailboxes = [];
  for (const mb of MAILBOXES) {
    const res = await ok(
      await api("/api/admin/mailboxes", {
        method: "POST",
        cookie: cookies.admin,
        json: {
          domainId: domainIds[mb.domain],
          localPart: mb.local,
          ownerUserId: userIds[mb.owner],
          type: mb.type,
        },
      }),
      `mailbox ${mb.local}`,
    );
    mailboxes.push({
      ...mb,
      id: (await res.json()).id,
      address: `${mb.local}@${DOMAINS[mb.domain]}`,
    });
  }

  for (const [local, members] of Object.entries(MEMBERS)) {
    const mb = mailboxes.find((m) => m.local === local);
    for (const email of members) {
      await ok(
        await api(`/api/mailboxes/${mb.id}/members`, {
          method: "POST",
          cookie: cookies.admin,
          json: { mailboxId: mb.id, userId: userIds[email], read: true, write: true },
        }),
        `member ${email} on ${local}`,
      );
    }
  }

  for (const u of USERS) cookies[u.email] = await signIn(u.email);

  // Build and import every message. Each mailbox is imported by its owner.
  const jobs = [];
  for (const [i, mb] of mailboxes.entries()) {
    const count = Math.round(TARGET * mb.weight);
    for (const m of planMailbox(mb, mb.address, count, `seed${i}`)) jobs.push({ mb, ...m });
  }
  let done = 0;
  let bytes = 0;
  let attachments = 0;
  const started = Date.now();
  const queue = jobs.slice();
  async function worker() {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const query = new URLSearchParams({
        seen: job.seen ? "1" : "0",
        ...(job.starred ? { starred: "1" } : {}),
      });
      const res = await api(`/api/mailboxes/${job.mb.id}/import?${query}`, {
        method: "POST",
        cookie: cookies[job.mb.owner],
        body: job.raw,
        headers: { "content-type": "message/rfc822" },
      });
      await ok(res, `import into ${job.mb.address}`);
      const result = await res.json();
      if (result.duplicate || result.skipped)
        throw new Error(`unexpected import result ${JSON.stringify(result)}`);
      done++;
      bytes += job.raw.length;
      if (job.raw.includes("Content-Disposition: attachment")) attachments++;
      if (done % 500 === 0) console.log(`  ${done}/${jobs.length} imported`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const summary = {
    base: ORIGIN,
    admin: { email: ADMIN.email, password: PASSWORD },
    users: USERS.map((u) => ({ email: u.email, password: PASSWORD, id: userIds[u.email] })),
    domains: DOMAINS.map((name, i) => ({ name, id: domainIds[i] })),
    mailboxes: mailboxes.map(({ id, address, type, owner }) => ({ id, address, type, owner })),
    messages: done,
    attachments,
    rawBytes: bytes,
    importSeconds: (Date.now() - started) / 1000,
  };
  writeFileSync(args.out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, mailboxes: summary.mailboxes.length }, null, 2));
  console.log(`Wrote ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
