// Helper for backup-daily.sh: names dated backup folders and picks the old ones.
//
//   node scripts/ops/backup-retention.mjs today
//   node scripts/ops/backup-retention.mjs prune <backup root> <keep>
//
// `today` prints the name for today's copy (YYYY-MM-DD, local time).
// `prune` prints, one per line, the dated folders to move to the Trash so that
// the newest <keep> remain. It never names anything that is not a dated folder,
// and it never names the newest one.
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const pad = (n) => String(n).padStart(2, "0");

export function snapshotName(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isSnapshotName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

export function snapshotsToPrune(names, keep) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keep must be a whole number of 1 or more, got ${String(keep)}`);
  }
  const snapshots = names.filter(isSnapshotName).toSorted();
  return snapshots.slice(0, Math.max(0, snapshots.length - keep));
}

function main(args) {
  const [command, root, keepText] = args;
  if (command === "today" && args.length === 1) {
    console.log(snapshotName(new Date()));
    return 0;
  }
  if (command === "prune" && args.length === 3) {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of snapshotsToPrune(names, Number(keepText))) console.log(name);
    return 0;
  }
  console.error("usage: backup-retention.mjs today | prune <backup root> <keep>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}
