import {
  appPassword,
  attachment,
  contactKey,
  domain,
  draft,
  folder,
  label,
  mailbox,
  mailboxMember,
  mailboxNotify,
  message,
  messageLabel,
  reminder,
  rule,
  thread,
  threadFolder,
} from "@cfmail/db/schema";
import { ALL_MAILBOX_KINDS, Perm } from "@cfmail/shared/permissions";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { applyMigrationsOnce, db, e, resetDb } from "../support/app.ts";
import { bodyText } from "../support/body.ts";
import { call, createUser, type Jar, signIn } from "../support/session.ts";

// AGENTS.md invariant 2, checked from the outside. A signed-in user who owns
// nothing calls every route of the real app (`buildApi()`) with another user's
// ids. A route that serves one mailbox's data must refuse with 403 or 404,
// whatever its handler looks like. Adding a route without a permission check
// fails this file, because the walk is built from `app.routes`.
const app = buildApi();

const MB = "victim-mailbox";
const THREAD = "victim-thread";
const MSG = "victim-message";
const ATT = "victim-attachment";
const LABEL = "victim-label";
const RULE = "victim-rule";
const CONTACT = "victim-contact-key";
const DRAFT = "victim-draft";
const REMINDER = "victim-reminder";
const FOLDER = "victim-folder";
const APP_PASSWORD = "victim-app-password";
const DOMAIN = "victim-domain";
// Text that only the victim's mail carries. No answer to the stranger may hold it.
const SECRET = "VICTIM-SECRET";

// Routes that answer about the caller, not about a mailbox, so a 2xx is right.
// They are still called, with the victim's ids where they take any, and must
// not answer with the victim's data. Adding a route here is a security
// decision, so say why.
const USER_SCOPED: Record<string, string> = {
  "GET /api/bootstrap": "public: tells the sign-in page whether setup is needed",
  "POST /api/bootstrap": "public: first-run setup, gated by SETUP_TOKEN",
  "POST /api/users/invites/accept": "public: gated by the invite token",
  "GET /api/users/invites/by-token/:token": "public: gated by the invite token",
  "GET /api/health": "liveness probe",
  "GET /api/me": "the caller's own session user",
  "GET /api/mailboxes": "the caller's own mailbox list",
  "GET /api/contacts": "suggestions from the caller's own readable mailboxes",
  "GET /api/domains": "domain names, which every user sees when creating a mailbox",
  "GET /api/temp/domains": "domains the caller may create a temp mailbox on",
  "GET /api/users/directory": "names and addresses of users, for the sharing picker",
  "GET /api/folders": "the caller's own folders; counts cover readable mailboxes only",
  "POST /api/folders": "creates a folder owned by the caller",
  "GET /api/reminders": "the caller's own reminders",
  "GET /api/app-passwords": "the caller's own app passwords",
  "GET /api/push/key": "the deployment's public VAPID key",
  "POST /api/push/subscribe": "registers the caller's own device",
  "POST /api/push/unsubscribe": "removes the caller's own device only",
  "GET /api/push/mailboxes": "the caller's own notification settings",
  "POST /api/attachments/upload": "stores under the caller's own draft/<userId>/ prefix",
  "POST /api/avatar": "replaces the caller's own avatar",
  "GET /api/avatar/:userId/:id": "avatars are shown next to every user's name by design",
  "POST /api/blocklist/check": "any sender may check recipients against the blocklist",
  "GET /api/labels/by-messages": "answers only for labels in mailboxes the caller can read",
  "GET /api/labels/by-threads": "answers only for labels in mailboxes the caller can read",
  "GET /api/messages/proxy-image": "not mailbox data: serves only URLs the server signed",
};

// Routes that take a service mailbox's bearer key instead of a session. A
// session cookie is not a key, so they answer 401 (see real-app.test.ts).
const KEY_AUTHED = (key: string) => key.split(" ")[1]?.startsWith("/api/svc/") ?? false;

// Routes the walk does not call, with the reason.
const NOT_CALLED: Record<string, string> = {
  "GET /api/stream": "opens a stream that never ends; hub.test.ts checks users are isolated",
};

