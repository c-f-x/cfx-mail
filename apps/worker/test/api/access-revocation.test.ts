import { appPassword, domain, mailbox, session, user, verification } from "@cfmail/db/schema";
import { eq, like } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { hashAppPassword, loginWithAppPassword } from "../../src/app-passwords.ts";
import { applyMigrationsOnce, db, resetDb } from "../support/app.ts";
import { call, createUser, signIn } from "../support/session.ts";

const ADMIN = { email: "admin@example.com", password: "admin-password-1" };
const ALICE = { email: "alice@example.com", password: "alice-password-1" };
const APP_PASSWORD = "abcde-fghjk-mnpqr-stuvw";

let adminId: string;
let aliceId: string;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await db().delete(verification);
  // The real app logs one line per request.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  adminId = await createUser(ADMIN.email, ADMIN.password, "admin");
  aliceId = await createUser(ALICE.email, ALICE.password);
  await db().insert(domain).values({ id: "d1", name: "example.com" });
  await db().insert(mailbox).values({
    id: "mb-alice",
    domainId: "d1",
    localPart: "alice",
    type: "personal",
    ownerUserId: aliceId,
  });
});

describe("ending access", () => {
  it("a ban ends the user's session on their next request and removes their app passwords", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);
    expect(alice.res.status).toBe(200);
    expect((await call(app, alice.jar, "GET", "/api/mailboxes")).status).toBe(200);
    await db()
      .insert(appPassword)
      .values({
        id: "ap-1",
        userId: aliceId,
        mailboxId: "mb-alice",
        name: "phone",
        hash: await hashAppPassword(APP_PASSWORD),
      });

    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const ban = await call(app, admin.jar, "PATCH", `/api/users/${aliceId}`, { banned: true });
    expect(ban.status).toBe(200);

    // The very next request, with every cookie the browser holds.
    expect((await call(app, alice.jar, "GET", "/api/mailboxes")).status).toBe(401);
    expect(await db().select().from(session).where(eq(session.userId, aliceId))).toHaveLength(0);
    expect(
      await db().select().from(appPassword).where(eq(appPassword.userId, aliceId)),
    ).toHaveLength(0);
    expect(await loginWithAppPassword(db(), "alice@example.com", APP_PASSWORD, null)).toBeNull();

    const again = await signIn(app, ALICE.email, ALICE.password);
    expect(again.res.status).toBe(403);
    // The admin's own session is untouched.
    expect((await call(app, admin.jar, "GET", "/api/users")).status).toBe(200);
    expect(await db().select().from(session).where(eq(session.userId, adminId))).toHaveLength(1);
  });

  it("an app password of a banned user does not log in", async () => {
    await db()
      .insert(appPassword)
      .values({
        id: "ap-1",
        userId: aliceId,
        mailboxId: "mb-alice",
        name: "phone",
        hash: await hashAppPassword(APP_PASSWORD),
      });
    expect(
      await loginWithAppPassword(db(), "alice@example.com", APP_PASSWORD, null),
    ).not.toBeNull();

    // Banned by a path that does not go through PATCH /api/users/:id, such as
    // the Better Auth admin plugin: the row survives and must still be refused.
    await db().update(user).set({ banned: true }).where(eq(user.id, aliceId));

    expect(await loginWithAppPassword(db(), "alice@example.com", APP_PASSWORD, null)).toBeNull();
  });

  it("a deleted session stops working at once, with no cached copy", async () => {
    const app = buildApi();
    const alice = await signIn(app, ALICE.email, ALICE.password);
    expect((await call(app, alice.jar, "GET", "/api/mailboxes")).status).toBe(200);

    await db().delete(session).where(eq(session.userId, aliceId));

    expect((await call(app, alice.jar, "GET", "/api/mailboxes")).status).toBe(401);
  });

  it("a password reset signs out every older session", async () => {
    const app = buildApi();
    const old = await signIn(app, ALICE.email, ALICE.password);
    expect((await call(app, old.jar, "GET", "/api/mailboxes")).status).toBe(200);

    const asked = await call(app, null, "POST", "/api/auth/request-password-reset", {
      email: ALICE.email,
    });
    expect(asked.status).toBe(200);
    const [row] = await db()
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(like(verification.identifier, "reset-password:%"));
    const token = row!.identifier.slice("reset-password:".length);

    const reset = await call(app, null, "POST", "/api/auth/reset-password", {
      newPassword: "a-brand-new-password",
      token,
    });
    expect(reset.status).toBe(200);

    expect((await call(app, old.jar, "GET", "/api/mailboxes")).status).toBe(401);
    expect((await signIn(app, ALICE.email, "a-brand-new-password")).res.status).toBe(200);
  });
});
