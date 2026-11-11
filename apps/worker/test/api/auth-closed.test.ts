import { systemConfig, user } from "@cfx-mail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, db, e, resetDb } from "../support/app.ts";
import { call, createUser } from "../support/session.ts";

// AGENTS.md invariant 5, checked through the real app and Better Auth: nobody
// signs themselves up, and an admin's password cannot be reset by email.
const app = buildApi();

// The EMAIL binding has no local simulation, so record what would be sent.
function recordingEnv(): { env: Env; sent: { to: string[] }[] } {
  const sent: { to: string[] }[] = [];
  const env = {
    ...e,
    EMAIL: { send: async (m: { to: string[] }) => void sent.push(m) },
  } as unknown as Env;
  return { env, sent };
}

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await db()
    .insert(systemConfig)
    .values({ key: "auth_from_address", value: "no-reply@example.com", updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemConfig.key, set: { value: "no-reply@example.com" } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db().delete(systemConfig).where(eq(systemConfig.key, "auth_from_address"));
});

describe("sign-up", () => {
  it("refuses a public sign-up and creates no account", async () => {
    const res = await call(app, null, "POST", "/api/auth/sign-up/email", {
      email: "newcomer@example.com",
      password: "a-long-enough-password",
      name: "Newcomer",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    const row = await db().query.user.findFirst({
      where: eq(user.email, "newcomer@example.com"),
    });
    expect(row).toBeUndefined();
  });
});

describe("password reset by email", () => {
  it("sends a reset link to a user", async () => {
    await createUser("someone@example.com", "correct-horse-battery");
    const { env, sent } = recordingEnv();

    const res = await call(
      app,
      null,
      "POST",
      "/api/auth/request-password-reset",
      { email: "someone@example.com", redirectTo: "/reset-password" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([["someone@example.com"]]);
  });

  it("sends nothing to an admin", async () => {
    await createUser("boss@example.com", "correct-horse-battery", "admin");
    const { env, sent } = recordingEnv();

    const res = await call(
      app,
      null,
      "POST",
      "/api/auth/request-password-reset",
      { email: "boss@example.com", redirectTo: "/reset-password" },
      env,
    );

    // The same answer as for anyone else, so the endpoint does not reveal who is an admin.
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });
});
