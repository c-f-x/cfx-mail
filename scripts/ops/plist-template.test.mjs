import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const template = readFileSync(
  join(import.meta.dirname, "com.cfx-mail.backup.plist.template"),
  "utf8",
);
const [comment = "", body = ""] = template.split("-->");
const placeholders = (text) =>
  [...new Set(text.match(/__[A-Z_]+__/g) ?? [])].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

test("every placeholder used in the plist is explained in its header comment", () => {
  assert.ok(placeholders(body).length > 0);
  for (const p of placeholders(body)) {
    assert.match(comment, new RegExp(`^\\s+${p}\\s+\\S`, "m"), `${p} is not explained`);
  }
});

test("the header comment explains no placeholder the plist does not use", () => {
  const explained = [...comment.matchAll(/^\s+(__[A-Z_]+__)\s+\S/gm)].map((m) => m[1]).toSorted();
  assert.deepEqual(explained, placeholders(body));
});

test("the plist runs the script that exists in the repository", () => {
  assert.match(body, /<string>__REPO__\/scripts\/ops\/backup-daily\.sh<\/string>/);
  assert.ok(existsSync(join(import.meta.dirname, "backup-daily.sh")));
});

test("the job sets CFX_SITE, since the backup reads the deployment from the site file", () => {
  assert.match(body, /<key>CFX_SITE<\/key>\s*<string>__SITE__<\/string>/);
});
