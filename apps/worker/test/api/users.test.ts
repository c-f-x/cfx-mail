import { domainGrant, systemConfig, user, userInvite } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usersRoutes } from "../../src/api/users.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, db, e, mountApp, request, resetDb } from "../support/app.ts";
import { runCronOffline } from "../support/cron.ts";
import {
  ADMIN_ID,
  admin,
  DOMAIN_ID,
  MEMBER_ID,
  member,
  OUTSIDER_ID,
  outsider,
  owner,
  seedBase,
} from "../support/seed.ts";

const asAdmin = () => mountApp(usersRoutes, admin);
const asOwner = () => mountApp(usersRoutes, owner);
const asAnon = () => mountApp(usersRoutes, null);

let inviteSeq = 0;

async function seedInvite(overrides: Partial<typeof userInvite.$inferInsert> = {}): Promise<{
  id: string;
  token: string;
  email: string;
}> {
  const n = ++inviteSeq;
  const id = `inv-${n}`;
  const token = `token-${n}-abcdefgh`;
  const email = `invitee${n}@example.com`;
  await db()
    .insert(userInvite)
    .values({
      id,
      email,
      role: "user",
      token,
      invitedByUserId: ADMIN_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    });
  return { id, token, email };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
  // system_config is not truncated between tests; keep auth-from unset so invite
  // creation reports sentEmail:false deterministically.
  await db().delete(systemConfig).where(eq(systemConfig.key, "auth_from_address"));
});

