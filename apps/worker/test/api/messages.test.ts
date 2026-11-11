import { attachment, mailbox, message, rateLimitCounter, thread } from "@cfx-mail/db/schema";
import { Flag } from "@cfx-mail/shared/flags";
import { Perm } from "@cfx-mail/shared/permissions";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesRoutes } from "../../src/api/messages.ts";
import { getOrCreateAuthSecret, getOrCreatePgpMasterKey } from "../../src/config.ts";
import type { AppBindings, Env } from "../../src/env.ts";
import { MAX_IMAGE_BYTES, proxyRemoteContent } from "../../src/mail/img-proxy.ts";
import * as pgp from "../../src/mail/pgp.ts";
import { refreshTrackerList } from "../../src/mail/trackers.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import { bodyText } from "../support/body.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OWNER_ID,
  outsider,
  owner,
  seedBase,
  seedThread,
} from "../support/seed.ts";

const asOwner = () => mountApp(messagesRoutes, owner);
const asMember = () => mountApp(messagesRoutes, member);
const asOutsider = () => mountApp(messagesRoutes, outsider);
const asAnon = () => mountApp(messagesRoutes, null);

// Like `request`, but with an env override — used to swap in a fake EMAIL
// binding (the send path) without touching the shared harness.
function requestWithEnv(
  app: Hono<AppBindings>,
  method: string,
  path: string,
  body: unknown,
  env: Env,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return Promise.resolve(app.request(path, init, env));
}

function envWithEmail(send: (...args: unknown[]) => Promise<unknown>): Env {
  return { ...e, EMAIL: { send } as unknown as Env["EMAIL"] } as Env;
}

const SEND_BODY = {
  mailboxId: MAILBOX_ID,
  to: [{ address: "recipient@elsewhere.test" }],
  subject: "Hi",
  text: "hello",
};

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  // R2 has no per-test reset — clear this mailbox's sent blobs so rollback
  // assertions don't see leftovers from earlier tests.
  const listed = await e.BLOBS.list({ prefix: `raw/${MAILBOX_ID}/` });
  await Promise.all(listed.objects.map((o) => e.BLOBS.delete(o.key)));
});

describe("POST /send — authorization", () => {
  it("401s an anonymous caller", async () => {
    const res = await request(asAnon(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(401);
  });

  it("403s a non-member", async () => {
    const res = await request(asOutsider(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(403);
  });

  it("403s a viewer (READ-only member)", async () => {
    await grantMember(db(), Perm.READ);
    const res = await request(asMember(), "POST", "/send", SEND_BODY);
    expect(res.status).toBe(403);
  });
});

describe("POST /send — delivery", () => {
  it("201s and persists the message on success", async () => {
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => ({ messageId: "platform-mid" })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { messageId: string; threadId: string };
    const row = await db().query.message.findFirst({ where: eq(message.id, body.messageId) });
    expect(row).toMatchObject({ direction: "out", threadId: body.threadId });
    expect(await e.BLOBS.head(row!.rawR2Key!)).not.toBeNull();
  });

  it("5xxs and rolls back the persisted record when EMAIL.send fails", async () => {
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => Promise.reject(new Error("smtp down"))),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("send failed");
    // No orphan Sent entry or thread survives the failure.
    expect(await db().query.message.findMany()).toHaveLength(0);
    expect(await db().query.thread.findMany()).toHaveLength(0);
    const blobs = await e.BLOBS.list({ prefix: `raw/${MAILBOX_ID}/sent/` });
    expect(blobs.objects).toHaveLength(0);
  });

  it("lists the attachments on the Sent copy and serves their bytes", async () => {
    const key = `draft/${OWNER_ID}/${crypto.randomUUID()}-shot.png`;
    await e.BLOBS.put(key, "png-bytes", { httpMetadata: { contentType: "image/png" } });
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      {
        ...SEND_BODY,
        attachments: [{ r2Key: key, filename: "shot.png", contentType: "image/png" }],
      },
      envWithEmail(async () => ({ messageId: "platform-mid" })),
    );
    expect(res.status).toBe(201);
    const { messageId } = (await res.json()) as { messageId: string };

    const body = (await (await request(asOwner(), "GET", `/${messageId}/body`)).json()) as {
      attachments: { id: string; filename: string; contentType: string; sizeBytes: number }[];
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      filename: "shot.png",
      contentType: "image/png",
      sizeBytes: 9,
    });

    const raw = await request(
      asOwner(),
      "GET",
      `/${messageId}/attachments/${body.attachments[0]!.id}/raw`,
    );
    expect(raw.status).toBe(200);
    expect(await bodyText(raw)).toBe("png-bytes");
  });

  it("429s once the per-user send window is exhausted", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: `send:${OWNER_ID}`, count: 60, windowStart: Date.now() });
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      "/send",
      SEND_BODY,
      envWithEmail(async () => ({ messageId: "x" })),
    );
    expect(res.status).toBe(429);
    expect(await db().query.message.findMany()).toHaveLength(0);
  });
});

