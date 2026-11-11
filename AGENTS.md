# AGENTS.md

How an agent sets up cfmail for a domain, manages its accounts, and changes its code safely.

cfmail is mail on Cloudflare for one owner's projects: one Worker serves the web app, the API, inbound mail and the scheduled jobs. People read and send mail in the browser; projects send mail (sign-in links and similar) through an API key.

Read `CLAUDE.md` first for how work is done in this repo. Where `CLAUDE.md` and this file disagree, `CLAUDE.md` wins. The background is in `docs/architecture.md` (how it works), `docs/config-reference.md` (every setting and secret) and `docs/decisions.md` (why it is this way).

## 1. Ground rules for operations

- **Ask the owner before creating anything new in Cloudflare**: a deployment, a database, a bucket, a domain's mail routing. Deploying a fix the owner asked for needs no further go (decisions D-5, D-12).
- **Look before you change a domain's mail.** Check its MX records and existing routing rules first. If the domain's mail goes to another mail host, stop and ask the owner: turning on Email Routing would take its mail away from that provider.
- **Never show a secret.** Pipe values from the Keychain straight into `wrangler secret put`. Never print them, never paste them into chat, a log or a file. A secret that was shown is compromised; say so and rotate it.
- **Local development sends real mail** unless the Worker runs with `wrangler dev --local`. Never press Send or confirm an Unsubscribe while checking screens.
- **Run commands with the pinned tools.** pnpm is 12.4.1 (`npx -y pnpm@12.4.1 <command>` if the installed one is older). Wrangler is `apps/worker/node_modules/.bin/wrangler`, logged in to the owner's account.
- **A brand-new hostname can look missing for up to 30 minutes** on a Mac: its resolver remembers "does not exist" from any lookup made before the record existed. Check new hostnames with `dig @1.1.1.1` and `curl --resolve`.

## 2. Deployments and the site file

The repository holds no deployment values: no account id, Worker name, hostname, database or bucket id (decision D-16). Each deployment's values are a block in a private site file, `cf-mail.jsonc`, kept in a checkout whose path is in the environment variable `CFX_SITE`. `scripts/site-config.mjs` joins that block with the template `apps/worker/wrangler.jsonc` at run time, in a scratch folder the run removes. `scripts/deploy.sh`, `scripts/state.sh`, `scripts/backup.mjs` and `scripts/restore.mjs` all go through it. The format is at the top of `scripts/site-config.mjs`.

`scripts/wrangler-config.test.mjs` fails when any file in the repository holds an account id, a resource id, or a hostname or email address that is not reserved (`example.com`, `.test`) or listed in `scripts/public-hosts.txt`. Use reserved names in tests and docs. Add a host to the list only for a public service the code must name. The owner's own domains are hashed in `scripts/private-values.sha256`, so they fail even if listed.

The owner keeps the site file, and private notes on what exists and where each key is kept, in a private repository next to it (`cf-mail.md`).

Run `CFX_SITE=<site checkout> scripts/state.sh <name>` for the live list of domains, mailboxes, service mailboxes, aliases and users. It reads names and counts only, never mail.

Mail routing and DMARC per domain are on Cloudflare: `wrangler email routing rules list <domain>` and `dig +short TXT _dmarc.<domain>`.

The owner's projects share one deployment (decision D-8). A new domain joins it (section 3). A project gets a deployment of its own only when it needs its own admin (section 4).

## 3. Add a domain to the shared deployment

This is the usual way to give a new project mail. `<domain>` is the project's domain, for example `example.org`.

### 3.1 Check first

1. The domain must be a zone in the owner's Cloudflare account: `dig +short NS <domain>` shows `*.ns.cloudflare.com`.
2. Look at its mail today:

   ```bash
   dig +short MX <domain>
   cd apps/worker && node_modules/.bin/wrangler email routing rules list <domain>
   ```

   - MX shows `route1.mx.cloudflare.net` and friends: Email Routing is on. Note every rule; they stay.
   - MX shows another provider: stop and ask the owner.
   - No MX: the domain receives no mail yet; go on.

