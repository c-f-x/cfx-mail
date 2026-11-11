import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, LIMITS, measure, publishedSourceMaps, report, run } from "./check-bundles.mjs";

const SCRIPT = fileURLToPath(new URL("./check-bundles.mjs", import.meta.url));

// Folders this run creates, removed when it ends, even on failure.
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// A build output on disk: a Worker index.js and a web dist with the given files.
function fakeBuild({ workerBytes, webFiles }) {
  const root = mkdtempSync(path.join(tmpdir(), "cfx-mail-budget-test-"));
  made.push(root);
  const workerDir = path.join(root, "worker");
  const webDir = path.join(root, "web");
  mkdirSync(workerDir);
  mkdirSync(path.join(webDir, "assets"), { recursive: true });
  writeFileSync(path.join(workerDir, "index.js"), workerBytes);
  for (const [name, bytes] of Object.entries(webFiles)) {
    writeFileSync(path.join(webDir, name), bytes);
  }
  return { workerDir, webDir };
}

const text = (n) => Buffer.from("const a = 1;\n".repeat(n));

test("measure counts JavaScript and CSS, leaves source maps out, and finds the largest chunk", () => {
  const measured = measure({
    workerIndex: Buffer.alloc(1000, 97),
    webFiles: [
      { name: "assets/a.js", bytes: Buffer.alloc(300, 97) },
      { name: "assets/b.js", bytes: Buffer.alloc(500, 98) },
      { name: "assets/a.css", bytes: Buffer.alloc(200, 99) },
      { name: "assets/a.js.map", bytes: Buffer.alloc(99_999, 100) },
    ],
  });
  assert.equal(measured.workerRaw, 1000);
  assert.equal(measured.webJsRaw, 800);
  assert.equal(measured.webCssRaw, 200);
  assert.equal(measured.webLargestJsRaw, 500);
  assert.equal(measured.webLargestJsName, "assets/b.js");
  assert.ok(measured.workerGzip < measured.workerRaw, "repeated bytes compress");
});

test("evaluate passes at the limit and fails one byte over", () => {
  const limits = [{ key: "workerRaw", label: "Worker", limit: 100 }];
  assert.equal(evaluate({ workerRaw: 100 }, limits)[0].ok, true);
  assert.equal(evaluate({ workerRaw: 101 }, limits)[0].ok, false);
});

test("every limit names a value that measure returns", () => {
  const measured = measure({ workerIndex: Buffer.from("x"), webFiles: [] });
  for (const { key } of LIMITS) assert.equal(typeof measured[key], "number", key);
});

test("the report names the measured value, the limit and what to do", () => {
  const limits = [{ key: "workerRaw", label: "Worker bundle, raw", limit: 1000 }];
  const measured = { workerRaw: 1234, webLargestJsName: "assets/x.js" };
  const out = report(evaluate(measured, limits), measured);
  assert.match(out, /OVER BUDGET: Worker bundle, raw is 1,234 bytes, the limit is 1,000\./);
  assert.match(out, /raise the limit in scripts\/budgets\/check-bundles\.mjs and say why/);
});

test("run reports a missing build output with exit code 2", () => {
  const { code, output } = run({
    workerDir: path.join(tmpdir(), "cfx-mail-no-such-dir", "worker"),
    webDir: path.join(tmpdir(), "cfx-mail-no-such-dir", "web"),
  });
  assert.equal(code, 2);
  assert.match(output, /Build output not found/);
  assert.match(output, /build/);
});

test("run passes a small build against the real limits", () => {
  const dirs = fakeBuild({
    workerBytes: text(1000),
    webFiles: { "assets/app.js": text(2000), "assets/app.css": text(50) },
  });
  const { code, output } = run(dirs);
  assert.equal(code, 0, output);
  assert.match(output, /ok +Worker bundle, raw/);
});

test("the command line exits 1 when a bundle is over its limit", () => {
  // Random bytes do not compress, so raw and gzip both exceed the Worker limits.
  const limit = LIMITS.find((l) => l.key === "workerRaw").limit;
  const dirs = fakeBuild({
    workerBytes: randomBytes(limit + 1),
    webFiles: { "assets/app.js": text(10) },
  });
  const result = spawnSync("node", [SCRIPT, dirs.workerDir, dirs.webDir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OVER BUDGET: Worker bundle, raw is/);
  assert.match(result.stderr, /OVER BUDGET: Worker bundle, gzip is/);
  assert.match(result.stderr, /If this growth is intended, raise the limit in/);
});

test("publishedSourceMaps lists the maps .assetsignore does not keep back", () => {
  const names = ["assets/a.js", "assets/a.js.map", "index.html"];
  assert.deepEqual(publishedSourceMaps(names, null), ["assets/a.js.map"]);
  assert.deepEqual(publishedSourceMaps(names, "# comment\n*.map\n"), []);
  assert.deepEqual(publishedSourceMaps(names, "**/*.map"), []);
  assert.deepEqual(publishedSourceMaps(names, "*.map\n!assets/a.js.map"), ["assets/a.js.map"]);
  assert.deepEqual(publishedSourceMaps(["assets/a.js"], null), []);
});

test("run fails when a source map would be published with the assets", () => {
  const dirs = fakeBuild({
    workerBytes: text(1000),
    webFiles: { "assets/app.js": text(20), "assets/app.js.map": text(20) },
  });
  const { code, output } = run(dirs);
  assert.equal(code, 1, output);
  assert.match(output, /FAIL +Source maps published with the assets +1 \//);
  assert.match(output, /assets\/app\.js\.map would be uploaded/);
});

test("run passes when .assetsignore keeps the source maps back", () => {
  const dirs = fakeBuild({
    workerBytes: text(1000),
    webFiles: {
      "assets/app.js": text(20),
      "assets/app.js.map": text(20),
      ".assetsignore": Buffer.from("*.map\n"),
    },
  });
  const { code, output } = run(dirs);
  assert.equal(code, 0, output);
  assert.match(output, /ok +Source maps published with the assets +0 \//);
});

test("the command line exits 2 when the build is missing", () => {
  const result = spawnSync("node", [SCRIPT, "/nonexistent/worker", "/nonexistent/web"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Build output not found/);
});