describe("GET /:id/body — server-side sanitization", () => {
  const RAW_HTML =
    `<div><script>alert(1)</script>` +
    `<p onclick="steal()">Hi <b>there</b></p>` +
    `<a href="javascript:alert(2)">bad</a>` +
    `<a href="https://ok.test/a">ok</a></div>`;

  async function seedHtmlMessage(rawHtml = RAW_HTML): Promise<string> {
    const { messageId } = await seedThread(db());
    const rawKey = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
    const eml = [
      "MIME-Version: 1.0",
      "From: sender@elsewhere.test",
      "To: team@example.com",
      "Subject: Hello",
      "Content-Type: text/html; charset=utf-8",
      "",
      rawHtml,
    ].join("\r\n");
    await e.BLOBS.put(rawKey, eml);
    await db().update(message).set({ rawR2Key: rawKey }).where(eq(message.id, messageId));
    return messageId;
  }

  it("strips script/event-handler/javascript: vectors but keeps benign markup", async () => {
    const id = await seedHtmlMessage();
    const res = await request(asOwner(), "GET", `/${id}/body`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string | null };
    expect(body.html).toBeTruthy();
    const html = body.html!;
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Hi <b>there</b>");
    expect(html).toContain("https://ok.test/a");
  });

  it("strips tracking beacons before proxying and reports the count", async () => {
    // Seed the fetched list the cron would have stored: both sources serve a
    // list padded past the per-source sanity threshold. The MailTrackerBlocker
    // one only carries filler vendors, so the beacon rules come from EasyPrivacy.
    const easyPrivacy = [
      "/wf/open?upn=$image",
      ...Array.from({ length: 20 }, (_, i) => `.v${i}.example/open/$image`),
    ].join("\n");
    const mailTrackerBlocker = [
      "+ (NSDictionary*)getTrackerDict {",
      "    return @{",
      ...Array.from(
        { length: 20 },
        (_, i) => `        @"Vendor${i}": @[@"w${i}.tracker.example/o/"],`,
      ),
      "    };",
      "}",
    ].join("\n");
    await refreshTrackerList(
      db(),
      new Date(),
      (async (input: RequestInfo | URL) =>
        new Response(
          (input instanceof Request ? input.url : String(input)).includes("easylist")
            ? easyPrivacy
            : mailTrackerBlocker,
        )) as unknown as typeof fetch,
    );
    const id = await seedHtmlMessage(
      `<p>News</p>` +
        `<img src="https://news.example.com/wf/open?upn=abc" alt="">` +
        `<img src="https://cdn.example.com/px.gif" width="1" height="1">` +
        `<img src="https://cdn.example.com/hero.png" width="600" height="200">`,
    );
    const res = await request(asOwner(), "GET", `/${id}/body`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; trackersBlocked: number };
    expect(body.trackersBlocked).toBe(2);
    expect(body.html).not.toContain("wf/open");
    expect(body.html).not.toContain("px.gif");
    // The surviving image went through the signed proxy, not to the sender.
    expect(body.html).toContain("/api/messages/proxy-image?u=");
    expect(body.html).not.toContain("https://cdn.example.com/hero.png");
  });

  it("lets a READ member fetch the body", async () => {
    await grantMember(db(), Perm.READ);
    const id = await seedHtmlMessage();
    const res = await request(asMember(), "GET", `/${id}/body`);
    expect(res.status).toBe(200);
  });

  it("403s a non-member and 404s a missing message", async () => {
    const id = await seedHtmlMessage();
    expect((await request(asOutsider(), "GET", `/${id}/body`)).status).toBe(403);
    expect((await request(asOwner(), "GET", "/missing/body")).status).toBe(404);
  });
});

