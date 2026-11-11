import { attachment, message, thread } from "@cfmail/db/schema";
import { Perm } from "@cfmail/shared/permissions";
import type { MessageBodyDto } from "@cfmail/shared/responses";
import { MAX_BODIES_PER_REQUEST } from "@cfmail/shared/schemas";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesRoutes } from "../../src/api/messages.ts";
import { threadsRoutes } from "../../src/api/threads.ts";
import type { AppBindings } from "../../src/env.ts";
import { refreshTrackerList } from "../../src/mail/trackers.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { bodyText } from "../support/body.ts";
import {
  grantMember,
  MAILBOX_ID,
  member,
  OTHER_MAILBOX_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

// GET /api/threads/:id/bodies returns the rendered bodies of several messages of
// one thread in one request, so opening a conversation is not one request per
// message. It must serve exactly what GET /api/messages/:id/body serves for each
// message, under the same permission and cache rules.

const threads = (user: typeof owner | null) => mountApp(threadsRoutes, user);
const messages = (user: typeof owner | null) => mountApp(messagesRoutes, user);

const get = (app: Hono<AppBindings>, path: string, headers?: Record<string, string>) =>
  Promise.resolve(app.request(path, { headers }, e));

const THREAD = "conv";

const HTML_EML = [
  "MIME-Version: 1.0",
  "From: sender@elsewhere.test",
  "To: team@example.com",
  "Subject: Newsletter",
  'Content-Type: multipart/related; boundary="b"',
  "",
  "--b",
  "Content-Type: text/html; charset=utf-8",
  "",
  `<div><script>alert(1)</script><p onclick="x()">News</p>` +
    `<img src="https://news.example.com/wf/open?upn=abc" alt="">` +
    `<img src="https://cdn.example.com/hero.png" width="600" height="200">` +
    `<img src="cid:logo@x"></div>`,
  "--b",
  "Content-Type: image/png",
  "Content-ID: <logo@x>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--b--",
  "",
].join("\r\n");

const PLAIN_EML = [
  "MIME-Version: 1.0",
  "From: team@example.com",
  "To: sender@elsewhere.test",
  "Subject: Re: Newsletter",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Thanks, noted.",
  "",
].join("\r\n");

let seq = 0;

// One message in `threadId`, stored in R2 under its raw key (or none at all).
async function seedMessage(
  threadId: string,
  eml: string | null,
  mailboxId: string = MAILBOX_ID,
): Promise<string> {
  const id = `m-${++seq}`;
  const rawR2Key = eml === null ? null : `raw/${mailboxId}/${id}.eml`;
  await db()
    .insert(message)
    .values({
      id,
      mailboxId,
      threadId,
      direction: "in",
      fromAddr: "sender@elsewhere.test",
      subject: "Newsletter",
      snippet: "News",
      rawR2Key,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
    });
  if (rawR2Key && eml) await e.BLOBS.put(rawR2Key, eml);
  return id;
}

async function seedThreadRow(id: string, mailboxId: string = MAILBOX_ID): Promise<void> {
  await db().insert(thread).values({ id, mailboxId, subjectNorm: "newsletter", msgCount: 1 });
}

// A thread with an HTML message carrying a tracker, a remote image and an
// inline image, a plain reply, and a message with a regular attachment.
async function seedConversation(): Promise<string[]> {
  await seedThreadRow(THREAD);
  const html = await seedMessage(THREAD, HTML_EML);
  await db()
    .insert(attachment)
    .values({
      id: `${html}-logo`,
      messageId: html,
      filename: "logo.png",
      contentType: "image/png",
      sizeBytes: 8,
      inline: true,
      contentId: "<logo@x>",
      r2Key: `att/${MAILBOX_ID}/${html}/logo.png`,
    });
  const plain = await seedMessage(THREAD, PLAIN_EML);
  const withFile = await seedMessage(THREAD, PLAIN_EML);
  await db()
    .insert(attachment)
    .values([
      {
        id: `${withFile}-a`,
        messageId: withFile,
        filename: "notes.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        r2Key: `att/${MAILBOX_ID}/${withFile}/notes.pdf`,
      },
      {
        id: `${withFile}-b`,
        messageId: withFile,
        filename: "photo.jpg",
        contentType: "image/jpeg",
        sizeBytes: 20,
        r2Key: `att/${MAILBOX_ID}/${withFile}/photo.jpg`,
      },
    ]);
  return [html, plain, withFile];
}

const bodiesPath = (threadId: string, ids: string[]) =>
  `/${threadId}/bodies?ids=${ids.map(encodeURIComponent).join(",")}`;

async function bodiesOf(
  user: typeof owner,
  threadId: string,
  ids: string[],
): Promise<Record<string, MessageBodyDto>> {
  const res = await get(threads(user), bodiesPath(threadId, ids));
  expect(res.status).toBe(200);
  return ((await res.json()) as { bodies: Record<string, MessageBodyDto> }).bodies;
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  // The tracker list the cron would have stored, so stripping has work to do.
  // The other source answers 404, which the refresh reports on the console.
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const easyPrivacy = [
    "/wf/open?upn=$image",
    ...Array.from({ length: 20 }, (_, i) => `.v${i}.example/open/$image`),
  ].join("\n");
  await refreshTrackerList(db(), new Date(), (async (input: RequestInfo | URL) =>
    (input instanceof Request ? input.url : String(input)).includes("easylist")
      ? new Response(easyPrivacy)
      : new Response("gone", { status: 404 })) as unknown as typeof fetch);
  quiet.mockRestore();
});
afterEach(async () => {
  const keys = (await e.BLOBS.list({ prefix: "raw/" })).objects.map((o) => o.key);
  await Promise.all(keys.map((key) => e.BLOBS.delete(key)));
});

