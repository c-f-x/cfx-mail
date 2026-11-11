# Decisions

One entry per decision. A decision is never changed in place; a later entry supersedes it.

## D-1 · Build on cloudflare-mail · accepted (2026-10-08)

**Context.** We want mailboxes on our own project domains with a free, open-source webmail client on Cloudflare. Seven clients were read at source level. Six failed a hard requirement: shared mailboxes across all users, a paid license for more than one account, plain-text single-recipient compose, or an unverified sign-in.

**Decision.** Use [Newspicel/cloudflare-mail](https://github.com/Newspicel/cloudflare-mail), MIT licensed, from a private copy imported at `bc1271a`.

**Consequences.** Upstream has one maintainer and no releases. We review and merge its changes by hand and own every fix ourselves. The audit of 2026-10-08 (`docs/reviews/`) lists what must be fixed before real use.

## D-2 · One deployment per project · superseded by D-8 (2026-10-08)

**Context.** All projects run in one Cloudflare account.

**Decision.** Each project gets its own Worker, database and bucket. Projects share no users and no mail.

**Consequences.** Names must be configurable per project without code edits. Cloudflare's sending limits and reputation are per account, so projects still share those.

## D-3 · No paid mail service or software license · accepted (2026-10-08)

**Decision.** The Cloudflare Workers Paid plan is the only cost. Mail is sent through Cloudflare Email Sending.

**Consequences.** Email Sending is in beta and its terms allow only transactional mail. Low-volume personal first contact (about 20 to 30 hand-written emails, no automation) is accepted use. If Cloudflare reviews the account, sending could pause for every project. Outreach moves to a regular mailbox provider if volume grows or lists come into use.

## D-4 · Web only · accepted (2026-10-08)

**Decision.** No phone app and no IMAP.

**Consequences.** The iOS app, the IMAP server, PGP, temp and service mailboxes stay in the code, switched off and hidden. They are not deleted, because deleting them would make every later upstream merge conflict.

## D-5 · Deploying needs the owner's go · accepted (2026-10-08)

**Decision.** Nothing is created or changed in Cloudflare without an explicit go. Work up to deploy-ready does not need one.

## D-6 · CI runs on the owner's Mac · superseded by D-19 (2026-10-08)

**Context.** GitHub refuses hosted runners for this account for billing reasons.

**Decision.** Two self-hosted runners on the Mac run every CI job. The repository variable `CI_RUNS_ON` switches back to hosted runners.

**Consequences.** CI runs only while the Mac is awake. A pull request runs its code on the Mac, so only the owner and the owner's agents may have push access.

## D-7 · Features removed, and features kept · accepted (2026-10-08)

Supersedes the consequences of D-4.

**Context.** The goal is simple mail for most of the owner's projects, used only by people the owner knows. The audit showed which features are isolated enough to remove safely.

**Decision.**

- Removed: the iOS app, sender brand logos (BIMI), the AI features, and the leftover share-link table.
- Kept and used: service mailboxes. Projects send their own mail (magic links and similar) through them.
- Kept: temporary mailboxes, for testing.
- Kept, not in use: the IMAP server and PGP. Cloudflare cannot expose IMAP to us today (it needs inbound TCP for Workers, in private beta, and Spectrum custom ports, an Enterprise feature).
- The settings screens for unused features are not hidden. All users are known to the owner.

**Consequences.** Upstream changes to removed code are dropped when merging. The audit's findings on service mailboxes (no sending limit per key) now matter and stay on the fix list. The audit's finding on brand logos is closed by removal; its findings on AI no longer apply.

## D-8 · One shared deployment for the owner's projects · accepted (2026-10-08)

Supersedes D-2.

**Context.** The owner wants to reach mail for most of their projects. One deployment can serve several mail domains, and the audit found no way for one ordinary user to read another's mailbox.

**Decision.** The owner's projects share one deployment that holds all their mail domains. A project gets its own deployment only when it needs its own admin.

**Consequences.** One sign-in, one backup, one place to add a domain. An admin of the shared deployment is admin for every project in it. The config supports several deployments, so D-2's shape stays possible.

## D-9 · Admins can reach users' mail · accepted (2026-10-08)

**Context.** The audit found that an admin can take over a user's mailbox or sign in as them. All users are the owner's own staff on the owner's own projects.

**Decision.** This stays as it is. Users are not shown a notice about it.

**Consequences.** Audit blocker B3 is closed as accepted. The admin account is as sensitive as every mailbox together, so it needs a strong password and two-factor sign-in.

## Facts confirmed by the owner

- The Cloudflare account is on Workers Paid (2026-10-08).

## D-10 · New app layout · accepted (2026-10-09)

**Context.** One person now holds mailboxes on several project domains. The inherited layout lists every mailbox in the sidebar and shows the views (Inbox, Sent, Drafts and so on) as a row of unlabelled icons. A design pass produced a layout plan and a prototype.

**Decision.** Build the plan's layout, with the owner's choices:

- One left rail holds the account switcher, the views as words with counts, and the folders. The top bar goes.
- The switcher says "accounts", not "mailboxes". The app opens in "All accounts".
- Compose stays a floating window. It does not move into the reading pane.
- The brand colour changes from orange to teal. Orange reads as a warning.
- IMAP access and PGP settings move under an "Advanced" group. This replaces the last point of D-7.
- Archive is not part of this. It needs its own data model change.

**Consequences.** The web app's shell moves further from upstream, so upstream changes to those files are merged by hand or dropped. The defects found while reading the code for the plan are fixed in the same work.

## D-11 · Keep zod whole in the Worker · decided (2026-10-10)

**Context.** zod carries translated error messages that the Worker never shows. A build alias on the branch `proposal-zod-bundle-alias` swapped them for a stand-in module (`shims/zod.ts`) and saved 41 KB compressed, out of a 618 KB Worker.

**Decision.** Not taken. The stand-in is a shim, which the working rules keep out without a specific approval. It would also have to track zod's internals at every update. The saving is small next to Cloudflare's 10 MB limit for a paid Worker.

**Consequences.** The branch stays unmerged as a record. If the Worker ever nears a size or startup budget, look at this again first.

## D-12 · Claude deploys · decided (2026-10-10)

**Context.** D-5 says deploying needs the owner's explicit go. On 2026-10-10 the deploy script gained a check that made the owner type the deployment's name in their own terminal. The owner called that theater: it moved the typing to him and protected nothing he cared about.

**Decision.** Claude runs `pnpm run deploy <name>`. The owner's go is still needed, and a fix the owner asks for carries it for the deployments that fix touches. Creating new Cloudflare resources, such as a new deployment or a new domain's routing, still waits for the owner's word.

**Consequences.** Architecture rule 15 is a process rule again, recorded as such. The terminal check and its test are gone.

## D-13 · Admins sign in with Cloudflare · decided (2026-10-10)

**Context.** Each deployment's first admin came from a one-time setup token that had to be generated, kept, typed and deleted. The owner asked why their Cloudflare account could not be the admin login. Since June 2026 Cloudflare lets an account create its own OAuth clients; a private one can be used only by members of that account, and Better Auth 1.7 ships a Cloudflare provider.

**Decision.** One private OAuth client, "cfmail admin sign-in", in the owner's account, with one permission (User Details Read) and every deployment's callback address. cfmail admits a Cloudflare sign-in only for the first user of an empty deployment, who becomes its admin, or for an existing admin with the same email. It never creates other accounts and never attaches to a non-admin. Passwords stay for everyone, the admin included, as the way in if Cloudflare is unreachable. The setup token still works on a deployment without the client.

**Consequences.** A new deployment needs no setup token; it needs the client's two secrets and its address added to the client. The admin's cfmail email must match the Cloudflare login. Cloudflare shows its consent screen at every sign-in, by its own choice.

## D-14 · Admins sign in only with Cloudflare · decided (2026-10-10)

**Context.** After D-13, an admin could still sign in with a password, and two-factor was off. The admin password was then the easiest door for an outsider: rate limits slow guessing from one address, not from many.

**Decision.** On a deployment with the Cloudflare OAuth client, an admin session is created only by Cloudflare sign-in. Password, passkey and any other method are refused for admins, in the one hook every sign-in passes through. Other users keep their passwords. This replaces D-13's "passwords stay for the admin".

**Consequences.** The admin's way in rests on the owner's Cloudflare login and its two-factor. If Cloudflare sign-in breaks, deleting the `CLOUDFLARE_CLIENT_ID` Worker secret brings back the admin's password until it is set again.


## D-15 · The shared deployment moves to the owner's tools domain · decided (2026-10-27)

**Context.** The shared deployment (D-8) was reachable only at a `mail.` address under its first project's domain. It now serves several projects, and the owner keeps shared tools under one domain of their own.

**Decision.** The deployment's address is `mail.` under the owner's tools domain. The first address keeps serving the same app, because two projects call its `/api/svc`; a redirect would break their sends, since a redirected POST arrives as a GET. The tools domain's own email, at another provider, is untouched: only a web address was added.

**Consequences.** Sign-in is per address, so people sign in once more at the new one. The OAuth client holds both callback addresses. Once both projects call the new address, the old one can be removed. The deployment keeps its config name and its Worker name; renaming them would move secrets, routes and the mail routing rules for no gain. The addresses themselves are in the owner's private notes (D-16).

## D-16 · Deployment values live in a private site file · decided (2026-11-11)

**Context.** cfmail is moving to the c-f-x family as `c-f-x/cf-mail` and will be public. The family rule (cf-kit conventions, section 4) is that a public repository holds no account id, resource id, real hostname or email address. `apps/worker/wrangler.jsonc` held the shared deployment's account id, database id, bucket and hostnames, and `AGENTS.md` and the README listed the owner's domains and where each key is kept.

**Decision.** Each deployment's values are a block in a private site file, `cf-mail.jsonc`, in a checkout named by the environment variable `CFX_SITE` (the owner keeps it in a private repository with notes on what exists). `scripts/site-config.mjs` checks the block and joins it with the template `wrangler.jsonc` into a scratch folder the run removes. `scripts/deploy.sh`, `scripts/state.sh`, `scripts/backup.mjs` and `scripts/restore.mjs` use it; without `CFX_SITE` they stop and say so. `scripts/wrangler-config.test.mjs` fails on an account id, a resource id, a hostname that is neither reserved nor on `scripts/public-hosts.txt`, or an email address at such a host, in any tracked file. A domain or address whose SHA-256 is in `scripts/private-values.sha256` fails even when its host is listed. The scan proves itself on samples it must flag.

This loader is the smallest one cf-mail needs. The family's shared loader in `@c-f-x/kit`, with a zod schema, replaces it once the kit is published.

**Consequences.** Deploying needs the site checkout. The joined config was proved equal to the old one apart from absolute paths, and its dry run built a byte-identical Worker bundle. Internal reviews, goals and the layout plan written before 2026-11 left the public tree; they remain in the private history.

## D-17 · The family's checks are copied in until the kit ships · decided (2026-11-11)

**Context.** The c-f-x conventions hold their rules with shared checks from `@c-f-x/kit`: the docs check, the run scope and the guard proof. The kit is not published yet. cfanalytics has working versions of each.

**Decision.** cf-mail copies them from cfanalytics, changed only where its layout differs: `scripts/docs.mjs` with `scripts/docs.test.mjs`, `scripts/run-scope.mjs` with its test and `scripts/vitest-run-scope.mjs`, and `scripts/guard-proof.slowtest.mjs`. The lifetimes check, `scripts/lifetimes.test.mjs`, is written here to the family's table format. Each is replaced by the kit's check once the kit is published, as the site-file loader is (D-16).

**Consequences.** Until then a fix to one of these checks lands in cfanalytics and here separately. The guard proof starts a workerd for each removed check, so it runs with `pnpm test:slow` on pushes to master, not on every pull request.

## D-18 · The public repository starts from a clean history · decided (2026-11-11)

**Context.** The private repository's history names the owner's domains, personal address, account id and keychain items, and GitHub keeps every pull request's head commit, which a rewrite cannot remove (the readiness review in the private record).

**Decision.** The owner chose a new repository, `c-f-x/cf-mail`. Its history is upstream's up to the copy at `bc1271a`, so Julian Haag's commits keep his name, followed by one commit with the cleaned tree. The private repository stays as the record of how it got here, including its reviews.

**Consequences.** The public log of cf-mail's own changes starts at that commit. Issues still open were filed again here.

## D-19 · CI runs on GitHub's hosted runners · decided (2026-11-11)

Supersedes D-6.

**Context.** A runner executes whatever a pull request contains. On a public repository that is anyone's code, so the owner's Mac must not run it. Hosted runners are free for public repositories, and a run on `ubuntu-latest` passed before the move (lint, build and test).

**Decision.** Every job runs on `ubuntu-latest` unless the repository variable `CI_RUNS_ON` names another runner.

**Consequences.** CI no longer depends on the Mac being awake, and a fork's pull request runs without setup.

## D-20 · The tool is named cfx-mail · decided (2026-11-11)

**Made by.** The owner, for every c-f-x tool: "go for cfx-<toolname>" (c-f-x/cfx-kit D-9). Later the same day, on what keeps the old name: "we should transition that to cfx-mail over time, so we dont have old junk in our projects".

**Context.** "cf-" reads like one of Cloudflare's own products and does not carry the family's name.

**Decision.** The repository is `c-f-x/cfx-mail`, and the docs, scripts, root package, site file (`cfx-mail.jsonc`, `cfx-mail.md`) and agent skill use that name. Names that live in Cloudflare or the keychain stay as they are: the Worker, D1 and R2 names, hostnames, keychain service names, the OAuth client "cfmail admin sign-in" and the Email Routing rule name.

**Consequences.** GitHub redirects the old URL. Three uses of the old name remain, each to move in a change of its own: the `@cfmail/*` package names (upstream's, imported by nearly every file), the product name people see in the app, and names stored in browsers and saved drafts (`cfmail-theme`, `data-cfmail-cid`, the `cfmail-quote` classes), which need a one-time copy so nobody loses a setting or an inline image. Entries above keep their original words.