describe("users", () => {
  // ── POST /invites/accept (public, token-gated) ──────────────────────────
  it("400s an invalid accept body via the validator", async () => {
    const res = await request(asAnon(), "POST", "/invites/accept", {
      token: "short",
      name: "X",
      password: "password123",
    });
    expect(res.status).toBe(400);
  });

  it("404s accepting an unknown invite token", async () => {
    const res = await request(asAnon(), "POST", "/invites/accept", {
      token: "does-not-exist-token",
      name: "Nobody",
      password: "password123",
    });
    expect(res.status).toBe(404);
  });

  it("410s accepting an already-used invite", async () => {
    const { token } = await seedInvite({ usedAt: new Date() });
    const res = await request(asAnon(), "POST", "/invites/accept", {
      token,
      name: "Used",
      password: "password123",
    });
    expect(res.status).toBe(410);
  });

  it("410s accepting an expired invite", async () => {
    const { token } = await seedInvite({ expiresAt: new Date(Date.now() - 1000) });
    const res = await request(asAnon(), "POST", "/invites/accept", {
      token,
      name: "Late",
      password: "password123",
    });
    expect(res.status).toBe(410);
  });

  it("accepts an invite: creates the user and consumes the invite", async () => {
    const { id, token, email } = await seedInvite();
    const res = await request(asAnon(), "POST", "/invites/accept", {
      token,
      name: "Fresh User",
      password: "password123",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const created = await db().query.user.findFirst({ where: eq(user.email, email) });
    expect(created).toMatchObject({ name: "Fresh User", role: "user", email });

    const inv = await db().query.userInvite.findFirst({ where: eq(userInvite.id, id) });
    expect(inv?.usedAt).not.toBeNull();
  });

  // ── GET /invites/by-token/:token (public) ───────────────────────────────
  it("looks up an invite by token without consuming it", async () => {
    const { token, email } = await seedInvite();
    const res = await request(asAnon(), "GET", `/invites/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email, role: "user", used: false, expired: false });
    // Still unused afterwards.
    const inv = await db().query.userInvite.findFirst({ where: eq(userInvite.token, token) });
    expect(inv?.usedAt).toBeNull();
  });

  it("reports an expired invite as expired in the by-token lookup", async () => {
    const { token } = await seedInvite({ expiresAt: new Date(Date.now() - 1000) });
    const res = await request(asAnon(), "GET", `/invites/by-token/${token}`);
    const body = (await res.json()) as { expired: boolean };
    expect(body.expired).toBe(true);
  });

  it("404s an unknown by-token lookup", async () => {
    const res = await request(asAnon(), "GET", "/invites/by-token/nope");
    expect(res.status).toBe(404);
  });

  // ── GET /directory (any signed-in user) ─────────────────────────────────
  it("401s an anonymous caller hitting the directory", async () => {
    const res = await request(asAnon(), "GET", "/directory");
    expect(res.status).toBe(401);
  });

  it("lists the directory for a non-admin signed-in user", async () => {
    const res = await request(asOwner(), "GET", "/directory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toEqual([
      admin.email,
      member.email,
      outsider.email,
      owner.email,
    ]);
  });

  it("excludes banned users from the directory", async () => {
    await db().update(user).set({ banned: true }).where(eq(user.id, OUTSIDER_ID));
    const res = await request(asOwner(), "GET", "/directory");
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).not.toContain(outsider.email);
  });

  // ── Admin gate on the rest ──────────────────────────────────────────────
  it("401s an anonymous caller listing users", async () => {
    const res = await request(asAnon(), "GET", "/");
    expect(res.status).toBe(401);
  });

  it("403s a non-admin listing users", async () => {
    const res = await request(asOwner(), "GET", "/");
    expect(res.status).toBe(403);
  });

  // ── GET / (admin) ───────────────────────────────────────────────────────
  it("lists users ordered by createdAt", async () => {
    const res = await request(asAdmin(), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { id: string; role: string }[] };
    expect(body.users).toHaveLength(4);
    expect(body.users.find((u) => u.id === ADMIN_ID)?.role).toBe("admin");
  });

  // ── POST / (admin create user) ──────────────────────────────────────────
  it("400s an invalid create-user body via the validator", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      email: "new@example.com",
      name: "New",
      password: "short",
    });
    expect(res.status).toBe(400);
  });

  it("403s a non-admin creating a user", async () => {
    const res = await request(asOwner(), "POST", "/", {
      email: "x@example.com",
      name: "X",
      password: "password123",
    });
    expect(res.status).toBe(403);
  });

  it("creates a user with a password", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      email: "Created@Example.com",
      name: "Created",
      password: "password123",
      role: "user",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await db().query.user.findFirst({ where: eq(user.id, id) });
    expect(row).toMatchObject({ email: "created@example.com", name: "Created", role: "user" });
  });

  it("409s creating a user whose email already exists", async () => {
    const res = await request(asAdmin(), "POST", "/", {
      email: owner.email,
      name: "Dup",
      password: "password123",
    });
    expect(res.status).toBe(409);
  });

  // ── PATCH /:id (admin update user) ──────────────────────────────────────
  it("400s an invalid update-user body via the validator", async () => {
    const res = await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, { role: "superuser" });
    expect(res.status).toBe(400);
  });

  it("403s a non-admin updating a user", async () => {
    const res = await request(asOwner(), "PATCH", `/${MEMBER_ID}`, { banned: true });
    expect(res.status).toBe(403);
  });

  it("bans and promotes another user", async () => {
    const res = await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, {
      banned: true,
      role: "admin",
    });
    expect(res.status).toBe(200);
    const row = await db().query.user.findFirst({ where: eq(user.id, MEMBER_ID) });
    expect(row).toMatchObject({ banned: true, role: "admin" });
  });

  // Better Auth moves updatedAt on its own writes; an admin's edit must too.
  it("moves the user's updatedAt when an admin edits them", async () => {
    const lastYear = new Date(Date.now() - 365 * 86_400_000);
    await db().update(user).set({ updatedAt: lastYear }).where(eq(user.id, MEMBER_ID));
    const before = Math.floor(Date.now() / 1000) * 1000;

    await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, { role: "admin" });

    const row = await db().query.user.findFirst({ where: eq(user.id, MEMBER_ID) });
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("400s an admin trying to demote themselves", async () => {
    const res = await request(asAdmin(), "PATCH", `/${ADMIN_ID}`, { role: "user" });
    expect(res.status).toBe(400);
  });

  it("no-ops an empty update with 200", async () => {
    const res = await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s patching an unknown user", async () => {
    const res = await request(asAdmin(), "PATCH", "/ghost", { role: "user" });
    expect(res.status).toBe(404);
  });

  // ── DELETE /:id (admin) ─────────────────────────────────────────────────
  it("403s a non-admin deleting a user", async () => {
    const res = await request(asOwner(), "DELETE", `/${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });

  it("404s deleting an unknown user", async () => {
    const res = await request(asAdmin(), "DELETE", "/ghost");
    expect(res.status).toBe(404);
  });

  it("400s an admin deleting themselves", async () => {
    const res = await request(asAdmin(), "DELETE", `/${ADMIN_ID}`);
    expect(res.status).toBe(400);
  });

  // The mail side of deletion is covered in destructive-deletes.test.ts.
  it("deletes another user: locked out and unlisted at once, row dropped by the cron", async () => {
    const res = await request(asAdmin(), "DELETE", `/${OUTSIDER_ID}`);
    expect(res.status).toBe(204);
    const row = await db().query.user.findFirst({ where: eq(user.id, OUTSIDER_ID) });
    expect(row).toMatchObject({ banned: true, banReason: "pending-delete" });

    const list = await request(asAdmin(), "GET", "/");
    const body = (await list.json()) as { users: { id: string }[] };
    expect(body.users.map((u) => u.id)).not.toContain(OUTSIDER_ID);

    await runCronOffline(e, new Date());
    expect(await db().query.user.findFirst({ where: eq(user.id, OUTSIDER_ID) })).toBeUndefined();
  });

  it("409s un-banning a user who is being deleted, and leaves a normal un-ban working", async () => {
    await request(asAdmin(), "DELETE", `/${OUTSIDER_ID}`);
    const refused = await request(asAdmin(), "PATCH", `/${OUTSIDER_ID}`, { banned: false });
    expect(refused.status).toBe(409);
    const row = await db().query.user.findFirst({ where: eq(user.id, OUTSIDER_ID) });
    expect(row?.banned).toBe(true);

    await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, { banned: true });
    const ok = await request(asAdmin(), "PATCH", `/${MEMBER_ID}`, { banned: false });
    expect(ok.status).toBe(200);
    expect((await db().query.user.findFirst({ where: eq(user.id, MEMBER_ID) }))?.banned).toBe(
      false,
    );
  });

  // ── GET/POST/DELETE /invites (admin) ────────────────────────────────────
  it("403s a non-admin listing invites", async () => {
    const res = await request(asOwner(), "GET", "/invites");
    expect(res.status).toBe(403);
  });

  it("400s an invalid invite email via the validator", async () => {
    const res = await request(asAdmin(), "POST", "/invites", { email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("creates an invite and lists it", async () => {
    const res = await request(asAdmin(), "POST", "/invites", {
      email: "Invitee@Example.com",
      role: "user",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      id: string;
      url: string;
      sentEmail: boolean;
      notSentReason: string | null;
    };
    expect(body.ok).toBe(true);
    // No sender address is set in these tests, so the admin must be told why
    // nothing went out, and given the link to pass on by hand.
    expect(body.sentEmail).toBe(false);
    expect(body.notSentReason).toBe("no_sender");
    expect(body.url).toContain("/accept-invite?token=");

    const row = await db().query.userInvite.findFirst({ where: eq(userInvite.id, body.id) });
    expect(row).toMatchObject({ email: "invitee@example.com", role: "user" });

    // The list gives each pending invite's link again, so a missed notice
    // does not lose it; the bare token is not sent separately.
    const list = await request(asAdmin(), "GET", "/invites");
    const listBody = (await list.json()) as {
      invites: { id: string; url: string; token?: string }[];
    };
    const listed = listBody.invites.find((i) => i.id === body.id);
    expect(listed?.url).toBe(body.url);
    expect(listed).not.toHaveProperty("token");
  });

  describe("invite email", () => {
    // The EMAIL binding has no local simulation; `send` stands in for it.
    async function invite(
      send: () => Promise<unknown>,
    ): Promise<{ sentEmail: boolean; notSentReason: string | null }> {
      await db()
        .insert(systemConfig)
        .values({ key: "auth_from_address", value: "no-reply@example.com", updatedAt: new Date() });
      const env = { ...e, EMAIL: { send } } as unknown as Env;
      const res = await asAdmin().request(
        "/invites",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "invitee@example.com" }),
        },
        env,
      );
      expect(res.status).toBe(201);
      return (await res.json()) as { sentEmail: boolean; notSentReason: string | null };
    }

    it("reports the invite as emailed when the send succeeds", async () => {
      const body = await invite(async () => ({ messageId: "x" }));
      expect(body.sentEmail).toBe(true);
      expect(body.notSentReason).toBeNull();
    });

    // The admin then shares the link by hand (users-section.tsx shows it).
    it("reports the invite as not emailed when the send fails, and logs why", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const body = await invite(() => Promise.reject(new Error("sending domain not verified")));
      expect(body.sentEmail).toBe(false);
      expect(body.notSentReason).toBe("send_failed");
      expect(logged).toHaveBeenCalledWith("notify.sendMail failed", expect.any(Error));
      logged.mockRestore();
    });
  });

  it("409s inviting an email that already has an account", async () => {
    const res = await request(asAdmin(), "POST", "/invites", { email: owner.email });
    expect(res.status).toBe(409);
  });

  it("deletes an invite", async () => {
    const { id } = await seedInvite();
    const res = await request(asAdmin(), "DELETE", `/invites/${id}`);
    expect(res.status).toBe(204);
    const row = await db().query.userInvite.findFirst({ where: eq(userInvite.id, id) });
    expect(row).toBeUndefined();
  });

  it("404s deleting an unknown invite", async () => {
    const res = await request(asAdmin(), "DELETE", "/invites/ghost");
    expect(res.status).toBe(404);
  });

  // ── Domain grants (admin) ───────────────────────────────────────────────
  it("403s a non-admin reading domain grants", async () => {
    const res = await request(asOwner(), "GET", `/${MEMBER_ID}/domain-grants`);
    expect(res.status).toBe(403);
  });

  it("starts with no domain grants for a user", async () => {
    const res = await request(asAdmin(), "GET", `/${MEMBER_ID}/domain-grants`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [] });
  });

  it("400s an out-of-range allowedKinds via the validator", async () => {
    const res = await request(asAdmin(), "PUT", `/${MEMBER_ID}/domain-grants/${DOMAIN_ID}`, {
      userId: MEMBER_ID,
      allowedKinds: 99,
    });
    expect(res.status).toBe(400);
  });

  it("upserts and then lists a domain grant (joined with the domain name)", async () => {
    const put = await request(asAdmin(), "PUT", `/${MEMBER_ID}/domain-grants/${DOMAIN_ID}`, {
      userId: MEMBER_ID,
      allowedKinds: 3,
    });
    expect(put.status).toBe(200);

    const list = await request(asAdmin(), "GET", `/${MEMBER_ID}/domain-grants`);
    expect(await list.json()).toEqual({
      grants: [{ domainId: DOMAIN_ID, domainName: "example.com", allowedKinds: 3 }],
    });

    // Upsert again updates in place.
    await request(asAdmin(), "PUT", `/${MEMBER_ID}/domain-grants/${DOMAIN_ID}`, {
      userId: MEMBER_ID,
      allowedKinds: 7,
    });
    const after = await request(asAdmin(), "GET", `/${MEMBER_ID}/domain-grants`);
    const body = (await after.json()) as { grants: { allowedKinds: number }[] };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.allowedKinds).toBe(7);
  });

  it("deletes a domain grant", async () => {
    await request(asAdmin(), "PUT", `/${MEMBER_ID}/domain-grants/${DOMAIN_ID}`, {
      userId: MEMBER_ID,
      allowedKinds: 1,
    });
    const res = await request(asAdmin(), "DELETE", `/${MEMBER_ID}/domain-grants/${DOMAIN_ID}`);
    expect(res.status).toBe(204);
    const rows = await db().select().from(domainGrant).where(eq(domainGrant.userId, MEMBER_ID));
    expect(rows).toHaveLength(0);
  });
});
