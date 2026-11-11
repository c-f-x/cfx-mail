import { account, session, user } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, db, e, resetDb } from "../support/app.ts";
import { call, createUser, type Jar, signIn } from "../support/session.ts";

// Admins sign in with their Cloudflare account. The OAuth client is private,
// so Cloudflare lets only members of the owner's account through; cfx-mail then admits
// only an admin. On a deployment with no users yet, the first such sign-in
// creates the admin, in place of the setup token. These tests run the deployed
// app with the real Better Auth, standing in only for Cloudflare's token and
// user endpoints.

const app = buildApi();
const configured = {
  ...e,
  SETUP_TOKEN: undefined,
  CLOUDFLARE_CLIENT_ID: "test-client-id",
  CLOUDFLARE_CLIENT_SECRET: "test-client-secret",
} as Env;
const unconfigured = {
  ...e,
  CLOUDFLARE_CLIENT_ID: undefined,
  CLOUDFLARE_CLIENT_SECRET: undefined,
} as Env;

const ADA = {
  id: "cf-user-ada",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
};

// Cloudflare as seen by the Worker: its token endpoint and its /user endpoint.
function cloudflareAs(profile: typeof ADA) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
        return Response.json({ access_token: "access", token_type: "bearer", expires_in: 3600 });
      }
      if (url.startsWith("https://api.cloudflare.com/client/v4/user")) {
        return Response.json({ success: true, errors: [], result: profile });
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

// The whole browser round trip: start, come back from Cloudflare, and ask the
// app who is signed in.
async function signInWithCloudflare(profile: typeof ADA, env: Env = configured) {
  cloudflareAs(profile);
  const jar: Jar = new Map();
  const start = await call(
    app,
    jar,
    "POST",
    "/api/auth/sign-in/social",
    { provider: "cloudflare", callbackURL: "/app", errorCallbackURL: "/login" },
    env,
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const back = await call(
    app,
    jar,
    "GET",
    `/api/auth/callback/cloudflare?code=one-time-code&state=${state}`,
    undefined,
    env,
  );
  const me = await call(app, jar, "GET", "/api/me", undefined, env);
  return {
    location: back.headers.get("location") ?? "",
    me: ((await me.json()) as { user: { email: string; role: string } | null }).user,
  };
}

const cloudflareAccounts = () =>
  db().select().from(account).where(eq(account.providerId, "cloudflare"));

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin sign-in with Cloudflare", () => {
  it("makes the first person to sign in the admin of a new deployment", async () => {
    const { me } = await signInWithCloudflare(ADA);

    expect(me).toMatchObject({ email: ADA.email, role: "admin" });
    const rows = await db().select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: ADA.email, role: "admin", emailVerified: true });
  });

  it("signs an existing admin in, and again later", async () => {
    const id = await createUser(ADA.email, "a-long-password", "admin");

    const first = await signInWithCloudflare(ADA);
    const again = await signInWithCloudflare(ADA);

    expect(first.me).toMatchObject({ email: ADA.email, role: "admin" });
    expect(again.me).toMatchObject({ email: ADA.email, role: "admin" });
    expect(await cloudflareAccounts()).toMatchObject([{ userId: id }]);
    expect(await db().select().from(user)).toHaveLength(1);
  });

  it("refuses a user who is not an admin, and attaches nothing to their account", async () => {
    await createUser("admin@example.com", "a-long-password", "admin");
    await createUser(ADA.email, "a-long-password", "user");

    const { me, location } = await signInWithCloudflare(ADA);

    expect(me).toBeNull();
    expect(location).toContain("/login");
    expect(location).toContain("error=");
    expect(await cloudflareAccounts()).toEqual([]);
  });

  it("creates no account for someone the deployment does not know", async () => {
    await createUser("admin@example.com", "a-long-password", "admin");

    const { me } = await signInWithCloudflare(ADA);

    expect(me).toBeNull();
    expect(await db().select().from(user)).toHaveLength(1);
    expect(await db().select().from(session)).toEqual([]);
  });

  it("refuses an admin who has since been made an ordinary user", async () => {
    const id = await createUser(ADA.email, "a-long-password", "admin");
    await signInWithCloudflare(ADA);
    await db().update(user).set({ role: "user" }).where(eq(user.id, id));

    const { me } = await signInWithCloudflare(ADA);

    expect(me).toBeNull();
  });

  // With the OAuth client set, Cloudflare is the admin's only way in, so the
  // most powerful account has no password to guess from outside. Everyone
  // else keeps their password.
  describe("admins are Cloudflare-only", () => {
    const passwordSignIn = (email: string) =>
      call(
        app,
        new Map(),
        "POST",
        "/api/auth/sign-in/email",
        { email, password: "a-long-password" },
        configured,
      );

    it("refuses an admin's password, says how to sign in, and starts no session", async () => {
      await createUser(ADA.email, "a-long-password", "admin");

      const res = await passwordSignIn(ADA.email);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        message: "Administrators sign in with Cloudflare.",
      });
      expect(await db().select().from(session)).toEqual([]);
    });

    it("keeps passwords working for everyone else", async () => {
      await createUser(ADA.email, "a-long-password", "admin");
      await createUser("member@example.com", "a-long-password", "user");

      expect((await passwordSignIn("member@example.com")).status).toBe(200);
    });

    it("still lets the admin in through Cloudflare", async () => {
      await createUser(ADA.email, "a-long-password", "admin");

      expect((await signInWithCloudflare(ADA)).me).toMatchObject({ role: "admin" });
    });

    it("leaves admin passwords working on a deployment without the OAuth client", async () => {
      await createUser(ADA.email, "a-long-password", "admin");

      const { res } = await signIn(app, ADA.email, "a-long-password");
      expect(res.status).toBe(200);
    });
  });

  // A signed-in user can ask Better Auth to attach a provider to their own
  // account (link-social). For Cloudflare that must stay an admin's privilege
  // too, whichever Cloudflare identity comes back.
  it.each([
    ["their own email", "member@example.com"],
    ["the admin's email", ADA.email],
  ])("does not let a signed-in non-admin attach a Cloudflare login with %s", async (_, email) => {
    await createUser(ADA.email, "a-long-password", "admin");
    await createUser("member@example.com", "a-long-password", "user");
    const { jar } = await signIn(app, "member@example.com", "a-long-password");
    cloudflareAs({ ...ADA, id: "cf-other", email });

    const start = await call(
      app,
      jar,
      "POST",
      "/api/auth/link-social",
      { provider: "cloudflare", callbackURL: "/app", errorCallbackURL: "/login" },
      configured,
    );
    // The link starts, so the refusal below is cfx-mail's, not a broken request.
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    const back = await call(
      app,
      jar,
      "GET",
      `/api/auth/callback/cloudflare?code=one-time-code&state=${state}`,
      undefined,
      configured,
    );

    expect(back.headers.get("location") ?? "").toContain("error=");
    expect(await cloudflareAccounts()).toEqual([]);
  });

  it("is off on a deployment with no OAuth client set", async () => {
    const res = await call(
      app,
      new Map(),
      "POST",
      "/api/auth/sign-in/social",
      { provider: "cloudflare", callbackURL: "/app" },
      unconfigured,
    );
    expect(res.status).not.toBe(200);
  });

  it("tells the login page whether it is available", async () => {
    const on = await call(app, null, "GET", "/api/bootstrap", undefined, configured);
    const off = await call(app, null, "GET", "/api/bootstrap", undefined, unconfigured);
    expect(await on.json()).toMatchObject({ needsBootstrap: true, cloudflareSignIn: true });
    expect(await off.json()).toMatchObject({ cloudflareSignIn: false });
  });
});