### 3.2 Give the domain its own app address (optional)

People can use the deployment's existing address for every domain. If the project's people should use `https://mail.<domain>` instead:

1. Check that `mail.<domain>` has no DNS records (`dig +short mail.<domain>`).
2. Add `"mail.<domain>"` to the deployment's `hostnames` in the site file, and commit that in the site repository.
3. Deploy: `CFX_SITE=<site checkout> scripts/deploy.sh <name>`. The deploy creates the DNS record and certificate.
4. Add `https://mail.<domain>/api/auth/callback/cloudflare` to the redirect URLs of the OAuth client "cfmail admin sign-in" (Cloudflare dashboard: Manage account, OAuth clients). Wrangler cannot do this; drive the dashboard in a browser where the owner is signed in. Without it, "Admin: sign in with Cloudflare" fails on that address.

A browser keeps a separate sign-in for each address.

### 3.3 Route the domain's mail to the app

1. If Email Routing is off and the domain has no other mail provider: `node_modules/.bin/wrangler email routing enable <domain>`.
2. Point the domain's catch-all at the Worker. Every mailbox created in the app then receives mail at once, and the app turns away addresses that do not exist ("Address not found"). Rules for single addresses, such as a forward to someone's inbox, still win over the catch-all, so they keep working. If the catch-all already forwards somewhere, ask the owner first.

   Wrangler cannot point a catch-all at a Worker, so use the API with wrangler's own login. The token is read inside the command and never printed:

   ```bash
   TOKEN=$(grep '^oauth_token' "$HOME/Library/Preferences/.wrangler/config/default.toml" | sed -E 's/^oauth_token *= *"(.*)"/\1/')
   ZONE=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones?name=<domain>" | jq -r '.result[0].id')
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     "https://api.cloudflare.com/client/v4/zones/$ZONE/email/routing/rules/catch_all" \
     --data '{"name":"everything else to cfmail","enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["mail-<name>"]}]}' \
     | jq -c '{success, errors}'
   ```

   Wrangler's login expires; run any wrangler command first to refresh it.

3. Check: `node_modules/.bin/wrangler email routing rules list <domain>` shows `Catch-all rule: enabled, action: worker:mail-<name>`.

### 3.4 Let the app send from the domain

```bash
node_modules/.bin/wrangler email sending enable <domain>
node_modules/.bin/wrangler email sending dns get <domain>
```

The first command adds the sending records (a `cf-bounce` subdomain with MX, SPF and DKIM). Check them with `dig`. Cloudflare also suggests a DMARC record with `p=reject`. Leave an existing DMARC record as it is; tightening it is the owner's call, after sending has worked for a while.

### 3.5 Add the domain in the app

An admin does this in the app (section 5.1 explains how an agent works as admin):

1. Admin, Domains: type `<domain>`, tick the mailbox kinds it may hold, press "Add domain". The kinds are personal, group, service and temp (section 5.2).
2. Within a minute the SPF, DKIM and DMARC badges turn green. Press "Recheck" to check at once. SPF needs the apex TXT record to include `_spf.mx.cloudflare.net`; DKIM looks for the `cf2024-1` record that Email Routing creates.
3. "Transactional email" is one address for the whole deployment, used for invites and password resets. It is set once; leave it unless the owner wants it changed.

### 3.6 Check it end to end

1. Create a mailbox on the domain (section 5.3).
2. Send it a test from the command line. This goes out through Cloudflare's sending and back in through routing:

   ```bash
   node_modules/.bin/wrangler email sending send --from "noreply@<domain>" --to "<mailbox>@<domain>" \
     --subject "Test from setup" --text "This is a test message. It can be deleted."
   ```

3. Confirm it arrived, without reading anyone's mail:

   ```bash
   scratch="$(mktemp -d)"; config="$(CFX_SITE=<site checkout> node ../../scripts/site-config.mjs <name> "$scratch")"
   node_modules/.bin/wrangler d1 execute DB --remote --config "$config" --env <name> --json --command \
     "SELECT m.spam_verdict, m.spam_auth FROM message m JOIN mailbox b ON b.id=m.mailbox_id WHERE b.local_part='<mailbox>' AND m.subject='Test from setup'"
   trash "$scratch"
   ```

   Expect one row, verdict `clean`, with `dkim` and `dmarc` passing.

