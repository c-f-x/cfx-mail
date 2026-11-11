import {
  appPassword,
  attachment,
  domain,
  mailbox,
  mailboxMember,
  message,
  session,
  thread,
  user,
} from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { hashAppPassword } from "../../src/app-passwords.ts";
import { resolveAccess } from "../../src/permissions.ts";
import { applyMigrationsOnce, db, e, resetDb } from "../support/app.ts";
import { runCronOffline } from "../support/cron.ts";
import { call, createUser, signIn } from "../support/session.ts";

const ADMIN = { email: "admin@example.com", password: "admin-password-1" };
const ALICE = { email: "alice@example.com", password: "alice-password-1" };
const DOMAIN = "d1";
const MB = "mb-alice";
const RAW = `raw/${MB}/m1.eml`;
const ATT = "att/m1/0-file.txt";

let aliceId: string;

async function blobKeys(prefix: string): Promise<string[]> {
  return (await e.BLOBS.list({ prefix })).objects.map((o) => o.key);
}

// A domain with one mailbox owned by Alice that holds one message with an
// attachment, both stored in R2.
async function seedMail(): Promise<void> {
  await db().insert(domain).values({ id: DOMAIN, name: "example.com" });
  await db().insert(mailbox).values({
    id: MB,
    domainId: DOMAIN,
    localPart: "alice",
    type: "personal",
    ownerUserId: aliceId,
  });
  await db().insert(thread).values({ id: "t1", mailboxId: MB, msgCount: 1 });
  await db().insert(message).values({
    id: "m1",
    mailboxId: MB,
    threadId: "t1",
    direction: "in",
    fromAddr: "sender@elsewhere.test",
    rawR2Key: RAW,
  });
  await db().insert(attachment).values({
    id: "a1",
    messageId: "m1",
    filename: "file.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    r2Key: ATT,
  });
  await e.BLOBS.put(RAW, "raw");
  await e.BLOBS.put(ATT, "hello");
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await Promise.all([RAW, ATT].map((key) => e.BLOBS.delete(key)));
  // The real app logs one line per request.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await createUser(ADMIN.email, ADMIN.password, "admin");
  aliceId = await createUser(ALICE.email, ALICE.password);
  await seedMail();
});

describe("deleting a user", () => {
  it("locks the user out at once and removes their mail through the staged purge", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);
    await db()
      .insert(appPassword)
      .values({
        id: "ap-1",
        userId: aliceId,
        mailboxId: MB,
        name: "phone",
        hash: await hashAppPassword("abcde-fghjk-mnpqr-stuvw"),
      });
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    const res = await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, {
      deleteMailboxIds: [MB],
    });
    expect(res.status).toBe(204);

    // Nothing was destroyed in the request itself.
    expect(await db().select().from(message)).toHaveLength(1);
    expect(await blobKeys(`raw/${MB}/`)).toEqual([RAW]);

    // At once: no access of any kind, and the mailbox reads as gone.
    expect((await call(app, alice.jar, "GET", "/api/mailboxes")).status).toBe(401);
    expect((await signIn(app, ALICE.email, ALICE.password)).res.status).toBe(403);
    expect(await db().select().from(session).where(eq(session.userId, aliceId))).toHaveLength(0);
    expect(
      await db().select().from(appPassword).where(eq(appPassword.userId, aliceId)),
    ).toHaveLength(0);
    expect(await resolveAccess(db(), aliceId, MB)).toBeNull();

    // The user is gone from both lists and cannot be brought back.
    const listed = (await (await call(app, admin.jar, "GET", "/api/users")).json()) as {
      users: { id: string }[];
    };
    expect(listed.users.map((u) => u.id)).not.toContain(aliceId);
    const directory = (await (
      await call(app, admin.jar, "GET", "/api/users/directory")
    ).json()) as { users: { id: string }[] };
    expect(directory.users.map((u) => u.id)).not.toContain(aliceId);
    const unban = await call(app, admin.jar, "PATCH", `/api/users/${aliceId}`, { banned: false });
    expect(unban.status).toBe(409);
    expect((await signIn(app, ALICE.email, ALICE.password)).res.status).toBe(403);

    // Deleting again while the purge runs is a no-op, not an error.
    expect(
      (await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, { deleteMailboxIds: [MB] }))
        .status,
    ).toBe(204);

    // Drain: the same tick purges the mailbox and then drops the user.
    await runCronOffline(e, new Date());

    expect(await db().select().from(thread)).toHaveLength(0);
    expect(await db().select().from(message)).toHaveLength(0);
    expect(await db().select().from(attachment)).toHaveLength(0);
    expect(await blobKeys(`raw/${MB}/`)).toEqual([]);
    expect(await blobKeys("att/m1/")).toEqual([]);
    expect(await db().select().from(mailbox)).toHaveLength(0);
    expect(await db().select().from(user).where(eq(user.id, aliceId))).toHaveLength(0);
  });

  it("keeps the user row while one of their mailboxes is still being purged", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect(
      (await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, { deleteMailboxIds: [MB] }))
        .status,
    ).toBe(204);
    // A second mailbox that the purge has not reached: an owner row must stay
    // for as long as mail hangs off it, or the cascade wipes it in one stroke.
    await db().update(mailbox).set({ pendingPurge: null }).where(eq(mailbox.id, MB));

    await runCronOffline(e, new Date());

    expect(await db().select().from(user).where(eq(user.id, aliceId))).toHaveLength(1);
    expect(await db().select().from(message)).toHaveLength(1);
    expect(await blobKeys(`raw/${MB}/`)).toEqual([RAW]);
  });
});

