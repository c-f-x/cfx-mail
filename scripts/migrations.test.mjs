import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// Architecture rule 14: migrations are append-only. A deployment that already
// ran a migration never runs it again, so editing one leaves its databases on
// the old version while new ones get the new. Every migration's contents are
// sealed in packages/db/drizzle/sealed.json the day it is added.
const dir = new URL("../packages/db/drizzle/", import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const journal = JSON.parse(await readFile(new URL("meta/_journal.json", dir), "utf8"));
const sealed = JSON.parse(await readFile(new URL("sealed.json", dir), "utf8"));
const sha256 = async (f) =>
  createHash("sha256")
    .update(await readFile(new URL(f, dir)))
    .digest("hex");

test("the journal lists every migration file once, in order", () => {
  assert.deepEqual(
    journal.entries.map((e) => e.idx),
    journal.entries.map((_, i) => i),
  );
  assert.deepEqual(
    journal.entries.map((e) => `${e.tag}.sql`),
    files,
  );
});

test("no migration changes after it is added", async () => {
  for (const f of files) {
    const tag = f.slice(0, -4);
    const hash = await sha256(f);
    assert.ok(
      sealed[tag],
      `${tag} is not sealed yet. Add "${tag}": "${hash}" to packages/db/drizzle/sealed.json.`,
    );
    assert.equal(hash, sealed[tag], `${tag} changed after it was added. Write a new migration.`);
  }
  assert.deepEqual(
    Object.keys(sealed).sort(),
    files.map((f) => f.slice(0, -4)),
    "a sealed migration was removed",
  );
});
