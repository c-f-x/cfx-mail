import type { DB } from "@cfmail/db";
import { mailbox, mailboxMember } from "@cfmail/db/schema";
import { ALL_PERMS, has, Perm, type PermBit } from "@cfmail/shared/permissions";
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { AppError } from "./errors.ts";

// Reusable predicates over the mailbox purge marker (schema: pending_purge).
// `notPurging` excludes both empty- and delete-pending mailboxes (no live
// content to show); `notDeletePending` only hides mailboxes being hard-deleted
// (their address is considered freed) while empty-pending ones stay listed.
export const mailboxNotPurging = isNull(mailbox.pendingPurge);
export const mailboxNotDeletePending = or(
  isNull(mailbox.pendingPurge),
  ne(mailbox.pendingPurge, "delete"),
);

// Sentinel mailbox id for the combined "All" view. Real ids are UUIDs, so this
// can never collide. Used by the threads/drafts list endpoints to aggregate
// across every mailbox the user can read instead of a single one.
export const ALL_MAILBOXES = "all";

export interface MailboxAccess {
  mailboxId: string;
  userId: string;
  perms: number;
  isOwner: boolean;
  // Mailbox is being emptied in the background — it still resolves (the user can
  // open it) but its threads should read as already gone.
  purging: boolean;
}

export async function resolveAccess(
  db: DB,
  userId: string,
  mailboxId: string,
): Promise<MailboxAccess | null> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, mailboxId),
    columns: { id: true, ownerUserId: true, pendingPurge: true },
  });
  if (!mb) return null;
  // A hard-delete in progress: treat the mailbox as already gone.
  if (mb.pendingPurge === "delete") return null;
  const purging = mb.pendingPurge != null;
  if (mb.ownerUserId === userId) {
    return { mailboxId, userId, perms: ALL_PERMS, isOwner: true, purging };
  }
  const member = await db.query.mailboxMember.findFirst({
    where: and(eq(mailboxMember.mailboxId, mailboxId), eq(mailboxMember.userId, userId)),
    columns: { perms: true },
  });
  if (!member) return null;
  return { mailboxId, userId, perms: member.perms, isOwner: false, purging };
}

export interface MailboxGrant {
  mailboxId: string;
  perms: number;
  isOwner: boolean;
}

// Every non-service mailbox the user owns or is a member of, with the bits they
// hold: ALL_PERMS for the owner, the grant (possibly 0) for a member. Service
// mailboxes are key-driven and never user-facing. `where` narrows further.
async function mailboxGrants(db: DB, userId: string, where?: SQL): Promise<MailboxGrant[]> {
  const rows = await db
    .select({
      id: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      memberPerms: mailboxMember.perms,
    })
    .from(mailbox)
    .leftJoin(
      mailboxMember,
      and(eq(mailboxMember.mailboxId, mailbox.id), eq(mailboxMember.userId, userId)),
    )
    .where(
      and(
        or(eq(mailbox.ownerUserId, userId), eq(mailboxMember.userId, userId)),
        ne(mailbox.type, "service"),
        where,
      ),
    );
  return rows.map((r) => {
    const isOwner = r.ownerUserId === userId;
    return { mailboxId: r.id, perms: isOwner ? ALL_PERMS : (r.memberPerms ?? 0), isOwner };
  });
}

// The user's mailbox list: every mailbox they own or share, whatever bits they
// hold. One being emptied stays listed (it shows empty); one being deleted is
// already gone.
export function listedMailboxes(db: DB, userId: string): Promise<MailboxGrant[]> {
  return mailboxGrants(db, userId, mailboxNotDeletePending);
}

// Every non-service, non-purging mailbox the user can read (owned + member).
// Backs the combined views: All Mail, custom folders, search and contacts.
// `combinedView` additionally drops mailboxes opted out of All Mail — pass it
// for the All Mail list/counts, not for surfaces the user filed into by hand
// (custom folders), which stay complete. `perm` raises the bar from READ to a
// stronger bit for bulk mutations over the combined view (owners always pass).
export async function accessibleMailboxIds(
  db: DB,
  userId: string,
  opts?: { combinedView?: boolean; perm?: PermBit },
): Promise<string[]> {
  const grants = await mailboxGrants(
    db,
    userId,
    and(mailboxNotPurging, opts?.combinedView ? eq(mailbox.excludeFromAll, false) : undefined),
  );
  const bit = opts?.perm ?? Perm.READ;
  return grants.filter((g) => has(g.perms, bit)).map((g) => g.mailboxId);
}

export async function requirePerm(
  db: DB,
  userId: string,
  mailboxId: string,
  bit: PermBit,
): Promise<MailboxAccess> {
  const access = await resolveAccess(db, userId, mailboxId);
  if (!access || !has(access.perms, bit)) {
    throw new AppError("forbidden", "forbidden");
  }
  return access;
}

// Load a mailbox-scoped entity by id, 404 if missing, then enforce mailbox
// RBAC — the "lookup → 404 → requirePerm" shape that backed every mutating
// mailbox route. Funnelling it here keeps the permission choke-point
// (invariant 2) impossible to skip and 404 messages uniform. Returns the full
// row so callers don't re-fetch.
export async function requireEntityAccess<
  T extends SQLiteTable & { id: SQLiteColumn; mailboxId: SQLiteColumn },
>(db: DB, userId: string, table: T, id: string, bit: PermBit): Promise<T["$inferSelect"]> {
  const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
  const row = rows[0] as T["$inferSelect"] | undefined;
  if (!row) throw new AppError("not_found", "not found");
  await requirePerm(db, userId, (row as { mailboxId: string }).mailboxId, bit);
  return row;
}
