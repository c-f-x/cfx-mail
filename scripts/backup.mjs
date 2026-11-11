#!/usr/bin/env node
// Copy a deployment's database and stored files to a folder on this machine.
//
//   node scripts/backup.mjs <name> <folder>          a deployment in Cloudflare
//   node scripts/backup.mjs --local <folder>         local development storage
//
// The folder can be reused: stored files already copied are skipped, and the
// database tables are rewritten. Cloudflare's own `d1 export` cannot be used,
// because it refuses databases with full-text search tables.
/* eslint-disable no-await-in-loop -- pages, retries and wrangler runs are sequential on purpose */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { blobFiles, insertOrder, isCopiedTable, isSafeKey, sniffImageType } from "./backup/lib.mjs";
import {
  bucketFor,
  getObject,
  parseTarget,
  pooled,
  query,
  transferLanes,
  workerDir,
} from "./backup/wrangler.mjs";

const PAGE = 100;

const { target, rest, missingName } = parseTarget(process.argv.slice(2));
const folder = rest[0];
if (missingName || !folder) {
  console.error(
    "usage: node scripts/backup.mjs <name> <folder>\n       node scripts/backup.mjs --local <folder>",
  );
  process.exit(2);
}
const out = resolve(folder);
await mkdir(join(out, "db"), { recursive: true });
await mkdir(join(out, "blobs"), { recursive: true });

const bucket = await bucketFor(target);

// ── Database ────────────────────────────────────────────────────────────────
const tables = (await query(target, "select name from sqlite_master where type = 'table'"))
  .map((r) => r.name)
  .filter(isCopiedTable);

const references = {};
const rows = {};
for (const table of tables) {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  references[table] = (
    await query(
      target,
      `select "table" as parent from pragma_foreign_key_list('${table.replaceAll("'", "''")}')`,
    )
  ).map((r) => r.parent);
  rows[table] = [];
  let after = 0;
  for (;;) {
    const page = await query(
      target,
      `select rowid as __rowid, * from ${quoted} where rowid > ${after} order by rowid limit ${PAGE}`,
    );
    for (const { __rowid, ...row } of page) {
      rows[table].push(row);
      after = __rowid;
    }
    if (page.length < PAGE) break;
  }
  const file = join(out, "db", `${table}.jsonl`);
  await writeFile(`${file}.tmp`, rows[table].map((r) => `${JSON.stringify(r)}\n`).join(""));
  await rename(`${file}.tmp`, file);
  console.log(`${table}: ${rows[table].length} rows`);
}

const migrations = await query(target, "select name from d1_migrations order by id");

// ── Stored files ────────────────────────────────────────────────────────────
const files = blobFiles(rows);
const unsafe = files.filter((f) => !isSafeKey(f.key));
if (unsafe.length)
  throw new Error(`Refusing unsafe file keys: ${unsafe.map((f) => f.key).join(", ")}`);

const missing = [];
let copied = 0;
let kept = 0;
await pooled(files, transferLanes(target), async (f) => {
  const path = join(out, "blobs", f.key);
  const existing = await stat(path).catch(() => null);
  if (existing?.isFile()) {
    kept++;
  } else {
    await mkdir(dirname(path), { recursive: true });
    if (await getObject(target, bucket, f.key, `${path}.tmp`)) {
      await rename(`${path}.tmp`, path);
      copied++;
    } else {
      missing.push(f.key);
      return;
    }
  }
  f.bytes = (await stat(path)).size;
  if (!f.contentType)
    f.contentType = sniffImageType(new Uint8Array(await readFile(path)).subarray(0, 12));
});

// ── Manifest ────────────────────────────────────────────────────────────────
const domains = new Map((rows.domain ?? []).map((d) => [d.id, d.name]));
const manifest = {
  createdAt: new Date().toISOString(),
  deployment: target.name ?? "local",
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workerDir, encoding: "utf8" }).trim(),
  lastMigration: migrations.at(-1)?.name ?? null,
  tables: Object.fromEntries(tables.map((t) => [t, rows[t].length])),
  insertOrder: insertOrder(tables, references),
  // Raw mail is under blobs/raw/<mailbox id>/, so say which address each id is.
  mailboxes: (rows.mailbox ?? []).map((m) => ({
    id: m.id,
    address: `${m.local_part}@${domains.get(m.domain_id) ?? "?"}`,
  })),
  files: files.filter((f) => !missing.includes(f.key)),
  missing,
};
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`stored files: ${copied} copied, ${kept} already here, ${missing.length} missing`);
console.log(`backup written to ${out}`);
if (missing.length) {
  console.error(
    `The database refers to ${missing.length} stored files that do not exist. See "missing" in manifest.json.`,
  );
  process.exit(1);
}
