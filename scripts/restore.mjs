#!/usr/bin/env node
// Load a backup made by backup.mjs into an EMPTY deployment.
//
//   node scripts/restore.mjs <name> <folder>                       a deployment in Cloudflare
//   node scripts/restore.mjs --local [--persist-to <dir>] <folder> local development storage
//
// Run it from the commit the backup was taken at (see "commit" in
// manifest.json), so the database has the shape the rows were copied from.
/* eslint-disable no-await-in-loop -- pages, retries and wrangler runs are sequential on purpose */
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { insertStatement } from "./backup/lib.mjs";
import {
  applyMigrations,
  bucketFor,
  executeFile,
  migrationsDir,
  parseTarget,
  pooled,
  putObject,
  query,
  transferLanes,
} from "./backup/wrangler.mjs";

const { target, rest, missingName } = parseTarget(process.argv.slice(2));
const folder = rest[0];
if (missingName || !folder) {
  console.error(
    "usage: node scripts/restore.mjs <name> <folder>\n       node scripts/restore.mjs --local [--persist-to <dir>] <folder>",
  );
  process.exit(2);
}
const from = resolve(folder);
const manifest = JSON.parse(await readFile(join(from, "manifest.json"), "utf8"));

const newest = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .toSorted()
  .at(-1);
if (newest !== manifest.lastMigration) {
  console.error(
    `This checkout's newest migration is ${newest}; the backup was taken at ${manifest.lastMigration}.\n` +
      `Check out commit ${manifest.commit} and run the restore from there.`,
  );
  process.exit(1);
}

await applyMigrations(target);

// Tables whose row count differs from the backup, as "table: expected x, found y".
async function mismatches() {
  const found = [];
  for (const [table, expected] of Object.entries(manifest.tables)) {
    const [{ n }] = await query(
      target,
      `select count(*) as n from "${table.replaceAll('"', '""')}"`,
    );
    if (n !== expected) found.push(`${table}: expected ${expected} rows, found ${n}`);
  }
  return found;
}

// ── Database ────────────────────────────────────────────────────────────────
const [{ n: users }] = await query(target, 'select count(*) as n from "user"');
const [{ n: messages }] = await query(target, 'select count(*) as n from "message"');
if (users === 0 && messages === 0) {
  // One file, parents before children. Foreign keys are checked when the file's
  // transaction ends, which covers tables that refer to each other. The file is a
  // copy of the whole database, password hashes included, so it lives in a temp
  // folder this run creates and removes, never in the backup.
  const scratch = await mkdtemp(join(tmpdir(), "cfmail-restore-"));
  try {
    const sqlFile = join(scratch, "restore.sql");
    const statements = ["PRAGMA defer_foreign_keys = TRUE;"];
    for (const table of manifest.insertOrder) {
      const lines = createInterface({
        input: createReadStream(join(from, "db", `${table}.jsonl`)),
      });
      for await (const line of lines)
        if (line) statements.push(insertStatement(table, JSON.parse(line)));
    }
    await writeFile(sqlFile, `${statements.join("\n")}\n`);
    await executeFile(target, sqlFile);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
// A restore that stopped while copying files is run again; its database is
// already in place. Anything else in the target is not ours to overwrite.
const wrong = await mismatches();
if (wrong.length) {
  console.error(
    users === 0 && messages === 0
      ? `The database did not restore fully:\n${wrong.join("\n")}`
      : `The target already holds other data (${users} users, ${messages} messages). Restore only into a new deployment.`,
  );
  process.exit(1);
}
console.log(`database: ${Object.keys(manifest.tables).length} tables match the backup`);

// ── Stored files ────────────────────────────────────────────────────────────
const bucket = await bucketFor(target);
await pooled(manifest.files, transferLanes(target), async (f) => {
  const path = join(from, "blobs", f.key);
  if ((await stat(path)).size !== f.bytes)
    throw new Error(`${f.key} changed size since the backup.`);
  await putObject(target, bucket, f.key, path, f.contentType);
});
console.log(`stored files: ${manifest.files.length} restored`);
console.log("restore complete");
