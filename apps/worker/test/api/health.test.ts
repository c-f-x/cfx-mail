import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, e, resetDb } from "../support/app.ts";
import { call } from "../support/session.ts";

const app = buildApi();

// Stands in for a binding that answers with an error, the way Cloudflare's
// does during an outage. The message carries a marker so a test can prove it
// never reaches the caller.
const LEAK = "secret-internal-detail";
const failing = () => {
  throw new Error(LEAK);
};
const brokenDb = { ...e, DB: { prepare: failing } } as unknown as Env;
const brokenBlobs = { ...e, BLOBS: { head: failing } } as unknown as Env;
const brokenBoth = { ...e, DB: { prepare: failing }, BLOBS: { head: failing } } as unknown as Env;

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("answers 200 when the database and the bucket answer", async () => {
    const res = await call(app, null, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok", storage: "ok" });
  });

  it("is never cached", async () => {
    const res = await call(app, null, "GET", "/api/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 and names the database when D1 fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call(app, null, "GET", "/api/health", undefined, brokenDb);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "failed", storage: "ok" });
    expect(logged).toHaveBeenCalledWith("health_failed", "db", expect.anything());
  });

  it("answers 503 and names the storage when R2 fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call(app, null, "GET", "/api/health", undefined, brokenBlobs);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "ok", storage: "failed" });
    expect(logged).toHaveBeenCalledWith("health_failed", "storage", expect.anything());
  });

  it("names both when both fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call(app, null, "GET", "/api/health", undefined, brokenBoth);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "failed", storage: "failed" });
  });

  it("does not leak the error to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call(app, null, "GET", "/api/health", undefined, brokenBoth);
    expect(await res.text()).not.toContain(LEAK);
  });

  it("does not need the sign-in tables, so a sign-in problem cannot hide a healthy database", async () => {
    // Only the single probe statement reaches D1. Sign-in reads would add more.
    const statements: string[] = [];
    const counting = {
      ...e,
      DB: {
        prepare: (sql: string) => {
          statements.push(sql);
          return e.DB.prepare(sql);
        },
      },
    } as unknown as Env;
    const res = await call(app, null, "GET", "/api/health", undefined, counting);
    expect(res.status).toBe(200);
    expect(statements).toHaveLength(1);
  });
});
