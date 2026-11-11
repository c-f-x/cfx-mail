// Every package in the workspace carries the same version and the licence in
// LICENSE, so a release tag names one version and every manifest agrees.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseJsonc } from "./backup/lib.mjs";

const root = new URL("..", import.meta.url);
const text = (path) => readFileSync(new URL(path, root), "utf8");
const workspace = text("pnpm-workspace.yaml");
const folders = [...workspace.matchAll(/^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/gm)].map((m) => m[1]);

const manifests = () => [
  "package.json",
  ...folders.flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${dir}/${d.name}/package.json`),
  ),
];

test("the workspace lists its package folders", () => {
  assert.deepEqual(folders.toSorted(), ["apps", "packages"]);
});

test("every package has the root's version and the MIT licence", () => {
  const rootVersion = parseJsonc(text("package.json")).version;
  assert.match(rootVersion, /^\d+\.\d+\.\d+$/);
  assert.match(text("LICENSE"), /^MIT License/);
  const all = manifests();
  assert.equal(all.length, 5);
  for (const path of all) {
    const pkg = parseJsonc(text(path));
    assert.equal(pkg.version, rootVersion, `${path} version`);
    assert.equal(pkg.license, "MIT", `${path} license`);
  }
});
