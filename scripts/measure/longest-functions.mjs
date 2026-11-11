// Longest functions and longest call chains in production code. Reads only.
// Usage, from the repo root:
//   npm i --prefix /tmp/ts5 typescript@5
//   node scripts/measure/longest-functions.mjs . 15 /tmp/ts5/node_modules/typescript
// Needs a `typescript` package that exposes the JS compiler API (5.x or 6.x;
// the repo's typescript@7 is the native compiler and does not).
// Counts FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression.
// Length = end line - start line + 1 (braces included). Nested functions count individually.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const topN = Number(process.argv[3] ?? 15);
const tsPath = process.argv[4] ?? "/tmp/ts5/node_modules/typescript";
const ts = createRequire(import.meta.url)(tsPath);

const SOURCE_DIRS = [
  "apps/worker/src",
  "apps/web/src",
  "packages/db/src",
  "packages/shared/src",
  "scripts",
];
const SKIP_DIR = new Set(["node_modules", "dist", ".turbo", ".wrangler", "drizzle"]);
const isTestOrConfig = (p) =>
  /(^|\/)test\//.test(p) || /\.test\.[mc]?[jt]sx?$/.test(p) || /\.config\.[mc]?[tj]s$/.test(p);
const isGenerated = (p) => p.endsWith("routeTree.gen.ts");
const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "use",
  "on",
  "options",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((d) =>
  fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : [],
)
  .map((f) => path.relative(root, f))
  .filter((f) => !isTestOrConfig(f) && !isGenerated(f))
  .toSorted();

const fns = [];
const chains = [];

function lineSpan(sf, node) {
  const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { start: s, end: e, lines: e - s + 1 };
}

function routeName(call) {
  // x.get("/path", ..., handler)  ->  GET /path
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const m = call.expression.name.text;
  if (!ROUTE_METHODS.has(m)) return null;
  const a0 = call.arguments[0];
  if (!a0 || !(ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))) return null;
  return `${m.toUpperCase()} ${a0.text}`;
}

function nameOf(node, sf) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "<default export>";
  if (ts.isMethodDeclaration(node)) {
    const cls = ts.isClassLike(node.parent) ? (node.parent.name?.text ?? "<class>") : "<obj>";
    return `${cls}.${node.name.getText(sf)}`;
  }
  const p = node.parent;
  if (p && ts.isCallExpression(p) && p.arguments.includes(node)) {
    const r = routeName(p);
    if (r) return `route ${r}`;
    return `callback to ${p.expression.getText(sf).split("\n")[0].slice(0, 50)}()`;
  }
  if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
  if (p && ts.isParenthesizedExpression(p)) return "<iife/parenthesised>";
  if (p && ts.isPropertyDeclaration(p)) return p.name.getText(sf);
  if (p && ts.isReturnStatement(p)) return "<returned fn>";
  return "<anonymous>";
}

function enclosingName(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isArrowFunction(p) ||
      ts.isFunctionExpression(p)
    ) {
      const n = nameOf(p, sf);
      if (!n.startsWith("callback to") && n !== "<anonymous>") return n;
    }
  }
  return null;
}

function chainLinks(expr) {
  // count `.a().b().c()` links walking down the callee
  let n = 0;
  let cur = expr;
  for (;;) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      n++;
      cur = cur.expression.expression;
    } else if (
      ts.isPropertyAccessExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAwaitExpression(cur) ||
      ts.isParenthesizedExpression(cur)
    ) {
      cur = cur.expression;
    } else break;
  }
  return n;
}

for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const kind = rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      if (node.body) {
        const { start, lines } = lineSpan(sf, node);
        fns.push({
          file: rel,
          line: start,
          lines,
          end: lineSpan(sf, node).end,
          name: nameOf(node, sf),
          kind: ts.SyntaxKind[node.kind],
          in: enclosingName(node, sf),
        });
      }
    }
    // outermost call chain: a CallExpression that is not itself the receiver of a longer chain
    if (ts.isCallExpression(node)) {
      const parentIsChain =
        node.parent &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        node.parent.parent &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent;
      if (!parentIsChain) {
        const links = chainLinks(node);
        if (links >= 3) {
          const { start, lines } = lineSpan(sf, node);
          chains.push({ file: rel, line: start, lines, links, in: enclosingName(node, sf) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const fmt = (rows, cols) =>
  rows.map((r) => `| ${cols.map((c) => r[c] ?? "").join(" | ")} |`).join("\n");

// A route-factory function (e.g. mailboxesRoutes) only wraps route handlers; flag it so
// the handlers themselves can be ranked on their own.
for (const f of fns) f.isRoute = f.name.startsWith("route ");
for (const f of fns) {
  f.container = fns.some(
    (g) => g !== f && g.isRoute && g.file === f.file && g.line >= f.line && g.end <= f.end,
  );
}
fns.sort((a, b) => b.lines - a.lines);
chains.sort((a, b) => b.lines - a.lines);

console.log(`files scanned: ${files.length}; functions counted: ${fns.length}`);
console.log(
  `functions > 50 lines: ${fns.filter((f) => f.lines > 50).length}; > 100: ${fns.filter((f) => f.lines > 100).length}; > 200: ${fns.filter((f) => f.lines > 200).length}`,
);
console.log(
  `\n## Longest ${topN} functions\n| lines | file:line | name | kind | inside |\n|---|---|---|---|---|`,
);
console.log(
  fmt(
    fns.slice(0, topN).map((f) => ({ ...f, loc: `${f.file}:${f.line}` })),
    ["lines", "loc", "name", "kind", "in"],
  ),
);
const leaves = fns.filter((f) => !f.container);
console.log(
  `\n## Longest ${topN} functions excluding route-factory containers\n| lines | file:line | name | kind | inside |\n|---|---|---|---|---|`,
);
console.log(
  fmt(
    leaves.slice(0, topN).map((f) => ({ ...f, loc: `${f.file}:${f.line}` })),
    ["lines", "loc", "name", "kind", "in"],
  ),
);
for (const area of ["apps/worker", "apps/web"]) {
  console.log(
    `\n## Longest 10 non-container functions in ${area}\n| lines | file:line | name | kind | inside |\n|---|---|---|---|---|`,
  );
  console.log(
    fmt(
      leaves
        .filter((f) => f.file.startsWith(area))
        .slice(0, 10)
        .map((f) => ({ ...f, loc: `${f.file}:${f.line}` })),
      ["lines", "loc", "name", "kind", "in"],
    ),
  );
}
const routes = fns.filter((f) => f.isRoute);
console.log(
  `\nroute handlers: ${routes.length}; > 50 lines: ${routes.filter((f) => f.lines > 50).length}; > 100: ${routes.filter((f) => f.lines > 100).length}`,
);
console.log(
  `\n## Longest ${topN} route handlers\n| lines | file:line | name | inside |\n|---|---|---|---|`,
);
console.log(
  fmt(
    routes.slice(0, topN).map((f) => ({ ...f, loc: `${f.file}:${f.line}` })),
    ["lines", "loc", "name", "in"],
  ),
);
console.log(
  `\n## Longest ${topN} call chains (>= 3 chained calls, outermost only)\n| lines | file:line | chained calls | inside |\n|---|---|---|---|`,
);
console.log(
  fmt(
    chains.slice(0, topN).map((f) => ({ ...f, loc: `${f.file}:${f.line}` })),
    ["lines", "loc", "links", "in"],
  ),
);
