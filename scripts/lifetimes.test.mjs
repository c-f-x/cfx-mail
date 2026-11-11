// Every store says what it keeps and what removes the rest (c-f-x conventions,
// section 5; /project-foundations, step 5). docs/data-model.md has a
// "## Lifetimes" table with one row per store: each binding in the Wrangler
// template, the Durable Object class, and each table the migrations leave
// standing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseJsonc } from "./backup/lib.mjs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const MIGRATIONS = "packages/db/drizzle/";

const HEADER = "| Store | Holds | Lifetime | Removed by |";
const NAME = '[`"]?([A-Za-z0-9_]+)[`"]?';
const DDL = new RegExp(
  `CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?${NAME}|DROP TABLE (?:IF EXISTS )?${NAME}|ALTER TABLE ${NAME} RENAME TO ${NAME}`,
  "gi",
);

/** The tables standing after every migration ran, in order. */
export function standingTables(migrations) {
  const tables = new Set();
  for (const sql of migrations) {
    for (const m of sql.matchAll(DDL)) {
      if (m[1]) tables.add(m[1]);
      else if (m[2]) tables.delete(m[2]);
      else {
        tables.delete(m[3]);
        tables.add(m[4]);
      }
    }
  }
  return tables;
}

/** The stores the Wrangler config binds: D1, R2 and KV bindings, Durable Object classes. */
export function boundStores(config) {
  return new Set([
    ...(config.d1_databases ?? []).map((d) => d.binding),
    ...(config.r2_buckets ?? []).map((b) => b.binding),
    ...(config.kv_namespaces ?? []).map((k) => k.binding),
    ...(config.durable_objects?.bindings ?? []).map((o) => o.class_name),
  ]);
}

/** The first table under "## Lifetimes": { rows: [{ store, cells }], problems }. */
export function lifetimesTable(doc) {
  const problems = [];
  const at = doc.indexOf("\n## Lifetimes\n");
  if (at === -1) return { rows: [], problems: ['no "## Lifetimes" heading'] };
  const lines = doc.slice(at).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  if (start === -1 || lines[start] !== HEADER) {
    return { rows: [], problems: [`the first table must start with: ${HEADER}`] };
  }
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const store = cells[0].match(/^`([A-Za-z0-9_]+)`$/)?.[1];
    if (cells.length !== 4) problems.push(`a row needs four cells: ${line}`);
    else if (!store) problems.push(`the Store cell holds only a name in backticks: ${line}`);
    else if (cells.some((c) => c === "")) problems.push(`${store} has an empty cell`);
    if (store) rows.push({ store, cells });
  }
  return { rows, problems };
}

/** What is wrong between the table and the stores that exist. */
export function lifetimeProblems(doc, stores) {
  const { rows, problems } = lifetimesTable(doc);
  const listed = new Set(rows.map((r) => r.store));
  for (const s of stores) if (!listed.has(s)) problems.push(`${s} has no row`);
  for (const r of rows) if (!stores.has(r.store)) problems.push(`${r.store} is not a store`);
  return problems;
}

test("the migration reader follows creates, drops and renames in order", () => {
  const steps = [
    "CREATE TABLE `a` (id text);\nCREATE TABLE `b` (id text);",
    "CREATE VIRTUAL TABLE `fts` USING fts5(x);\nDROP TABLE `a`;",
    "CREATE TABLE `__new_b` (id text);\nDROP TABLE `b`;\nALTER TABLE `__new_b` RENAME TO `b`;",
  ];
  assert.deepEqual(
    [...standingTables(steps)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ["b", "fts"],
  );
});

test("the check flags a missing row, a row for no store, an empty cell and a wrong header", () => {
  const doc = [
    "# x",
    "",
    "## Lifetimes",
    "",
    HEADER,
    "|---|---|---|---|",
    "| `DB` | everything | forever | nothing |",
    "| `gone` | old rows | a day | the cron |",
    "| `thread` | conversations |  | the cron |",
  ].join("\n");
  assert.deepEqual(lifetimeProblems(doc, new Set(["DB", "thread", "message"])), [
    "thread has an empty cell",
    "message has no row",
    "gone is not a store",
  ]);
  assert.deepEqual(lifetimeProblems("\n## Lifetimes\n\n| Store | Keeps |\n", new Set()), [
    `the first table must start with: ${HEADER}`,
  ]);
});

test("docs/data-model.md has a lifetime for every store", () => {
  const migrations = readdirSync(new URL(MIGRATIONS, root))
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .map((f) => read(MIGRATIONS + f));
  const config = parseJsonc(read("apps/worker/wrangler.jsonc"));
  const stores = new Set([...boundStores(config), ...standingTables(migrations)]);
  assert.ok(stores.has("DB") && stores.has("BLOBS") && stores.has("message"));
  assert.deepEqual(lifetimeProblems(read("docs/data-model.md"), stores), []);
});
