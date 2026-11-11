// What the docs check reads. Pure: callers pass text and an `exists` function.
// The path rule comes from cfx-analytics' scripts/lib/docs.mjs, the shape the
// c-f-x kit's `check docs` will take; this copy is replaced by the kit's once
// it is published (decision D-16 explains the same choice for the loader).

// The docs that say what holds now. The decision log and dated reviews are
// history: a path they name may be gone on purpose.
export const CHECKED_DOCS = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/code-structure.md",
  "docs/config-reference.md",
  "docs/data-model.md",
  "docs/runbooks/backup-and-restore.md",
  "docs/runbooks/monitoring.md",
];

export const BRIEF = "CLAUDE.md";
export const BRIEF_MAX_LINES = 150;

const PLANNED = " (planned)";
const REPO_ROOTS = /^(apps|packages|scripts|docs|\.github)\//;
const FILE_EXT = /\.(md|ts|tsx|mjs|js|json|jsonc|sql|ya?ml|toml|sh|txt|sha256|template)$/;

/**
 * Repo paths a doc names in backticks: a token with a slash that starts at a
 * top-level folder or ends in a file extension. URL paths ("/api/x"),
 * templates ("<name>"), globs, package names and other repos' paths
 * ("repo:path") are not this repo's files. A path followed by "(planned)" is
 * not built yet.
 */
export function namedPaths(text) {
  const paths = [];
  for (const m of text.matchAll(/`([^`\s]+)`( \(planned\))?/g)) {
    const token = m[1].replace(/:\d+(-\d+)?$/, "");
    if (!token.includes("/") || /^[/@~.]/.test(token) || /[<>*:{}()$]/.test(token)) continue;
    if (!REPO_ROOTS.test(token) && !FILE_EXT.test(token)) continue;
    paths.push({ path: token.replace(/\/$/, ""), planned: m[2] === PLANNED });
  }
  return paths;
}

/** Paths a doc names that do not exist, and paths marked planned that now exist. */
export function pathViolations(doc, text, exists) {
  const found = [];
  const named = namedPaths(text);
  const planned = new Set(named.filter((n) => n.planned).map((n) => n.path));
  for (const p of planned)
    if (exists(p)) found.push(`${doc}: ${p} exists, so drop its "(planned)"`);
  for (const { path } of named) {
    if (!planned.has(path) && !exists(path)) found.push(`${doc}: ${path} does not exist`);
  }
  return [...new Set(found)];
}

// `## D-<n> · <title> · <status> (<date>)`, the family's heading (c-f-x
// conventions, section 13).
const HEADING = /^## D-(\d+) · ([^·]+?) · ([^·()]+?) \((\d{4}-\d{2}-\d{2})\)$/;

/**
 * Problems with the decision log: a `## D-` heading in another shape, numbers
 * that skip or repeat, and a decision another one supersedes whose own
 * heading does not say so.
 */
export function decisionViolations(text) {
  const found = [];
  const entries = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## D-")) {
      const m = line.match(HEADING);
      if (!m) {
        found.push(`not in the form "## D-<n> · <title> · <status> (<date>)": ${line}`);
        current = null;
        continue;
      }
      current = { n: Number(m[1]), status: m[3], body: "" };
      entries.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  entries.forEach((e, i) => {
    if (e.n !== i + 1)
      found.push(`D-${e.n} should be D-${i + 1}: numbers run 1, 2, 3 without gaps`);
  });
  const byNumber = new Map(entries.map((e) => [e.n, e]));
  for (const e of entries) {
    for (const m of e.body.matchAll(/^Supersedes D-(\d+)\./gm)) {
      const old = byNumber.get(Number(m[1]));
      const mark = `superseded by D-${e.n}`;
      if (!old) found.push(`D-${e.n} supersedes D-${m[1]}, which does not exist`);
      else if (!old.status.startsWith(mark)) {
        found.push(`D-${old.n}'s status should start "${mark}", since D-${e.n} supersedes it`);
      }
    }
  }
  return found;
}
