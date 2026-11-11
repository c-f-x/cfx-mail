// Joins the template config (apps/worker/wrangler.jsonc) with a deployment's
// values from the private site file, so the repository holds no account id,
// resource id or hostname (decision D-16, c-f-x conventions section 4).
//
// The site file is `<CFX_SITE>/cfx-mail.jsonc`, where CFX_SITE is the path of a
// local checkout of the owner's private site repository:
//
//   {
//     "deployments": {
//       "<name>": {
//         "account_id": "<32 hex characters>",
//         "worker_name": "mail-<name>",
//         "hostnames": ["mail.example.com"],
//         "d1": { "database_name": "mail-<name>", "database_id": "<uuid>" },
//         "r2": { "bucket_name": "mail-<name>-blobs" }
//       }
//     }
//   }
//
// This is the smallest loader cfx-mail needs. It is replaced by the shared one
// in @c-f-x/kit once the kit is published (D-16).
//
// CLI: node scripts/site-config.mjs <name> <scratch folder>
// writes the joined config into the scratch folder and prints its path.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./backup/lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const templatePath = join(root, "apps", "worker", "wrangler.jsonc");
export const SITE_FILE = "cfx-mail.jsonc";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEYS = new Set(["account_id", "worker_name", "hostnames", "d1", "r2"]);

// The values of one deployment, checked. Returns { block } or { errors }.
export function deploymentValues(site, name) {
  const all = site?.deployments;
  if (!all || typeof all !== "object") return { errors: [`${SITE_FILE} has no "deployments".`] };
  const d = all[name];
  if (!d) {
    const known = Object.keys(all).join(", ") || "none";
    return { errors: [`No deployment named "${name}" in ${SITE_FILE} (it has: ${known}).`] };
  }
  const errors = [];
  for (const key of Object.keys(d)) {
    if (!KEYS.has(key)) errors.push(`${name}.${key} is not a known setting.`);
  }
  if (!ACCOUNT_ID.test(d.account_id ?? ""))
    errors.push(`${name}.account_id must be 32 hex characters.`);
  if (!NAME.test(d.worker_name ?? "")) errors.push(`${name}.worker_name must be a Worker name.`);
  if (!Array.isArray(d.hostnames) || d.hostnames.length === 0) {
    errors.push(`${name}.hostnames must list at least one hostname.`);
  } else {
    for (const h of d.hostnames) {
      if (!HOSTNAME.test(h)) errors.push(`${name}.hostnames: "${h}" is not a hostname.`);
    }
  }
  if (!NAME.test(d.d1?.database_name ?? "")) errors.push(`${name}.d1.database_name is missing.`);
  if (!UUID.test(d.d1?.database_id ?? "")) errors.push(`${name}.d1.database_id must be a UUID.`);
  if (!NAME.test(d.r2?.bucket_name ?? "")) errors.push(`${name}.r2.bucket_name is missing.`);
  return errors.length ? { errors } : { block: d };
}

// The template with the deployment added as `env.<name>`. Paths in the
// template are relative to its folder; they are made absolute, because the
// joined config is written elsewhere. Wrangler does not inherit bindings into
// an env block, so the block repeats each one.
export function joinedConfig(template, templateDir, name, values) {
  const abs = (p) => (typeof p === "string" && !isAbsolute(p) ? resolve(templateDir, p) : p);
  const config = structuredClone(template);
  delete config.env;
  config.main = abs(config.main);
  if (config.$schema) config.$schema = abs(config.$schema);
  if (config.assets?.directory) config.assets.directory = abs(config.assets.directory);
  for (const [k, v] of Object.entries(config.alias ?? {})) {
    if (v.startsWith(".")) config.alias[k] = abs(v);
  }
  const db = (template.d1_databases ?? []).find((d) => d.binding === "DB");
  const migrationsDir = abs(db?.migrations_dir);
  if (db) config.d1_databases = [{ ...db, migrations_dir: migrationsDir }];
  config.env = {
    [name]: {
      name: values.worker_name,
      account_id: values.account_id,
      routes: values.hostnames.map((pattern) => ({ pattern, custom_domain: true })),
      d1_databases: [
        {
          binding: "DB",
          database_name: values.d1.database_name,
          database_id: values.d1.database_id,
          migrations_dir: migrationsDir,
        },
      ],
      r2_buckets: [{ binding: "BLOBS", bucket_name: values.r2.bucket_name }],
      durable_objects: structuredClone(template.durable_objects),
      // Local development may reach the real binding ("remote"); a deployment
      // always does, so the flag is left out.
      send_email: (template.send_email ?? []).map(({ remote: _remote, ...rest }) => rest),
    },
  };
  return config;
}

// Reads the site file and the template and writes the joined config into
// `scratch`. Returns { configPath, accountId, values }. Throws with a readable
// message when CFX_SITE is unset or the site file is wrong.
export function writeJoinedConfig(name, scratch, env = process.env) {
  if (!env.CFX_SITE) {
    throw new Error(
      `CFX_SITE is not set. Set it to the path of a checkout of the private site repository, which holds ${SITE_FILE}.`,
    );
  }
  const sitePath = join(env.CFX_SITE, SITE_FILE);
  let site;
  try {
    site = parseJsonc(readFileSync(sitePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${sitePath}: ${err.message}`, { cause: err });
  }
  const { block, errors } = deploymentValues(site, name);
  if (errors) throw new Error(`${sitePath} is wrong:\n  ${errors.join("\n  ")}`);
  const template = parseJsonc(readFileSync(templatePath, "utf8"));
  const configPath = join(scratch, "wrangler.jsonc");
  const config = joinedConfig(template, dirname(templatePath), name, block);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, accountId: block.account_id, values: block };
}

// writeJoinedConfig into a scratch folder of its own, removed when the process
// ends, whatever the ending.
export async function openDeployment(name, env = process.env) {
  const scratch = await mkdtemp(join(env.TMPDIR || tmpdir(), "cfx-mail-site-"));
  process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
  return writeJoinedConfig(name, scratch, env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, scratch] = process.argv.slice(2);
  if (!name || !scratch) {
    console.error("usage: node scripts/site-config.mjs <name> <scratch folder>");
    process.exit(2);
  }
  try {
    console.log(writeJoinedConfig(name, scratch).configPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
