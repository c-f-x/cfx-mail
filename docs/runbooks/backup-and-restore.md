# Back up and restore

Status: the full round trip (backup, restore into an empty store, a second backup identical to the first) runs on local development storage on every push to `master` (`scripts/backup/roundtrip.slowtest.mjs`, `pnpm test:slow`). Against production, the backup's reads were checked on 2026-11-11 (bucket name, table count, a stored-file read). No full backup of production is recorded, and the daily job below is not installed. Update this file after the first real backup.

## What a backup holds

A folder on this machine with:

- `db/`: every database table as one file of rows. The search index, sign-in sessions and rate-limit counters are left out. The index is rebuilt during restore, and everyone signs in again afterwards.
- `blobs/`: every stored file the database refers to. Raw mail is under `blobs/raw/<mailbox id>/` as ordinary `.eml` files that any mail program opens.
- `manifest.json`: when it was taken, from which commit, row counts, and which mailbox id is which address.

The folder holds password hashes and the instance's secrets. Keep it on an encrypted disk and treat it like the live system.

Cloudflare's own `wrangler d1 export` does not work here. It refuses databases with full-text search tables.

## Back up

```bash
CFX_SITE=<site checkout> pnpm run backup <name> <folder>
```

`<name>` is the deployment's name in the site file ([`AGENTS.md`](../../AGENTS.md), section 2). Use the same folder every time: files already copied are skipped, so a repeat run only fetches new mail. Database tables are rewritten in full.

The command ends with an error if the database refers to a stored file that does not exist. The missing keys are listed under `missing` in `manifest.json`.

Stored files are fetched one request each, six at a time. A mailbox with thousands of messages takes a while on its first run.

## Restore

Restore only into a new, empty deployment (see `AGENTS.md`, section 4, steps 1 to 3). Run it from the commit named in the backup's `manifest.json`, so the database has the shape the rows were copied from:

```bash
git checkout <commit from manifest.json>
pnpm install
CFX_SITE=<site checkout> pnpm run restore <name> <folder>
```

It applies the migrations, loads the rows, checks every table's row count against the backup, and uploads the stored files. If it stops while uploading, run it again: it sees that the database is already in place and continues with the files. It refuses a target that holds any other data.

Afterwards, deploy the Worker from the newest commit. Its migrations bring the restored database up to date.

Set the `AUTH_SECRET` Worker secret again on the new deployment, the way [`AGENTS.md`](../../AGENTS.md), section 4, step 4 does. It is not in the backup; the owner's private notes say where the old value is kept.

Reusing the old value keeps two-factor sign-in working, because Better Auth encrypts its secrets with it.

## Run it every day

Do this after the first real deployment and one manual backup that ended without an error. Nothing here is installed yet. The files are written and tested, and the steps below are for the owner.

`scripts/ops/backup-daily.sh <name> <backup root> [keep]` runs `pnpm run backup <name> <backup root>/current`, then clones `current` to a folder named for the day (`2026-10-09`). It keeps the newest `keep` dated folders (14 if you give none) and moves older ones to the Trash with `trash`. Cloning is instant and shares disk space on APFS, so a dated copy costs little. If the backup ends with an error, the dated folders stay as they were, the script prints why and exits with 1.

Try it by hand first. Use a folder outside Documents, Desktop and Downloads, because macOS may stop a background job from writing there.

```bash
CFX_SITE=<site checkout> scripts/ops/backup-daily.sh <name> ~/cfmail-backups 14
```

If the installed pnpm is older than 12, set `CFMAIL_PNPM="npx -y pnpm@12.4.1"` in front of the command. For the daily job, add it to the plist's `EnvironmentVariables` dictionary as a second key.

Then install the job:

1. Copy `scripts/ops/com.cfmail.backup.plist.template` to `~/Library/LaunchAgents/com.cfmail.backup.<name>.plist`.
2. Replace every `__PLACEHOLDER__`. The comment at the top of the file explains each one. `__SITE__` is the site checkout, the same path you give `CFX_SITE`. For `__PATH__`, paste the output of `echo $PATH` from your terminal, so the job finds `node`, `pnpm` and `trash`.
3. Check the file: `plutil -lint ~/Library/LaunchAgents/com.cfmail.backup.<name>.plist`.
4. Load it: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.cfmail.backup.<name>.plist`.
5. Run it once now to see it work: `launchctl kickstart -k gui/$UID/com.cfmail.backup.<name>`.

The job runs while you are logged in. If the Mac sleeps at the set time, launchd runs it when the Mac wakes (`man launchd.plist`, `StartCalendarInterval`).

Check that it ran:

```bash
ls ~/cfmail-backups                         # a folder named for today
tail -n 20 ~/Library/Logs/cfmail-backup-<name>.log
launchctl print gui/$UID/com.cfmail.backup.<name> | grep -E 'state|last exit'
```

A good run ends with `cfmail backup: saved ...`. A failed one has a line starting `cfmail backup FAILED`. The log grows by a few lines a day; trash it now and then. A failure shows up only in the log and as a missing dated folder, so look weekly (see `monitoring.md`).

If a run dies and leaves `<backup root>/.lock`, the next run refuses to start and says so. Remove that folder once you are sure no backup is running.

The backup root holds password hashes and secrets, like any backup. Keep it on an encrypted disk.

Remove it:

```bash
launchctl bootout gui/$UID/com.cfmail.backup.<name>
trash ~/Library/LaunchAgents/com.cfmail.backup.<name>.plist
```

## Practise it locally

```bash
pnpm run backup --local /tmp/mail-backup
pnpm run restore --local --persist-to /tmp/mail-restored /tmp/mail-backup
```

The second command restores into a separate local store and leaves the normal one alone.

## Also available

Cloudflare keeps 30 days of point-in-time history for the database on the Workers Paid plan (D1 Time Travel). It can undo a bad change to the database. It does not cover stored files, and it does not help if the account itself is lost. It is not a replacement for this backup.
