import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseJsonc } from "./backup/lib.mjs";
import { hostAllowed, parseHostList, sha256, trackedValues } from "./tracked-values.mjs";

const config = parseJsonc(
  await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"),
);

test("every request reaches the Worker, so the app's pages get its security headers", () => {
  // With only /api/* routed to the Worker first, Cloudflare serves the app's
  // pages straight from static assets and withSecurityHeaders never runs.
  assert.equal(config.assets.run_worker_first, true);
});

// AGENTS.md invariant 4: no secrets or deployment values in wrangler.jsonc.
// Settings live in system_config; SETUP_TOKEN and AUTH_SECRET are Worker
// secrets set with `wrangler secret put`. So no block may declare `vars`, and
// neither secret may be named in the file. Returns the offending paths.
function valuesThatBelongElsewhere(cfg) {
  const found = [];
  const blocks = [["", cfg], ...Object.entries(cfg.env ?? {}).map(([n, b]) => [`env.${n}.`, b])];
  for (const [prefix, block] of blocks) {
    if (block.vars !== undefined) found.push(`${prefix}vars`);
  }
  for (const name of ["SETUP_TOKEN", "AUTH_SECRET", "CLOUDFLARE_CLIENT_SECRET"]) {
    if (JSON.stringify(cfg).includes(name)) found.push(name);
  }
  return found;
}

test("the check catches values and secrets put in the config", () => {
  const bad = {
    vars: { BASE_URL: "https://mail.example" },
    env: { demo: { vars: { AUTH_SECRET: "x" } } },
  };
  assert.deepEqual(valuesThatBelongElsewhere(bad), ["vars", "env.demo.vars", "AUTH_SECRET"]);
});

test("wrangler.jsonc holds no secrets or deployment values", () => {
  assert.deepEqual(valuesThatBelongElsewhere(config), []);
});

test("development secrets in .dev.vars stay out of git", () => {
  const ignored = spawnSync("git", ["check-ignore", "-q", "apps/worker/.dev.vars"], {
    cwd: new URL("..", import.meta.url),
  });
  assert.equal(ignored.status, 0);
});

// Decision D-16: deployment values live in the private site file, so the
// template names no deployment.
test("the template config names no deployment", () => {
  assert.equal(config.env, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.account_id, undefined);
});

const repo = new URL("..", import.meta.url);
const publicHosts = parseHostList(
  await readFile(new URL("public-hosts.txt", import.meta.url), "utf8"),
);
const privateHashes = parseHostList(
  await readFile(new URL("private-values.sha256", import.meta.url), "utf8"),
);

// The samples are built at run time, so this file itself stays clean.
const sampleAccount = "0123456789abcdef".repeat(2);
const sampleHost = ["mail", "acme-corp", "com"].join(".");
const sampleId = ["database", "id"].join("_");

test("the scan flags account ids, resource ids, hostnames and addresses", () => {
  const text = [
    `account ${sampleAccount}`,
    `"${sampleId}": "b7a8-not-a-placeholder"`,
    `"${sampleId}": "<id from step 1>"`,
    `see https://${sampleHost}/inbox`,
    `write to ${["ada", sampleHost].join("@")}`,
    "user.email and import.meta.env stay code",
    "pnpm@12.4.1 is a version",
    "mail.example.com and ada@example.org are reserved",
  ].join("\n");
  assert.deepEqual(trackedValues(text, publicHosts, privateHashes), [
    { kind: "account id", value: sampleAccount },
    { kind: "resource id", value: "database_id: b7a8-not-a-placeholder" },
    { kind: "email address", value: `ada@${sampleHost}` },
    { kind: "hostname", value: sampleHost },
  ]);
});

test("a private domain fails even when the public list names it", () => {
  const domain = ["acme-corp", "com"].join(".");
  const both = new Set([domain]);
  assert.equal(hostAllowed(`mail.${domain}`, both, new Set()), true);
  assert.equal(hostAllowed(`mail.${domain}`, both, new Set([sha256(domain)])), false);
  assert.equal(hostAllowed(`mail.${domain}`, new Set(), new Set([sha256(domain)])), false);
});

test("a personal address at a public provider fails when its hash is listed", () => {
  const address = ["someone", "gmail.com"].join("@");
  const text = `write to ${address}`;
  assert.deepEqual(trackedValues(text, publicHosts, new Set()), []);
  assert.deepEqual(trackedValues(text, publicHosts, new Set([sha256(address)])), [
    { kind: "email address", value: address },
  ]);
});

test("the private list holds only SHA-256 hashes", () => {
  assert.ok(privateHashes.size > 0);
  for (const h of privateHashes) assert.match(h, /^[0-9a-f]{64}$/);
});

// Tracked files and new files not yet added, so a local run catches a value
// before it is committed. The lockfile is generated and names the registry.
function repositoryFiles() {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\0").filter((f) => f && f !== "pnpm-lock.yaml");
}

test("no file in the repository holds a deployment value or personal address", () => {
  const found = [];
  for (const file of repositoryFiles()) {
    let text;
    try {
      text = readFileSync(new URL(file, repo), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue; // deleted in the working tree
      throw err;
    }
    if (text.includes("\0")) continue; // binary
    for (const { kind, value } of trackedValues(text, publicHosts, privateHashes)) {
      found.push(`${file}: ${kind} ${value}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    "Move deployment values to the site file (AGENTS.md section 2). A public service or a test fixture goes in scripts/public-hosts.txt.",
  );
});