async function seedNewsletter(listUnsubscribe: string, post: string | null = null) {
  const { messageId } = await seedThread(db());
  await db()
    .update(message)
    .set({ listUnsubscribe, listUnsubscribePost: post, deliveredTo: "team@example.com" })
    .where(eq(message.id, messageId));
  return messageId;
}

async function seedWithEml(): Promise<string> {
  const { messageId } = await seedThread(db());
  const key = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
  await e.BLOBS.put(
    key,
    [
      "MIME-Version: 1.0",
      "From: sender@elsewhere.test",
      "To: team@example.com",
      "Subject: Hello",
      "Content-Type: text/plain",
      "",
      "hi",
    ].join("\r\n"),
  );
  await db().update(message).set({ rawR2Key: key }).where(eq(message.id, messageId));
  return messageId;
}

async function seedAtt(messageId: string, contentType: string, filename = "file.bin") {
  const id = `att-${messageId}-${contentType.replace(/\W/g, "")}`;
  const r2Key = `att/${id}`;
  await e.BLOBS.put(r2Key, "BYTES");
  await db()
    .insert(attachment)
    .values({ id, messageId, filename, contentType, sizeBytes: 5, r2Key });
  return id;
}

const get = (app: Hono<AppBindings>, path: string, headers?: Record<string, string>) =>
  Promise.resolve(app.request(path, { headers }, e));

