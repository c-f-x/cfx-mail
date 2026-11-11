import type { MeUserDto } from "@cfx-mail/shared/responses";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { authFromCtx } from "../auth-ctx.ts";
import type { AppBindings } from "../env.ts";
import { AppError, httpStatus } from "../errors.ts";
import { sessionMiddleware } from "../middleware.ts";
import { adminRoutes } from "./admin.ts";
import { adminBlockRoutes } from "./admin-block.ts";
import { appPasswordsRoutes } from "./app-passwords.ts";
import { attachmentsRoutes } from "./attachments.ts";
import { avatarRoutes } from "./avatar.ts";
import { blocklistRoutes } from "./blocklist.ts";
import { bootstrapRoutes } from "./bootstrap.ts";
import { contactsRoutes } from "./contacts.ts";
import { domainsRoutes } from "./domains.ts";
import { draftsRoutes } from "./drafts.ts";
import { foldersRoutes } from "./folders.ts";
import { labelsRoutes } from "./labels.ts";
import { mailboxesRoutes } from "./mailboxes.ts";
import { messagesRoutes } from "./messages.ts";
import { pushRoutes } from "./push.ts";
import { remindersRoutes } from "./reminders.ts";
import { rulesRoutes } from "./rules.ts";
import { searchRoutes } from "./search.ts";
import { streamRoute } from "./stream.ts";
import { svcRoutes } from "./svc.ts";
import { tempRoutes } from "./temp.ts";
import { threadsRoutes } from "./threads.ts";
import { usersRoutes } from "./users.ts";

// One line per request for Workers Logs: method, the route pattern that
// answered, status and duration. Never the concrete path or the query string,
// which carry invite tokens, search terms and signed image-proxy URLs.
const requestLog: MiddlewareHandler<AppBindings> = async (c, next) => {
  const start = Date.now();
  await next();
  console.log(`${c.req.method} ${routePath(c)} ${c.res.status} ${Date.now() - start}ms`);
};

// Runs one health probe. The caller gets "ok" or "failed", never the error:
// the detail goes to Workers Logs only.
async function probe(
  part: "db" | "storage",
  run: () => Promise<unknown>,
): Promise<"ok" | "failed"> {
  try {
    await run();
    return "ok";
  } catch (err) {
    console.error("health_failed", part, err);
    return "failed";
  }
}

// Single chained expression: Hono RPC (`hc<AppType>` in the web app) can only
// infer the route schema when every registration flows through the chain.
export function buildApi() {
  const app = new Hono<AppBindings>()
    .use("*", requestLog)
    .use(
      "/api/*",
      cors({
        // Web app and API are one Worker on one origin, so the only legitimate
        // credentialed caller is the instance's own origin. Reflect the Origin
        // only when it matches; otherwise send no CORS headers.
        origin: (o, c) => {
          const self = new URL(c.req.url).origin;
          return o === self ? o : null;
        },
        credentials: true,
        allowHeaders: ["content-type", "authorization"],
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      }),
    )
    // Bootstrap endpoints sit outside session middleware — they're how the
    // first admin is created when the DB has zero users.
    .route("/api/bootstrap", bootstrapRoutes())
    // Service-mailbox API is bearer-key authed, not session authed — mount it
    // before the session middleware so it never touches cookies.
    .route("/api/svc", svcRoutes())
    // Public HTTP sign-up is closed via `disableSignUp: true` in auth.ts.
    // All account creation flows through /api/bootstrap (first admin) or
    // /api/users (admin-created) or /api/invites/accept (invited user).
    .all("/api/auth/*", async (c) => {
      const auth = await authFromCtx(c);
      const res = await auth.handler(c.req.raw);
      // Mail bodies and attachments may sit in the browser's cache; on a shared
      // computer they must not outlive the session.
      if (c.req.path === "/api/auth/sign-out" && res.ok) {
        const out = new Response(res.body, res);
        out.headers.set("Clear-Site-Data", '"cache"');
        return out;
      }
      return res;
    })
    // Before the session middleware: a probe must not depend on sign-in, and
    // must cost one database statement, not the three a session lookup adds.
    .get("/api/health", async (c) => {
      const [db, storage] = await Promise.all([
        probe("db", () => c.env.DB.prepare("SELECT 1").first()),
        // A key outside every layout in AGENTS.md invariant 6. Asking for a
        // missing key is the cheapest call that still reaches R2.
        probe("storage", () => c.env.BLOBS.head("health/none")),
      ]);
      const ok = db === "ok" && storage === "ok";
      c.header("Cache-Control", "no-store");
      return c.json({ ok, db, storage }, ok ? 200 : 503);
    })
    .use("/api/*", sessionMiddleware)
    .get("/api/me", (c) => {
      // Better Auth's inferred session-user type drops plugin fields (role,
      // twoFactorEnabled) that the runtime object carries; MeUserDto is the
      // canonical wire shape, so surface it to the RPC client.
      const user = c.get("user") as MeUserDto | null;
      return c.json({ user });
    })
    .route("/api/domains", domainsRoutes())
    .route("/api/users", usersRoutes())
    .route("/api/admin", adminRoutes())
    .route("/api/admin/block", adminBlockRoutes())
    .route("/api/blocklist", blocklistRoutes())
    .route("/api/mailboxes", mailboxesRoutes())
    .route("/api/contacts", contactsRoutes())
    .route("/api/threads", threadsRoutes())
    .route("/api/drafts", draftsRoutes())
    .route("/api/messages", messagesRoutes())
    .route("/api/labels", labelsRoutes())
    .route("/api/folders", foldersRoutes())
    .route("/api/rules", rulesRoutes())
    .route("/api/attachments", attachmentsRoutes())
    .route("/api/avatar", avatarRoutes())
    .route("/api/temp", tempRoutes())
    .route("/api/push", pushRoutes())
    .route("/api/app-passwords", appPasswordsRoutes())
    .route("/api/reminders", remindersRoutes())
    .route("/api/search", searchRoutes())
    .get("/api/stream", streamRoute);

  // One error shape everywhere: `{ error }`. HTTPExceptions carrying their own
  // response keep it; the rest become JSON so clients never have to
  // special-case a plain-text body. Validation failures answer in the same shape
  // before they get here (api/validate.ts).
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.getResponse();
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof AppError) return c.json({ error: err.message }, httpStatus(err.code));
    console.error("unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

// The composed route schema, consumed type-only by `hc<AppType>` in apps/web.
export type AppType = ReturnType<typeof buildApi>;
