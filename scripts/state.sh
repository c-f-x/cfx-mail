#!/usr/bin/env bash
# Show what the shared cfmail deployment holds: domains, mailboxes, service
# mailboxes, aliases and users. Read-only, names and counts only; it never
# reads anyone's mail. Usage: CFX_SITE=<site checkout> scripts/state.sh <deployment>
# The deployment's values come from the private site file (decision D-16).
set -euo pipefail

env="${1:-}"
[ -n "$env" ] || { echo "usage: CFX_SITE=<site checkout> scripts/state.sh <deployment>" >&2; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
wrangler="$repo/apps/worker/node_modules/.bin/wrangler"
[ -x "$wrangler" ] || { echo "No wrangler at $wrangler. Run 'npx -y pnpm@12.4.1 install' in $repo first." >&2; exit 1; }

# The joined config lives in this run's own scratch folder, removed on exit.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/cfmail-state.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
config="$(node "$repo/scripts/site-config.mjs" "$env" "$scratch")"
CLOUDFLARE_ACCOUNT_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).env[process.argv[2]].account_id)' "$config" "$env")"
export CLOUDFLARE_ACCOUNT_ID

query() {
  echo "== $1"
  local out
  out=$(cd "$repo/apps/worker" && "$wrangler" d1 execute DB --remote --config "$config" --env "$env" --json --command "$2" 2>&1) || true
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$out"; then
    jq -r '.error.text // .' <<<"$out" >&2 2>/dev/null || echo "$out" >&2
    exit 1
  fi
  jq -r '.[0].results[] | [.[]] | map(tostring) | join("  ")' <<<"$out"
}

query "Domains (name, allowed kinds: 1 personal, 2 group, 4 service, 8 temp; SPF/DKIM/DMARC ok)" \
  "SELECT name, allowed_kinds, spf_ok, dkim_ok, dmarc_ok FROM domain ORDER BY name"
query "Mailboxes (address, kind, owner, people sharing it)" \
  "SELECT m.local_part||'@'||d.name, m.type, u.email, (SELECT count(*) FROM mailbox_member mm WHERE mm.mailbox_id=m.id) FROM mailbox m JOIN domain d ON d.id=m.domain_id JOIN user u ON u.id=m.owner_user_id WHERE m.type!='service' AND m.pending_purge IS NULL ORDER BY d.name, m.local_part"
query "Service mailboxes (address, display name, direction)" \
  "SELECT m.local_part||'@'||d.name, coalesce(m.display_name,''), m.service_mode FROM mailbox m JOIN domain d ON d.id=m.domain_id WHERE m.type='service' AND m.pending_purge IS NULL ORDER BY d.name, m.local_part"
query "Aliases (address, delivers to)" \
  "SELECT r.local_part||'@'||d.name, t.local_part||'@'||td.name FROM redirect r JOIN domain d ON d.id=r.domain_id JOIN mailbox t ON t.id=r.target_mailbox_id JOIN domain td ON td.id=t.domain_id ORDER BY d.name, r.local_part"
query "Users (email, role)" \
  "SELECT email, role FROM user WHERE ban_reason IS NULL OR ban_reason!='pending-delete' ORDER BY role, email"
