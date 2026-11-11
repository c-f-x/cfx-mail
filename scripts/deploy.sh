#!/usr/bin/env bash
# Deploy one deployment: build, apply database migrations, deploy the Worker.
# Usage: CFX_SITE=<site checkout> pnpm run deploy <name>
# <name> is a deployment in <CFX_SITE>/cf-mail.jsonc. Its values are joined
# with apps/worker/wrangler.jsonc by scripts/site-config.mjs (decision D-16).
set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "usage: CFX_SITE=<site checkout> pnpm run deploy <name>" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"

# The joined config lives in this run's own scratch folder, removed on exit.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/cfmail-deploy.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
config="$(node "$root/scripts/site-config.mjs" "$name" "$scratch")"
account="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).env[process.argv[2]].account_id)' "$config" "$name")"
export CLOUDFLARE_ACCOUNT_ID="$account"

cd "$root"
node_modules/.bin/turbo run build --filter=@cfmail/web

cd "$root/apps/worker"
wrangler="node_modules/.bin/wrangler"

# Build the bundle once before touching anything remote.
"$wrangler" deploy --dry-run --config "$config" --env "$name"
"$wrangler" d1 migrations apply DB --remote --config "$config" --env "$name"
"$wrangler" deploy --config "$config" --env "$name"