4. Run `CFX_SITE=<site checkout> scripts/state.sh <name>` to see the domain listed with its badges.

## 4. Set up a separate deployment

Only when a project needs its own admin (D-8). Ask the owner first. `<name>` is a short label such as the project name.

1. **Database and bucket**, from `apps/worker`:

   ```bash
   node_modules/.bin/wrangler d1 create mail-<name>
   node_modules/.bin/wrangler r2 bucket create mail-<name>-blobs
   ```

   Keep the `database_id` the first command prints.

2. **Site file.** Add a block for `<name>` to `cf-mail.jsonc` in the site checkout, in the format at the top of `scripts/site-config.mjs`: the account id, the Worker name `mail-<name>`, the hostname `mail.<domain>`, the database name and the `database_id` from step 1, and the bucket name. Commit it in the site repository. Never put these values in this repository; `scripts/wrangler-config.test.mjs` fails on an account id, a resource id or a real hostname in any tracked file.

3. **Dry run**, from `apps/worker`:

   ```bash
   scratch="$(mktemp -d)"; config="$(CFX_SITE=<site checkout> node ../../scripts/site-config.mjs <name> "$scratch")"
   node_modules/.bin/wrangler deploy --dry-run --config "$config" --env <name>
   ```

   The bindings must show `mail-<name>` and `mail-<name>-blobs`. Keep `$config` for step 4, then `trash "$scratch"`.

4. **Secrets.** `AUTH_SECRET` is new for each deployment and goes into the Keychain first, because a backup does not hold it. The OAuth client is shared:

   ```bash
   printf 'add-generic-password -a AUTH_SECRET -s "cfmail <name>" -l "cfmail <name> AUTH_SECRET" -w "%s"\n' "$(openssl rand -base64 48)" | security -i
   security find-generic-password -a AUTH_SECRET -s "cfmail <name>" -w | tr -d '\n' | node_modules/.bin/wrangler secret put AUTH_SECRET --config "$config" --env <name>
   for k in CLOUDFLARE_CLIENT_ID CLOUDFLARE_CLIENT_SECRET; do
     security find-generic-password -a $k -s "cfmail cloudflare oauth" -w | tr -d '\n' | node_modules/.bin/wrangler secret put $k --config "$config" --env <name>
   done
   ```

   Set them before the first request reaches the Worker. Changing `AUTH_SECRET` later signs everyone out.

5. **Deploy**: `CFX_SITE=<site checkout> scripts/deploy.sh <name>`. It builds the web app, dry-runs, applies the database migrations and deploys the Worker.

6. **OAuth callback**: add `https://mail.<domain>/api/auth/callback/cloudflare` to the OAuth client (step 4 of section 3.2).

7. **Check it is up**:

   ```bash
   curl -s https://mail.<domain>/api/health
   curl -sI https://mail.<domain>/ | grep -i content-security-policy
   ```

   The first answers `{"ok":true,"db":"ok","storage":"ok"}`. The second must print a line; if it does not, the pages are served without the Worker's security headers.

8. **First admin**: open `https://mail.<domain>/login` and press "Set up with Cloudflare". The first person through becomes the admin, under the email of their Cloudflare login. Cloudflare shows a consent screen for "cfmail admin sign-in" every time; approve it for the owner's own account.

9. **The domain**: sections 3.3 to 3.6.

10. **Watch it**: set up the uptime check (`docs/runbooks/monitoring.md`) and the daily backup (`docs/runbooks/backup-and-restore.md`). Note the deployment in the owner's private notes.

To remove a deployment, delete in this order: the routing rules, the sending domain, the Worker, the database, the bucket. Then remove its block from the site file.

## 5. Accounts and mailboxes

### 5.1 Who can do what, and how an agent acts as admin

