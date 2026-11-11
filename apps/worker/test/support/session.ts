import { createUserWithPassword } from "../../src/api/bootstrap.ts";
import type { buildApi } from "../../src/api/index.ts";
import type { Env } from "../../src/env.ts";
import { db, e } from "./app.ts";

// Drives the real app (`buildApi()`) with real Better Auth sessions, for tests
// where the session itself is the subject. Route tests that only need "a signed
// in user" should keep using `mountApp`.
export const ORIGIN = "http://localhost";

export type RealApp = ReturnType<typeof buildApi>;
export type Jar = Map<string, string>;

function store(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair = "", ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (expired || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

// One request as the browser holding `jar`: every cookie the server set goes
// back, including Better Auth's cached-session cookie when it issues one.
export async function call(
  app: RealApp,
  jar: Jar | null,
  method: string,
  path: string,
  body?: unknown,
  env: Env = e,
): Promise<Response> {
  // Cloudflare sets the client IP on every request; Better Auth keys its rate
  // limit on it.
  const headers: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": "203.0.113.7" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar?.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await app.request(
    `${ORIGIN}${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  if (jar) store(jar, res);
  return res;
}

export async function createUser(
  email: string,
  password: string,
  role: "admin" | "user" = "user",
): Promise<string> {
  const { id } = await createUserWithPassword(db(), { email, name: email, password, role });
  return id;
}

export async function signIn(
  app: RealApp,
  email: string,
  password: string,
): Promise<{ res: Response; jar: Jar }> {
  const jar: Jar = new Map();
  const res = await call(app, jar, "POST", "/api/auth/sign-in/email", { email, password });
  return { res, jar };
}
