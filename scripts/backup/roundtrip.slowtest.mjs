// Backup, restore, backup again, on local development storage only.
//
// A backup is only worth having if a restore from it rebuilds the same data.
// This test builds a small deployment in a temporary local store, backs it up
// with scripts/backup.mjs, restores that backup into a second empty store with
// scripts/restore.mjs, backs the second store up, and requires the two backups
// to match: every table file, every stored file byte for byte, and the manifest
// (except the time it was made). Nothing here reaches Cloudflare: every wrangler
// call carries --local --persist-to <temp folder>, and the folder is removed
// afterwards.
//
// It is slow because every query is a separate wrangler process. See the
// timing printed at the end of the test.
/* eslint-disable no-await-in-loop -- wrangler runs against one local store, one at a time on purpose */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { blobsBucket, parseJsonc } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workerDir = join(root, "apps", "worker");
const wranglerBin = join(workerDir, "node_modules", ".bin", "wrangler");

let tmp;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cfx-mail-roundtrip-"));
  // Every wrangler this run starts inherits this, so its logs stay in the
  // run's own folder instead of the shared one in the home directory.
  process.env.WRANGLER_LOG_PATH = join(tmp, "wrangler-logs");
});

after(async () => {
  // A folder this run created, so removing it is this run's job.
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

function run(file, args, { cwd = root, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.join(" ")} exited ${error.code}\n${stderr}\n${stdout}`.slice(0, 4000),
            ),
          );
        } else resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

const wrangler = (args, options = {}) => run(wranglerBin, args, { cwd: workerDir, ...options });
const script = (name, args) => run(process.execPath, [join(root, "scripts", name), ...args]);

// ── What the test deployment holds ──────────────────────────────────────────

const q = (s) => `'${s.replaceAll("'", "''")}'`;

// Text that has broken backups before: quotes, newlines, backslashes, percent
// signs, accents, CJK, an emoji, and a NUL byte (which ends a SQL string).
const TRICKY_SUBJECT = `It's a "quoted" subject: ünïcödé 日本語 😀 \\back\\slash 100% $x`;
const TRICKY_BODY = "line one\nline two\twith a tab\n\nunicorn and 'single' quotes";
const NUL_BODY = "before\u0000after";

const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
// The first bytes of a PNG; the backup works out the type of an avatar from them.
const AVATAR = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really an image"),
]);
const RAW_ONE = "From: bob@example.com\r\nTo: alice@example.com\r\nSubject: one\r\n\r\nunicorn\r\n";
const RAW_TWO = "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: two\r\n\r\nreply\r\n";

const BLOBS = [
  { key: "raw/mailbox-1/one.eml", bytes: Buffer.from(RAW_ONE), type: "message/rfc822" },
  { key: "raw/mailbox-1/two.eml", bytes: Buffer.from(RAW_TWO), type: "message/rfc822" },
  { key: "att/msg-1/0-data.bin", bytes: BINARY, type: "application/octet-stream" },
  { key: "avatar/user-1/av1", bytes: AVATAR, type: "image/png" },
];

const SEED_SQL = [
  `INSERT INTO "user" (id, name, email, image) VALUES ('user-1', 'Alice', 'alice@example.com', '/api/avatar/user-1/av1');`,
  `INSERT INTO "user" (id, name, email) VALUES ('user-2', ${q("Bob O'Brien")}, 'bob@example.com');`,
  `INSERT INTO session (id, user_id, token, expires_at) VALUES ('sess-1', 'user-1', 'tok-1', 4102444800);`,
  `INSERT INTO domain (id, name) VALUES ('domain-1', 'example.com');`,
  `INSERT INTO mailbox (id, domain_id, local_part, type, owner_user_id) VALUES ('mailbox-1', 'domain-1', 'alice', 'personal', 'user-1');`,
  `INSERT INTO thread (id, mailbox_id, subject_norm, msg_count) VALUES ('thread-1', 'mailbox-1', 'one', 2);`,
  `INSERT INTO message (id, mailbox_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, body_text, flags, size_bytes, raw_r2_key) VALUES ('msg-1', 'mailbox-1', 'thread-1', 'in', 'bob@example.com', ${q("Bob O'Brien")}, '[{"address":"alice@example.com"}]', ${q(TRICKY_SUBJECT)}, 'snippet', ${q(TRICKY_BODY)}, 1, ${RAW_ONE.length}, 'raw/mailbox-1/one.eml');`,
  `INSERT INTO message (id, mailbox_id, thread_id, direction, from_addr, subject, body_text, size_bytes, raw_r2_key) VALUES ('msg-2', 'mailbox-1', 'thread-1', 'out', 'alice@example.com', 'two', ('before' || char(0) || 'after'), ${RAW_TWO.length}, 'raw/mailbox-1/two.eml');`,
  `INSERT INTO attachment (id, message_id, filename, content_type, size_bytes, r2_key) VALUES ('att-1', 'msg-1', 'data.bin', 'application/octet-stream', ${BINARY.length}, 'att/msg-1/0-data.bin');`,
  `INSERT INTO system_config (key, value) VALUES ('example_setting', ${q('{"a":"it\'s","b":[1,2]}')});`,
].join("\n");

// ── Helpers ─────────────────────────────────────────────────────────────────

const local = (store) => ["--local", "--persist-to", store];

async function seed(store) {
  await wrangler(["d1", "migrations", "apply", "DB", ...local(store)], { input: "y\n" });
  const sqlFile = join(tmp, "seed.sql");
  await writeFile(sqlFile, `${SEED_SQL}\n`);
  await wrangler(["d1", "execute", "DB", ...local(store), "--yes", "--file", sqlFile]);

  const config = parseJsonc(await readFile(join(workerDir, "wrangler.jsonc"), "utf8"));
  const bucket = blobsBucket(config, null);
  for (const [i, blob] of BLOBS.entries()) {
    const file = join(tmp, `seed-blob-${i}`);
    await writeFile(file, blob.bytes);
    await wrangler([
      "r2",
      "object",
      "put",
      `${bucket}/${blob.key}`,
      "--file",
      file,
      "--content-type",
      blob.type,
      ...local(store),
    ]);
  }
}

async function filesUnder(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(dir, path));
    }
  };
  await walk(dir);
  return found.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function readRows(backup, table) {
  const text = await readFile(join(backup, "db", `${table}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── The test ────────────────────────────────────────────────────────────────

test("a restored deployment backs up to the same files as the original", {
  timeout: 60 * 60 * 1000,
}, async (t) => {
  const started = Date.now();
  const lap = (label) => t.diagnostic(`${label}: ${Math.round((Date.now() - started) / 1000)} s`);
  const storeA = join(tmp, "store-a");
  const storeB = join(tmp, "store-b");
  const backupA = join(tmp, "backup-a");
  const backupB = join(tmp, "backup-b");
  await mkdir(storeA);
  await mkdir(storeB);

  await seed(storeA);
  lap("seeded the original store");

  // 1. Back up the original.
  await script("backup.mjs", ["--local", "--persist-to", storeA, backupA]);
  lap("first backup");

  // The backup holds what was seeded, so the comparison below is not of two empty folders.
  const manifestA = await readJson(join(backupA, "manifest.json"));
  assert.equal(manifestA.deployment, "local");
  assert.deepEqual(manifestA.missing, []);
  assert.equal(manifestA.tables.user, 2);
  assert.equal(manifestA.tables.message, 2);
  assert.equal(manifestA.tables.attachment, 1);
  assert.deepEqual(
    manifestA.files.map((f) => f.key),
    BLOBS.map((b) => b.key).toSorted(),
  );
  assert.deepEqual(manifestA.mailboxes, [{ id: "mailbox-1", address: "alice@example.com" }]);
  for (const blob of BLOBS) {
    assert.deepEqual(await readFile(join(backupA, "blobs", blob.key)), blob.bytes, blob.key);
  }
  const avatar = manifestA.files.find((f) => f.key === "avatar/user-1/av1");
  assert.equal(avatar.contentType, "image/png", "an avatar's type is worked out from its bytes");

  const messages = await readRows(backupA, "message");
  assert.equal(messages.find((m) => m.id === "msg-1").subject, TRICKY_SUBJECT);
  assert.equal(messages.find((m) => m.id === "msg-1").body_text, TRICKY_BODY);
  assert.equal(messages.find((m) => m.id === "msg-2").body_text, NUL_BODY);

  // Search index and sign-in sessions are left out on purpose.
  const copied = await readdir(join(backupA, "db"));
  assert.ok(!copied.includes("session.jsonl"));
  assert.ok(!copied.some((f) => f.startsWith("message_fts")));

  // 2. Restore it into an empty store.
  await script("restore.mjs", ["--local", "--persist-to", storeB, backupA]);
  lap("restore");

  // The search index was rebuilt by the restore, not copied.
  const hits = await wrangler([
    "d1",
    "execute",
    "DB",
    ...local(storeB),
    "--json",
    "--command",
    "select message_id from message_fts where message_fts match 'unicorn' order by message_id",
  ]);
  const found = JSON.parse(hits.stdout.slice(hits.stdout.indexOf("[")))[0].results;
  assert.deepEqual(
    found.map((r) => r.message_id),
    ["msg-1"],
  );

  // 3. Back up the restored store and compare.
  await script("backup.mjs", ["--local", "--persist-to", storeB, backupB]);
  lap("second backup");

  // Restoring reads the backup and leaves it exactly as it was: no scratch
  // copy of the database (password hashes included) is left behind in it.
  const backupFiles = await filesUnder(backupA);
  assert.deepEqual(await filesUnder(backupB), backupFiles, "same set of files");
  for (const file of backupFiles) {
    if (file === "manifest.json") continue;
    assert.deepEqual(
      await readFile(join(backupB, file)),
      await readFile(join(backupA, file)),
      `${file} differs`,
    );
  }
  const { createdAt: firstTime, ...manifestWithoutTimeA } = manifestA;
  const { createdAt: secondTime, ...manifestWithoutTimeB } = await readJson(
    join(backupB, "manifest.json"),
  );
  assert.ok(firstTime && secondTime, "both manifests say when they were made");
  assert.deepEqual(manifestWithoutTimeB, manifestWithoutTimeA);
});
