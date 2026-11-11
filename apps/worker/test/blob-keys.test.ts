import { attachment, draft, message } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentsRoutes } from "../src/api/attachments.ts";
import { avatarRoutes } from "../src/api/avatar.ts";
import { draftsRoutes } from "../src/api/drafts.ts";
import type { Env } from "../src/env.ts";
import { ingestRaw } from "../src/mail/ingest.ts";
import { sendFromMailbox } from "../src/mail/send.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "./support/app.ts";
import { MAILBOX_ID, OWNER_ID, owner, seedBase } from "./support/seed.ts";

// R2 key layouts are a contract (AGENTS.md invariant 6): objects already in the
// bucket live under these exact shapes. Each test drives the real code path that
// writes a key and pins the key byte for byte, filename handling included.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// Filenames as a sender or the composer may give them, and the key segment each
// becomes: runs outside [a-z0-9._-] turn into one "_", case is kept, and the
// result is cut to 128 characters after that replacement.
const LONG = `${"a".repeat(200)}.pdf`;
const FILENAMES = {
  spaced: ["My Report (final).PDF", "My_Report_final_.PDF"],
  long: [LONG, "a".repeat(128)],
  // Replaced before it is cut: the 100 accented letters shrink to one "_".
  replacedThenCut: [`${"é".repeat(100)}${"x".repeat(100)}`, `_${"x".repeat(100)}`],
} as const;

async function clearBlobs(): Promise<void> {
  const keys = (await e.BLOBS.list()).objects.map((o) => o.key);
  if (keys.length) await e.BLOBS.delete(keys);
}

async function blobKeys(prefix: string): Promise<string[]> {
  return (await e.BLOBS.list({ prefix })).objects.map((o) => o.key).toSorted();
}

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function ingestOpts(raw: ArrayBuffer, over: Partial<Parameters<typeof ingestRaw>[2]> = {}) {
  return {
    mailboxId: MAILBOX_ID,
    raw,
    direction: "in" as const,
    deliveredTo: null,
    flags: 0,
    receivedAt: new Date("2024-01-02T03:04:05Z"),
    sentAt: null,
    spam: null,
    ...over,
  };
}

const PLAIN_MAIL = [
  "From: Sender <sender@elsewhere.test>",
  "To: Team <team@example.com>",
  "Subject: Keys",
  "",
  "hello",
  "",
].join("\r\n");

// Three attachments: a name that needs replacing, no name at all, and a name
// longer than the key allows.
const MAIL_WITH_ATTACHMENTS = [
  "From: Sender <sender@elsewhere.test>",
  "To: Team <team@example.com>",
  "Subject: Attachments",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="B"',
  "",
  "--B",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "body",
  "--B",
  `Content-Type: application/pdf; name="${FILENAMES.spaced[0]}"`,
  `Content-Disposition: attachment; filename="${FILENAMES.spaced[0]}"`,
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8=",
  "--B",
  "Content-Type: application/octet-stream",
  "Content-Disposition: attachment",
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8=",
  "--B",
  `Content-Type: application/pdf; name="${FILENAMES.long[0]}"`,
  `Content-Disposition: attachment; filename="${FILENAMES.long[0]}"`,
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8=",
  "--B--",
  "",
].join("\r\n");

async function messageRow(): Promise<typeof message.$inferSelect> {
  const rows = await db().query.message.findMany({ where: eq(message.mailboxId, MAILBOX_ID) });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function attachmentKeys(messageId: string): Promise<string[]> {
  const rows = await db().query.attachment.findMany({
    where: eq(attachment.messageId, messageId),
  });
  return rows.map((r) => r.r2Key).toSorted();
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  await clearBlobs();
});

