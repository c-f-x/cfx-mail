// Runs wrangler for backup.mjs and restore.mjs. All I/O with Cloudflare (or
// with local development storage) goes through here.
/* eslint-disable no-await-in-loop -- pages, retries and wrangler runs are sequential on purpose */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDeployment } from "../site-config.mjs";
import { blobsBucket, parseJsonc } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const workerDir = join(root, "apps", "worker");
export const migrationsDir = join(root, "packages", "db", "drizzle");
const wranglerBin = join(workerDir, "node_modules", ".bin", "wrangler");

// Where to read from or write to: a named deployment in Cloudflare, or local
// development storage (optionally a separate folder, for restore drills).
// `target` is { name, persistTo }, with name null for local.
export function parseTarget(args) {
  const rest = [];
  let local = false;
  let persistTo = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local") local = true;
    else if (args[i] === "--persist-to") {
      // Without a folder the restore would land in the default local store.
      const dir = args[++i];
      if (!dir || dir.startsWith("--")) throw new Error("--persist-to needs a folder.");
      persistTo = dir;
    } else rest.push(args[i]);
  }
  if (persistTo && !local) throw new Error("--persist-to only applies with --local.");
  if (local) return { target: { name: null, persistTo }, rest };
  const [name, ...others] = rest;
  return { target: { name: name ?? null, persistTo: null }, rest: others, missingName: !name };
}

const where = (target) =>
  target.name
    ? ["--remote"]
    : ["--local", ...(target.persistTo ? ["--persist-to", target.persistTo] : [])];
// A named deployment's config is the template joined with its values from the
// private site file (scripts/site-config.mjs), opened once per run.
const deploymentOf = (target) => {
  target.deployment ??= openDeployment(target.name);
  return target.deployment;
};

async function run(target, args, { input } = {}) {
  const deployment = target.name ? await deploymentOf(target) : null;
  const scoped = deployment
    ? [...args, "--config", deployment.configPath, "--env", target.name]
    : args;
  const env = { ...process.env, NO_COLOR: "1" };
  // Wrangler's login can see more than one account; name the deployment's.
  if (deployment) env.CLOUDFLARE_ACCOUNT_ID = deployment.accountId;
  return new Promise((resolve, reject) => {
    const child = execFile(
      wranglerBin,
      scoped,
      { cwd: workerDir, maxBuffer: 256 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${stderr || stdout}`));
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function bucketFor(target) {
  if (target.name) return (await deploymentOf(target)).values.r2.bucket_name;
  const config = parseJsonc(await readFile(join(workerDir, "wrangler.jsonc"), "utf8"));
  return blobsBucket(config, null);
}

export async function query(target, sql) {
  const out = await run(target, [
    "d1",
    "execute",
    "DB",
    ...where(target),
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0].results;
}

export const executeFile = (target, file) =>
  run(target, ["d1", "execute", "DB", ...where(target), "--yes", "--file", file]);

export const applyMigrations = (target) =>
  run(target, ["d1", "migrations", "apply", "DB", ...where(target)], { input: "y\n" });

const isMissing = (err) => /not exist|not found|NoSuchKey|404/i.test(String(err.message));

// A file transfer can drop mid-way; getting or putting an object again is safe.
async function retried(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt === 3 || isMissing(err)) throw err;
      await new Promise((done) => setTimeout(done, attempt * 1000));
    }
  }
}

// Resolves false when the object does not exist.
export async function getObject(target, bucket, key, file) {
  try {
    await retried(() =>
      run(target, ["r2", "object", "get", `${bucket}/${key}`, "--file", file, ...where(target)]),
    );
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export const putObject = (target, bucket, key, file, contentType) =>
  retried(() =>
    run(target, [
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--file",
      file,
      ...(contentType ? ["--content-type", contentType] : []),
      ...where(target),
    ]),
  );

// How many file transfers to run at once. Local storage is one SQLite file and
// drops connections when several wrangler processes write to it together.
export const transferLanes = (target) => (target.name ? 6 : 1);

// Run `work` over `items`, a few at a time.
export async function pooled(items, size, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
