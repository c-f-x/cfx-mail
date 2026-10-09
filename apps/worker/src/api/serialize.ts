import type { draft, message, reminder, thread } from "@cfx-mail/db/schema";
import type {
  DraftDto,
  MessageDto,
  MessagePgpKeyDto,
  ReminderDto,
  ThreadDto,
} from "@cfx-mail/shared";
import { sql } from "drizzle-orm";

// Map Drizzle rows (with real `Date` columns) to the wire shape `c.json()`
// emits. The return types are the canonical DTOs, so any schema change that
// breaks a response shape fails typecheck right here.

// The subject of a thread's first message, as a column of a query over
// `thread`. "First" is the order the thread route returns its messages in, so
// a list row and the reading pane's heading show the same line. Written out by
// hand: Drizzle leaves column names unqualified in a one-table query, and an
// unqualified `id` inside the subquery would name the message's id.
export const firstMessageSubject = sql<string | null>`(SELECT m.subject FROM message m
  WHERE m.thread_id = "thread"."id" ORDER BY m.created_at LIMIT 1)`;

export function serializeThread(r: typeof thread.$inferSelect, subject: string | null): ThreadDto {
  // The list id only steers threading on the server.
  const { listId: _listId, ...rest } = r;
  return {
    ...rest,
    subject: subject ?? "",
    lastMsgAt: rest.lastMsgAt.toISOString(),
    trashedAt: rest.trashedAt?.toISOString() ?? null,
  };
}

export function serializeMessage(
  r: typeof message.$inferSelect,
  pgpKey?: MessagePgpKeyDto | null,
): MessageDto {
  return {
    id: r.id,
    mailboxId: r.mailboxId,
    threadId: r.threadId,
    direction: r.direction,
    messageIdHdr: r.messageIdHdr,
    references: r.references,
    fromName: r.fromName,
    fromAddr: r.fromAddr,
    deliveredTo: r.deliveredTo,
    toAddrs: r.toAddrs,
    ccAddrs: r.ccAddrs,
    bccAddrs: r.bccAddrs,
    subject: r.subject,
    snippet: r.snippet,
    flags: r.flags,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    spamVerdict: r.spamVerdict,
    spamReasons: r.spamReasons,
    spamAuth: r.spamAuth,
    listUnsubscribe: r.listUnsubscribe,
    otpCode: r.otpCode,
    otpOrigin: r.otpOrigin,
    pgpEncrypted: r.pgpEncrypted,
    pgpSigned: r.pgpSigned,
    pgpVerify: r.pgpVerify,
    pgpKeyEvent: r.pgpKeyEvent,
    createdAt: r.createdAt.toISOString(),
    pgpKey: pgpKey ?? null,
  };
}

export function serializeReminder(r: typeof reminder.$inferSelect): ReminderDto {
  return {
    ...r,
    remindAt: r.remindAt.toISOString(),
    firedAt: r.firedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function serializeDraft(r: typeof draft.$inferSelect): DraftDto {
  const { scheduledPayload: _payload, scheduledAttempts: _attempts, ...rest } = r;
  return {
    ...rest,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
  };
}