// The admin chooses which of a user's mailboxes go with them. The rest are
// handed to the admin, mail and members intact, so deleting a person never
// takes shared mail with it by accident.
describe("deleting a user: which mailboxes go with them", () => {
  const GROUP = "mb-team";
  let bobId: string;

  beforeEach(async () => {
    bobId = await createUser("bob@example.com", "bob-password-12");
    await db().insert(mailbox).values({
      id: GROUP,
      domainId: DOMAIN,
      localPart: "team",
      type: "group",
      ownerUserId: aliceId,
    });
    await db().insert(mailboxMember).values({ mailboxId: GROUP, userId: bobId, perms: 3 });
  });

  const owner = async (id: string) =>
    (await db().query.mailbox.findFirst({ where: eq(mailbox.id, id) }))?.ownerUserId;

  it("lists the mailboxes the user owns, and how many others share each", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    const res = await call(app, admin.jar, "GET", `/api/users/${aliceId}/mailboxes`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mailboxes: [
        { id: MB, address: "alice@example.com", type: "personal", sharedWith: 0 },
        { id: GROUP, address: "team@example.com", type: "group", sharedWith: 1 },
      ],
    });
  });

  it("hands every mailbox nobody ticked to the admin, with its mail and members", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const adminId = (await db().query.user.findFirst({ where: eq(user.email, ADMIN.email) }))!.id;

    const res = await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, {
      deleteMailboxIds: [],
    });
    await runCronOffline(e, new Date());

    expect(res.status).toBe(204);
    expect(await owner(MB)).toBe(adminId);
    expect(await owner(GROUP)).toBe(adminId);
    expect(await db().select().from(message)).toHaveLength(1);
    expect(await db().select().from(mailboxMember)).toMatchObject([{ userId: bobId }]);
    expect(await db().select().from(user).where(eq(user.id, aliceId))).toHaveLength(0);
  });

  it("deletes only the ticked mailboxes", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, { deleteMailboxIds: [GROUP] });
    await runCronOffline(e, new Date());

    expect((await db().select().from(mailbox)).map((m) => m.id)).toEqual([MB]);
    expect(await db().select().from(message)).toHaveLength(1);
  });

  it("refuses a mailbox the user does not own, and changes nothing", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    await db().update(mailbox).set({ ownerUserId: bobId }).where(eq(mailbox.id, GROUP));

    const res = await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, {
      deleteMailboxIds: [GROUP],
    });

    expect(res.status).toBe(400);
    expect((await db().query.user.findFirst({ where: eq(user.id, aliceId) }))?.banned).toBe(false);
    expect(await owner(MB)).toBe(aliceId);
  });

  it("leaves no member row for the admin on a mailbox handed to them", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const adminId = (await db().query.user.findFirst({ where: eq(user.email, ADMIN.email) }))!.id;
    await db().insert(mailboxMember).values({ mailboxId: GROUP, userId: adminId, perms: 1 });

    await call(app, admin.jar, "DELETE", `/api/users/${aliceId}`, { deleteMailboxIds: [] });

    expect(
      await db().select().from(mailboxMember).where(eq(mailboxMember.userId, adminId)),
    ).toEqual([]);
  });
});

