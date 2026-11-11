import type { DB } from "@cfmail/db";
import { account, user } from "@cfmail/db/schema";
import { bootstrapAdmin } from "@cfmail/shared/schemas";
import { hashPassword } from "better-auth/crypto";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cloudflareSignIn } from "../auth.ts";
import { authFromCtx } from "../auth-ctx.ts";
import { dbFromCtx } from "../db.ts";
import type { AppBindings } from "../env.ts";
import { zValidator } from "./validate.ts";

async function userCount(db: DB): Promise<number> {
  const rows = await db.select({ n: count() }).from(user);
  return rows[0]?.n ?? 0;
}

// Constant-time comparison of two secrets. Hashing first gives both sides the
// same length, so the loop's duration says nothing about either input.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = (
    await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(a)),
      crypto.subtle.digest("SHA-256", enc.encode(b)),
    ])
  ).map((buf) => new Uint8Array(buf)) as [Uint8Array, Uint8Array];
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export function bootstrapRoutes() {
  const r = new Hono<AppBindings>()

    .get("/", async (c) => {
      const db = dbFromCtx(c);
      return c.json({
        needsBootstrap: (await userCount(db)) === 0,
        setupLocked: !c.env.SETUP_TOKEN,
        cloudflareSignIn: cloudflareSignIn(c.env),
      });
    })

    // Unauthenticated, so the cheap refusals come first and the password hash
    // (scrypt) last: only the operator, who holds the SETUP_TOKEN secret, can
    // make this route do real work or create the admin.
    .post("/", zValidator("json", bootstrapAdmin), async (c) => {
      const db = dbFromCtx(c);
      const body = c.req.valid("json");

      if ((await userCount(db)) > 0) {
        throw new HTTPException(409, { message: "already bootstrapped" });
      }
      const setupToken = c.env.SETUP_TOKEN;
      if (!setupToken) {
        throw new HTTPException(403, {
          message: "Setup is locked. Set the SETUP_TOKEN secret on the Worker, then reload.",
        });
      }
      if (!(await sameSecret(body.setupToken, setupToken))) {
        throw new HTTPException(403, { message: "Wrong setup token." });
      }

      const email = body.email.toLowerCase();
      const userId = crypto.randomUUID();
      const accountId = crypto.randomUUID();
      const password = await hashPassword(body.password);

      // Atomic first-user claim: the row is written only if the table is still
      // empty, so two concurrent bootstraps can't both succeed. If we didn't
      // win the insert, someone else already bootstrapped. The credential goes
      // in the same batch and only for the row this request claimed, so there
      // is never an admin without a password. (D1's own batch: Drizzle's does
      // not take raw statements.)
      const d1 = c.env.DB;
      const [claim] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO "user" (id, name, email, email_verified, role)
              SELECT ?1, ?2, ?3, 1, 'admin'
              WHERE NOT EXISTS (SELECT 1 FROM "user")`,
          )
          .bind(userId, body.name, email),
        d1
          .prepare(
            `INSERT INTO "account" (id, user_id, account_id, provider_id, password)
              SELECT ?1, ?2, ?2, 'credential', ?3
              WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ?2)`,
          )
          .bind(accountId, userId, password),
      ]);
      if (!claim || claim.meta.changes === 0) {
        throw new HTTPException(409, { message: "already bootstrapped" });
      }

      // Sign the new admin in immediately so the SPA can redirect to /app.
      const auth = await authFromCtx(c);
      const res = await auth.api.signInEmail({
        body: { email, password: body.password },
        asResponse: true,
        headers: c.req.raw.headers,
      });
      return res;
    });

  return r;
}

// Helper exported for /api/users and /api/invites/accept — both create a
// user + account pair the same way bootstrap does, just without the admin
// role. Both rows go in one batch: a user without a credential could never
// sign in, and would block the email from being used again.
export async function createUserWithPassword(
  db: DB,
  input: { name: string; email: string; password: string; role: "admin" | "user" },
): Promise<{ id: string }> {
  const email = input.email.toLowerCase();
  const existing = await db.query.user.findFirst({
    where: eq(user.email, email),
    columns: { id: true },
  });
  if (existing) {
    throw new HTTPException(409, { message: "user exists" });
  }
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const password = await hashPassword(input.password);
  await db.batch([
    db.insert(user).values({
      id: userId,
      name: input.name,
      email,
      emailVerified: true,
      role: input.role,
    }),
    db.insert(account).values({
      id: accountId,
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    }),
  ]);
  return { id: userId };
}
