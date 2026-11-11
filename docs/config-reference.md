# Configuration reference

Every input that changes how cfx-mail runs, where it is set, who reads it and what happens without it. Paths are relative to the repository root unless they start with a folder inside `apps/worker/src/`. For how the parts fit together, see [`architecture.md`](./architecture.md). For the steps of a deployment, see [`AGENTS.md`](../AGENTS.md), sections 3 and 4.

There are five places configuration lives:

1. `apps/worker/wrangler.jsonc`: bindings and Worker settings.
2. Worker secrets: `AUTH_SECRET`, `CLOUDFLARE_CLIENT_ID`, `CLOUDFLARE_CLIENT_SECRET`, and `SETUP_TOKEN` where there is no OAuth client.
3. The `system_config` table in D1: instance secrets the app creates itself, and settings an admin sets in the app.
4. Ordinary tables: per-domain, per-mailbox and per-user settings.
5. The GitHub repository variable `CI_RUNS_ON`.

The web app has no build-time configuration of its own (section 6).

## 1. `wrangler.jsonc`

The file is a template. It describes local development and tests (`name: "cfmail-local"`, `database_id: "local"`) and names no real deployment. At deploy time `scripts/site-config.mjs` writes a joined copy into a scratch folder, with the deployment as a block under `env`. The block's values come from the private site file named by `CFX_SITE` ([`AGENTS.md`](../AGENTS.md), section 2; decision D-16).

### Bindings

The joined `env` block repeats these four, because Wrangler does not inherit them from the top level. `scripts/site-config.mjs` writes them, and `scripts/site-config.test.mjs` fails if one is missing.

| Binding | Type | Top-level value | Read by | Required | If missing |
|---|---|---|---|---|---|
| `DB` | D1 database, with `migrations_dir: "../../packages/db/drizzle"` | `cfmail-local` | Every module through `makeDB` (`packages/db/src/index.ts`); `api/bootstrap.ts` uses it raw | Yes | Every API request, delivery and cron tick fails. |
| `BLOBS` | R2 bucket | `cfmail-local-blobs` | `mail/ingest.ts`, `mail/send.ts`, `mail/blobs.ts`, `mail/quote.ts`, `api/messages.ts`, `api/attachments.ts`, `api/avatar.ts`, `api/drafts.ts`, `api/svc.ts`, `api/threads.ts`, `cron.ts`, `imap/store.ts` | Yes | No mail can be stored or opened. |
| `USER_HUB` | Durable Object namespace, class `UserHub` | `UserHub` | `hub.ts` (`broadcastToUsers`), `api/stream.ts`, `imap/hub-listener.ts` | Yes | Live updates stop. Broadcasts are best-effort, so mail still flows. |
| `EMAIL` | `send_email`, `remote: true` | no allowed-address list | `mail/send.ts`, `mail/notify.ts`, `mail/rule-sends.ts`, `mail/unsubscribe.ts` | Yes | Sending answers 502 and rolls back; invites and resets are not sent. |
| `ASSETS` | Static assets from `../web/dist` | | `index.ts` | Yes | The app does not load. |

`remote: true` means `wrangler dev` sends real mail through Cloudflare.

### Settings

These are set once at the top level and inherited by the joined `env` block.

| Setting | Value | Effect |
|---|---|---|
| `main` | `src/index.ts` | The Worker's entry. |
| `compatibility_date`, `compatibility_flags` | `2026-06-23`, `["nodejs_compat"]` | Runtime version and Node built-ins. |
| `minify`, `placement` | `true`, `{ "mode": "smart" }` | Bundle size and where the Worker runs. |
| `limits.cpu_ms` | `300000` | CPU cap per invocation. Raised for long IMAP sessions. |
| `alias` | `mime-types`, `@opentelemetry/semantic-conventions` → `src/shims/` | Replaces two large dependencies with small shims. Removing them grows the bundle. |
| `observability` | logs on | Workers Logs receives the `console` output the code writes. |
| `assets` | `directory: "../web/dist"`, `not_found_handling: "single-page-application"`, `run_worker_first: true` | Every request reaches the Worker, which serves the build through `env.ASSETS` and adds the security headers. Narrowing it drops the app's CSP; see [`architecture.md`](./architecture.md#9-security-baseline). |
| `migrations` | `v1`: `new_sqlite_classes: ["UserHub"]` | Durable Object class migration. |
| `triggers.crons` | `["*/1 * * * *"]` | Runs `scheduled()` every minute. Without it, nothing in `cron.ts` runs: no scheduled sends, reminders, purges or retention. |
| `name` | `cfmail-local` at the top level; `mail-<name>` per deployment in the runbook | The Worker's name in Cloudflare. |