// Which victim id each path parameter takes. `:id` depends on the route group.
const ID_BY_PREFIX: [string, string][] = [
  ["/api/admin/block/", "x"],
  ["/api/admin/", MB],
  ["/api/push/mailboxes/", MB],
  ["/api/mailboxes/", MB],
  ["/api/labels/", LABEL],
  ["/api/rules/", RULE],
  ["/api/threads/", THREAD],
  ["/api/messages/", MSG],
  ["/api/drafts/", DRAFT],
  ["/api/folders/", FOLDER],
  ["/api/reminders/", REMINDER],
  ["/api/attachments/", ATT],
  ["/api/app-passwords/", APP_PASSWORD],
  ["/api/users/invites/", "x"],
  ["/api/domains/", DOMAIN],
  ["/api/svc/", MSG],
];

let victimId = "";
let strangerId = "";
let memberId = "";

function paramValue(path: string, name: string): string {
  switch (name) {
    case "id":
      if (path.startsWith("/api/users/:id")) return victimId;
      if (path.startsWith("/api/avatar/")) return "avatar";
      return ID_BY_PREFIX.find(([prefix]) => path.startsWith(prefix))?.[1] ?? "x";
    case "userId":
      return path.startsWith("/api/avatar/") ? victimId : memberId;
    case "contactId":
      return CONTACT;
    case "messageId":
      return MSG;
    case "threadId":
      return THREAD;
    case "attId":
      return ATT;
    case "domainId":
      return DOMAIN;
    default:
      return "x";
  }
}

const inAnHour = () => Date.now() + 3_600_000;

// The query string or body each route needs to get past its validator, so the
// only thing that can stop it is the permission check.
const QUERY: Record<string, () => string> = {
  "GET /api/labels": () => `mailboxId=${MB}`,
  "GET /api/rules": () => `mailboxId=${MB}`,
  "GET /api/threads": () => `mailboxId=${MB}`,
  "GET /api/threads/counts": () => `mailboxId=${MB}`,
  "GET /api/threads/:id/bodies": () => `ids=${MSG}`,
  "GET /api/drafts": () => `mailboxId=${MB}`,
  "GET /api/labels/by-messages": () => `id=${MSG}`,
  "GET /api/labels/by-threads": () => `id=${THREAD}`,
  "GET /api/search": () => `mailboxId=${MB}&q=${SECRET}`,
  "GET /api/attachments/draft-blob": () => `key=draft/${victimId}/photo.png`,
};

const BODY: Record<string, () => unknown> = {
  "POST /api/mailboxes": () => ({ domainId: DOMAIN, localPart: "grab", type: "group" }),
  "PATCH /api/mailboxes/:id/settings": () => ({ displayName: "taken" }),
  "POST /api/mailboxes/:id/pgp/import": () => ({ privateKey: "x" }),
  "POST /api/mailboxes/:id/contacts": () => ({ publicKey: "x" }),
  "PATCH /api/mailboxes/:id/contacts/:contactId": () => ({ verified: false }),
  "POST /api/mailboxes/:id/members": () => ({
    mailboxId: MB,
    userId: strangerId,
    read: true,
    write: true,
    manage: true,
  }),
  "POST /api/mailboxes/:id/import": () => "From: someone@elsewhere.test\r\n\r\nhello",
  "POST /api/temp": () => ({ domainId: DOMAIN }),
  "POST /api/labels": () => ({ mailboxId: MB, name: "taken" }),
  "PATCH /api/labels/:id": () => ({ name: "taken" }),
  "POST /api/rules": () => ({
    mailboxId: MB,
    name: "taken",
    conditions: [{ field: "from", op: "contains", value: "x" }],
    actions: [{ type: "forward", to: "thief@elsewhere.test" }],
  }),
  "PATCH /api/rules/:id": () => ({ name: "taken" }),
  "POST /api/rules/:id/clone": () => ({}),
  "PATCH /api/threads/:id": () => ({ read: true }),
  "POST /api/threads/read-all": () => ({ mailboxId: MB }),
  "POST /api/drafts": () => ({ mailboxId: MB }),
  "PATCH /api/drafts/:id": () => ({ subject: "taken" }),
  "POST /api/drafts/:id/schedule": () => ({
    sendAt: inAnHour(),
    payload: { mailboxId: MB, to: [{ address: "someone@elsewhere.test" }] },
  }),
  "PATCH /api/folders/:id": () => ({ name: "taken" }),
  "POST /api/folders/:id/threads": () => ({ threadIds: [THREAD] }),
  "POST /api/messages/send": () => ({
    mailboxId: MB,
    to: [{ address: "someone@elsewhere.test" }],
    text: "hello",
  }),
  "PATCH /api/messages/:id": () => ({ seen: true }),
  "POST /api/messages/:id/block-request": () => ({}),
  "POST /api/reminders": () => ({ mailboxId: MB, threadId: THREAD, remindAt: inAnHour() }),
  "PATCH /api/reminders/:id": () => ({ note: "taken" }),
  "POST /api/app-passwords": () => ({ mailboxId: MB, name: "taken" }),
  "PUT /api/push/mailboxes/:id": () => ({ level: "normal" }),
  "POST /api/folders": () => ({ name: "mine" }),
  "POST /api/blocklist/check": () => ({ addresses: ["someone@elsewhere.test"] }),
  "POST /api/push/unsubscribe": () => ({ endpoint: "https://push.example.com/x" }),
};

