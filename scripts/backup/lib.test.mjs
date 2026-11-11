import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blobFiles,
  blobsBucket,
  insertOrder,
  insertStatement,
  isCopiedTable,
  isSafeKey,
  parseJsonc,
  sniffImageType,
  sqlLiteral,
} from "./lib.mjs";

test("search index, sessions and other transient tables are not copied", () => {
  for (const t of ["message_fts", "message_fts_data", "_cf_METADATA", "sqlite_sequence", "session"])
    assert.equal(isCopiedTable(t), false, t);
  for (const t of ["message", "user", "system_config", "rate_limit_other"])
    assert.equal(isCopiedTable(t), true, t);
});

test("parseJsonc drops comments and trailing commas, and keeps // inside strings", () => {
  const config = parseJsonc(`{
    // a comment
    "name": "x", /* inline */
    "url": "http://localhost:8787",
    "list": [1, 2,],
  }`);
  assert.deepEqual(config, { name: "x", url: "http://localhost:8787", list: [1, 2] });
});

test("blobsBucket finds the bucket for a deployment and for local use", () => {
  const config = {
    r2_buckets: [{ binding: "BLOBS", bucket_name: "local-blobs" }],
    env: { prod: { r2_buckets: [{ binding: "BLOBS", bucket_name: "mail-prod-blobs" }] } },
  };
  assert.equal(blobsBucket(config, null), "local-blobs");
  assert.equal(blobsBucket(config, "prod"), "mail-prod-blobs");
  assert.throws(() => blobsBucket(config, "nope"), /No deployment named "nope"/);
});

test("sqlLiteral escapes quotes and keeps newlines, numbers and NULL", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(true), "1");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("a\nb"), "'a\nb'");
  assert.equal(sqlLiteral("a\u0000b"), "('a' || char(0) || 'b')");
  assert.throws(() => sqlLiteral({}), /Unexpected object/);
});

test("insertStatement quotes names and lists every column", () => {
  assert.equal(
    insertStatement("user", { id: "u1", name: 'O"Neil', banned: 0, image: null }),
    `INSERT INTO "user" ("id", "name", "banned", "image") VALUES ('u1', 'O"Neil', 0, NULL);`,
  );
});

test("insertOrder puts parents before children and survives a cycle", () => {
  const order = insertOrder(["message", "thread", "mailbox", "user", "a", "b"], {
    message: ["thread", "mailbox"],
    thread: ["mailbox"],
    mailbox: ["user", "domain_not_copied"],
    a: ["b"],
    b: ["a"],
  });
  const at = (t) => order.indexOf(t);
  assert.ok(at("user") < at("mailbox"));
  assert.ok(at("mailbox") < at("thread"));
  assert.ok(at("thread") < at("message"));
  assert.equal(order.length, 6);
});

test("blobFiles collects raw mail, attachments, draft uploads and avatars with their types", () => {
  const files = blobFiles({
    message: [
      { raw_r2_key: "raw/m1/a.eml", plain_r2_key: null },
      { raw_r2_key: "raw/m1/b.eml", plain_r2_key: "plain/m1/b.eml" },
    ],
    attachment: [{ r2_key: "att/x/0-f.pdf", content_type: "application/pdf" }],
    draft: [
      {
        attachments: '[{"r2Key":"draft/u1/one.png","contentType":"image/png"}]',
        scheduled_payload: null,
      },
      {
        attachments: null,
        scheduled_payload:
          '{"attachments":[{"r2Key":"draft/u1/two.txt","contentType":"text/plain"}]}',
      },
    ],
    user: [
      { image: "/api/avatar/u1/abc-1" },
      { image: "https://elsewhere.example/x.png" },
      { image: null },
    ],
  });
  assert.deepEqual(files, [
    { key: "att/x/0-f.pdf", contentType: "application/pdf" },
    { key: "avatar/u1/abc-1", contentType: null },
    { key: "draft/u1/one.png", contentType: "image/png" },
    { key: "draft/u1/two.txt", contentType: "text/plain" },
    { key: "plain/m1/b.eml", contentType: "message/rfc822" },
    { key: "raw/m1/a.eml", contentType: "message/rfc822" },
    { key: "raw/m1/b.eml", contentType: "message/rfc822" },
  ]);
});

test("sniffImageType recognises the four avatar formats", () => {
  assert.equal(sniffImageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d)), "image/png");
  assert.equal(sniffImageType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffImageType(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39)), "image/gif");
  assert.equal(
    sniffImageType(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    "image/webp",
  );
  assert.equal(sniffImageType(Uint8Array.of(0x3c, 0x73, 0x76, 0x67)), null);
});

test("isSafeKey refuses keys that would leave the backup folder", () => {
  for (const key of ["raw/m/a.eml", "att/id/0-file.pdf"]) assert.equal(isSafeKey(key), true, key);
  for (const key of ["../x", "raw/../../x", "/etc/passwd", "raw//x", "raw\\x", ""])
    assert.equal(isSafeKey(key), false, key);
});
