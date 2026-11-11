import type { DB } from "@cfmail/db";
import { appPassword, mailbox, mailboxMember } from "@cfmail/db/schema";
import { and, eq } from "drizzle-orm";

// Give a mailbox a new owner. The owner holds every right without a member
// row, so the new owner's own member row goes. The previous owner's app
// passwords for the mailbox go too: they unlocked it as its owner, and that
// access has ended.
export async function handOverMailbox(
  db: DB,
  mailboxId: string,
  previousOwnerId: string,
  newOwnerId: string,
): Promise<void> {
  await db.batch([
    db.update(mailbox).set({ ownerUserId: newOwnerId }).where(eq(mailbox.id, mailboxId)),
    db
      .delete(mailboxMember)
      .where(and(eq(mailboxMember.mailboxId, mailboxId), eq(mailboxMember.userId, newOwnerId))),
    db
      .delete(appPassword)
      .where(and(eq(appPassword.mailboxId, mailboxId), eq(appPassword.userId, previousOwnerId))),
  ]);
}
