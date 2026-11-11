import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

// Architecture rules that no linter knows, checked by reading the source.
// The rules are in AGENTS.md and docs/code-structure.md ("Dependency direction").

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKER_SRC = path.join(ROOT, "apps/worker/src");

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (/\.d\.ts$|\.gen\.ts$/.test(file)) continue;
    out.push(file);
  }
  return out.toSorted();
}

async function read(files) {
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

const rel = (file) => path.relative(ROOT, file);

// Every module specifier a file imports or re-exports, with whether the whole
// statement is type-only. Statements end with ";" (Biome enforces it), so a
// lazy match up to `from "x"` spans multi-line import lists.
function importsOf(text) {
  const out = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const m of text.matchAll(statement)) out.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ spec: m[1], typeOnly: false });
  }
  return out;
}

// The folder of apps/worker/src a file belongs to: api, imap, mail, lib, shims,
// or "root" for the modules directly in src/.
function workerArea(file) {
  const [first, second] = path.relative(WORKER_SRC, file).split(path.sep);
  return second === undefined ? "root" : first;
}

// docs/code-structure.md, "Inside apps/worker/src". Areas each one never imports.
const NEVER_IMPORTS = {
  api: ["imap"],
  imap: ["api"],
  mail: ["api", "imap"],
  root: ["api", "imap"],
  lib: ["api", "imap", "mail", "root", "lib", "shims"],
  shims: ["api", "imap", "mail", "root", "lib", "shims"],
};

// The entry composes every transport, so it alone may import api/ and imap/.
const ENTRY = path.join(WORKER_SRC, "index.ts");

function workerDirectionViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (file === ENTRY) continue;
    const from = workerArea(file);
    for (const { spec } of importsOf(text)) {
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      // lib/ and shims/ import nothing local, not even a sibling.
      const to = workerArea(target);
      if (NEVER_IMPORTS[from]?.includes(to)) found.push(`${rel(file)} (${from}) imports ${spec}`);
    }
  }
  return found;
}

// docs/code-structure.md, "Between packages". Which @cfmail packages each may import.
const PACKAGE_RULES = [
  { dir: "packages/db/src", may: [] },
  { dir: "packages/shared/src", may: ["@cfmail/db"] },
  { dir: "apps/worker/src", may: ["@cfmail/db", "@cfmail/shared"] },
  // The web app reads the Worker's route types, type-only; it runs no Worker code.
  { dir: "apps/web/src", may: ["@cfmail/shared"], typeOnly: ["@cfmail/worker"] },
];

const packageOf = (spec) => spec.split("/").slice(0, 2).join("/");

function packageViolations(rule, sources) {
  const found = [];
  for (const { file, text } of sources) {
    for (const { spec, typeOnly } of importsOf(text)) {
      if (!spec.startsWith("@cfmail/")) continue;
      const pkg = packageOf(spec);
      if (rule.may.includes(pkg)) continue;
      if (typeOnly && rule.typeOnly?.includes(pkg)) continue;
      found.push(`${rel(file)} imports ${spec}${typeOnly ? " (type-only)" : ""}`);
    }
  }
  return found;
}

// AGENTS.md invariant 3: live updates ride Server-Sent Events through UserHub.
const WEBSOCKET = /\bWebSocket(Pair)?\b|\bacceptWebSocket\b/;
const POLLING = /\brefetchInterval\b/;
// setInterval is allowed only where it moves no data. Each entry says why.
const INTERVAL_ALLOWED = {
  "apps/worker/src/hub.ts": "keeps open SSE streams alive with a comment frame",
  "apps/web/src/lib/time.ts": "re-renders relative times; makes no request",
};

function realtimeViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (WEBSOCKET.test(text)) found.push(`${rel(file)} uses WebSockets`);
    if (POLLING.test(text)) found.push(`${rel(file)} polls with refetchInterval`);
    if (/\bsetInterval\(/.test(text) && !INTERVAL_ALLOWED[rel(file)]) {
      found.push(`${rel(file)} calls setInterval`);
    }
  }
  return found;
}

// AGENTS.md invariant 12: only imap/store.ts touches the IMAP UID tables.
const IMAP_TABLES = /\bimap(Folder|Uid)\b|\bimap_(folder|uid)\b/;
const IMAP_STORE = path.join(WORKER_SRC, "imap/store.ts");

function imapTableViolations(sources) {
  return sources
    .filter(({ file, text }) => file !== IMAP_STORE && IMAP_TABLES.test(text))
    .map(({ file }) => `${rel(file)} touches imap_folder or imap_uid`);
}

const workerSources = await read(await sourceFiles(WORKER_SRC));
const webSources = await read(await sourceFiles(path.join(ROOT, "apps/web/src")));
const serviceWorker = await read([path.join(ROOT, "apps/web/public/sw.js")]);

test("the import scan sees the shapes the code uses", () => {
  const text = [
    'import { a } from "./a.ts";',
    'import type { B } from "../b.ts";',
    'import {\n  c,\n  type D,\n} from "@cfmail/shared/x";',
    'export { e } from "./e.ts";',
    'import "./side-effect.ts";',
    'const f = await import("./f.ts");',
  ].join("\n");
  assert.deepEqual(importsOf(text), [
    { spec: "./a.ts", typeOnly: false },
    { spec: "../b.ts", typeOnly: true },
    { spec: "@cfmail/shared/x", typeOnly: false },
    { spec: "./e.ts", typeOnly: false },
    { spec: "./side-effect.ts", typeOnly: false },
    { spec: "./f.ts", typeOnly: false },
  ]);
});

test("the scans find files to read", () => {
  assert.ok(workerSources.length > 50, `worker files: ${workerSources.length}`);
  assert.ok(webSources.length > 50, `web files: ${webSources.length}`);
});

test("worker folders import only in the documented direction", () => {
  assert.deepEqual(workerDirectionViolations(workerSources), []);
});

for (const rule of PACKAGE_RULES) {
  test(`${rule.dir} imports only the workspace packages it may`, async () => {
    const sources = await read(await sourceFiles(path.join(ROOT, rule.dir)));
    assert.deepEqual(packageViolations(rule, sources), []);
  });
}

test("live updates use SSE: no WebSockets, no polling", () => {
  assert.deepEqual(realtimeViolations([...workerSources, ...webSources, ...serviceWorker]), []);
});

test("every setInterval allowance still points at a file", () => {
  const files = new Set([...workerSources, ...webSources].map(({ file }) => rel(file)));
  assert.deepEqual(
    Object.keys(INTERVAL_ALLOWED).filter((file) => !files.has(file)),
    [],
  );
});

test("only imap/store.ts touches the IMAP UID tables", () => {
  assert.deepEqual(imapTableViolations(workerSources), []);
});

// AGENTS.md invariant 1: apps/worker is the only runtime. A second Worker would
// arrive as a second Wrangler config. test/entry.test.ts pins the handlers.
test("apps/worker is the only Worker in the workspace", async () => {
  const groups = ["apps", "packages"];
  const entries = await Promise.all(
    groups.map((group) => readdir(path.join(ROOT, group), { withFileTypes: true })),
  );
  const packages = groups.flatMap((group, i) =>
    entries[i].filter((entry) => entry.isDirectory()).map((entry) => `${group}/${entry.name}`),
  );
  const listings = await Promise.all(packages.map((pkg) => readdir(path.join(ROOT, pkg))));
  const workers = packages.filter((_, i) =>
    listings[i].some((f) => /^wrangler\.(jsonc?|toml)$/.test(f)),
  );
  assert.deepEqual(workers, ["apps/worker"]);
});