describe("R2 key layout — inbound mail (ingest)", () => {
  it("writes the raw message at raw/<mailboxId>/<uuid>.eml", async () => {
    await ingestRaw(e, db(), ingestOpts(utf8(PLAIN_MAIL)));
    const row = await messageRow();
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/${UUID}\\.eml$`));
    expect(row.plainR2Key).toBeNull();
    expect(await blobKeys("")).toEqual([row.rawR2Key]);
  });

  it("writes decrypted PGP mail at plain/<mailboxId>/<uuid>.eml beside the raw key", async () => {
    await ingestRaw(
      e,
      db(),
      ingestOpts(utf8(PLAIN_MAIL), {
        pgp: {
          encrypted: true,
          signed: false,
          verify: null,
          signedBy: null,
          plainRaw: new TextEncoder().encode(PLAIN_MAIL),
        },
      }),
    );
    const row = await messageRow();
    expect(row.rawR2Key).toMatch(new RegExp(`^raw/${MAILBOX_ID}/${UUID}\\.eml$`));
    expect(row.plainR2Key).toMatch(new RegExp(`^plain/${MAILBOX_ID}/${UUID}\\.eml$`));
    expect(row.plainR2Key!.slice("plain/".length)).not.toBe(row.rawR2Key!.slice("raw/".length));
    expect(await blobKeys("")).toEqual([row.plainR2Key, row.rawR2Key]);
  });

  it("writes attachments at att/<messageId>/<index>-<filename>", async () => {
    await ingestRaw(e, db(), ingestOpts(utf8(MAIL_WITH_ATTACHMENTS)));
    const row = await messageRow();
    const expected = [
      `att/${row.id}/0-${FILENAMES.spaced[1]}`,
      `att/${row.id}/1-file-1`,
      `att/${row.id}/2-${FILENAMES.long[1]}`,
    ];
    expect(await attachmentKeys(row.id)).toEqual(expected);
    expect(await blobKeys("att/")).toEqual(expected);
  });
});

// The EMAIL binding has no local simulation, so the send tests swap in a fake.
function emailOk(): Env {
  const send = vi.fn(async () => ({ messageId: "platform-mid" }));
  return { ...e, EMAIL: { send } } as unknown as Env;
}

describe("R2 key layout — sent mail (send)", () => {
  it("writes the raw message at raw/<mailboxId>/sent/<messageId>.eml", async () => {
    const res = await sendFromMailbox(emailOk(), db(), OWNER_ID, {
      mailboxId: MAILBOX_ID,
      to: [{ address: "recipient@elsewhere.test" }],
      subject: "Keys",
      text: "hello",
    } as Parameters<typeof sendFromMailbox>[3]);
    const row = await messageRow();
    expect(row.id).toBe(res.messageId);
    expect(row.rawR2Key).toBe(`raw/${MAILBOX_ID}/sent/${res.messageId}.eml`);
    expect(await blobKeys("raw/")).toEqual([row.rawR2Key]);
  });

  it("copies attachments to att/<messageId>/<index>-<filename>", async () => {
    const names = [FILENAMES.spaced, FILENAMES.long, FILENAMES.replacedThenCut];
    const attachments = await Promise.all(
      names.map(async ([filename], idx) => {
        const r2Key = `draft/${OWNER_ID}/upload-${idx}`;
        await e.BLOBS.put(r2Key, `bytes ${idx}`, {
          httpMetadata: { contentType: "application/pdf" },
        });
        return { r2Key, filename, contentType: "application/pdf" };
      }),
    );
    const res = await sendFromMailbox(emailOk(), db(), OWNER_ID, {
      mailboxId: MAILBOX_ID,
      to: [{ address: "recipient@elsewhere.test" }],
      subject: "Keys",
      text: "hello",
      attachments,
    } as Parameters<typeof sendFromMailbox>[3]);
    const expected = names.map(([, key], idx) => `att/${res.messageId}/${idx}-${key}`).toSorted();
    expect(await attachmentKeys(res.messageId)).toEqual(expected);
    expect(await blobKeys("att/")).toEqual(expected);
  });
});

function rawRequest(
  app: ReturnType<typeof mountApp>,
  method: string,
  path: string,
  body?: BodyInit,
  headers?: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(app.request(path, { method, body, headers }, e as unknown as Env));
}

describe("R2 key layout — composer uploads (POST /api/attachments/upload)", () => {
  const upload = (headers: Record<string, string>) =>
    rawRequest(mountApp(attachmentsRoutes, owner), "POST", "/upload", "bytes", {
      "content-type": "application/pdf",
      ...headers,
    });

  it.each([
    ["a name that needs replacing", FILENAMES.spaced],
    ["a name longer than the key allows", FILENAMES.long],
  ])("writes draft/<userId>/<uuid>-<filename> for %s", async (_name, [filename, inKey]) => {
    const res = await upload({ "x-filename": filename });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { r2Key: string; filename: string };
    expect(body.filename).toBe(filename);
    expect(body.r2Key).toMatch(
      new RegExp(`^draft/${OWNER_ID}/${UUID}-${inKey.replace(/\./g, "\\.")}$`),
    );
    expect(await blobKeys("")).toEqual([body.r2Key]);
  });

  it("names an upload without a filename upload.bin", async () => {
    const res = await upload({});
    const body = (await res.json()) as { r2Key: string };
    expect(body.r2Key).toMatch(new RegExp(`^draft/${OWNER_ID}/${UUID}-upload\\.bin$`));
  });
});

describe("R2 key layout — avatars (POST /api/avatar)", () => {
  it("writes avatar/<userId>/<uuid> and links it as /api/avatar/<userId>/<uuid>", async () => {
    const res = await rawRequest(mountApp(avatarRoutes, owner), "POST", "/", "PNG", {
      "content-type": "image/png",
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^/api/avatar/${OWNER_ID}/${UUID}$`));
    const id = url.split("/").at(-1);
    expect(await blobKeys("")).toEqual([`avatar/${OWNER_ID}/${id}`]);
  });
});

describe("R2 key ownership — the draft/<userId>/ prefix", () => {
  // Shares the owner's id as a prefix but is another namespace.
  const LOOKALIKE = `draft/${OWNER_ID}-evil/pic.png`;

  it("refuses to serve a lookalike key from /draft-blob", async () => {
    await e.BLOBS.put(LOOKALIKE, "x", { httpMetadata: { contentType: "image/png" } });
    const res = await rawRequest(
      mountApp(attachmentsRoutes, owner),
      "GET",
      `/draft-blob?key=${encodeURIComponent(LOOKALIKE)}`,
    );
    expect(res.status).toBe(403);
  });

  it("deletes only the owner's own uploads when a draft is deleted", async () => {
    const own = `draft/${OWNER_ID}/own.png`;
    await Promise.all([own, LOOKALIKE].map((key) => e.BLOBS.put(key, "x")));
    const id = "draft-keys";
    await db()
      .insert(draft)
      .values({
        id,
        mailboxId: MAILBOX_ID,
        userId: OWNER_ID,
        attachments: [own, LOOKALIKE].map((r2Key) => ({
          r2Key,
          filename: "pic.png",
          contentType: "image/png",
          sizeBytes: 1,
        })),
      });
    const res = await request(mountApp(draftsRoutes, owner), "DELETE", `/${id}`);
    expect(res.status).toBe(200);
    expect(await blobKeys("draft/")).toEqual([LOOKALIKE]);
  });
});