function requestFor(key: string, path: string): { url: string; body: unknown } {
  const filled = path.replace(/:([A-Za-z]+)/g, (_, name: string) => paramValue(path, name));
  const query = QUERY[key]?.();
  return { url: query ? `${filled}?${query}` : filled, body: BODY[key]?.() };
}

// Every row the victim owns, in a stable order. A refused request changes none.
async function victimState(): Promise<string> {
  const d = db();
  const rows = await Promise.all([
    d.select().from(mailbox).where(eq(mailbox.id, MB)),
    d.select().from(mailboxMember).where(eq(mailboxMember.mailboxId, MB)),
    d.select().from(thread).where(eq(thread.mailboxId, MB)),
    d.select().from(message).where(eq(message.mailboxId, MB)),
    d.select().from(attachment).where(eq(attachment.id, ATT)),
    d.select().from(label).where(eq(label.mailboxId, MB)),
    d.select().from(messageLabel).where(eq(messageLabel.labelId, LABEL)),
    d.select().from(rule).where(eq(rule.mailboxId, MB)),
    d.select().from(contactKey).where(eq(contactKey.mailboxId, MB)),
    d.select().from(draft).where(eq(draft.mailboxId, MB)),
    d.select().from(reminder).where(eq(reminder.mailboxId, MB)),
    d.select().from(folder).where(eq(folder.userId, victimId)),
    d.select().from(threadFolder).where(eq(threadFolder.threadId, THREAD)),
    d.select().from(appPassword).where(eq(appPassword.mailboxId, MB)),
    d.select().from(mailboxNotify).where(eq(mailboxNotify.mailboxId, MB)),
  ]);
  return JSON.stringify(rows);
}

async function seedVictim(): Promise<void> {
  victimId = await createUser("victim@example.com", "victim-password-123");
  memberId = await createUser("member@example.com", "member-password-123");
  const d = db();
  await d
    .insert(domain)
    .values({ id: DOMAIN, name: "victim.test", allowedKinds: ALL_MAILBOX_KINDS });
  await d.insert(mailbox).values({
    id: MB,
    domainId: DOMAIN,
    localPart: "secret-box",
    type: "group",
    ownerUserId: victimId,
  });
  const writerId = await createUser("writer@example.com", "writer-password-123");
  await d.insert(mailboxMember).values([
    { mailboxId: MB, userId: memberId, perms: Perm.READ },
    { mailboxId: MB, userId: writerId, perms: Perm.WRITE },
  ]);
  await d.insert(thread).values({ id: THREAD, mailboxId: MB, subjectNorm: SECRET, msgCount: 1 });
  await d.insert(message).values({
    id: MSG,
    mailboxId: MB,
    threadId: THREAD,
    direction: "in",
    fromAddr: "sender@elsewhere.test",
    subject: SECRET,
    snippet: SECRET,
    rawR2Key: `raw/${MB}/${MSG}.eml`,
  });
  await e.BLOBS.put(`raw/${MB}/${MSG}.eml`, `Subject: ${SECRET}\r\n\r\n${SECRET}`);
  await d.insert(attachment).values({
    id: ATT,
    messageId: MSG,
    filename: "secret.txt",
    contentType: "text/plain",
    sizeBytes: SECRET.length,
    r2Key: `att/${MB}/${MSG}/secret.txt`,
  });
  await e.BLOBS.put(`att/${MB}/${MSG}/secret.txt`, SECRET);
  await d.insert(label).values({ id: LABEL, mailboxId: MB, name: SECRET });
  await d.insert(messageLabel).values({ messageId: MSG, labelId: LABEL });
  await d.insert(rule).values({
    id: RULE,
    mailboxId: MB,
    createdBy: victimId,
    name: SECRET,
    conditions: [{ field: "from", op: "contains", value: "x" }],
    actions: [{ type: "markRead" }],
  });
  await d.insert(contactKey).values({
    id: CONTACT,
    mailboxId: MB,
    email: "friend@elsewhere.test",
    publicKey: SECRET,
    fingerprint: SECRET,
  });
  await d.insert(draft).values({ id: DRAFT, mailboxId: MB, userId: victimId, subject: SECRET });
  await d.insert(reminder).values({
    id: REMINDER,
    userId: victimId,
    mailboxId: MB,
    threadId: THREAD,
    kind: "manual",
    remindAt: new Date(inAnHour()),
    subject: SECRET,
  });
  await d.insert(folder).values({ id: FOLDER, userId: victimId, name: SECRET });
  await d.insert(threadFolder).values({ threadId: THREAD, folderId: FOLDER, userId: victimId });
  await d.insert(appPassword).values({
    id: APP_PASSWORD,
    userId: victimId,
    mailboxId: MB,
    name: SECRET,
    hash: "x",
  });
  await d.insert(mailboxNotify).values({ mailboxId: MB, userId: victimId, level: "important" });
}