describe("/:id/unsubscribe", () => {
  it("429s once the per-user send window is exhausted, sending nothing", async () => {
    const id = await seedNewsletter("<mailto:unsub@news.example>");
    await db()
      .insert(rateLimitCounter)
      .values({ key: `send:${OWNER_ID}`, count: 60, windowStart: Date.now() });
    const sent: unknown[] = [];
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      `/${id}/unsubscribe`,
      undefined,
      envWithEmail(async (m) => void sent.push(m)),
    );
    expect(res.status).toBe(429);
    expect(sent).toEqual([]);
  });

  it("counts toward the same send window as POST /send", async () => {
    const id = await seedNewsletter("<mailto:unsub@news.example>");
    const send = envWithEmail(async () => ({ messageId: "x" }));
    expect(
      (await requestWithEnv(asOwner(), "POST", `/${id}/unsubscribe`, undefined, send)).status,
    ).toBe(200);
    const bucket = await db().query.rateLimitCounter.findFirst({
      where: eq(rateLimitCounter.key, `send:${OWNER_ID}`),
    });
    expect(bucket?.count).toBe(1);
  });

  it("422s the audited multi-recipient mailto and sends nothing", async () => {
    const id = await seedNewsletter(
      "<mailto:boss@corp.example,press@news.example?subject=I%20resign&body=Effective%20today.>",
    );
    const sent: unknown[] = [];
    const res = await requestWithEnv(
      asOwner(),
      "POST",
      `/${id}/unsubscribe`,
      undefined,
      envWithEmail(async (m) => void sent.push(m)),
    );
    expect(res.status).toBe(422);
    expect(sent).toEqual([]);
  });

  it("GET names the target before anything is sent", async () => {
    const mailto = await seedNewsletter("<mailto:unsub@news.example?body=x>");
    const res = await request(asOwner(), "GET", `/${mailto}/unsubscribe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "email", address: "unsub@news.example" });

    const oneClick = await seedNewsletter(
      "<https://news.example/u/abc>",
      "List-Unsubscribe=One-Click",
    );
    const res2 = await request(asOwner(), "GET", `/${oneClick}/unsubscribe`);
    expect(await res2.json()).toEqual({ method: "one-click", host: "news.example" });
  });

  it("GET 422s a header with no usable target and 403s a non-member", async () => {
    const bad = await seedNewsletter("<mailto:a@b.example,c@d.example>");
    expect((await request(asOwner(), "GET", `/${bad}/unsubscribe`)).status).toBe(422);
    expect((await request(asOutsider(), "GET", `/${bad}/unsubscribe`)).status).toBe(403);
  });
});

// Mail must not outlive the session or a revoked permission in the browser
// cache, and sender-chosen attachment types must not be served as themselves.
describe("cache and content headers on body, raw and attachment routes", () => {
  describe("GET /:id/body", () => {
    it("is revalidated, not cached for a year, and carries an ETag", async () => {
      const id = await seedWithEml();
      const res = await request(asOwner(), "GET", `/${id}/body`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("etag")).toBe(`"body-${id}"`);
    });

    it("answers a matching If-None-Match with 304 and no body", async () => {
      const id = await seedWithEml();
      const res = await get(asOwner(), `/${id}/body`, { "if-none-match": `"body-${id}"` });
      expect(res.status).toBe(304);
      expect(await bodyText(res)).toBe("");
      expect(res.headers.get("etag")).toBe(`"body-${id}"`);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("sends the body when the ETag does not match", async () => {
      const id = await seedWithEml();
      const res = await get(asOwner(), `/${id}/body`, { "if-none-match": '"body-other"' });
      expect(res.status).toBe(200);
    });

    it("lets 403 win over 304 for a user without access", async () => {
      const id = await seedWithEml();
      const res = await get(asOutsider(), `/${id}/body`, { "if-none-match": `"body-${id}"` });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:id/raw", () => {
    it("is nosniff, sandboxed and not cached", async () => {
      const id = await seedWithEml();
      const res = await request(asOwner(), "GET", `/${id}/raw`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("message/rfc822");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    });
  });

  describe("GET /:id/attachments/:attId/raw", () => {
    it.each([
      ["text/html", "page.html"],
      ["text/html; charset=utf-8", "page.html"],
      ["image/svg+xml", "logo.svg"],
      ["text/javascript", "x.js"],
      ["application/javascript", "x.js"],
      ["application/xhtml+xml", "x.xhtml"],
      ["text/plain", "note.txt"],
      ["application/x-evil", "x.bin"],
    ])("serves %s as an opaque download", async (contentType, filename) => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, contentType, filename);
      const res = await request(asOwner(), "GET", `/${id}/attachments/${attId}/raw`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    });

    it.each([
      ["image/png", "image/png"],
      ["image/jpeg", "image/jpeg"],
      ["image/gif", "image/gif"],
      ["image/webp", "image/webp"],
      ["image/avif", "image/avif"],
      ["application/pdf", "application/pdf"],
      ["image/png; name=a.png", "image/png"],
    ])("serves %s inline as %s, still nosniff and sandboxed", async (contentType, served) => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, contentType, "a.bin");
      const res = await request(asOwner(), "GET", `/${id}/attachments/${attId}/raw`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(served);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(await bodyText(res)).toBe("BYTES");
    });

    it("?download forces a save with the real filename even for an image", async () => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, "image/png", "Bild ä.png");
      const res = await request(asOwner(), "GET", `/${id}/attachments/${attId}/raw?download`);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="Bild _.png"; filename*=UTF-8''Bild%20%C3%A4.png`,
      );
    });

    it("is revalidated, not cached for a year, and carries an ETag", async () => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, "image/png");
      const res = await request(asOwner(), "GET", `/${id}/attachments/${attId}/raw`);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("etag")).toBe(`"att-${id}-${attId}"`);
    });

    it("answers a matching If-None-Match with 304", async () => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, "image/png");
      const res = await get(asOwner(), `/${id}/attachments/${attId}/raw`, {
        "if-none-match": `"att-${id}-${attId}"`,
      });
      expect(res.status).toBe(304);
      expect(await bodyText(res)).toBe("");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("lets 403 win over 304, and 404 win for an attachment of another message", async () => {
      const id = await seedWithEml();
      const attId = await seedAtt(id, "image/png");
      const etag = { "if-none-match": `"att-${id}-${attId}"` };
      expect((await get(asOutsider(), `/${id}/attachments/${attId}/raw`, etag)).status).toBe(403);
      const other = await seedWithEml();
      expect((await get(asOwner(), `/${other}/attachments/${attId}/raw`, etag)).status).toBe(404);
    });
  });
});

describe("message mutations — viewer role semantics", () => {
  it("a READ member can mark seen/starred but cannot trash or delete", async () => {
    await grantMember(db(), Perm.READ);
    const { messageId } = await seedThread(db());

    const seen = await request(asMember(), "PATCH", `/${messageId}`, { seen: true });
    expect(seen.status).toBe(200);
    const { flags } = (await seen.json()) as { flags: number };
    expect(flags & Flag.SEEN).toBe(Flag.SEEN);

    expect((await request(asMember(), "PATCH", `/${messageId}`, { trash: true })).status).toBe(403);
    expect((await request(asMember(), "DELETE", `/${messageId}`)).status).toBe(403);
  });

  it("403s a non-member on any message mutation", async () => {
    const { messageId } = await seedThread(db());
    expect((await request(asOutsider(), "PATCH", `/${messageId}`, { seen: true })).status).toBe(
      403,
    );
    expect((await request(asOutsider(), "DELETE", `/${messageId}`)).status).toBe(403);
  });
});

