import type { DB } from "@cfx-mail/db";
import { mailbox } from "@cfx-mail/db/schema";
import { and, eq } from "drizzle-orm";
import { mailboxNotDeletePending } from "./permissions.ts";

// Flag a mailbox for background purge. The cron's purgePendingMailboxes drains
// its threads (and their blobs) in bounded batches, then finalizes: "empty"
// clears the flag, "delete" drops the mailbox row. Every mailbox deletion goes
// through this — a synchronous cascade-delete of a large mailbox exceeds D1's
// per-statement limits and loads every blob key into memory. A delete-pending
// mailbox reads as gone immediately (mailboxNotDeletePending / resolveAccess).
// "delete" is terminal: it drops the row out of the address index, so letting an
// "empty" flip it back could collide with a mailbox re-created at that address.
// The request time is recorded because an "empty" mailbox keeps receiving: the
// drain removes only what was there when the purge was asked for.
export async function markMailboxPurge(
  db: DB,
  mailboxId: string,
  mode: "empty" | "delete",
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(mailbox)
    .set({ pendingPurge: mode, purgeStartedAt: now })
    .where(and(eq(mailbox.id, mailboxId), mailboxNotDeletePending));
}