describe("GET /api/threads/:id/bodies", () => {
  it("serves for each message exactly what the single-body route serves", async () => {
    const ids = await seedConversation();
    const bodies = await bodiesOf(owner, THREAD, ids);
    expect(Object.keys(bodies).toSorted()).toEqual(ids.toSorted());
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- one comparison per message
      const single = await get(messages(owner), `/${id}/body`);
      expect(single.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop -- one comparison per message
      expect(bodies[id], id).toEqual(await single.json());
    }
    // The comparison is only worth something if the HTML went through every step.
    const html = bodies[ids[0]!]!;
    expect(html.trackersBlocked).toBe(1);
    expect(html.html).not.toContain("<script");
    expect(html.html).toContain("/api/messages/proxy-image?u=");
    expect(html.html).toContain(`/api/messages/${ids[0]}/attachments/${ids[0]}-logo/raw`);
    expect(bodies[ids[2]!]!.attachments.map((a) => a.filename)).toEqual(["notes.pdf", "photo.jpg"]);
  });

  it("serves only the requested messages", async () => {
    const ids = await seedConversation();
    const bodies = await bodiesOf(owner, THREAD, [ids[1]!]);
    expect(Object.keys(bodies)).toEqual([ids[1]]);
  });

  it("lets a READ member fetch the bodies", async () => {
    await grantMember(db(), Perm.READ);
    const ids = await seedConversation();
    expect(Object.keys(await bodiesOf(member, THREAD, ids))).toHaveLength(3);
  });

  it("refuses a user without READ on the thread's mailbox", async () => {
    const ids = await seedConversation();
    expect((await get(threads(outsider), bodiesPath(THREAD, ids))).status).toBe(403);
    await grantMember(db(), Perm.WRITE);
    expect((await get(threads(member), bodiesPath(THREAD, ids))).status).toBe(403);
  });

  it("404s a thread that does not exist", async () => {
    expect((await get(threads(owner), bodiesPath("missing", ["m-x"]))).status).toBe(404);
  });

  it("never serves a message of another thread, even one the caller may read", async () => {
    const ids = await seedConversation();
    await seedThreadRow("elsewhere", OTHER_MAILBOX_ID);
    const foreign = await seedMessage("elsewhere", PLAIN_EML, OTHER_MAILBOX_ID);
    const bodies = await bodiesOf(owner, THREAD, [ids[1]!, foreign]);
    expect(Object.keys(bodies)).toEqual([ids[1]]);
  });

  it("leaves out a message without a stored body, as the single route 404s it", async () => {
    await seedThreadRow(THREAD);
    const stored = await seedMessage(THREAD, PLAIN_EML);
    const noKey = await seedMessage(THREAD, null);
    const blobGone = await seedMessage(THREAD, PLAIN_EML);
    await e.BLOBS.delete(`raw/${MAILBOX_ID}/${blobGone}.eml`);
    for (const id of [noKey, blobGone]) {
      // eslint-disable-next-line no-await-in-loop -- one check per message
      expect((await get(messages(owner), `/${id}/body`)).status).toBe(404);
    }
    const bodies = await bodiesOf(owner, THREAD, [stored, noKey, blobGone]);
    expect(Object.keys(bodies)).toEqual([stored]);
  });

  it("refuses an empty id list and more than the per-request maximum", async () => {
    await seedThreadRow(THREAD);
    expect((await get(threads(owner), `/${THREAD}/bodies?ids=`)).status).toBe(400);
    expect((await get(threads(owner), `/${THREAD}/bodies`)).status).toBe(400);
    const tooMany = Array.from({ length: MAX_BODIES_PER_REQUEST + 1 }, (_, i) => `m-${i}`);
    expect((await get(threads(owner), bodiesPath(THREAD, tooMany))).status).toBe(400);
  });

  describe("caching, as on the single-body route", () => {
    it("is revalidated, not cached, and carries an ETag", async () => {
      const ids = await seedConversation();
      const res = await get(threads(owner), bodiesPath(THREAD, ids));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("etag")).toMatch(/^"bodies-[A-Za-z0-9_-]+"$/);
    });

    it("names the set of messages served, whatever their order in the request", async () => {
      const ids = await seedConversation();
      const etag = async (list: string[]) =>
        (await get(threads(owner), bodiesPath(THREAD, list))).headers.get("etag");
      expect(await etag(ids)).toBe(await etag(ids.toReversed()));
      expect(await etag(ids)).not.toBe(await etag(ids.slice(1)));
      // A message that is gone no longer counts, so a cached copy holding it is not reused.
      await db().delete(message).where(eq(message.id, ids[0]!));
      expect(await etag(ids)).toBe(await etag(ids.slice(1)));
    });

    it("answers a matching If-None-Match with 304 and no body", async () => {
      const ids = await seedConversation();
      const etag = (await get(threads(owner), bodiesPath(THREAD, ids))).headers.get("etag")!;
      const res = await get(threads(owner), bodiesPath(THREAD, ids), { "if-none-match": etag });
      expect(res.status).toBe(304);
      expect(await bodyText(res)).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("lets 403 win over 304 for a user without access", async () => {
      const ids = await seedConversation();
      const etag = (await get(threads(owner), bodiesPath(THREAD, ids))).headers.get("etag")!;
      const res = await get(threads(outsider), bodiesPath(THREAD, ids), { "if-none-match": etag });
      expect(res.status).toBe(403);
    });
  });
});
