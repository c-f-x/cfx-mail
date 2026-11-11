# Data model: what is kept, and for how long

The tables and their columns are described in `docs/architecture.md`, section 4, and defined in `packages/db/src/schema.ts`. This file says how long each store keeps what it holds, and what removes the rest.

Facts were read from the code on 2026-11-11. "The cron" is `apps/worker/src/cron.ts`, which runs every minute. A "cascade" is a foreign key with `onDelete: cascade` in the schema, so the row goes when its parent goes.

## Lifetimes

`scripts/lifetimes.test.mjs` fails when a binding or a table the migrations leave standing has no row here, when a row names no store, or when a cell is empty.

| Store | Holds | Lifetime | Removed by |
|---|---|---|---|
| `DB` | every table below | as long as the deployment runs | deleting the D1 database by hand |
| `BLOBS` | raw mail, attachments, uploads and avatars (prefixes below) | as long as the deployment runs | deleting the bucket by hand |
| `UserHub` | nothing: open live-update streams, in memory only | none | nothing |
| `account` | one sign-in credential of a user | while its user exists | user cascade, when the cron's `deletePurgedUsers` drops the user |
| `app_password` | one IMAP password (IMAP is off) | until revoked | the app-passwords route, member removal, owner handover, user ban or delete; user and mailbox cascade |
| `attachment` | one attachment of a message | while its message exists | message cascade |
| `block_request` | a user's request to block a sender | forever, also after review | an admin's delete; user cascade. Nothing removes reviewed requests (see below) |
| `blocklist` | a sender blocked for the whole deployment | until an admin removes it | an admin's delete |
| `contact_key` | a correspondent's public key (PGP is off) | until deleted | the contacts route; mailbox cascade |
| `domain` | one mail domain | until an admin deletes it | an admin's delete, refused while a mailbox is on it |
| `domain_grant` | which mailbox kinds a user may create on a domain | until an admin removes it | an admin's delete; domain and user cascade |
| `draft` | an unsent message, or a scheduled send | until sent or deleted | the user's delete; the cron after a scheduled send; mailbox and user cascade. A scheduled send that fails becomes a plain draft and stays |
| `folder` | a user's folder | until the user deletes it | the folders route; user cascade |
| `imap_folder` | an IMAP folder's numbering (IMAP is off) | while its user, mailbox and folder exist | cascade from each |
| `imap_uid` | a message's number in an IMAP folder (IMAP is off) | while the message is in the folder | IMAP expunge; message and folder cascade |
| `label` | a mailbox's label | until deleted | the labels route; mailbox cascade |
| `mailbox` | one address | personal, group and service: until deleted; temporary: until it expires | the cron's `expireTempMailboxes` marks expired ones, a delete marks the rest, and `purgePendingMailboxes` drops them with their mail |
| `mailbox_member` | one person's access to a mailbox | until removed | a manager's removal, owner handover; mailbox and user cascade |
| `mailbox_notify` | a person's notification level for a mailbox | until set to none | the push route; mailbox and user cascade |
| `message` | one stored email, with the one-time code found in it at delivery | while its thread exists | thread cascade; deleting one message from Trash or Spam |
| `message_fts` | the search index, one row per message | while its message exists | the `message_fts_ad` trigger on every message delete |
| `message_label` | a label on a message | until removed | the labels route; message and label cascade |
| `passkey` | one passkey | until removed | Better Auth's passkey routes; user cascade |
| `push_subscription` | one browser's push endpoint | until the browser unsubscribes or the endpoint is gone | the push route; a 404 or 410 from the push service; user cascade |
| `rate_limit` | Better Auth's sign-in rate counters | until the next window starts for the same key | Better Auth itself |
| `rate_limit_counter` | the app's own rate counters | one day after the window ends | the cron's `pruneRateLimitCounters` |
| `redirect` | an inbound alias or catch-all | until an admin removes it | an admin's delete; domain and target mailbox cascade |
| `reminder` | a reminder or follow-up | forever, also after it fires | the user's delete; user, mailbox and thread cascade. Nothing removes fired or cancelled ones (see below) |
| `rule` | a mailbox rule | until deleted | the rules route; mailbox and user cascade |
| `rule_send_log` | one forward or auto-reply a rule sent, to cap the rate | 4 days, the longest window read (`RULE_SEND_LOG_KEEP_MS` in `mail/rule-sends.ts`) | the cron's `pruneRuleSendLog`; a failed send's own row at once; mailbox and rule cascade |
| `session` | one signed-in browser, 30 days, renewed daily | until it expires, or the user is banned, deleted or resets the password | the cron's `pruneExpiredSessions` within a minute of expiry; Better Auth on presenting an expired session; the users routes; user cascade |
| `system_config` | the deployment's settings and generated keys, one row each | forever | nothing; settings are replaced, never removed |
| `thread` | one conversation | Inbox and other folders: until deleted; Trash: 30 days; service mailboxes: 30 days after the newest message; Spam: until deleted | the cron's `purgeStaleTrash` and `purgeStaleServiceThreads`; the user's delete from Trash or Spam; mailbox purge |
| `thread_folder` | a conversation filed in a folder | until unfiled | the folders route; user, thread and folder cascade |
| `two_factor` | a user's two-factor secret | while two-factor is on | user cascade |
| `user` | one person | until an admin deletes them | the users route marks them, and the cron's `deletePurgedUsers` drops them once they own no mailbox |
| `user_invite` | one invitation, valid for 7 days | used: until its 7 days end; unused: until an admin revokes it, also after expiry | the cron's `pruneUsedInvites`; an admin's delete; inviter cascade. Nothing removes expired unused invites (see below) |
| `verification` | a password-reset or sign-in token | until used or expired | Better Auth, on use, and on the next lookup after it expires |

## R2 prefixes

Every key is built in `apps/worker/src/mail/blob-keys.ts`. Mail and attachments are deleted before the rows that point at them, because R2 has no cascade (`collectThreadBlobKeys` and `deleteBlobs` in `apps/worker/src/mail/blobs.ts`).

| Prefix | Holds | Removed by |
|---|---|---|
| `raw/<mailbox>/` | received mail and sent copies, as `.eml` | its message's removal, through `deleteBlobs` |
| `plain/<mailbox>/` | decrypted copies (PGP is off) | its message's removal |
| `att/<message>/` | attachments | its message's removal |
| `draft/<user>/` | uploads from the composer | deleting its draft, or the cron after a scheduled send. The cron's hourly `sweepOrphanBlobs` removes an upload no draft refers to once it is 7 days old (`ORPHAN_GRACE_MS` in `mail/orphan-blobs.ts`) |
| `avatar/<user>/` | the picture a user shows, and for up to 7 days any upload it did not keep | the cron's hourly `sweepOrphanBlobs` removes a picture no user's `image` points at once it is 7 days old: a replaced picture, an upload never saved, a deleted user's |

There is no lifecycle rule on the bucket.

## Grows without limit

These stores keep rows that nothing removes. Each is small per row, but the count only goes up. Tracked in issue #2.

- `thread` in Spam: never aged out, unlike Trash.
- `draft`: abandoned drafts, and scheduled sends that failed.
- `reminder`: fired, done and cancelled reminders.
- `user_invite`: expired invites that were never used. The admin still sees them in the invite list.
- `block_request`: reviewed requests.

Mail itself is kept until someone deletes it. That is the product's purpose, not a gap.
