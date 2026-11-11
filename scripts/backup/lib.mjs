// Pure helpers for backup.mjs and restore.mjs. No I/O here.

// Tables that are not copied. The search index is rebuilt by the insert trigger
// on `message` during restore. Sessions, rate-limit counters and pending
// verifications are transient: after a restore everyone signs in again.
// `d1_migrations` is written by applying the migrations to the target.
const SKIPPED = [
  /^message_fts/,
  /^_cf_/,
  /^sqlite_/,
  /^d1_migrations$/,
  /^session$/,
  /^verification$/,
  /^rate_limit$/,
  /^rate_limit_counter$/,
];

export function isCopiedTable(name) {
  return !SKIPPED.some((re) => re.test(name));
}

// A JSON document with // and /* */ comments, as wrangler.jsonc is. Comment
// markers inside strings are left alone.
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// The bucket bound as BLOBS for a deployment, or for local development when
// `name` is null.
export function blobsBucket(config, name) {
  const scope = name === null ? config : config.env?.[name];
  if (!scope) throw new Error(`No deployment named "${name}" in the wrangler config.`);
  const bucket = (scope.r2_buckets ?? []).find((b) => b.binding === "BLOBS");
  if (!bucket) throw new Error("The wrangler config has no BLOBS bucket for this deployment.");
  return bucket.bucket_name;
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot store ${value} in SQL.`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "string") throw new Error(`Unexpected ${typeof value} in a row.`);
  // SQLite ends a string literal at a NUL byte, so those go in through char().
  const parts = value.split("\u0000").map((part) => `'${part.replaceAll("'", "''")}'`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" || char(0) || ")})`;
}

const quoteName = (name) => `"${name.replaceAll('"', '""')}"`;

export function insertStatement(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${quoteName(table)} (${columns.map(quoteName).join(", ")}) VALUES (${columns
    .map((c) => sqlLiteral(row[c]))
    .join(", ")});`;
}

// Parents before children, so every insert finds the rows it refers to.
// `references` maps a table to the tables its foreign keys point at. A cycle
// (or a self-reference) cannot be ordered and is left to deferred checking.
export function insertOrder(tables, references) {
  const ordered = [];
  const state = new Map();
  const visit = (table) => {
    if (state.get(table)) return;
    state.set(table, "visiting");
    for (const parent of references[table] ?? []) {
      if (tables.includes(parent) && state.get(parent) !== "visiting") visit(parent);
    }
    state.set(table, "done");
    ordered.push(table);
  };
  for (const table of tables.toSorted()) visit(table);
  return ordered;
}

const AVATAR_URL = /^\/api\/avatar\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)$/;

// Every stored file the database refers to, with the content type the app
// stored it under where the database knows it. `rows` holds the copied rows by
// table name. Columns that hold JSON arrive as strings. An avatar's type is not
// in the database; see `sniffImageType`.
export function blobFiles(rows) {
  const files = new Map();
  const add = (key, contentType) => {
    if (typeof key === "string" && key && !files.has(key)) files.set(key, contentType ?? null);
  };
  for (const m of rows.message ?? []) {
    add(m.raw_r2_key, "message/rfc822");
    add(m.plain_r2_key, "message/rfc822");
  }
  for (const a of rows.attachment ?? []) add(a.r2_key, a.content_type);
  for (const d of rows.draft ?? []) {
    for (const column of ["attachments", "scheduled_payload"]) {
      if (typeof d[column] !== "string") continue;
      const parsed = JSON.parse(d[column]);
      const list = Array.isArray(parsed) ? parsed : (parsed?.attachments ?? []);
      for (const att of list) add(att?.r2Key, att?.contentType);
    }
  }
  for (const u of rows.user ?? []) {
    const match = typeof u.image === "string" ? AVATAR_URL.exec(u.image) : null;
    if (match) add(`avatar/${match[1]}/${match[2]}`, null);
  }
  return [...files]
    .map(([key, contentType]) => ({ key, contentType }))
    .toSorted((x, y) => (x.key < y.key ? -1 : 1));
}

// The image type of an avatar, from its first bytes. The app only accepts
// these four, and serves anything else as a download.
export function sniffImageType(bytes) {
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

// A key is used as a relative path inside the backup folder. Keys are built by
// the app from ids and sanitised filenames, but a backup tool must not write
// outside its folder whatever the database says.
export function isSafeKey(key) {
  return (
    key.length > 0 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
