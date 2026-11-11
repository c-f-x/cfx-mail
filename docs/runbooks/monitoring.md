# Monitoring

Status: production has run since 2026-10-10. `GET /api/health` was checked against it on 2026-11-11 and answered `{"ok":true,"db":"ok","storage":"ok"}`. No outside check watches it yet, and nothing records that the weekly routine below has been followed.

This page answers two questions: is the app up, and is inbound mail arriving. The first has an automatic answer. The second does not, so it has a routine.

## What exists today

- The Worker writes a log line for each request and for each failure. Cloudflare keeps them in Workers Logs (`observability` is on in `apps/worker/wrangler.jsonc`).
- `GET /api/health` answers 200 when the database and the file bucket both answer, and 503 when one does not. It needs no sign-in.
- Nothing watches either of these for you. Cloudflare's alert catalog has no ready-made alert for Worker errors (checked 2026-10-09 at <https://developers.cloudflare.com/notifications/notification-available/>). You need an outside check, and you need to look at the logs now and then.

## Is the app up

Point an outside monitor at `https://mail.<project domain>/api/health` and have it alert on any answer other than 200.

The body says which part failed:

| Answer | Meaning |
|---|---|
| 200 `{"ok":true,"db":"ok","storage":"ok"}` | The Worker runs, D1 answers and R2 answers. |
| 503 `{"ok":false,"db":"failed",...}` | D1 did not answer. The app cannot work and no mail can be stored. |
| 503 `{"ok":false,...,"storage":"failed"}` | R2 did not answer. Mail cannot be stored or opened. |
| Timeout, 5xx from Cloudflare, no answer | The Worker or the web address is down. |

The check costs one database statement and one bucket lookup. Polling every minute or every five minutes is fine. The detail of a failure goes to the logs (`health_failed`), never to the caller.

Requirements for the monitor: it fetches an HTTPS URL, it alerts on a status other than 200, it alerts by email or phone, and it polls at least every five minutes. Several uptime services meet these on a free plan; read the terms before relying on one.

Set the monitor up after the custom domain exists (`AGENTS.md`, section 4, step 7). Also check `/api/health` by hand once with `curl -s -o /dev/null -w '%{http_code}\n' https://mail.<project domain>/api/health`.

## Is inbound mail arriving

The health check cannot see inbound mail. Mail arrives through Cloudflare Email Routing, which calls the Worker directly. A broken routing rule, a full account limit or a bug in the inbound code all leave the health check green.

Two things catch it:

1. Once a week, send a message from an outside address (a personal account) to each mail domain's address and see that it arrives within a minute.
2. Look at the logs for `inbound_failed` (see below). If it appears, mail was refused or lost on its way in.

What a sending server sees when the inbound code fails is not yet known (audit gap G7). Until it is confirmed on a live zone, treat every `inbound_failed` line as possibly lost mail and ask the sender to resend.

## Read the logs

