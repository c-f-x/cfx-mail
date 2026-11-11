// The access checks are proven to guard (/project-foundations, step 8; c-f-x
// conventions, section 8). Each case removes one check from a scratch copy of
// the repository and runs the tests that should notice. A case passes only
// when the named test fails. The unchanged copy runs first and must pass, so
// a broken harness cannot pass for a removed check. Shape copied from
// cfanalytics' scripts/guard-proof.test.mjs (decision D-17).
//
// Slow: each case starts its own workerd. It runs with `pnpm test:slow`, which
// CI runs on every push to master.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openRunScope } from "./run-scope.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIDDLEWARE = "apps/worker/src/middleware.ts";
const PERMISSIONS = "apps/worker/src/permissions.ts";
const SVC = "apps/worker/src/api/svc.ts";
const ROUTE_WALK = ["test/api/route-walk.test.ts"];
// A timeout catches a hung workerd, never a slow one.
const HANG_MS = 600_000;

/** Each removed check: the file, the exact text taken out, and a test that must fail. */
export const REMOVED_CHECKS = [
  {
    name: "the sign-in check",
    file: MIDDLEWARE,
    text: '  if (!c.get("user")) throw new AppError("unauthenticated", "unauthenticated");\n',
    tests: ["test/api/threads.test.ts"],
    fails: "rejects anonymous callers with 401",
  },
  {
    name: "the admin role check",
    file: MIDDLEWARE,
    text: '  if (!row || row.banned || row.role !== "admin") {\n',
    with: "  if (!row || row.banned) {\n",
    tests: ["test/api/admin.test.ts"],
    fails: "403s a non-admin caller",
  },
  {
    name: "the permission bit check",
    file: PERMISSIONS,
    text: "  if (!access || !has(access.perms, bit)) {\n",
    with: "  if (!access) {\n",
    tests: ["test/permissions.test.ts"],
    fails: "READ-only member: READ passes, WRITE and MANAGE are forbidden",
  },
  {
    name: "the membership check, so a stranger gets every right",
    file: PERMISSIONS,
    text: "  if (!member) return null;\n",
    with: "  if (!member) return { mailboxId, userId, perms: ALL_PERMS, isOwner: false, purging };\n",
    tests: ROUTE_WALK,
    fails: "a signed-in stranger",
  },
  {
    name: "the entity lookup's permission check",
    file: PERMISSIONS,
    text: "  await requirePerm(db, userId, (row as { mailboxId: string }).mailboxId, bit);\n",
    tests: ROUTE_WALK,
    fails: "a signed-in stranger",
  },
  {
    name: "the service key's hash match, so any key opens any service mailbox",
    file: SVC,
    text: "      eq(mailbox.serviceKeyHash, hash),\n",
    tests: ["test/api/svc.test.ts"],
    fails: "401s when the bearer key matches no mailbox",
  },
];

/** The text with `check.text` replaced; it must appear exactly once, so a stale case fails. */
export function removeCheck(source, check) {
  const at = source.indexOf(check.text);
  if (at === -1 || source.indexOf(check.text, at + 1) !== -1) {
    throw new Error(
      `${check.file} holds "${check.text.trim()}" ${at === -1 ? "nowhere" : "twice"}`,
    );
  }
  return source.slice(0, at) + (check.with ?? "") + source.slice(at + check.text.length);
}

let scope;

before(() => {
  scope = openRunScope({ installExitHandlers: true });
});

after(async () => {
  const { leftovers } = await scope.close();
  assert.deepEqual(leftovers, []);
});

const SKIP = /[/\\](node_modules|dist|\.wrangler|\.turbo)$/;

/** A copy of the sources the Worker's tests need, with the installed modules linked in. */
function scratchCopy(name) {
  const dir = path.join(scope.dir, name);
  mkdirSync(dir);
  for (const file of ["package.json", "tsconfig.base.json", "tsconfig.json"]) {
    cpSync(path.join(ROOT, file), path.join(dir, file));
  }
  for (const file of ["run-scope.mjs", "vitest-run-scope.mjs"]) {
    cpSync(path.join(ROOT, "scripts", file), path.join(dir, "scripts", file));
  }
  for (const pkg of ["apps/worker", "packages/db", "packages/shared"]) {
    cpSync(path.join(ROOT, pkg), path.join(dir, pkg), {
      recursive: true,
      filter: (from) => !SKIP.test(from),
    });
    symlinkSync(path.join(ROOT, pkg, "node_modules"), path.join(dir, pkg, "node_modules"));
  }
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** Runs the Worker's tests in `dir`; resolves with the full names of the tests that failed. */
function failingTests(dir, files) {
  const worker = path.join(dir, "apps/worker");
  const report = path.join(dir, "report.json");
  const vitest = path.join(ROOT, "apps/worker/node_modules/vitest/vitest.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, "run", ...files, "--reporter=json", `--outputFile=${report}`],
      { cwd: worker, stdio: "ignore", detached: true },
    );
    scope.recordChild(child.pid, { group: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!existsSync(report)) {
        reject(new Error(`vitest exited ${code} in ${dir} and wrote no report`));
        return;
      }
      const results = JSON.parse(readFileSync(report, "utf8")).testResults ?? [];
      const failed = results
        .flatMap((file) => file.assertionResults ?? [])
        .filter((result) => result.status === "failed")
        .map((result) => result.fullName ?? result.title);
      resolve({ code, failed });
    });
  });
}

test("removeCheck refuses text that is missing or appears twice", () => {
  const check = { file: "x.ts", text: "check();\n" };
  assert.equal(removeCheck("a\ncheck();\nb\n", check), "a\nb\n");
  assert.throws(() => removeCheck("a\n", check), /nowhere/);
  assert.throws(() => removeCheck("check();\ncheck();\n", check), /twice/);
});

test("every check's text is in its file exactly once", () => {
  for (const check of REMOVED_CHECKS) {
    removeCheck(readFileSync(path.join(ROOT, check.file), "utf8"), check);
  }
});

test("the unchanged copy passes, so the harness itself is sound", {
  timeout: HANG_MS,
}, async () => {
  const dir = scratchCopy("unchanged");
  const files = [...new Set(REMOVED_CHECKS.flatMap((c) => c.tests))];
  const { code, failed } = await failingTests(dir, files);
  assert.deepEqual(failed, []);
  assert.equal(code, 0);
});

// Two at a time: each case runs its own workerd on a machine CI shares.
describe("each access check removed", { concurrency: 2, timeout: HANG_MS }, () => {
  for (const [index, check] of REMOVED_CHECKS.entries()) {
    test(`removing ${check.name} fails "${check.fails}"`, async () => {
      const dir = scratchCopy(`removed-${index}`);
      const file = path.join(dir, check.file);
      writeFileSync(file, removeCheck(readFileSync(file, "utf8"), check));
      const { code, failed } = await failingTests(dir, check.tests);
      assert.notEqual(code, 0);
      assert.ok(
        failed.some((name) => name.includes(check.fails)),
        `expected a test named like "${check.fails}" to fail, got: ${failed.join("; ") || "none"}`,
      );
    });
  }
});