There are two roles. An **admin** manages domains, users and every mailbox, and can reach everyone's mail (decision D-9). A **user** reads and sends from the mailboxes they own or were given, and may create some themselves if an admin granted it (section 5.4).

Admins sign in only with Cloudflare ("Admin: sign in with Cloudflare"); their passwords are refused (D-14). Cloudflare only lets members of the owner's account through, and the app only admits an admin whose email matches. If Cloudflare sign-in ever breaks, deleting the `CLOUDFLARE_CLIENT_ID` secret brings the admin's password back until it is set again.

An agent has no admin session of its own. Admin work happens in the app, either by the owner or by an agent driving a browser in which the owner has signed in. Do not write account rows straight into the database: that skips the checks the app makes.

Everything below is in the app under **Admin** (tabs Domains, Users, Mailboxes, Service, Blocking). The API routes are in `docs/architecture.md`, section 7.

### 5.2 The four mailbox kinds

| Kind | What it is | Created by |
|---|---|---|
| personal | One person's mailbox | an admin, or a user with a grant |
| group | Shared mailbox; members get read, write and manage rights | an admin, or a user with a grant |
| temp | Throwaway address with a random name that deletes itself, for testing | a user with a grant, or an admin |
| service | No login; a project sends (and optionally receives) through an API key | an admin |

A domain only holds the kinds ticked for it under Admin, Domains. Ticking a kind off later stops new mailboxes of that kind; it leaves existing ones alone.

An address's name part may use letters, digits, `.`, `_` and `-`, up to 64 characters. `+` is reserved: mail to `name+anything@<domain>` arrives in `name@<domain>`, and that mailbox may also send from such plus-addresses.

### 5.3 Give a person access

1. **Add the person.** Admin, Users:
   - "Send invite" with their email and role. They get a link, valid 7 days, to choose their name and password. The invite is emailed only if a "Transactional email" sender is set (Admin, Domains). If it is not sent, the app says so and shows the link with a "Copy link" button; send it to them another way. Each pending invite also has "Copy link".
   - Or "Create user directly", with a starting password you pass on yourself.

   Make someone an admin only if they are a member of the owner's Cloudflare account under the same email; otherwise they cannot sign in at all (D-14).

2. **Give them a mailbox.** Admin, Mailboxes, "New mailbox": the name part, the domain, the kind (personal or group), and the owner. The owner can read and send from it straight away, and mail to it arrives at once (section 3.3).

3. **Share a group mailbox.** On the group mailbox's row, "Members", then pick a user and tick read, write or manage. Read lets them see the mail. Write lets them send, file and label. Manage lets them change the mailbox's settings, members and rules. The "Members" button shows only on group mailboxes you hold manage rights on; to manage someone else's, take it over first with "Change owner".

4. **Hand a mailbox over.** "Change owner" on its row. The same panel switches a mailbox between personal and group; switching to personal removes all members.

Users sign in with email and password, a passkey, or both, and can turn on two-factor sign-in (Settings, Security and Two-factor authentication). A user who forgets their password uses "Forgot password?", which also needs the "Transactional email" sender.

### 5.4 Let a user create their own mailboxes

On their row in Admin, Users, press "Grants" and tick the kinds they may create on each domain. A kind must also be allowed on the domain itself. A user creates personal and group mailboxes under Accounts, and temporary ones from the account switcher with "New temporary account" (1 hour to 7 days). Users never create service mailboxes.

### 5.5 Give a project a service mailbox

This is how a project's code sends mail, such as sign-in links, from one of its own addresses.

1. On Admin, Domains, tick "service" for the project's domain.
2. Admin, Service: the name part (for example `noreply`), the domain, and the direction: "send-only" (mail sent to it is refused) or "send + receive" (mail sent to it is kept for 30 days and read through the API). Press "Add service".
3. The app shows the API key once. Put it straight into the project's own secret store, for example `wrangler secret put CFMAIL_KEY` in the project's Worker, and note where it is kept in the owner's private notes. Never paste it anywhere else. "Rotate key" issues a new one and stops the old one at once.

The project then calls the deployment's address:

