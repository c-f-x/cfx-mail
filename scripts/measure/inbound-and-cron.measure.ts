// Measurement, not a test. It lives outside apps/worker/test so the normal
// suite never runs it. To run it, copy it in, run it, and trash the copy:
//   cp scripts/measure/inbound-and-cron.measure.ts apps/worker/test/zz-measure.test.ts
//   cd apps/worker && npx -y pnpm@12.4.1 exec vitest run test/zz-measure.test.ts \
//     --silent=false --reporter=verbose
//   trash test/zz-measure.test.ts
// The report is printed after "MEASURE REPORT".
//
// Delivers mail through the real handleInbound and runs the real cron against
// the test D1/R2, counting D1 statements and timing each call. Outbound fetch
// (DoH, tracker lists) is replaced by a recorder that fails fast, so nothing
// leaves the machine. EMAIL is the test environment's binding, and no path here
// sends mail: no rules or auto-replies exist. Times come from the workerd
// clock, which only advances at I/O and has 1 ms steps.
/* eslint-disable no-await-in-loop -- deliveries and ticks are timed one after another */
import { applyD1Migrations, env } from "cloudflare:test";
import { makeDB } from "@cfmail/db";
import { domain, mailbox, user } from "@cfmail/db/schema";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runCron } from "../src/cron.ts";
import type { Env } from "../src/env.ts";
import { handleInbound } from "../src/mail/receive.ts";

// Env resolves only once this file is copied into apps/worker/test.
// oxlint-disable-next-line typescript/no-redundant-type-constituents
const e = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const report: string[] = [];
let fetches: string[] = [];

function counting(real: D1Database) {
  const stats = { statements: 0, roundTrips: 0, sql: [] as string[] };
  const patch = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const s = stmt as unknown as Record<string, unknown>;
    for (const m of ["first", "all", "run", "raw"] as const) {
      const orig = (stmt as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        m
      ]!.bind(stmt);
      s[m] = (...a: unknown[]) => {
        stats.statements++;
        stats.roundTrips++;
        stats.sql.push(sql.replace(/\s+/g, " ").slice(0, 600));
        return orig(...a);
      };
    }
    const origBind = stmt.bind.bind(stmt);
    s.bind = (...v: unknown[]) => patch(origBind(...v), sql);
    return stmt;
  };
  const db = new Proxy(real, {
    get(t, prop) {
      if (prop === "prepare") return (sql: string) => patch(t.prepare(sql), sql);
      if (prop === "batch")
        return (stmts: D1PreparedStatement[]) => {
          stats.statements += stmts.length;
          stats.roundTrips++;
          stats.sql.push(`[batch of ${stmts.length}]`);
          return t.batch(stmts);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db, stats };
}

function inbound(raw: string, to = "me@example.com") {
  return {
    from: "sender@elsewhere.test",
    to,
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

function message(id: string, opts: { refs?: string[]; attachBytes?: number; html?: boolean } = {}) {
  const refs = opts.refs ?? [];
  const head = [
    "From: Sender <sender@elsewhere.test>",
    "To: Me <me@example.com>",
    `Subject: ${refs.length ? "Re: " : ""}Planning notes`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    ...(refs.length
      ? [`In-Reply-To: <${refs.at(-1)}>`, `References: ${refs.map((r) => `<${r}>`).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
  ];
  const text = "Hello, here are the notes from today. ".repeat(20);
  if (!opts.attachBytes)
    return [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n");
  const bytes = new Uint8Array(opts.attachBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin).replace(/.{76}/g, "$&\r\n");
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--b1",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    "--b1--",
    "",
  ].join("\r\n");
}

async function deliver(raw: string) {
  const { db, stats } = counting(e.DB);
  const deferred: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException() {} };
  const t0 = performance.now();
  await handleInbound(inbound(raw), { ...e, DB: db }, ctx as unknown as ExecutionContext);
  const accept = performance.now() - t0;
  const acceptStatements = stats.statements;
  await Promise.allSettled(deferred);
  return {
    accept,
    total: performance.now() - t0,
    acceptStatements,
    statements: stats.statements,
    roundTrips: stats.roundTrips,
    sql: stats.sql,
  };
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

beforeAll(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  const db = makeDB(e.DB);
  await db.insert(user).values({ id: "u-owner", name: "Owner", email: "owner@example.com" });
  await db.insert(domain).values({ id: "d-1", name: "example.com", lastCheckedAt: new Date() });
  await db.insert(mailbox).values({
    id: "mb-1",
    domainId: "d-1",
    localPart: "me",
    type: "personal",
    ownerUserId: "u-owner",
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    fetches.push(String(input instanceof Request ? input.url : input).slice(0, 80));
    return new Response("measurement: no network", { status: 503 });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function series(name: string, make: (i: number) => string, runs = 5) {
  const rows = [];
  fetches = [];
  for (let i = 0; i < runs; i++) rows.push(await deliver(make(i)));
  const acc = rows.map((r) => r.accept);
  const tot = rows.map((r) => r.total);
  report.push(
    `| ${name} | ${median(acc).toFixed(1)} | ${Math.max(...acc).toFixed(1)} | ${median(tot).toFixed(1)} | ${Math.max(...tot).toFixed(1)} | ${rows[0]!.acceptStatements} | ${rows[0]!.statements} | ${rows[0]!.roundTrips} | ${fetches.length / runs} |`,
  );
  report.push(`  statements of first run: ${rows[0]!.sql.join(" ; ")}`);
}

it("measures inbound delivery", async () => {
  report.push(
    "| Inbound case (5 runs) | Accept median ms | Accept worst ms | With deferred work median ms | worst ms | D1 statements before accept | D1 statements incl. deferred | D1 round trips | Outbound fetches per delivery |",
  );
  report.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  await series("Plain text, new thread", (i) => message(`plain-${i}@elsewhere.test`));
  await series("2 MB attachment, new thread", (i) =>
    message(`att-${i}@elsewhere.test`, { attachBytes: 2 * 1024 * 1024 }),
  );

  // Build a 100-message conversation, then time the 101st reply joining it.
  const chain: string[] = [];
  for (let i = 0; i < 100; i++) {
    const id = `chain-${i}@elsewhere.test`;
    await deliver(message(id, { refs: [...chain] }));
    chain.push(id);
  }
  await series("Reply joining a 100-message thread (100 References)", (i) =>
    message(`chain-reply-${i}@elsewhere.test`, { refs: [...chain] }),
  );
  expect(report.length).toBeGreaterThan(0);
}, 120_000);

it("measures idle cron ticks", async () => {
  report.push("\n| Cron tick (idle) | D1 statements | D1 round trips | Outbound fetches | ms |");
  report.push("|---|---:|---:|---:|---:|");
  const start = new Date();
  for (let i = 0; i < 5; i++) {
    fetches = [];
    const { db, stats } = counting(e.DB);
    const t0 = performance.now();
    await runCron({ ...e, DB: db }, new Date(start.getTime() + i * 60_000));
    report.push(
      `| tick ${i + 1} | ${stats.statements} | ${stats.roundTrips} | ${fetches.length} (${[...new Set(fetches.map((f) => new URL(f).host))].join(", ")}) | ${(performance.now() - t0).toFixed(1)} |`,
    );
    if (i === 0 || i === 1) report.push(`  statements: ${stats.sql.join(" ; ")}`);
  }
  console.error(`\nMEASURE REPORT\n${report.join("\n")}\n`);
}, 120_000);