## 2. Worker secrets

All are declared in `apps/worker/src/env.ts`. `AUTH_SECRET` and the two Cloudflare OAuth client values are required on a deployment ([`AGENTS.md`](../AGENTS.md), section 4, step 4). Set them with `pnpm exec wrangler secret put <NAME> --env <name>` from `apps/worker`. For local development, put them in `apps/worker/.dev.vars`, which git ignores. No other `env.X` is read in `apps/worker/src`.

| Name | Read by | Required | Default | If missing |
|---|---|---|---|---|
| `SETUP_TOKEN` | `api/bootstrap.ts` | No. Only creates the first admin on a deployment without the Cloudflare OAuth client | none | `GET /api/bootstrap` reports `setupLocked: true` and `POST /api/bootstrap` answers 403. Delete it once the admin exists; after that, bootstrap answers 409 anyway. |
| `CLOUDFLARE_CLIENT_ID`, `CLOUDFLARE_CLIENT_SECRET` | `auth.ts` (`cloudflareSignIn`, the `cloudflare` social provider), `api/bootstrap.ts` | Yes, on every deployment: they are how the admin signs in and how a new deployment gets its admin | none | The login page has no Cloudflare button, admins sign in with a password, and a new deployment can only be set up with `SETUP_TOKEN`. The values belong to the private "cfmail admin sign-in" OAuth client in the owner's Cloudflare account, shared by all deployments, and are kept in his login Keychain ("cfmail cloudflare oauth"). |
| `AUTH_SECRET` | `config.ts` (`getOrCreateAuthSecret`), used by `auth.ts` and by the image proxy in `api/messages.ts` | Yes, on every deployment. The code starts without it so that local development and the tests need no setup | none | The code generates a secret and stores it as `auth_secret` in `system_config`, so anyone with a database copy could sign sessions, and every request reads that row. Shorter than 32 characters: every request that needs it fails with an error. Changing it signs everyone out, and image-proxy URLs signed with the old value stop working. |

The test runner sets `SETUP_TOKEN` to a fixed test value in `apps/worker/vitest.config.ts`.

`AUTH_SECRET` is not in a backup. Set it again on a restored deployment ([`runbooks/backup-and-restore.md`](./runbooks/backup-and-restore.md)).

## 3. `system_config` keys

The table is `system_config` (`packages/db/src/schema.ts`): `key`, `value`, `updatedAt`. Access goes through `getConfig` and `setConfig` in `apps/worker/src/config.ts`. The backup copies this table, so a backup holds these secrets.

| Key | Set by | How | Read by | If missing |
|---|---|---|---|---|
| `auth_secret` | The app | Generated on first use by `getOrCreateAuthSecret` (`config.ts`), only when `AUTH_SECRET` is not set | `config.ts` | Generated. When `AUTH_SECRET` is set this row is neither read nor written. |
| `pgp_master_key` | The app | Generated on first PGP use by `getOrCreatePgpMasterKey` (`config.ts`) | `mail/receive.ts`, `mail/send.ts`, `api/mailboxes.ts`, `api/messages.ts` | Generated. Losing it makes every wrapped mailbox private key unreadable. PGP is not in use. |
| `vapid_public`, `vapid_private_jwk` | The app | Generated on first use by `getOrCreateVapid` (`mail/push.ts`) | `mail/push.ts`, `api/push.ts` (`GET /api/push/key`) | Generated. Replacing them invalidates every browser's push subscription. |
| `tracker_list` | The app | Refreshed daily by the cron (`refreshTrackerList`, `mail/trackers.ts`); one hour after a failed fetch | `getTrackerRules` (`mail/trackers.ts`), used by `api/messages.ts` | Only the built-in rules and the invisible-image check strip trackers until the first refresh. |
| `auth_from_address` | An admin | `PUT /api/domains/settings/auth-from`. The address's domain must be a configured domain with SPF and DKIM passing | `auth.ts` (password reset, change of email), `api/users.ts` (invites), `api/domains.ts` | No reset, change-of-email or invite mail is sent. The invite endpoint still returns the link with `sentEmail: false`. |
| `imap_host`, `imap_port` | An admin | `PUT /api/domains/settings/imap` | `getImapConnection` (`config.ts`), used by `api/domains.ts` and `api/app-passwords.ts` | No host: the settings page shows "(ask your admin)". A missing or invalid port reads as 993. IMAP is not in use. |
| `protected_domains` | An admin | `PUT /api/admin/block/protected-domains` | `mail/blocklist.ts`, used by `api/admin-block.ts` | The built-in list in `DEFAULT_PROTECTED_DOMAINS` (`mail/blocklist.ts`): large providers that may not be blocked as whole domains. |
| `spamhaus_dqs_key` | An admin | `PUT /api/admin/block/dqs`. The key is checked against Spamhaus test points first; an empty key clears it | `getDqsConfig` (`mail/dnsbl.ts`), used by `mail/spam.ts`, `app-passwords.ts`, `api/admin-block.ts` | No Spamhaus lookups. Spam scoring uses authentication results and heuristics only. |

