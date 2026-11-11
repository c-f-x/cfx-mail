import { user } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { authFromCtx } from "./auth-ctx.ts";
import { dbFromCtx } from "./db.ts";
import type { AppBindings } from "./env.ts";
import { AppError } from "./errors.ts";

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = await authFromCtx(c);
  const sess = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", sess?.user ?? null);
  return next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user")) throw new AppError("unauthenticated", "unauthenticated");
  return next();
};

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const u = c.get("user");
  if (!u) throw new AppError("unauthenticated", "unauthenticated");
  // Role and ban are read from D1 here, not taken from the session object, so
  // admin access never depends on how Better Auth populated the session user.
  const row = await dbFromCtx(c).query.user.findFirst({
    where: eq(user.id, u.id),
    columns: { role: true, banned: true },
  });
  if (!row || row.banned || row.role !== "admin") {
    throw new AppError("forbidden", "admin only");
  }
  return next();
};
