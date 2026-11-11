import { systemConfig } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import { messagesRoutes } from "../../src/api/messages.ts";
import { getOrCreateAuthSecret } from "../../src/config.ts";
import type { Env } from "../../src/env.ts";
import { proxyRemoteContent } from "../../src/mail/img-proxy.ts";
import { applyMigrationsOnce, db, e, mountApp, resetDb } from "../support/app.ts";
import { owner, seedBase } from "../support/seed.ts";
import { call, createUser, type Jar } from "../support/session.ts";

// The secret that signs sessions and image-proxy URLs. With the AUTH_SECRET
// Worker secret set it never touches the database, so a copy of the database
// is not enough to forge a session.
const app = buildApi();

// Test values, not secrets. 48 characters, as the runbook's command produces more.
const FROM_ENV = "test-auth-secret-from-env-0123456789-abcdefghijkl";
const withSecret = (value: string): Env => ({ ...e, AUTH_SECRET: value });

const storedSecret = async () =>
  (
    await db().query.systemConfig.findFirst({
      where: eq(systemConfig.key, "auth_secret"),
      columns: { value: true },
    })
  )?.value ?? null;

async function signInWith(env: Env): Promise<{ res: Response; jar: Jar }> {
  const jar: Jar = new Map();
  const res = await call(
    app,
    jar,
    "POST",
    "/api/auth/sign-in/email",
    { email: "alice@example.com", password: "correct-horse-battery" },
    env,
  );
  return { res, jar };
}

const whoAmI = async (jar: Jar, env: Env) =>
  (
    (await (await call(app, jar, "GET", "/api/me", undefined, env)).json()) as {
      user: { email: string } | null;
    }
  ).user;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  // resetDb leaves system_config alone; start each test with no stored secret.
  await db().delete(systemConfig).where(eq(systemConfig.key, "auth_secret"));
  await createUser("alice@example.com", "correct-horse-battery");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AUTH_SECRET set on the Worker", () => {
  it("signs a working session and stores nothing in the database", async () => {
    const env = withSecret(FROM_ENV);
    const { res, jar } = await signInWith(env);
    expect(res.status).toBe(200);
    expect((await whoAmI(jar, env))?.email).toBe("alice@example.com");
    expect(await storedSecret()).toBeNull();
  });

  it("is the secret the session is signed with: another secret refuses the cookie", async () => {
    const env = withSecret(FROM_ENV);
    const { jar } = await signInWith(env);
    expect(await whoAmI(jar, withSecret(`${FROM_ENV}-rotated`))).toBeNull();
    // Without the Worker secret the app falls back to a database secret, which
    // did not sign this cookie either.
    expect(await whoAmI(jar, e)).toBeNull();
    expect(await whoAmI(jar, env)).not.toBeNull();
  });

  it("wins over a secret already stored in the database, and leaves that one alone", async () => {
    const stored = await getOrCreateAuthSecret(e, db());
    expect(await getOrCreateAuthSecret(withSecret(FROM_ENV), db())).toBe(FROM_ENV);
    expect(await storedSecret()).toBe(stored);
  });

  it("signs image-proxy URLs with the same secret", async () => {
    await seedBase(db());
    const html = await proxyRemoteContent('<img src="https://images.example/a.png">', FROM_ENV);
    const query = html.match(/proxy-image\?([^"\s]+)/)?.[1]?.replace(/&amp;/g, "&");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      body: new Response("png").body,
      headers: new Headers({ "content-type": "image/png" }),
    }));
    const messages = mountApp(messagesRoutes, owner);
    const get = (env: Env) => messages.request(`/proxy-image?${query}`, {}, env);
    expect((await get(withSecret(FROM_ENV))).status).toBe(200);
    expect((await get(e)).status).toBe(403);
    expect(await storedSecret()).not.toBe(FROM_ENV);
  });

  it("fails loudly when shorter than 32 characters", async () => {
    await expect(getOrCreateAuthSecret(withSecret("x".repeat(31)), db())).rejects.toThrow(
      "AUTH_SECRET must be at least 32 characters",
    );
    expect(await getOrCreateAuthSecret(withSecret("x".repeat(32)), db())).toBe("x".repeat(32));

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { res } = await signInWith(withSecret("too-short"));
    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalledWith(
      "unhandled",
      expect.objectContaining({ message: expect.stringContaining("AUTH_SECRET") }),
    );
    expect(await storedSecret()).toBeNull();
  });
});

describe("AUTH_SECRET not set", () => {
  it("generates a secret on first use and keeps it in the database", async () => {
    const { res, jar } = await signInWith(e);
    expect(res.status).toBe(200);
    expect((await whoAmI(jar, e))?.email).toBe("alice@example.com");
    const stored = await storedSecret();
    expect(stored).toEqual(expect.any(String));
    expect(await getOrCreateAuthSecret(e, db())).toBe(stored);
  });

  it("treats an empty value as not set", async () => {
    const secret = await getOrCreateAuthSecret(withSecret(""), db());
    expect(secret).toBe(await storedSecret());
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});
