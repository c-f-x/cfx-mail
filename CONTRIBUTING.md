# Contributing

cfx-mail started as a copy of [Newspicel/cloudflare-mail](https://github.com/Newspicel/cloudflare-mail). The codebase is small and opinionated, so please read this once before opening a pull request. `CLAUDE.md` holds the project's own rules and wins where this file disagrees.

## Ground rules

- **Read `AGENTS.md` first.** It captures the invariants (single Worker, RBAC on every route, R2 key namespaces, etc.) that keep the project safe to change. They apply to humans too.
- **One Worker.** Don't split `apps/worker` into multiple Workers or add a separate API service.

## Branching and PRs

- Branch off `master`, the trunk, and open a pull request. Never push to `master`. Name branches `<type>/<short-slug>` (e.g. `feat/labels-ui`, `fix/thread-merge`, `refactor/send-path`).
- There is no protected `develop` branch. A schema change is a new migration: edit `packages/db/src/schema.ts`, then run `pnpm db:generate` (see "Migrations" in `AGENTS.md`). Production data can exist, so never drop or recreate a table.
- Keep PRs focused. A bug fix doesn't need surrounding cleanup; a new feature doesn't need a refactor folded in.
- The work list is the repository's open issues. If your PR closes one, name it in the description.

### Required local checks

Run before opening the PR:

```bash
pnpm typecheck    # tsc (TypeScript 7) across all packages
pnpm lint         # oxlint + biome
pnpm build        # Vite + wrangler deploy --dry-run
pnpm test         # vitest (worker, web) and the node tests under scripts/
```

All four must be green. `pnpm lint` runs both oxlint and Biome. Don't silence a rule in one without considering the other.

### Commit messages

One commit per change. The subject is a short imperative sentence, and the body explains why:

```
Refuse real network requests in worker tests
Give every outbound request a deadline
Add a daily backup script and a launchd template
```

Merge a pull request with a merge commit, not a squash. A squash discards the history of any upstream changes it carries, and the next upstream merge then conflicts.

## Running locally against a real Cloudflare account

`wrangler dev` against the real Workers runtime is the only way to exercise the email bindings end-to-end. Local-only D1/R2 is good for UI work; for mail flow you want both ends real.

### One-time setup

Follow [`AGENTS.md`](./AGENTS.md), section 4, against a staging zone in your own Cloudflare account. You'll end up with:

- Wrangler logged in (`wrangler login`)
- A real D1 database and R2 bucket
- The zone's MX records pointed at Cloudflare Email Routing
- A verified Email Sending domain

Every deployment needs the `AUTH_SECRET`, `CLOUDFLARE_CLIENT_ID` and `CLOUDFLARE_CLIENT_SECRET` Worker secrets (`docs/config-reference.md`, section 2). Local development needs none of them: put a `SETUP_TOKEN` in `apps/worker/.dev.vars` to unlock first-run setup, and the Worker generates a session secret and keeps it in D1 (`system_config`). Per-domain config (which mailbox kinds a domain accepts, who can create what) lives in D1 too.

### Local dev loop

```bash
# Vite (:5173) proxies /api to Wrangler (:8787)
pnpm dev
```

Two important flags when developing against real bindings:

- **D1**: `wrangler dev` uses a local SQLite by default. To reach a deployment's real D1 and R2, pass `--remote --config "$config" --env <name>`, with `$config` from `scripts/site-config.mjs` (`AGENTS.md`, section 2). That reads and writes real data.
- **Email Sending**: the `EMAIL` binding is already `"remote": true` in `wrangler.jsonc`, so `env.EMAIL.send()` reaches Cloudflare Email Sending even under local `wrangler dev`. Use a test sending domain so you don't spam real users.
- **Inbound (`email()`)**: cannot be triggered by `wrangler dev`. Either deploy to a staging Worker and use Email Routing for real inbound, or write a `.eml` fixture and feed it through the integration test suite (`apps/worker/test/receive.test.ts` shows the shape).
- **Cron (`scheduled()`)**: doesn't fire under `wrangler dev` automatically. Run `wrangler dev --test-scheduled` and request `/__scheduled` to trigger it.

### Testing your changes

- `pnpm test` runs the worker integration suite via `@cloudflare/vitest-plugin`. It spins up a real Workers runtime against a local D1 + R2, so inbound, RBAC, threading, and cron logic are all exercised without a real Cloudflare account. It also runs the web tests and the node tests under `scripts/`. Tests may not reach the internet.
- For UI changes, run `pnpm dev` and click through the affected flows in a browser. Type-checking does not catch UX regressions.

## Code style

- Follow the existing patterns. When in doubt, grep for similar code rather than introducing a new abstraction.
- No comments that restate the code; only comments that explain *why* a non-obvious decision was made.
- No backwards-compat shims or feature flags for code that doesn't exist yet.
- Don't reintroduce `composite: true` project references: the workspace resolves via `paths`, not `tsc --build`.
- New runtime dependencies must work on the Workers runtime (no `fs`, no native modules, no Node-only APIs unless `nodejs_compat` covers them).

## Reporting bugs / requesting features

Open an issue in this repository with a minimal repro (or, for features, the user-visible behavior you want). Bugs in upstream's code can also go to [upstream's tracker](https://github.com/Newspicel/cloudflare-mail/issues).

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE) that covers the project.
