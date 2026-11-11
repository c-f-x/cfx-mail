# cfx-mail

Our private copy of [Newspicel/cloudflare-mail](https://github.com/Newspicel/cloudflare-mail) (MIT). It gives people mailboxes on our own project domains. One deployment serves several domains.

Read `AGENTS.md` for upstream's invariants and the migration workflow. Where this file and `AGENTS.md` disagree, this file wins.

## Start here

- `.context/` (gitignored, copied into new workspaces by `.worktreeinclude`) holds private notes for the agent working here, such as the latest handover. Read it first if it exists.
- `docs/decisions.md`: decisions already made. Check it before asking the owner.
- `docs/architecture.md`: how the system works, its binding principles and what enforces each.
- `docs/data-model.md`: what each store keeps, for how long, and what removes it. A new table or binding needs a row there (`scripts/lifetimes.test.mjs`).
- `docs/config-reference.md`: every binding, secret and setting, and what happens without it.
- `docs/code-structure.md`: where code lives and which folder may import which.
- `AGENTS.md`: how to add a domain or a deployment and manage accounts. `CFX_SITE=<site checkout> pnpm run deploy <name>` deploys one.
- `docs/runbooks/backup-and-restore.md`: `pnpm run backup <name> <folder>` and `pnpm run restore <name> <folder>`, both with `CFX_SITE` set. It also explains the daily backup in `scripts/ops/`.
- `docs/runbooks/monitoring.md`: how to notice that the app is down or inbound mail is failing, and what each log line means.

## Upstream

- Imported at `bc1271a985c9ed12326b9b6aedcd7256808db133` (2026-09-30).
- Add the `upstream` remote once per clone: `git remote add upstream https://github.com/Newspicel/cloudflare-mail.git`. Fetch it, review the changes, and merge by hand. Never track it automatically.
- Merge pull requests that bring in upstream history with a merge commit. A squash discards that history and makes the next upstream merge conflict.
- Keep `LICENSE` and its copyright notice.
- Change upstream's own files as little as the task allows. Every edit there is a possible conflict in the next upstream merge.

## Differences from AGENTS.md

- The trunk is `master`. Work on a branch and open a pull request. Do not push to the trunk.
- Deploying needs an explicit go from the owner. Claude runs `pnpm run deploy <name>` itself; a fix the owner asks for carries the go to ship it to the deployments it touches (D-12).

## Tooling

The repo pins pnpm 12.4.1. Older versions cannot read the lockfile and fail with `ERR_PNPM_BROKEN_LOCKFILE`. If the installed pnpm is older, run `npx -y pnpm@12.4.1 <command>`.

## Running it locally

- Local development sends real mail through the owner's Cloudflare account, because the `EMAIL` binding is remote. Start the Worker with `wrangler dev --local` to swap it for a local stand-in, and never press Send or confirm an Unsubscribe while checking screens.
- Sign in through the Worker's own port, not Vite's: the Worker only trusts its own origin. Build the web app first (`pnpm --filter @cfmail/web build`).
- First-run setup needs `SETUP_TOKEN=<any value>` in `apps/worker/.dev.vars` (gitignored).
- `node scripts/seed-local.mjs` fills a local Worker with fictional mail; `scripts/measure/` holds the measurement scripts. Use a separate `--persist-to` folder and a free port, and trash both afterwards.

## Working with helpers

- Give each parallel helper its own worktree and its own files. Remove a worktree once its branch is merged.
- A hook blocks deleting branches on GitHub. Leave merged branches; the owner deletes them or turns on automatic deletion.
- While the owner is away, a pull request may be merged when CI is green and it changes nothing a user sees, or only fixes a defect. New or changed screens wait for the owner.

## Test strategy

Times were measured on the owner's Mac on 2026-11-11 without the turbo cache (`TURBO_FORCE=true`), each through `npx -y pnpm@12.4.1`. Other jobs kept the Mac busy (load average 23 to 29), so expect less on an idle Mac. About 90 percent of the worker test time is module transform.

| Command | Checks | Time |
|---|---|---|
| `pnpm lint` | oxlint and Biome | 2 s |
| `pnpm typecheck` | `tsc` in all four packages | 6 s |
| `pnpm build` | Vite build and a wrangler dry run | 11 s |
| `pnpm test` | Worker tests (1,901), web tests (287), and the script tests under `scripts/` (99) | 125 s |
| `pnpm test:slow` | The backup-and-restore round trip on local storage, and the guard proof (each access check removed in a scratch copy must fail a named test) | About 6 minutes: the round trip about 5, the guard proof 47 s (2026-11-11) |

- Run lint and typecheck on every change.
- A change under `apps/worker`, `packages/db` or `packages/shared` runs `pnpm --filter @cfmail/worker test`.
- A change under `apps/web` runs `pnpm --filter @cfmail/web test`.
- When unsure what a change touches, run all four commands.
- CI runs all four on every pull request and on every push to `master`. `pnpm test:slow` runs only on pushes to `master`; run it yourself after changing `scripts/backup*` or `scripts/restore.mjs`.
- `scripts/docs.test.mjs` (part of `pnpm test`) fails when a doc names a path that does not exist, when this file passes 150 lines, or when a decision heading leaves the form `## D-<n> · <title> · <status> (<date>)`.
- Check the exit code of each command. Filtering the output with `grep` has hidden a formatter error and a crashed test run before.
- `pnpm lint` exits 1 inside a worktree under `.claude/`, because Biome ignores that folder and finds no files. Run `oxlint` and `biome check apps packages` there instead.

### Performance budgets

Budgets count bytes and database statements, never milliseconds, so a busy CI Mac cannot make them flaky. Each limit is the value measured on 2026-10-09 plus about 10 to 15 percent (for statement counts, 10 percent and at least one), with the measured value written next to it. A failure names the value and the limit. If the growth is intended, raise the limit in the file named below and say why in the commit.

| Budget | Command | Limits live in |
|---|---|---|
| Worker bundle (raw, gzip) and web JavaScript and CSS (raw, gzip, largest chunk). Also fails if a source map would be uploaded with the assets (`apps/web/public/.assetsignore` keeps them back) | `pnpm run check:bundles`, after `pnpm build`. CI runs it in the `build` job. Under 1 s. | `scripts/budgets/check-bundles.mjs` (its own tests run with `pnpm test`) |
| D1 statements per request: inbox list, thread counts, search, opening a thread (1, 10 and 50 messages), one message body, a thread's bodies (1 and 50 messages), send, inbound delivery (plain and joining a thread), idle cron tick | `pnpm --filter @cfmail/worker test` (the `test/budgets/` folder, about 8 s). Counted exactly on real Miniflare D1 through the real app and real sessions. | `apps/worker/test/budgets/statements.test.ts` (the counter is `test/support/count-statements.ts`) |

The web limits were re-set on the new layout (D-10) on 2026-10-09.

Opening a thread costs 6 statements for 1, 10 or 50 messages, because the thread route does not load bodies. The web app then fetches the bodies of up to 50 messages in one request (7 statements, 3 of them sign-in checks), so a 10-message conversation costs 13. A test fails if either route starts to grow with message count.

## CI

CI runs on GitHub's hosted runners (`ubuntu-latest`), free for a public repository (D-19). The repository variable `CI_RUNS_ON` overrides the runner, as JSON: `'["self-hosted", "macOS", "<label>"]'` for runners of your own. Never point a public repository's pull requests at a machine of your own: a pull request runs whatever code it carries.