describe("DELETE /:id — only from Trash or Spam", () => {
  // Two messages in one thread, so deleting the first leaves the thread. The
  // first has a stored body and an attachment.
  async function seedTwo(overrides: Parameters<typeof seedThread>[2] = {}) {
    const { threadId, messageId } = await seedThread(db(), MAILBOX_ID, {
      msgCount: 2,
      ...overrides,
    });
    const otherId = `${messageId}-b`;
    await db().insert(message).values({
      id: otherId,
      mailboxId: MAILBOX_ID,
      threadId,
      direction: "in",
      fromAddr: "sender@elsewhere.test",
      subject: "Hello",
      snippet: "Second",
    });
    const rawKey = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
    await e.BLOBS.put(rawKey, "raw");
    await db().update(message).set({ rawR2Key: rawKey }).where(eq(message.id, messageId));
    const attId = await seedAtt(messageId, "image/png");
    return { threadId, messageId, otherId, keys: [rawKey, `att/${attId}`] };
  }

  const messageIds = async (threadId: string) =>
    (await db().select({ id: message.id }).from(message).where(eq(message.threadId, threadId)))
      .map((r) => r.id)
      .sort();
  const blobsPresent = (keys: string[]) =>
    Promise.all(keys.map(async (key) => (await e.BLOBS.head(key)) !== null));

  it("refuses a live message in a live thread, and keeps its blobs", async () => {
    const { threadId, messageId, otherId, keys } = await seedTwo();
    const res = await request(asOwner(), "DELETE", `/${messageId}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Move it to Trash first." });
    expect(await messageIds(threadId)).toEqual([messageId, otherId]);
    expect(await blobsPresent(keys)).toEqual([true, true]);
  });

  it("deletes a message of a trashed thread with its blobs", async () => {
    const { threadId, messageId, otherId, keys } = await seedTwo({ trashed: true });
    const res = await request(asOwner(), "DELETE", `/${messageId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, threadDeleted: false });
    expect(await messageIds(threadId)).toEqual([otherId]);
    expect(await blobsPresent(keys)).toEqual([false, false]);
  });

  it("deletes a message of a thread filed as spam", async () => {
    const { threadId, messageId, otherId } = await seedTwo({ spam: true });
    expect((await request(asOwner(), "DELETE", `/${messageId}`)).status).toBe(200);
    expect(await messageIds(threadId)).toEqual([otherId]);
  });

  it("deletes a message that was itself moved to Trash, in a live thread", async () => {
    const { threadId, messageId, otherId, keys } = await seedTwo();
    const trashed = await request(asOwner(), "PATCH", `/${messageId}`, { trash: true });
    expect(trashed.status).toBe(200);
    expect((await request(asOwner(), "DELETE", `/${messageId}`)).status).toBe(200);
    expect(await messageIds(threadId)).toEqual([otherId]);
    expect(await blobsPresent(keys)).toEqual([false, false]);
    // Its live sibling still cannot be deleted outright.
    expect((await request(asOwner(), "DELETE", `/${otherId}`)).status).toBe(409);
  });

  it("drops the thread with its last message", async () => {
    const { threadId, messageId } = await seedThread(db(), MAILBOX_ID, { trashed: true });
    const res = await request(asOwner(), "DELETE", `/${messageId}`);
    expect(await res.json()).toEqual({ deleted: true, threadDeleted: true });
    expect(await db().select().from(thread).where(eq(thread.id, threadId))).toEqual([]);
  });

  it("removes the row before the blobs, so a failed blob delete leaves no message without its body", async () => {
    const { threadId, messageId, otherId } = await seedTwo({ trashed: true });
    const failing = {
      ...e,
      BLOBS: { delete: () => Promise.reject(new Error("r2 down")) },
    } as unknown as Env;
    await requestWithEnv(asOwner(), "DELETE", `/${messageId}`, undefined, failing);
    expect(await messageIds(threadId)).toEqual([otherId]);
  });

  it("still needs WRITE when the thread is trashed (403 for a READ member)", async () => {
    await grantMember(db(), Perm.READ);
    const { threadId, messageId, keys } = await seedTwo({ trashed: true });
    expect((await request(asMember(), "DELETE", `/${messageId}`)).status).toBe(403);
    expect(await messageIds(threadId)).toHaveLength(2);
    expect(await blobsPresent(keys)).toEqual([true, true]);
  });
});

