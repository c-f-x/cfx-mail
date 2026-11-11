import type { DB } from "@cfmail/db";
import type { Auth, User } from "./auth.ts";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  EMAIL: SendEmail;
  USER_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Optional Worker secret. First-run setup (POST /api/bootstrap) is locked
  // until the operator sets it, and it is deleted once the admin exists.
  SETUP_TOKEN?: string;
  // Optional Worker secret, at least 32 characters. When set it signs sessions
  // and image-proxy URLs, and no auth secret is kept in the database (see
  // getOrCreateAuthSecret). Changing it signs everyone out.
  AUTH_SECRET?: string;
  // Optional Worker secrets: the private Cloudflare OAuth client behind "Sign
  // in with Cloudflare" for admins (auth.ts). Without both, that button is off.
  CLOUDFLARE_CLIENT_ID?: string;
  CLOUDFLARE_CLIENT_SECRET?: string;
}

export interface HonoVars {
  db: DB;
  auth: Auth;
  user: User | null;
  // Set by the bearer-key middleware on /api/svc routes — the mailbox the key
  // unlocks. Never set on session routes.
  serviceMailbox: {
    id: string;
    domainId: string;
    localPart: string;
    mode: "duplex" | "send";
  } | null;
  baseUrl: string;
}

export type AppBindings = { Bindings: Env; Variables: HonoVars };
