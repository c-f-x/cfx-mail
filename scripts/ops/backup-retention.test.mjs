import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSnapshotName, snapshotName, snapshotsToPrune } from "./backup-retention.mjs";

const helper = join(import.meta.dirname, "backup-retention.mjs");

// A scratch folder that the test removes again, even when it fails.
function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), "cfmail-retention-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("snapshots are named by local calendar date", () => {
  assert.equal(snapshotName(new Date(2026, 9, 9, 3, 5)), "2026-10-09");
  assert.equal(snapshotName(new Date(2026, 0, 2, 23, 59)), "2026-01-02");
});

test("only real YYYY-MM-DD dates count as snapshots", () => {
  assert.equal(isSnapshotName("2026-10-09"), true);
  for (const bad of [
    "current",
    "2026-10-9",
    "2026-13-01",
    "2026-02-30",
    "2026-10-09.partial",
    ".2026-10-09.partial",
    "x2026-10-09",
  ])
    assert.equal(isSnapshotName(bad), false, bad);
});

test("keeps the newest N and prunes the rest, oldest first", () => {
  const names = ["2026-10-03", "2026-10-01", "2026-10-05", "2026-10-02", "2026-10-04"];
  assert.deepEqual(snapshotsToPrune(names, 3), ["2026-10-01", "2026-10-02"]);
});

test("prunes nothing when there are N or fewer", () => {
  assert.deepEqual(snapshotsToPrune(["2026-10-01", "2026-10-02"], 2), []);
  assert.deepEqual(snapshotsToPrune([], 5), []);
});

test("never names a folder that is not a dated snapshot", () => {
  const names = ["current", "notes.txt", ".2026-10-09.partial", "2026-10-01", "2026-10-02"];
  assert.deepEqual(snapshotsToPrune(names, 1), ["2026-10-01"]);
});

test("refuses a keep count below 1 or one that is not a whole number", () => {
  for (const keep of [0, -1, 1.5, Number.NaN, "3", undefined])
    assert.throws(() => snapshotsToPrune(["2026-10-01"], keep), /keep/, String(keep));
});

test("the command prints the snapshot folders to prune, one per line", () => {
  withScratch((root) => {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "current"]) mkdirSync(join(root, d));
    writeFileSync(join(root, "2026-09-01"), "a file, not a folder");
    const out = execFileSync("node", [helper, "prune", root, "2"], { encoding: "utf8" });
    assert.equal(out, "2026-10-01\n");
  });
});

test("the command prints today's snapshot name", () => {
  const out = execFileSync("node", [helper, "today"], { encoding: "utf8" }).trim();
  assert.equal(isSnapshotName(out), true, out);
});

test("the command exits 2 with a message on a bad keep count", () => {
  withScratch((root) => {
    assert.throws(
      () => execFileSync("node", [helper, "prune", root, "0"], { encoding: "utf8", stdio: "pipe" }),
      (e) => e.status === 2 && /keep/.test(e.stderr),
    );
  });
});

test("the command exits 2 on an unknown subcommand", () => {
  assert.throws(
    () => execFileSync("node", [helper, "nope"], { encoding: "utf8", stdio: "pipe" }),
    (e) => e.status === 2 && /usage/.test(e.stderr),
  );
});
