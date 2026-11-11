#!/usr/bin/env bash
# Take a daily backup of one deployment and keep the last N dated copies.
# Usage: scripts/ops/backup-daily.sh <name> <backup root> [keep]
#
# <backup root>/current       the working copy that `pnpm run backup` updates
# <backup root>/YYYY-MM-DD    one clone of `current` per day, taken after a good run
#
# Older dated copies are moved to the Trash with `trash`. A failed backup
# leaves the dated copies alone, prints why, and exits 1.
# Set CFMAIL_PNPM to change how pnpm is called, for example "npx -y pnpm@12.4.1"
# when the installed pnpm is older than 12.
set -euo pipefail
umask 077

fail() {
  echo "cfmail backup FAILED ($(date '+%Y-%m-%d %H:%M:%S')): $*" >&2
  exit 1
}

name="${1:-}"
root="${2:-}"
keep="${3:-14}"
if [ -z "$name" ] || [ -z "$root" ]; then
  echo "usage: scripts/ops/backup-daily.sh <name> <backup root> [keep]" >&2
  exit 2
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
retention="$repo/scripts/ops/backup-retention.mjs"
read -r -a pnpm_cmd <<<"${CFMAIL_PNPM:-pnpm}"
for tool in node trash "${pnpm_cmd[0]}"; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is not on PATH ($PATH)."
done

mkdir -p "$root" || fail "cannot create $root."
root="$(cd "$root" && pwd)"

# One run at a time. The lock is a folder this run creates and removes again.
lock="$root/.lock"
mkdir "$lock" 2>/dev/null || fail "another backup is running, or one died and left $lock. Remove that folder if no backup is running."
trap 'rmdir "$lock"' EXIT

# Check the keep count before anything is changed.
node "$retention" prune "$root" "$keep" >/dev/null ||
  fail "keep must be a whole number of 1 or more (got '$keep')."

cd "$repo"
echo "cfmail backup: $name -> $root/current"
"${pnpm_cmd[@]}" run backup "$name" "$root/current" ||
  fail "'run backup $name' ended with an error. The dated copies are untouched."

today="$(node "$retention" today)"
partial="$root/.$today.partial"
[ -e "$partial" ] && trash "$partial"
# -c clones on APFS: instant, and shares disk space with the working copy.
cp -cR "$root/current" "$partial" ||
  fail "could not copy $root/current to $partial (the backup folder must be on APFS)."
[ -e "$root/$today" ] && trash "$root/$today"
mv "$partial" "$root/$today" || fail "could not move $partial to $root/$today."
echo "cfmail backup: saved $root/$today"

while IFS= read -r old; do
  [ -n "$old" ] || continue
  trash "$root/$old" || fail "could not move $root/$old to the Trash."
  echo "cfmail backup: moved $root/$old to the Trash"
done < <(node "$retention" prune "$root" "$keep")
