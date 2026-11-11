import { account, user } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapRoutes, createUserWithPassword } from "../../src/api/bootstrap.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { seedBase } from "../support/seed.ts";

// bootstrap.ts has no session middleware — it gates on the user table being
// empty and on the operator's setup token, so we mount with a null session user.
const app = () => mountApp(bootstrapRoutes, null);

// The token the test Worker is configured with (vitest.config.ts).
const TOKEN = e.SETUP_TOKEN!;
const first = { email: "first@example.com", name: "First Admin", password: "longenough123" };

// `env` lets a test run the Worker as deployed without the secret.
function get(env: Env = e): Promise<Response> {
  return Promise.resolve(app().request("/", {}, env));
}
function post(body: unknown, env: Env = e): Promise<Response> {
  return Promise.resolve(
    app().request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    ),
  );
}
const unconfigured = { ...e, SETUP_TOKEN: undefined } as Env;
const userCount = async () => (await db().select().from(user)).length;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
});

describe("bootstrap", () => {
  it("reports needsBootstrap=true when no users exist", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      needsBootstrap: true,
      setupLocked: false,
      cloudflareSignIn: false,
    });
  });

  it("reports needsBootstrap=false once a user exists", async () => {
    await seedBase(db());
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      needsBootstrap: false,
      setupLocked: false,
      cloudflareSignIn: false,
    });
  });

  it("reports setupLocked=true while the Worker has no setup token", async () => {
    expect(await (await get(unconfigured)).json()).toEqual({
      needsBootstrap: true,
      setupLocked: true,
      cloudflareSignIn: false,
    });
    expect(await (await get({ ...e, SETUP_TOKEN: "" } as Env)).json()).toEqual({
      needsBootstrap: true,
      setupLocked: true,
      cloudflareSignIn: false,
    });
  });

  it("rejects an invalid body with 400", async () => {
    // password too short (min 8) — fails the zod validator.
    const res = await post({ ...first, password: "short", setupToken: TOKEN });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await post({ ...first, email: "not-an-email", setupToken: TOKEN });
    expect(res.status).toBe(400);
  });

  it("is locked while the Worker has no setup token: 403 and no user", async () => {
    for (const env of [unconfigured, { ...e, SETUP_TOKEN: "" } as Env]) {
      // eslint-disable-next-line no-await-in-loop -- two independent cases, in order
      const res = await post({ ...first, setupToken: "anything" }, env);
      expect(res.status).toBe(403);
      // eslint-disable-next-line no-await-in-loop
      expect(await res.json()).toEqual({
        error: "Setup is locked. Set the SETUP_TOKEN secret on the Worker, then reload.",
      });
    }
    expect(await userCount()).toBe(0);
  });

  it("refuses a wrong setup token: 403 and no user", async () => {
    const res = await post({ ...first, setupToken: `${TOKEN}x` });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Wrong setup token." });
    expect(await userCount()).toBe(0);
  });

  it("refuses a request with no setup token", async () => {
    const res = await post(first);
    expect(res.status).toBe(400);
    expect(await userCount()).toBe(0);
  });

  it("refuses to bootstrap when users already exist (409)", async () => {
    await seedBase(db());
    const res = await post({ ...first, setupToken: TOKEN });
    expect(res.status).toBe(409);
  });

  it("answers 409 before it looks at the token or hashes anything", async () => {
    await seedBase(db());
    // "Already bootstrapped" wins over a wrong token and over a missing secret.
    // Both checks come before the password hash, so an anonymous caller cannot
    // make a set-up instance spend CPU on scrypt.
    const wrong = await post({ ...first, setupToken: "wrong" });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ error: "already bootstrapped" });
    expect((await post({ ...first, setupToken: "wrong" }, unconfigured)).status).toBe(409);
    expect(await userCount()).toBe(4);
  });

  it("creates the first admin (and signs them in) with the right token", async () => {
    const res = await post({ ...first, email: "First@Example.com", setupToken: TOKEN });
    // signInEmail returns a 200 response with a session cookie.
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);

    const row = await db().query.user.findFirst({
      where: eq(user.email, "first@example.com"),
      columns: { id: true, role: true, emailVerified: true, name: true },
    });
    expect(row?.role).toBe("admin");
    expect(row?.emailVerified).toBe(true);
    expect(row?.name).toBe("First Admin");
    expect(await db().select().from(account).where(eq(account.userId, row!.id))).toHaveLength(1);

    // A second bootstrap now refuses.
    const again = await post({ ...first, email: "second@example.com", setupToken: TOKEN });
    expect(again.status).toBe(409);
    expect(await userCount()).toBe(1);
  });

  it("lets exactly one of several concurrent bootstraps win", async () => {
    const results = await Promise.all(
      ["a", "b", "c"].map((n) => post({ ...first, email: `${n}@example.com`, setupToken: TOKEN })),
    );
    expect(results.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409, 409]);
    expect(await userCount()).toBe(1);
    expect(await db().select().from(account)).toHaveLength(1);
  });

  it("leaves no admin without a password when the credential write fails", async () => {
    await e.DB.exec(
      "CREATE TRIGGER account_refuse BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'account refused'); END",
    );
    try {
      const res = await post({ ...first, setupToken: TOKEN });
      expect(res.status).toBe(500);
    } finally {
      await e.DB.exec("DROP TRIGGER account_refuse");
    }
    // Setup can still be completed: nothing claimed the first-user slot.
    expect(await userCount()).toBe(0);
    expect((await post({ ...first, setupToken: TOKEN })).status).toBe(200);
  });

  it("needsBootstrap flips to false after a successful bootstrap", async () => {
    await post({ ...first, setupToken: TOKEN });
    expect(await (await get()).json()).toEqual({
      needsBootstrap: false,
      setupLocked: false,
      cloudflareSignIn: false,
    });
  });
});

describe("createUserWithPassword", () => {
  it("writes the user and their credential together or not at all", async () => {
    await seedBase(db());
    const before = await userCount();
    // A broken database after the user insert: the account table refuses rows.
    await e.DB.exec(
      "CREATE TRIGGER account_refuse BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'account refused'); END",
    );
    try {
      await expect(
        createUserWithPassword(db(), {
          email: "new@example.com",
          name: "New",
          password: "longenough123",
          role: "user",
        }),
      ).rejects.toThrow();
    } finally {
      await e.DB.exec("DROP TRIGGER account_refuse");
    }
    // No user without a password: that account could never sign in.
    expect(await userCount()).toBe(before);
  });
});
