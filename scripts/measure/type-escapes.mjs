// Per-package counts of type escapes and lint suppressions (AST for types, regex for comments).
// Reads only. Usage, from the repo root:
//   npm i --prefix /tmp/ts5 typescript@5
//   git ls-files '*.ts' '*.tsx' '*.mjs' '*.js' | grep -v -e node_modules -e drizzle/meta > /tmp/files.txt
//   node scripts/measure/type-escapes.mjs . /tmp/files.txt /tmp/ts5/node_modules/typescript [--detail]

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const list = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
const tsArg =
  process.argv[4] && !process.argv[4].startsWith("--")
    ? process.argv[4]
    : "/tmp/ts5/node_modules/typescript";
const ts = createRequire(import.meta.url)(tsArg);

const isTest = (p) => /(^|\/)test\//.test(p) || /\.test\.[mc]?[jt]sx?$/.test(p);
function area(p) {
  if (p.endsWith("routeTree.gen.ts")) return null;
  if (/\.config\.[mc]?[tj]s$/.test(p)) return "configs";
  if (p.startsWith("apps/worker/test/")) return "worker test";
  if (p.startsWith("apps/worker/")) return "worker src";
  if (p.startsWith("apps/web/"))
    return isTest(p)
      ? "web test"
      : p.includes("/components/ui/")
        ? "web src (components/ui, vendored)"
        : p.endsWith(".d.ts")
          ? "web src (.d.ts shim)"
          : "web src";
  if (p.startsWith("packages/db/")) return "db";
  if (p.startsWith("packages/shared/")) return "shared";
  if (p.startsWith("scripts/")) return isTest(p) ? "scripts test" : "scripts";
  return "other";
}
const KEYS = [
  "files",
  "any",
  "as (plain)",
  "as const",
  "as unknown as",
  "<T>x assertion",
  "non-null !",
  "satisfies",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "biome-ignore",
  "oxlint-disable",
  "eslint-disable",
  "react-doctor",
];
const tot = {};
const detail = [];
const ruleCounts = {};
const bump = (a, k, n = 1) => {
  if (!tot[a]) tot[a] = Object.fromEntries(KEYS.map((x) => [x, 0]));
  tot[a][k] += n;
};

for (const rel of list) {
  const a = area(rel);
  if (!a) continue;
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  bump(a, "files");
  const at = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) {
      bump(a, "any");
      detail.push(["any", at(n), n.parent.getText(sf).split("\n")[0].slice(0, 90)]);
    } else if (ts.isAsExpression(n)) {
      const isConst = ts.isTypeReferenceNode(n.type) && n.type.typeName.getText(sf) === "const";
      const isUnknownAs =
        n.expression &&
        ts.isAsExpression(n.expression) &&
        n.expression.type.kind === ts.SyntaxKind.UnknownKeyword;
      const isInnerUnknown =
        n.type.kind === ts.SyntaxKind.UnknownKeyword &&
        ts.isAsExpression(n.parent) &&
        n.parent.expression === n;
      if (isConst) bump(a, "as const");
      else if (isUnknownAs) {
        bump(a, "as unknown as");
        detail.push(["as unknown as", at(n), n.getText(sf).split("\n")[0].slice(0, 90)]);
      } else if (!isInnerUnknown) bump(a, "as (plain)");
    } else if (ts.isTypeAssertionExpression(n)) bump(a, "<T>x assertion");
    else if (ts.isNonNullExpression(n)) bump(a, "non-null !");
    else if (ts.isSatisfiesExpression?.(n)) bump(a, "satisfies");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    const loc = `${rel}:${i + 1}`;
    const inComment = /\/\/|\/\*|^\s*\*|\{\s*\/\*/.test(ln);
    if (!inComment) return;
    for (const d of ["@ts-expect-error", "@ts-ignore", "@ts-nocheck"])
      if (ln.includes(d)) {
        bump(a, d);
        detail.push([d, loc, ln.trim().slice(0, 110)]);
      }
    const bi = ln.match(
      /biome-ignore(?:-all|-start|-end)?\s+([A-Za-z0-9/_-]+(?:\/[A-Za-z0-9_]+)*)/,
    );
    if (ln.includes("biome-ignore")) {
      bump(a, "biome-ignore");
      const r = bi ? bi[1] : "?";
      ruleCounts[`biome-ignore ${r}`] = (ruleCounts[`biome-ignore ${r}`] ?? 0) + 1;
      detail.push(["biome-ignore", loc, ln.trim().slice(0, 130)]);
    }
    if (/oxlint-disable/.test(ln)) {
      bump(a, "oxlint-disable");
      const r = (ln.match(/oxlint-disable[-a-z]*\s+([^\s*]+(?:\s*,\s*[^\s*]+)*)/) ?? [
        null,
        "(all)",
      ])[1];
      ruleCounts[`oxlint-disable ${r}`] = (ruleCounts[`oxlint-disable ${r}`] ?? 0) + 1;
      detail.push(["oxlint-disable", loc, ln.trim().slice(0, 130)]);
    }
    if (/eslint-disable/.test(ln)) {
      bump(a, "eslint-disable");
      const r = (ln.match(/eslint-disable[-a-z]*\s+([^\s*]+(?:\s*,\s*[^\s*]+)*)/) ?? [
        null,
        "(all)",
      ])[1];
      ruleCounts[`eslint-disable ${r}`] = (ruleCounts[`eslint-disable ${r}`] ?? 0) + 1;
      detail.push(["eslint-disable", loc, ln.trim().slice(0, 130)]);
    }
    if (/react-doctor/i.test(ln)) {
      bump(a, "react-doctor");
      detail.push(["react-doctor", loc, ln.trim().slice(0, 130)]);
    }
  });
}

const areas = Object.keys(tot).toSorted();
console.log(`| metric | ${areas.join(" | ")} | total |`);
console.log(`|---|${areas.map(() => "---").join("|")}|---|`);
for (const k of KEYS)
  console.log(
    `| ${k} | ` +
      areas.map((a) => tot[a][k]).join(" | ") +
      ` | ${areas.reduce((s, a) => s + tot[a][k], 0)} |`,
  );
console.log("\n### Suppression rules\n| rule | count |\n|---|---|");
for (const [k, v] of Object.entries(ruleCounts).toSorted((x, y) => y[1] - x[1]))
  console.log(`| ${k} | ${v} |`);
if (process.argv.includes("--detail")) {
  console.log("\n### Detail\n| kind | file:line | text |\n|---|---|---|");
  for (const d of detail.toSorted((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])))
    console.log(`| ${d[0]} | ${d[1]} | \`${d[2].replace(/\|/g, "\\|")}\` |`);
}
