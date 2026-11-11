#!/usr/bin/env node
// Counts tracked source files and lines per package, and direct and total
// dependencies per package from package.json and pnpm-lock.yaml.
// Run from the repo root: `node scripts/measure/size.mjs`. Reads only.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SOURCE = /\.(ts|tsx|mjs|js|sql|sh|css)$/;
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

/** @type {[string, (file: string) => boolean][]} */
const areas = [
  ["apps/worker/src", (f) => f.startsWith("apps/worker/src/")],
  ["apps/worker/test", (f) => f.startsWith("apps/worker/test/")],
  [
    "apps/web/src (no tests, no routeTree.gen.ts)",
    (f) => f.startsWith("apps/web/src/") && !/\.test\./.test(f) && !f.endsWith("routeTree.gen.ts"),
  ],
  ["apps/web/src tests", (f) => f.startsWith("apps/web/src/") && /\.test\./.test(f)],
  ["apps/web/src/routeTree.gen.ts", (f) => f === "apps/web/src/routeTree.gen.ts"],
  ["packages/db/src", (f) => f.startsWith("packages/db/src/")],
  [
    "packages/db/drizzle (*.sql)",
    (f) => f.startsWith("packages/db/drizzle/") && f.endsWith(".sql"),
  ],
  ["packages/shared/src", (f) => f.startsWith("packages/shared/src/")],
  ["scripts", (f) => f.startsWith("scripts/")],
];

/** @param {string[]} files */
function count(files) {
  let lines = 0;
  let nonBlank = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    lines += all.length;
    nonBlank += all.filter((l) => l.trim() !== "").length;
  }
  return { files: files.length, lines, nonBlank };
}

console.log("| Area | Files | Lines | Non-blank lines |\n|---|---:|---:|---:|");
for (const [name, match] of areas) {
  const c = count(tracked.filter((f) => SOURCE.test(f) && match(f)));
  console.log(`| ${name} | ${c.files} | ${c.lines} | ${c.nonBlank} |`);
}

console.log("\n| apps/worker/src folder | Files | Lines |\n|---|---:|---:|");
const workerSrc = tracked.filter((f) => f.startsWith("apps/worker/src/") && SOURCE.test(f));
const byDir = new Map();
for (const f of workerSrc) {
  const rest = f.slice("apps/worker/src/".length);
  const dir = rest.includes("/") ? rest.split("/")[0] : "(top level)";
  byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
}
for (const [dir, files] of [...byDir].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const c = count(files);
  console.log(`| ${dir} | ${c.files} | ${c.lines} |`);
}

// Dependencies: walks `pnpm ls --json --depth Infinity` for each workspace
// package on its own (pnpm marks repeats inside one tree as "deduped" and shows
// their children once) and counts unique name@version pairs, peers included.
const workspace = [
  "cloudflare-mail",
  "@cfx-mail/web",
  "@cfx-mail/worker",
  "@cfx-mail/db",
  "@cfx-mail/shared",
];
function tree(name, prodOnly) {
  const args = ["-y", "pnpm@12.4.1", "--filter", name, "ls", "--depth", "Infinity", "--json"];
  if (prodOnly) args.push("--prod");
  return JSON.parse(execFileSync("npx", args, { encoding: "utf8", maxBuffer: 1 << 28 }))[0];
}
function walk(deps, seen) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    const key = `${name}@${d.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    walk(d.dependencies, seen);
  }
  return seen;
}
console.log(
  "\n| Package | Direct deps | Direct devDeps | Unique packages, prod | Unique packages, prod + dev |",
);
console.log("|---|---:|---:|---:|---:|");
for (const name of workspace) {
  const prod = tree(name, true);
  const full = tree(name, false);
  const m = JSON.parse(readFileSync(`${full.path}/package.json`, "utf8"));
  const prodCount = walk(prod.dependencies, new Set()).size;
  const allCount = walk({ ...full.dependencies, ...full.devDependencies }, new Set()).size;
  const nd = Object.keys(m.dependencies ?? {}).length;
  const ndd = Object.keys(m.devDependencies ?? {}).length;
  console.log(`| ${name} | ${nd} | ${ndd} | ${prodCount} | ${allCount} |`);
}
const lock = readFileSync("pnpm-lock.yaml", "utf8");
const lastDoc = lock.split(/^---$/m).at(-1);
const packagesSection = lastDoc.split(/^packages:\s*$/m)[1]?.split(/^snapshots:\s*$/m)[0] ?? "";
console.log(
  `\nResolved packages in pnpm-lock.yaml (main document): ${(packagesSection.match(/^ {2}\S.*:$/gm) ?? []).length}`,
);