// Sign a proxy URL the same way the body rewriter does, so /proxy-image
// accepts it.
async function signedProxyPath(url: string): Promise<string> {
  const secret = await getOrCreateAuthSecret(e, db());
  const html = await proxyRemoteContent(`<img src="${url}">`, secret);
  const query = html.match(/proxy-image\?([^"\s]+)/)?.[1];
  if (!query) throw new Error("no proxy url produced");
  return `/proxy-image?${query.replace(/&amp;/g, "&")}`;
}

function stream(totalBytes: number, chunkSize = 1024 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= totalBytes) return ctrl.close();
      const n = Math.min(chunkSize, totalBytes - sent);
      ctrl.enqueue(new Uint8Array(n));
      sent += n;
    },
  });
}

// safeRedirectFetch only reads status/ok/body/headers, so a duck-typed
// upstream keeps header control exact (a real Response may rewrite
// content-length).
function stubUpstream(headers: Record<string, string>, body: ReadableStream<Uint8Array>): void {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    body,
    headers: new Headers(headers),
  }));
}

describe("GET /proxy-image — size limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("413s when the declared content-length exceeds the cap", async () => {
    const path = await signedProxyPath("https://images.example/big.png");
    stubUpstream(
      { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
      stream(16),
    );
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(413);
  });

  it("enforces the streaming cap when no content-length is declared", async () => {
    const path = await signedProxyPath("https://images.example/chunked.png");
    stubUpstream({ "content-type": "image/png" }, stream(MAX_IMAGE_BYTES + 1024));
    const res = await request(asOwner(), "GET", path);
    // The cap trips mid-stream: headers are already committed, so the failure
    // surfaces as an errored body rather than a status code.
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("streams a small image through untouched", async () => {
    const path = await signedProxyPath("https://images.example/ok.png");
    stubUpstream({ "content-type": "image/png", "content-length": "16" }, stream(16, 16));
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(16);
  });

  it("504s when the upstream never answers (hanging or self-redirecting tracker)", async () => {
    const path = await signedProxyPath("https://tracker.example/open-duration.gif");
    // Hang until the proxy's own deadline aborts the request.
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(504);
  }, 10_000);

  it("429s once the per-user proxy window is exhausted", async () => {
    await db()
      .insert(rateLimitCounter)
      .values({ key: `proxy-image:${OWNER_ID}`, count: 300, windowStart: Date.now() });
    const path = await signedProxyPath("https://images.example/limited.png");
    const res = await request(asOwner(), "GET", path);
    expect(res.status).toBe(429);
  });
});

describe("POST /:id/pgp/trust-sender — signature re-check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the stored result and logs ids and the error when the re-check throws", async () => {
    const [senderKey, mailboxKey] = await Promise.all([
      pgp.generateKeypair("Sender", "sender@elsewhere.test"),
      pgp.generateKeypair("Team", "team@example.com"),
    ]);
    const master = await getOrCreatePgpMasterKey(db());
    await db()
      .update(mailbox)
      .set({
        pgpPrivateKeyWrapped: await pgp.wrapSecret(master, mailboxKey.privateArmored),
        pgpPassphraseWrapped: await pgp.wrapSecret(master, mailboxKey.passphrase),
      })
      .where(eq(mailbox.id, MAILBOX_ID));
    const { messageId } = await seedThread(db());
    const rawKey = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
    const secretBody = "the body text that must not reach the log";
    await e.BLOBS.put(
      rawKey,
      [
        "From: sender@elsewhere.test",
        "Subject: Hello",
        "",
        secretBody,
        senderKey.publicArmored,
      ].join("\r\n"),
    );
    await db()
      .update(message)
      .set({ rawR2Key: rawKey, pgpSigned: true, pgpVerify: "unknown" })
      .where(eq(message.id, messageId));

    vi.spyOn(pgp, "decryptVerify").mockRejectedValue(new Error("openpgp unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(asOwner(), "POST", `/${messageId}/pgp/trust-sender`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { verify: string }).verify).toBe("unknown");
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls[0]);
    expect(line).toContain(messageId);
    expect(line).toContain(MAILBOX_ID);
    expect(line).toContain("openpgp unavailable");
    expect(line).not.toContain(secretBody);
  });
});