In the Cloudflare dashboard: Workers & Pages, the Worker (`mail-<name>`), Observability. Search for an event name from the table below. Workers Logs keeps 3 days on the free plan and 7 days on the paid plan, and logs every request unless sampling is lowered (<https://developers.cloudflare.com/workers/observability/logs/workers-logs/>). Our plan is paid (`decisions.md`), so 7 days. A failure is gone from the logs after a week, so look at least that often.

Live, from this machine:

```bash
cd apps/worker
pnpm exec wrangler tail --env <name> --format pretty --search inbound_failed
```

`wrangler tail` prints new log lines as they happen. The flags exist in the installed Wrangler (`wrangler tail --help`): `--search` filters by text in console messages, `--status error` shows only failed invocations, `--method`, `--ip` and `--header` filter requests, `--format json` is for piping into `jq`. Whether `--search` matches `console.error` lines has not been tried against a real deployment.

Request lines look like `GET /api/threads/:id 200 12ms`. They hold the route pattern, never the path or the query string, so tokens and search terms stay out of the logs.

## Log lines worth knowing

Each line below is written with `console.error`. The first column is the start of the line. The fields that follow hold ids and step names, never mail content, subjects or addresses.

Look at these first. They mean mail or data may be lost, or the app is failing.

| Line | Written in | Meaning | What to do |
|---|---|---|---|
| `inbound_failed` | `mail/receive.ts` | A delivery failed before the message was stored. The error is rethrown to Cloudflare. Fields: `step`, `mailboxId`, `messageIdHdr`, `error`. | Treat the mail as not received. Read `step` and `error`. Ask the sender to resend if it matters. |
| `inbound_post_store_failed` | `mail/receive.ts` | The message is stored, but a later step failed (`step` is `rule_actions` or `members`). Fields: `step`, `mailboxId`, `messageId`. | The mail is there. Look for a rule that did not apply, or a missing live update or alert. |
| `ingest_undo_failed` | `mail/ingest.ts` | A failed delivery could not clean up what it had written. Fields: `rawKey`, `blobs`, `threadId`. | Files in the bucket may be orphaned. Harmless but untidy. |
| `unhandled` | `api/index.ts` | A request ended in a 500. The user sees `internal_error`. | Read the error that follows. A cluster of these is an outage. |
| `health_failed` | `api/index.ts` | The health check could not reach `db` or `storage`. | See the health table above. Check Cloudflare's status page. |
| `cron step failed: <name>` | `cron.ts` | One of the minute-by-minute jobs threw. The other jobs still ran. Names: `scheduled-sends`, `reminders`, `expire-temp-mailboxes`, `purge-trash`, `purge-service-retention`, `purge-pending-mailboxes`, `delete-purged-users`, `prune-rate-limit-counters`, `prune-expired-sessions`, `prune-rule-send-log`, `prune-used-invites`, `sweep-orphan-blobs` (on the hour only), `dns-recheck`, `tracker-list`. | One line is a blip. The same name every minute is a broken job. |
| `scheduled send failed for draft <id> (attempt n/m)` | `cron.ts` | A scheduled message could not be sent. It is retried, and handed back to the author as a draft after the last attempt. | Tell the author if the last attempt fails. |
| `scheduled_send_cleanup_failed` | `cron.ts` | A scheduled message was sent, but its draft row (`step: "draft"`) or temporary files (`step: "blobs"`) could not be removed. | For `draft`, the message may be sent a second time when the draft's lease ends (about 10 minutes). Check the author's Drafts. |
| `rule_send_failed` | `mail/rule-sends.ts` | A rule that forwards or auto-replies could not send. Fields: `mailboxId`, `ruleId`, `error`. | A forward target is not receiving. Check the rule and the sending domain. |

Quieter lines. They point at one feature or a degraded extra:

| Line | Written in | Meaning |
|---|---|---|
| `inbound_deferred_failed` | `mail/receive.ts` | A best-effort step after delivery failed (`what` is `cancel_reminders`, `rule_sends`, `broadcast` or `push`). Mail is stored. |
| `inbound_pgp_failed` | `mail/receive.ts` | Decrypting mail for a PGP mailbox failed; the mail was stored as received. PGP is not in use. |
| `failed-send cleanup failed for message <id>` | `mail/send.ts` | A send failed, and the clean-up of its half-written rows failed too. |
| `notify.sendMail failed` | `mail/notify.ts` | An invite or reset message could not be sent. Check Email Sending and the transactional from-address. |
| `rate limit check failed for <key>` | `rate-limit.ts` | The limit counter could not be read. The request is let through, so the limit is off while this repeats. |
| `spamhaus dqs: ...` | `mail/dnsbl.ts` | The Spamhaus key is disabled or in use elsewhere. Spam scoring is weaker until fixed. |
| `server-side html sanitize failed`, `quote html sanitize failed` | `mail/sanitize.ts` | Cleaning a mail body failed. |
| `dns check failed for <domain>` | `cron.ts` | The SPF, DKIM and DMARC re-check for a domain failed. |
| `reminder dispatch failed for <id>` | `cron.ts` | A reminder was not delivered. |
| `orphan_sweep_truncated` | `mail/orphan-blobs.ts` | The hourly sweep listed its limit of keys under one prefix (`prefix`) and left the rest for the next hour. A bucket that grows past the limit is never swept to the end. |
| `tracker list fetch failed: <source>` | `mail/trackers.ts` | The tracker list could not be refreshed; the last list stays in use. |
| `hub broadcast failed`, `push rejected`, `push send failed`, `pushToUsers failed`, `notifyMailbox failed` | `hub.ts`, `mail/push.ts` | Live updates or browser notifications failed. Mail is unaffected. |
| `imap ...` | `imap/` | IMAP is not in use (`decisions.md`, D-7). |

To list the lines again after the code changes: `grep -rn 'console\.error' apps/worker/src`.

## A routine

- After the first real deployment: set up the outside monitor, send a test message in, and open the logs once to see the request lines.
- Weekly: send a message in from outside, and search the logs for `inbound_failed`, `unhandled` and `cron step failed`.
- After every deploy: open `/api/health` and check that it answers 200.
