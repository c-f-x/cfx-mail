import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../src/api/index.ts";
import type { Env } from "../../src/env.ts";
import { applyMigrationsOnce, e, resetDb } from "../support/app.ts";
import { call, createUser, signIn } from "../support/session.ts";

// The app as it is deployed: `buildApi()` with its own middleware order, error
// handler and Better Auth. Route tests mount one sub-app behind a fixture, so
// only this file sees a route that was registered without a guard.
const app = buildApi();

// Routes an anonymous caller may reach, each with the status it must give them.
// Every entry is public by design; anything else must answer 401. Adding a
// route here is a security decision, so say why.
const PUBLIC: Record<string, { status: number; why: string }> = {
  "GET /api/bootstrap": { status: 200, why: "the sign-in page asks whether setup is needed" },
  "POST /api/bootstrap": {
    status: 400,
    why: "first-run setup, before any account exists; gated by SETUP_TOKEN",
  },
  "GET /api/health": { status: 200, why: "liveness probe, returns a constant" },
  "GET /api/me": { status: 200, why: "the app asks who is signed in; answers { user: null }" },
  "POST /api/users/invites/accept": {
    status: 400,
    why: "an invited person has no account yet; gated by the invite token",
  },
  "GET /api/users/invites/by-token/:token": {
    status: 404,
    why: "the accept page looks up its invite; gated by the invite token",
  },
};

// Catch-all registrations (`.use` and `.all`). Middleware has no handler of its
// own, so a path under it answers 401 (a guard) or 404 (nothing there). The one
// handler among them is Better Auth, which authenticates its own endpoints.
const AUTH_HANDLER = "/api/auth/*";

const concrete = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "x");

const routes = [...new Map(app.routes.map((r) => [`${r.method} ${r.path}`, r] as const)).values()];
const handlers = routes.filter((r) => r.method !== "ALL");
const catchAlls = routes.filter((r) => r.method === "ALL");

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("default deny", () => {
  it("has routes to check", () => {
    expect(handlers.length).toBeGreaterThan(100);
    expect(catchAlls.map((r) => r.path)).toContain(AUTH_HANDLER);
  });

  it.each(handlers.map((r) => [`${r.method} ${r.path}`, r.method, r.path] as const))(
    "%s refuses an anonymous request",
    async (key, method, path) => {
      const res = await call(app, null, method, concrete(path));
      const allowed = PUBLIC[key];
      if (allowed) {
        // A public route that starts answering 401 no longer belongs on the list.
        expect(res.status).toBe(allowed.status);
        return;
      }
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    },
  );

  it.each(catchAlls.filter((r) => r.path !== AUTH_HANDLER).map((r) => [r.path] as const))(
    "nothing answers under the catch-all %s without a guard",
    async (path) => {
      const res = await call(app, null, "GET", concrete(path).replace(/x$/, "no-such-route"));
      expect([401, 404]).toContain(res.status);
    },
  );

  it("every public route on the list still exists", () => {
    const known = new Set(handlers.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(PUBLIC).filter((key) => !known.has(key))).toEqual([]);
  });

  it("service routes need a bearer key", async () => {
    const svc = handlers.filter((r) => r.path.startsWith("/api/svc/"));
    expect(svc.length).toBeGreaterThan(0);
    const res = await app.request(
      "http://localhost/api/svc/info",
      { headers: { authorization: "Bearer not-a-real-key" } },
      e,
    );
    expect(res.status).toBe(401);
  });
});

describe("error shape", () => {
  it("answers a refused request with { error } JSON", async () => {
    const res = await call(app, null, "GET", "/api/mailboxes");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers a signed-in non-admin on an admin route with 403 { error }", async () => {
    await createUser("bob@example.com", "correct-horse-battery");
    const { jar } = await signIn(app, "bob@example.com", "correct-horse-battery");
    const res = await call(app, jar, "GET", "/api/admin/mailboxes");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "admin only" });
  });

  it("answers an unexpected failure with { error } JSON and no detail", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { ...e, DB: undefined } as unknown as Env;
    const res = await call(app, null, "GET", "/api/bootstrap", undefined, broken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(logged).toHaveBeenCalledWith("unhandled", expect.anything());
  });
});

describe("request log", () => {
  it("logs the route pattern, never the path or the query string", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await call(app, null, "GET", "/api/users/invites/by-token/SECRET-INVITE-TOKEN?next=PRIVATE");
    await call(app, null, "GET", "/api/search?q=PRIVATE-SEARCH-TERM");
    await call(app, null, "GET", "/api/no-such-route/PRIVATE-SEGMENT");

    const lines = log.mock.calls.map((args) => args.join(" "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^GET \/api\/users\/invites\/by-token\/:token 404 \d+ms$/);
    expect(lines[1]).toMatch(/^GET \/api\/search\S* 401 \d+ms$/);
    expect(lines[2]).toMatch(/ 404 \d+ms$/);
    expect(lines.join("\n")).not.toMatch(/SECRET|PRIVATE/);
  });
});

describe("sign-out", () => {
  it("tells the browser to drop what it cached of the account", async () => {
    await createUser("alice@example.com", "correct-horse-battery");
    const { res: signedIn, jar } = await signIn(app, "alice@example.com", "correct-horse-battery");
    expect(signedIn.status).toBe(200);

    const res = await call(app, jar, "POST", "/api/auth/sign-out", {});

    expect(res.status).toBe(200);
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
  });

  it("leaves other auth responses alone", async () => {
    const res = await call(app, null, "GET", "/api/auth/get-session");
    expect(res.headers.get("clear-site-data")).toBeNull();
  });
});