## 4. Settings stored in their own tables

An admin or a user changes these in the app. Each lives in the table named (`packages/db/src/schema.ts`).

| Setting | Table and column | Changed through |
|---|---|---|
| Mailbox types a domain allows | `domain.allowedKinds` | `POST`, `PATCH /api/domains` (admin) |
| Mailbox types a user may create on a domain | `domain_grant` | `PUT /api/users/:id/domain-grants/:domainId` (admin) |
| User role and ban | `user.role`, `user.banned` | `PATCH /api/users/:id` (admin) |
| Display name, signature, Reply-To, spam filter level, "leave out of All Mail", PGP mode | `mailbox` | `PATCH /api/mailboxes/:id/settings` (MANAGE), `PATCH /api/admin/mailboxes/:id/settings` (admin) |
| Service mailbox mode (`send` or `duplex`) and key | `mailbox.serviceMode`, `mailbox.serviceKeyHash` | `/api/admin/service` (admin) |
| Aliases and catch-all | `redirect` | `/api/admin/redirects` (admin) |
| Blocked senders | `blocklist` | `/api/admin/block/entries` (admin) |
| Mailbox members and rights | `mailbox_member` | `/api/mailboxes/:id/members` (MANAGE) |
| Rules | `rule` | `/api/rules` (MANAGE) |
| Notification level per mailbox | `mailbox_notify` | `PUT /api/push/mailboxes/:id` |
| Personal preferences | `user.preferences` (JSON, parsed by `parseUserPrefs` in `packages/shared`) | Better Auth `updateUser` from `apps/web/src/lib/prefs.ts` |

The theme is the only setting kept in the browser (`localStorage`, `apps/web/src/lib/theme.ts`).

## 5. Fixed in code

These values are constants. Changing one is a code change.

| Value | Where |
|---|---|
| 60 sends per user per hour, shared by immediate, scheduled and unsubscribe sends | `rate-limit.ts` (`enforceSendLimit`) |
| 600 sends per service mailbox per hour | `api/svc.ts` |
| 50 recipients and 5 MiB per sent message | `mail/send.ts` |
| 25 MiB per inbound message and per upload | `mail/ingest.ts` (`MAX_EMAIL_BYTES`), `api/attachments.ts` |
| 30 days in Trash, 30 days of service mail | `cron.ts` |
| 30-day sessions renewed daily; 10 sign-ins a minute | `auth.ts` |
| 7-day invites | `api/users.ts` |
| Product name "cfmail" (passkey `rpName`, page title, web manifest) | `auth.ts`, `apps/web/index.html`, `apps/web/public/manifest.webmanifest` |

## 6. Web app build

The web app reads one build-time value: `import.meta.env.DEV` in `apps/web/src/lib/pwa.ts`, which Vite sets. In development the service worker is not registered. There are no `VITE_` variables. In development Vite (`apps/web/vite.config.ts`) serves on port 5173 and proxies `/api` to `http://localhost:8787`. Sign-in through port 5173 is refused, because Better Auth trusts only the Worker's own origin (`auth.ts`).

## 7. CI

`.github/workflows/ci.yml` picks its runner with `fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"')`.

| Name | Where | Default | If missing |
|---|---|---|---|
| `CI_RUNS_ON` | GitHub repository variable | unset | Jobs run on GitHub's hosted `ubuntu-latest` (D-19). The value must be JSON, so a label list such as `["self-hosted", "macOS"]` keeps its brackets and quotes. |

The scripts in `scripts/` take their target as an argument (a deployment name or `--local`) and read bucket names from `wrangler.jsonc` (`scripts/backup/lib.mjs`, `blobsBucket`). Their use is in the runbooks.
