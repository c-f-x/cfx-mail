import { account, session, user } from "@cfmail/db/schema";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { applyMigrationsOnce, db, resetDb } from "../support/app.ts";
import { call, createUser, signIn } from "../support/session.ts";

// Accounts exist only because an admin made them (first-run setup, the admin's
// user form, or an invite). The public sign-up endpoint that Better Auth ships
// must stay shut, on a fresh deployment and on a running one. These tests post
// to it through the deployed app, `buildApi()`, with the real Better Auth in it.

const app = buildApi();

const SIGN_UP = "/api/auth/sign-up/email";
const attempt = (over: Record<string, unknown> = {}) => ({
  name: "Mallory",
  email: "mallory@example.com",
  password: "a-perfectly-good-password",
  ...over,
});

async function authRows() {
  const [users, accounts, sessions] = await Promise.all([
    db().select().from(user),
    db().select().from(account),
    db().select().from(session),
  ]);
  return { users: users.length, accounts: accounts.length, sessions: sessions.length };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("public sign-up stays closed", () => {
  it("refuses sign-up on a deployment that has no users yet, and creates nothing", async () => {
    const res = await call(app, null, "POST", SIGN_UP, attempt());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: expect.any(String) });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await authRows()).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });

  it("refuses sign-up on a running deployment, and creates nothing more", async () => {
    await createUser("admin@example.com", "correct-horse-battery", "admin");
    const before = await authRows();

    const res = await call(app, null, "POST", SIGN_UP, attempt());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: expect.any(String) });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await authRows()).toEqual(before);
  });

  it("does not let the refused sign-up be used to sign in", async () => {
    await call(app, null, "POST", SIGN_UP, attempt());

    // Better Auth warns that the user does not exist; that is the expected outcome here.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let res: Response;
    try {
      ({ res } = await signIn(app, "mallory@example.com", "a-perfectly-good-password"));
    } finally {
      warned.mockRestore();
    }

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("answers the same way whether or not the email already has an account", async () => {
    await createUser("alice@example.com", "correct-horse-battery");

    const taken = await call(app, null, "POST", SIGN_UP, attempt({ email: "alice@example.com" }));
    const free = await call(app, null, "POST", SIGN_UP, attempt({ email: "nobody@example.com" }));

    expect(taken.status).toBe(free.status);
    expect(await taken.text()).toBe(await free.text());
  });
});

describe("accounts an admin creates still work (control)", () => {
  it("lets a user created through the admin path sign in", async () => {
    await createUser("alice@example.com", "correct-horse-battery");

    const { res, jar } = await signIn(app, "alice@example.com", "correct-horse-battery");

    expect(res.status).toBe(200);
    expect(jar.size).toBeGreaterThan(0);
  });
});