const routes = [...new Map(app.routes.map((r) => [`${r.method} ${r.path}`, r] as const)).values()];
const handlers = routes.filter((r) => r.method !== "ALL");
const walked = handlers.filter((r) => !NOT_CALLED[`${r.method} ${r.path}`]);

// The stranger owns nothing. The writer holds WRITE on the victim's mailbox, but not READ.
let jar: Jar;
let writerJar: Jar;
let before = "";

beforeAll(async () => {
  // The request log would print a line for every call.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await applyMigrationsOnce();
  await resetDb();
  await seedVictim();
  strangerId = await createUser("stranger@example.com", "stranger-password-123");
  const signedIn = await signIn(app, "stranger@example.com", "stranger-password-123");
  expect(signedIn.res.status).toBe(200);
  jar = signedIn.jar;
  const writer = await signIn(app, "writer@example.com", "writer-password-123");
  expect(writer.res.status).toBe(200);
  writerJar = writer.jar;
  before = await victimState();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("a signed-in stranger", () => {
  it("has routes to walk", () => {
    expect(walked.length).toBeGreaterThan(100);
  });

  it.each(walked.map((r) => [`${r.method} ${r.path}`, r.method, r.path] as const))(
    "%s gives away nothing of another user's mailbox",
    async (key, method, path) => {
      const { url, body } = requestFor(key, path);
      const res = await call(app, jar, method, url, body);
      const text = await bodyText(res);

      if (KEY_AUTHED(key)) {
        expect(res.status).toBe(401);
      } else if (USER_SCOPED[key]) {
        expect(res.status).toBeLessThan(500);
      } else {
        expect([403, 404], `${key} answered ${res.status}: ${text}`).toContain(res.status);
      }
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(MB);
      expect(await victimState()).toBe(before);
    },
  );

  // The combined views list several mailboxes at once, so they decide access
  // through accessibleMailboxIds instead of requirePerm. A member who may not
  // read the mailbox must not see it there either.
  it.each([
    "/api/threads?mailboxId=all",
    "/api/threads/counts?mailboxId=all",
    "/api/drafts?mailboxId=all",
    "/api/folders",
    "/api/contacts",
    `/api/search?q=${SECRET}`,
  ])("%s leaves out a mailbox shared without READ", async (url) => {
    const res = await call(app, writerJar, "GET", url);
    expect(res.status).toBe(200);
    expect(await bodyText(res)).not.toContain(SECRET);
  });

  it("every route on the lists still exists", () => {
    const known = new Set(handlers.map((r) => `${r.method} ${r.path}`));
    const listed = [...Object.keys(USER_SCOPED), ...Object.keys(NOT_CALLED)];
    expect(listed.filter((key) => !known.has(key))).toEqual([]);
    const shaped = [...Object.keys(QUERY), ...Object.keys(BODY)];
    expect(shaped.filter((key) => !known.has(key))).toEqual([]);
  });
});
