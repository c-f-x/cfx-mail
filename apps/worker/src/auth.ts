import { passkey } from "@better-auth/passkey";
import { type DB, makeDB, schema } from "@cfmail/db";
import { user } from "@cfmail/db/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { count, eq } from "drizzle-orm";
import { getConfig, getOrCreateAuthSecret } from "./config.ts";
import type { Env } from "./env.ts";
import { sendMail } from "./mail/notify.ts";

export type Auth = Awaited<ReturnType<typeof createAuth>>;
export type User =
  Awaited<ReturnType<Auth["api"]["getSession"]>> extends infer S | null | undefined
    ? S extends { user: infer U }
      ? U
      : never
    : never;

interface CreateAuthOpts {
  env: Env;
  db?: DB;
  baseURL: string;
}

// App preferences ride on the session user so /api/me returns them and
// authClient.updateUser persists them. Value is a JSON string (UserPrefs).
export const userAdditionalFields = {
  preferences: { type: "string", required: false, input: true },
} as const;

// `user.banReason` of a user an admin has deleted. The ban locks them out at
// once; the row stays until the cron has purged the mailboxes they own, because
// dropping it earlier would cascade-delete that mail in one statement and leave
// its R2 blobs behind.
export const BAN_REASON_PENDING_DELETE = "pending-delete";

// The Better Auth plugin list. Kept here (not inlined below) so the schema
// drift test can ask Better Auth for the exact tables/columns these plugins
// require and diff them against schema.ts. This is the single source of truth.
// Whether this deployment has the private Cloudflare OAuth client that lets
// admins sign in with their Cloudflare account.
export function cloudflareSignIn(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET);
}

// Who may sign in with Cloudflare. The client is private, so Cloudflare admits
// only members of the account that owns it; cfmail then admits only an admin:
// the first person on a deployment with no users (who becomes its admin, in
// place of the setup token), or an existing admin with the same email. It never
// creates a second account and never attaches to a non-admin.
async function admitCloudflareUser(
  db: DB,
  incoming: { email?: unknown },
  action: "create-user" | "link-account" | "sign-in",
): Promise<{ error: string } | undefined> {
  if (action === "create-user") {
    const [row] = await db.select({ n: count() }).from(user);
    return (row?.n ?? 0) === 0 ? undefined : { error: "not_an_admin" };
  }
  const email = typeof incoming.email === "string" ? incoming.email.toLowerCase() : "";
  const known = await db.query.user.findFirst({
    where: eq(user.email, email),
    columns: { role: true },
  });
  return known?.role === "admin" ? undefined : { error: "not_an_admin" };
}

export function authPlugins(baseURL: string) {
  return [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    twoFactor(),
    // rpID/origin derive from the request-scoped baseURL (no hardcoded host),
    // so passkeys bind to whatever domain the deployment is served on.
    passkey({
      rpID: new URL(baseURL).hostname,
      rpName: "cfmail",
      origin: baseURL,
    }),
  ];
}

export async function createAuth({ env, db, baseURL }: CreateAuthOpts) {
  const database = db ?? makeDB(env.DB);
  const secret = await getOrCreateAuthSecret(env, database);

  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    // Off at runtime; the bundle drop happens via the semantic-conventions
    // shim alias in wrangler.jsonc (the flag alone doesn't tree-shake it).
    telemetry: { enabled: false },
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
        passkey: schema.passkey,
        rateLimit: schema.rateLimit,
      },
      usePlural: false,
    }),
    // Brute-force protection for login/2FA/password-reset. Database storage —
    // Workers isolates have no shared memory, so counters must live in D1.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // Closes public sign-up (test/api/auth-closed.test.ts). Accounts come
      // only from first-run setup, the admin's user routes and invite
      // acceptance, which write the rows themselves (createUserWithPassword).
      disableSignUp: true,
      sendResetPassword: async ({ user, url }) => {
        // Admins cannot use the self-service reset flow — they must recover
        // via 2FA backup codes or a CLI `wrangler d1 execute` reset.
        const u = user as { email: string; role?: string };
        if (u.role === "admin") return;
        const from = await getConfig(database, "auth_from_address");
        if (!from) return;
        await sendMail(env, {
          from,
          to: u.email,
          subject: "Reset your password",
          text:
            `A password reset was requested for your account.\n\n` +
            `Reset link (valid 1 hour):\n${url}\n\n` +
            `If you didn't request this, ignore this email.`,
        });
      },
      resetPasswordTokenExpiresIn: 3600,
      // A reset is how a user locks out whoever else holds their account.
      revokeSessionsOnPasswordReset: true,
    },
    ...(cloudflareSignIn(env)
      ? {
          socialProviders: {
            cloudflare: {
              clientId: env.CLOUDFLARE_CLIENT_ID!,
              clientSecret: env.CLOUDFLARE_CLIENT_SECRET!,
              // Cloudflare holds the address; the account owner signed in.
              mapProfileToUser: () => ({ emailVerified: true }),
            },
          },
        }
      : {}),
    // Cloudflare does not say its emails are verified, so linking to the
    // admin's existing account needs the provider named as trusted.
    account: { accountLinking: { enabled: true, trustedProviders: ["cloudflare"] } },
    // Only reachable via the change-email flow below: sign-up is closed and
    // all accounts are created pre-verified, so plain verify-email never runs.
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        const from = await getConfig(database, "auth_from_address");
        if (!from) return;
        await sendMail(env, {
          from,
          to: user.email,
          subject: "Confirm your new email address",
          text:
            `A request was made to use this address for your account.\n\n` +
            `Confirm the change:\n${url}\n\n` +
            `If you didn't request this, ignore this email.`,
        });
      },
    },
    user: {
      additionalFields: userAdditionalFields,
      // Sends the confirmation link to the NEW address (accounts are always
      // email-verified); the email only changes once that link is clicked.
      changeEmail: { enabled: true },
      validateUserInfo: ({ user: incoming, source }) =>
        source.oauth?.providerId === "cloudflare"
          ? admitCloudflareUser(database, incoming, source.action)
          : undefined,
    },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { sameSite: "lax" },
      // Cloudflare's canonical client-IP header, so rate-limit buckets key on
      // the real client rather than an easily spoofed X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // No cookie cache: every request reads its session row from D1, so a
      // deleted session (ban, password reset, sign-out elsewhere) stops working
      // on the next request.
    },
    databaseHooks: {
      session: {
        create: {
          // With the OAuth client set, an admin signs in only through
          // Cloudflare: the most powerful account keeps no password, passkey
          // or other way in that an outsider could try. Every sign-in method
          // ends here, so one check covers them all.
          before: async (row, ctx) => {
            if (!cloudflareSignIn(env) || ctx?.params?.id === "cloudflare") return;
            const signingIn = await database.query.user.findFirst({
              where: eq(user.id, row.userId),
              columns: { role: true },
            });
            if (signingIn?.role === "admin") {
              throw new APIError("FORBIDDEN", {
                message: "Administrators sign in with Cloudflare.",
              });
            }
          },
        },
      },
      user: {
        create: {
          // A user created by Cloudflare sign-in is a deployment's first user
          // (admitCloudflareUser refuses any other), and so its admin.
          before: async (row, ctx) =>
            ctx?.params?.id === "cloudflare" ? { data: { ...row, role: "admin" } } : undefined,
        },
      },
    },
    plugins: authPlugins(baseURL),
  });
}

export function baseUrlFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
