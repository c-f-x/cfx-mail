import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTarget } from "./wrangler.mjs";

// parseTarget decides whether backup.mjs and restore.mjs touch a deployment in
// Cloudflare or local development storage. A mistake here points a restore at
// the wrong store, so each way of writing the command line is pinned.

test("a deployment name and a folder select that deployment in Cloudflare", () => {
  assert.deepEqual(parseTarget(["prod", "/backups/prod"]), {
    target: { name: "prod", persistTo: null },
    rest: ["/backups/prod"],
    missingName: false,
  });
});

test("--local selects local storage, and every other argument is left for the caller", () => {
  assert.deepEqual(parseTarget(["--local", "/backups/dev"]), {
    target: { name: null, persistTo: null },
    rest: ["/backups/dev"],
  });
});

test("--local may come after the folder", () => {
  assert.deepEqual(parseTarget(["/backups/dev", "--local"]), {
    target: { name: null, persistTo: null },
    rest: ["/backups/dev"],
  });
});

test("--local with --persist-to selects a separate local store", () => {
  assert.deepEqual(parseTarget(["--local", "--persist-to", "/tmp/store", "/backups/dev"]), {
    target: { name: null, persistTo: "/tmp/store" },
    rest: ["/backups/dev"],
  });
});

test("--persist-to may come before --local and after the folder", () => {
  assert.deepEqual(parseTarget(["--persist-to", "/tmp/store", "--local", "/backups/dev"]).target, {
    name: null,
    persistTo: "/tmp/store",
  });
  assert.deepEqual(parseTarget(["/backups/dev", "--local", "--persist-to", "/tmp/store"]), {
    target: { name: null, persistTo: "/tmp/store" },
    rest: ["/backups/dev"],
  });
});

test("--persist-to without --local is refused", () => {
  assert.throws(
    () => parseTarget(["--persist-to", "/tmp/store", "prod", "/backups/prod"]),
    /--persist-to only applies with --local/,
  );
  assert.throws(
    () => parseTarget(["prod", "/backups/prod", "--persist-to", "/tmp/store"]),
    /--persist-to only applies with --local/,
  );
});

test("--persist-to followed by --local is refused", () => {
  // It must not quietly fall back to the normal local store.
  assert.throws(
    () => parseTarget(["--persist-to", "--local", "/backups/dev"]),
    /--persist-to needs a folder/,
  );
});

test("without --local and without a name, the name is reported missing", () => {
  assert.deepEqual(parseTarget([]), {
    target: { name: null, persistTo: null },
    rest: [],
    missingName: true,
  });
  assert.equal(parseTarget(["--local"]).rest.length, 0);
});

test("arguments after the folder are passed through", () => {
  assert.deepEqual(parseTarget(["prod", "/backups/prod", "extra"]).rest, [
    "/backups/prod",
    "extra",
  ]);
});

test("--persist-to with no value is refused, so a restore cannot fall back to the default store", () => {
  assert.throws(
    () => parseTarget(["--local", "/backups/dev", "--persist-to"]),
    /--persist-to needs a folder/,
  );
});