describe("deleting a shared mailbox", () => {
  const GROUP = "mb-shared";

  beforeEach(async () => {
    const bobId = await createUser("bob@example.com", "bob-password-12");
    await db().insert(mailbox).values({
      id: GROUP,
      domainId: DOMAIN,
      localPart: "shared",
      type: "group",
      ownerUserId: aliceId,
    });
    await db().insert(mailboxMember).values({ mailboxId: GROUP, userId: bobId, perms: 1 });
  });

  it("is refused to an owner who is not an admin", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);

    const res = await call(app, alice.jar, "DELETE", `/api/mailboxes/${GROUP}`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This mailbox is shared with others. Ask an admin to delete it.",
    });
    expect(
      (await db().query.mailbox.findFirst({ where: eq(mailbox.id, GROUP) }))?.pendingPurge,
    ).toBeNull();
  });

  it("is still allowed to an owner when nobody else shares it", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);

    expect((await call(app, alice.jar, "DELETE", `/api/mailboxes/${MB}`)).status).toBe(204);
  });

  it("is allowed to an admin", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    expect((await call(app, admin.jar, "DELETE", `/api/admin/mailboxes/${GROUP}`, {})).status).toBe(
      204,
    );
  });
});

describe("changing a mailbox's owner", () => {
  it("takes away the previous owner's app passwords for it", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const adminId = (await db().query.user.findFirst({ where: eq(user.email, ADMIN.email) }))!.id;
    await db()
      .insert(appPassword)
      .values({
        id: "ap-old-owner",
        userId: aliceId,
        mailboxId: MB,
        name: "phone",
        hash: await hashAppPassword("abcde-fghjk-mnpqr-stuvw"),
      });

    const res = await call(app, admin.jar, "PATCH", `/api/admin/mailboxes/${MB}`, {
      ownerUserId: adminId,
    });

    expect(res.status).toBe(200);
    expect(await db().select().from(appPassword)).toEqual([]);
  });
});

describe("deleting a domain", () => {
  it("refuses while a mailbox belongs to it, and leaves everything intact", async () => {
    const app = buildApi();
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    const res = await call(app, admin.jar, "DELETE", `/api/domains/${DOMAIN}`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Delete this domain's mailboxes first." });
    expect(await db().select().from(domain)).toHaveLength(1);
    expect(await db().select().from(mailbox)).toHaveLength(1);
    expect(await db().select().from(message)).toHaveLength(1);
    expect(await blobKeys(`raw/${MB}/`)).toEqual([RAW]);
  });

  it("still refuses while a deleted mailbox is being purged, then deletes", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect((await call(app, alice.jar, "DELETE", `/api/mailboxes/${MB}`)).status).toBe(204);

    expect((await call(app, admin.jar, "DELETE", `/api/domains/${DOMAIN}`)).status).toBe(409);
    expect(await db().select().from(message)).toHaveLength(1);

    await runCronOffline(e, new Date());
    expect(await blobKeys(`raw/${MB}/`)).toEqual([]);

    expect((await call(app, admin.jar, "DELETE", `/api/domains/${DOMAIN}`)).status).toBe(204);
    expect(await db().select().from(domain)).toHaveLength(0);
  });
});
