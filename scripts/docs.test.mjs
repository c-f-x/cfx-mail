// Docs say what holds: they name only paths that exist, the brief stays short,
// and the decision log keeps its shape (/project-foundations, step 2;
// c-f-x conventions, section 13).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BRIEF,
  BRIEF_MAX_LINES,
  CHECKED_DOCS,
  decisionViolations,
  pathViolations,
} from "./docs.mjs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
// Docs name a file the way a reader finds it: from the repository root, from
// the doc's own folder (a link), or from inside one of the packages, as
// `api/svc.ts` for `apps/worker/src/api/svc.ts` or `backup/lib.mjs` for
// `scripts/backup/lib.mjs`.
const BASES = [
  "",
  "apps/worker/src/",
  "apps/worker/",
  "apps/web/src/",
  "apps/web/",
  "packages/db/src/",
  "packages/db/",
  "packages/shared/src/",
  "packages/shared/",
  "scripts/",
];
// A file git ignores on purpose, such as apps/worker/.dev.vars, is one the
// reader creates; naming it is right.
const ignored = (path) =>
  spawnSync("git", ["check-ignore", "-q", path], { cwd: root }).status === 0;
const existsFor = (doc) => (path) => {
  const docDir = doc.includes("/") ? doc.slice(0, doc.lastIndexOf("/") + 1) : "";
  return [docDir, ...BASES].some((base) => existsSync(new URL(base + path, root))) || ignored(path);
};

test("the path check flags missing paths and stale planned marks", () => {
  const text = [
    "See `docs/architecture.md` and `apps/worker/src/gone.ts`.",
    "Later: `apps/web/src/features/` (planned), and again `apps/web/src/features/`.",
    "Stale: `docs/decisions.md` (planned).",
    "Not paths: `/api/health`, `mail-<name>`, `cfx-kit:docs/conventions.md`, `$scratch`, `wrangler.jsonc`, `@cfx-mail/db`, `typescript/no-floating-promises`, `~/cfx-mail-backups`.",
    "With a line number: `docs/code-structure.md:12`.",
  ].join("\n");
  const existing = new Set(["docs/architecture.md", "docs/decisions.md", "docs/code-structure.md"]);
  assert.deepEqual(
    pathViolations("sample.md", text, (p) => existing.has(p)),
    [
      'sample.md: docs/decisions.md exists, so drop its "(planned)"',
      "sample.md: apps/worker/src/gone.ts does not exist",
    ],
  );
});

for (const doc of CHECKED_DOCS) {
  test(`${doc} names only paths that exist or are marked planned`, () => {
    assert.deepEqual(pathViolations(doc, read(doc), existsFor(doc)), []);
  });
}

test(`${BRIEF} stays at or under ${BRIEF_MAX_LINES} lines`, () => {
  const lines = read(BRIEF).split("\n").length;
  assert.ok(lines <= BRIEF_MAX_LINES, `${BRIEF} has ${lines} lines`);
});

test("the decision check flags a wrong heading, a gap and an unmarked supersession", () => {
  const log = [
    "## D-1 · First · decided (2026-01-01)",
    "## D-2 — Second — decided (2026-01-02)",
    "## D-4 · Fourth · decided (2026-01-04)",
    "Supersedes D-1.",
  ].join("\n");
  assert.deepEqual(decisionViolations(log), [
    'not in the form "## D-<n> · <title> · <status> (<date>)": ## D-2 — Second — decided (2026-01-02)',
    "D-4 should be D-2: numbers run 1, 2, 3 without gaps",
    `D-1's status should start "superseded by D-4", since D-4 supersedes it`,
  ]);
});

test("docs/decisions.md keeps the family's shape", () => {
  assert.deepEqual(decisionViolations(read("docs/decisions.md")), []);
});