```bash
curl -sS -X POST "https://mail.example.com/api/svc/send" \
  -H "Authorization: Bearer $CFMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":[{"address":"person@example.org"}],"subject":"Your sign-in link","text":"Open https://app.example.org/magic?token=abc"}'
# 201 {"messageId":"…","threadId":"…"}
```

Mail sent to many people, such as a daily digest, also carries one-click unsubscribe:

```bash
curl -sS -X POST "https://mail.example.com/api/svc/send" \
  -H "Authorization: Bearer $CFMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":[{"address":"person@example.org"}],"subject":"Your daily digest","text":"…",
       "headers":{"List-Unsubscribe":"<https://app.example.org/unsubscribe?t=abc>, <mailto:unsubscribe@example.org>",
                  "List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}}'
```

- The sender is the service mailbox's own address, or a plus-address of it (`fromAddress`).
- `to`, `cc` and `bcc` together hold at most 50 recipients. Send `text`, `html` or both. Attachments are not supported.
- `headers` may hold two headers and no others: `List-Unsubscribe` and `List-Unsubscribe-Post` (names in any case). Large mailbox providers require both on bulk mail (RFC 8058, one-click unsubscribe). `List-Unsubscribe` is one or two entries in angle brackets, each an `https:` address or a `mailto:` address, at most 2,048 characters. `List-Unsubscribe-Post` must be exactly `List-Unsubscribe=One-Click` and needs an `https:` entry in `List-Unsubscribe`. A line break, any other header or any other value answers 400. The headers go out with the message and stay in the stored copy.
- Each service mailbox may send 600 messages an hour. Over that, the answer is 429; failed attempts count too.
- `GET /api/svc/info` says which address and direction the key belongs to. `GET /api/svc/messages?after=<id>` lists stored mail, oldest first after the cursor, 50 at a time, and `GET /api/svc/messages/<id>` returns one message's text.
- Errors come back as `{"error": "…"}`.

The routes are in `apps/worker/src/api/svc.ts`.

### 5.6 Aliases and catch-alls inside the app

Admin, Mailboxes, "New redirect" makes an inbound-only alias: mail to the alias arrives in a target mailbox, which may be on another domain. Tick "catch-all" to take every address on the domain that has no mailbox or alias of its own. "Change target" moves it. An alias cannot send.

### 5.7 Remove access

- **A mailbox**: "Delete" on its row. It can leave a redirect behind so its address keeps receiving into another mailbox. "Empty" deletes its mail and keeps the mailbox.
- **A person**: "Delete" on their row in Admin, Users. The dialog lists every mailbox they own, marking those shared with others. Tick the ones to delete with all their mail; nothing is ticked at first. Every unticked mailbox is handed to you with its mail and members, and you can give it a new owner with "Change owner".
- **A shared mailbox** can only be deleted by an admin; its owner is refused while anyone else shares it.
- Deleting happens in the background over the next minutes. An address is free for reuse at once.

### 5.8 Not available

- **Mail apps (IMAP)**: built, but Cloudflare cannot expose it yet (decision D-7). Settings shows IMAP under Advanced as "not in use".
- **PGP**: built, not in use (D-7). It sits under each mailbox's Advanced settings.

## 6. Invariants (don't break without approval)

