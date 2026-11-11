import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { parseJsonc } from "./backup/lib.mjs";
import { deploymentValues, joinedConfig, templatePath, writeJoinedConfig } from "./site-config.mjs";

const template = parseJsonc(await readFile(templatePath, "utf8"));

// Fake ids held in constants, so the repository scan in
// wrangler-config.test.mjs does not read them as real ones.
const fakeAccount = "f".repeat(32);
const fakeDatabase = "00000000-0000-4000-8000-000000000000";
const [shortAccount, shortDatabase] = ["abc", "12"];

const good = {
  account_id: fakeAccount,
  worker_name: "mail-demo",
  hostnames: ["mail.example.com", "mail.example.org"],
  d1: { database_name: "mail-demo", database_id: fakeDatabase },
  r2: { bucket_name: "mail-demo-blobs" },
};
const site = { deployments: { demo: good } };

test("a complete deployment is accepted as written", () => {
  assert.deepEqual(deploymentValues(site, "demo"), { block: good });
});

test("each wrong or missing value is named", () => {
  const bad = {
    deployments: {
      demo: {
        account_id: shortAccount,
        worker_name: "Mail Demo",
        hostnames: ["not a host"],
        d1: { database_name: "mail-demo", database_id: shortDatabase },
        r2: {},
        vars: {},
      },
    },
  };
  assert.deepEqual(deploymentValues(bad, "demo").errors, [
    "demo.vars is not a known setting.",
    "demo.account_id must be 32 hex characters.",
    "demo.worker_name must be a Worker name.",
    'demo.hostnames: "not a host" is not a hostname.',
    "demo.d1.database_id must be a UUID.",
    "demo.r2.bucket_name is missing.",
  ]);
  assert.deepEqual(
    deploymentValues({ deployments: { demo: { ...good, hostnames: [] } } }, "demo").errors,
    ["demo.hostnames must list at least one hostname."],
  );
});

test("an unknown deployment lists the known ones", () => {
  assert.deepEqual(deploymentValues(site, "other").errors, [
    'No deployment named "other" in cf-mail.jsonc (it has: demo).',
  ]);
  assert.deepEqual(deploymentValues({}, "demo").errors, ['cf-mail.jsonc has no "deployments".']);
});

test("the joined config adds one env block with every binding the Worker needs", () => {
  const joined = joinedConfig(template, dirname(templatePath), "demo", good);
  const env = joined.env.demo;
  assert.deepEqual(Object.keys(joined.env), ["demo"]);
  assert.equal(env.name, "mail-demo");
  assert.equal(env.account_id, good.account_id);
  assert.deepEqual(env.routes, [
    { pattern: "mail.example.com", custom_domain: true },
    { pattern: "mail.example.org", custom_domain: true },
  ]);
  assert.equal(env.d1_databases[0].binding, "DB");
  assert.equal(env.d1_databases[0].database_id, good.d1.database_id);
  assert.deepEqual(env.r2_buckets, [{ binding: "BLOBS", bucket_name: "mail-demo-blobs" }]);
  assert.deepEqual(env.durable_objects, template.durable_objects);
  // Wrangler does not inherit these into an env block, so each one the
  // template declares must be repeated.
  for (const key of ["d1_databases", "r2_buckets", "durable_objects", "send_email"]) {
    if (template[key]) assert.ok(env[key], `env.demo.${key} is missing`);
  }
  for (const binding of env.send_email) assert.equal(binding.remote, undefined);
  assert.equal(template.send_email.length, env.send_email.length);
});

test("paths in the joined config are absolute, since it is written elsewhere", () => {
  const joined = joinedConfig(template, dirname(templatePath), "demo", good);
  assert.ok(isAbsolute(joined.main));
  assert.ok(isAbsolute(joined.assets.directory));
  assert.ok(isAbsolute(joined.env.demo.d1_databases[0].migrations_dir));
  assert.ok(isAbsolute(joined.d1_databases[0].migrations_dir));
  // The template itself is left as it was.
  assert.ok(!isAbsolute(template.main));
});

test("the site file is read from CFX_SITE and the config written to the scratch folder", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cfmail-site-test-"));
  try {
    await writeFile(join(scratch, "cf-mail.jsonc"), `// comment\n${JSON.stringify(site)}`);
    const { configPath, accountId } = writeJoinedConfig("demo", scratch, { CFX_SITE: scratch });
    assert.equal(configPath, join(scratch, "wrangler.jsonc"));
    assert.equal(accountId, good.account_id);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(written.env.demo.name, "mail-demo");
    assert.throws(() => writeJoinedConfig("demo", scratch, {}), /CFX_SITE is not set/);
    assert.throws(
      () => writeJoinedConfig("nope", scratch, { CFX_SITE: scratch }),
      /No deployment named "nope"/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