1. **One Worker.** `apps/worker` is the only runtime (`fetch`, `email`, `scheduled`, `connect`, `UserHub` DO). Don't add a separate service; a new protocol is a new handler, not a new script.
2. **RBAC everywhere.** Mailbox routes go through `permissions.ts`. Don't reimplement the owner shortcut.
3. **Realtime is SSE** via `UserHub` DO; the web app and IMAP `IDLE` both ride it. No WebSockets, no polling (IMAP's slow re-reconcile timer is a backstop for peers' changes the hub can't see, not a substitute).
4. **Zero-config, secrets out of the repo.** No deployment values or secrets in `wrangler.jsonc`; lazy-store settings in `system_config` instead. The exceptions are Worker secrets: `AUTH_SECRET`, which signs sessions; `CLOUDFLARE_CLIENT_ID` and `CLOUDFLARE_CLIENT_SECRET`, the admin sign-in client; and `SETUP_TOKEN`, only on a deployment without that client. The base URL is derived from the request. Development secrets live in `.dev.vars` (gitignored).
5. **No open sign-up.** The first admin of a deployment is the first person through "Set up with Cloudflare" (or, without the OAuth client, the holder of `SETUP_TOKEN`). Everyone else comes from an admin or an invite. Admins sign in only with Cloudflare, and never reset their password by email.
6. **R2 key layouts are a contract.** Other code parses these paths; change a scheme and you must migrate existing objects. Every key is built in `apps/worker/src/mail/blob-keys.ts`.
7. **Gateway PGP is not end-to-end.** The Worker holds the mailbox keypair so it can decrypt for search, spam and threading. Never reject mail on PGP failure; never return private keys from the API.
8. **Mail never hard-fails on best-effort steps**: spam scoring, PGP and push must not block delivery.
9. **`HTTPException` lives in `api/` only.** Everything below it throws `AppError` (`errors.ts`) with a transport-neutral code, so one failure can be a JSON 4xx and a tagged IMAP `NO`. Transports translate; nothing else does.
10. **Spamhaus: who sent it can refuse, what's in it only scores.** DQS (`mail/dnsbl.ts`) runs only when an admin has stored a query key. A ZEN hit on the connecting host, or a DBL/ZRD hit on a name the sending side asserts (envelope/header From, EHLO), SMTP-rejects with the listing named so the sender can delist. Content (abused-legit DBL codes, link domains, HBL hashes) only scores, and no listing may reach `SPAM_AT` alone except an HBL malware-file hash, which is an exact match rather than a reputation guess. Lookups stay best-effort: a DNS failure or error code never blocks mail. Public DNSBL zones don't work here at all (a Worker resolves via DoH, that is a public resolver).
11. **A signature is not a character reference.** `dmarc=pass` retires the forgery signals and the connecting-IP check, nothing else: reputation and content checks run for authenticated mail too. Spam *phrasing* is the exception; it is too weak to outvote an aligned signature, so for authenticated mail it does not count.
12. **IMAP folders are derived, never stored.** `store.ts` computes membership from thread and message state on every load; `imap_folder`/`imap_uid` own only the UID space. A message that leaves a folder and returns gets a *new, higher* UID. Never reuse one, and never let a mail pipeline write IMAP tables.

`docs/architecture.md`, section 2, names the test or lint rule that enforces each one.

## 7. Migrations

Edit `schema.ts`, then `pnpm --filter @cfmail/db generate` to emit the `drizzle/NNNN_*.sql` file, snapshot and journal entry. Add the new file's line to `packages/db/drizzle/sealed.json`; `scripts/migrations.test.mjs` prints it for you. Apply locally with `pnpm --filter @cfmail/db migrate:local`; `scripts/deploy.sh <name>` applies them to a deployment. Never edit a migration once it is merged: deployments that ran it will not run it again. Hand-writing a migration is fine for what `generate` can't express (FTS triggers), but keep the snapshot and journal consistent. Production data exists; never drop and recreate tables.

## 8. Tooling

- Typecheck: `pnpm typecheck` (`tsc` from `typescript@7`, the native compiler; no `composite: true`).
- Lint: `pnpm lint` (oxlint and Biome; keep both green).
- Tests and their times: `CLAUDE.md`, "Test strategy".
- `apps/web/src/routeTree.gen.ts` is generated (`tsr generate`). Don't edit it.
- New dependencies must run on the Workers runtime (no Node-only APIs unless `nodejs_compat` covers them).

## 9. Working style

- Terse updates, no speculative features, no comments restating code, no compatibility shims.
- Work on a branch and open a pull request. Never push to the trunk (`master`).
- When a change touches an invariant above, ask before coding.
- A new rule worth keeping goes here as a rule, never as a state snapshot, and gets a check that fails when it is broken.
- Build UI from the components in `apps/web/src/components/ui/`. Don't invent new components or styles; search for an existing component first.
- Ignore changes you didn't make. Several agents can work at once; commit only your own changes.
