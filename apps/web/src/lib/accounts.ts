import type { FolderCountsDto, MailboxSummaryDto, MailView } from "@cfmail/shared";
import { has, Perm } from "@cfmail/shared/permissions";

// The rules of the account switcher and of everything that depends on "which
// account am I in": which address a new message is sent from, what a list row
// says about its account, where an action returns to, and which counts the rail
// shows. Pure, so they are tested without rendering anything.

type Account = MailboxSummaryDto;

/**
 * Sentinel id of the unified "All accounts" view. Mirrors the worker constant;
 * real ids are UUIDs so it never collides.
 */
export const ALL_MAILBOXES = "all";

export const ALL_ACCOUNTS_LABEL = "All accounts";

export function canSendFrom(account: Account): boolean {
  return has(account.perms, Perm.WRITE);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The name shown for an account: its display name, else the part before "@". */
export function accountName(account: Account): string {
  const name = account.displayName?.trim();
  if (name) return name;
  const at = account.address.lastIndexOf("@");
  return at > 0 ? account.address.slice(0, at) : account.address;
}

/** One letter for the account's tile: the domain's, since the domain is what differs. */
export function accountInitial(account: Account): string {
  return (domainOf(account.address)[0] ?? "?").toUpperCase();
}

// ─── Which address a message is sent from ───────────────────────────────────

export interface FromContext {
  /** Reopened draft: it was written from this account. */
  draftMailboxId?: string | null;
  /** Reply: the account the mail arrived in. */
  replyMailboxId?: string | null;
  /** Forward: the account the mail sits in. */
  forwardMailboxId?: string | null;
  /** The account on screen; "all", a folder or nothing when there is no single one. */
  viewingMailboxId?: string | null;
  /** Every account the user has, in the switcher's order. */
  accounts: Account[];
}

/**
 * The account a message is sent from when the composer opens.
 *
 * In order: the draft's account, the account the answered or forwarded mail is
 * in, the account on screen, and otherwise the default: the first personal
 * account in the switcher's order, or the first account of any kind. An account
 * the user cannot send from is never chosen. Returns "" when there is none.
 */
export function defaultFromMailboxId(ctx: FromContext): string {
  const sendable = ctx.accounts.filter(canSendFrom);
  const usable = (id: string | null | undefined) =>
    id && sendable.some((a) => a.id === id) ? id : undefined;
  return (
    usable(ctx.draftMailboxId) ??
    usable(ctx.replyMailboxId) ??
    usable(ctx.forwardMailboxId) ??
    usable(ctx.viewingMailboxId) ??
    sendable.find((a) => a.type === "personal")?.id ??
    sendable[0]?.id ??
    ""
  );
}

// ─── The switcher ───────────────────────────────────────────────────────────

export interface AccountGroup {
  /** Domain heading, or null when the list is short enough to go without. */
  domain: string | null;
  accounts: Account[];
}

export interface SwitcherModel {
  /** The unified entry; pointless with a single account. */
  showAllAccounts: boolean;
  /** A filter field, once the list is too long to scan. */
  showFilter: boolean;
  groups: AccountGroup[];
}

/** Above this many accounts on more than one domain, the list is grouped by domain. */
export const GROUP_ABOVE = 4;
/** Above this many accounts, the switcher gets a filter field. */
export const FILTER_ABOVE = 8;

/** The switcher's list. Keeps the server's order, which is by domain. */
export function switcherModel(accounts: Account[], filter = ""): SwitcherModel {
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? accounts.filter((a) => `${a.address} ${a.displayName ?? ""}`.toLowerCase().includes(needle))
    : accounts;
  const domains = [...new Set(accounts.map((a) => domainOf(a.address)))];
  const grouped = accounts.length > GROUP_ABOVE && domains.length > 1;
  const groups: AccountGroup[] = grouped
    ? domains
        .map((domain) => ({
          domain,
          accounts: shown.filter((a) => domainOf(a.address) === domain),
        }))
        .filter((g) => g.accounts.length > 0)
    : shown.length > 0
      ? [{ domain: null, accounts: shown }]
      : [];
  return {
    showAllAccounts: accounts.length > 1 && !needle,
    showFilter: accounts.length > FILTER_ABOVE,
    groups,
  };
}

export type AccountTag = "shared" | "temporary" | "read-only";

/** What a switcher row says about an account besides its name and address. */
export function accountTags(account: Account): AccountTag[] {
  const tags: AccountTag[] = [];
  if (account.type === "group") tags.push("shared");
  if (account.type === "temp") tags.push("temporary");
  if (!canSendFrom(account)) tags.push("read-only");
  return tags;
}

/** Unread across the unified view: accounts opted out of it do not count. */
export function allAccountsUnread(accounts: Account[]): number {
  return accounts.reduce((sum, a) => (a.excludeFromAll ? sum : sum + a.unread), 0);
}

// ─── Lists ──────────────────────────────────────────────────────────────────

/** What is on screen: one account, the unified view, or one of the user's folders. */
export type ListScope =
  | { kind: "mailbox"; mailboxId: string }
  | { kind: "folder"; folderId: string };

/**
 * The line a row carries to say which account a conversation is in. Only where
 * rows from several accounts mix (the unified view and folders); in a single
 * account every row would repeat the header.
 */
export function accountLine(
  scope: ListScope,
  threadMailboxId: string,
  accounts: Account[],
  view: MailView = "inbox",
): string | null {
  const mixed = scope.kind === "folder" || scope.mailboxId === ALL_MAILBOXES;
  if (!mixed) return null;
  const address = accounts.find((a) => a.id === threadMailboxId)?.address;
  if (!address) return null;
  return `${view === "sent" || view === "drafts" ? "from" : "to"} ${address}`;
}

export type ListTarget =
  | { to: "/app/m/$mailboxId"; params: { mailboxId: string } }
  | { to: "/app/folder/$folderId"; params: { folderId: string } };

/**
 * Where the reading pane goes after an action that removes the conversation
 * from the list (trash, spam, move, delete): back to the list the user came
 * from. In the unified view that is the unified view, never the conversation's
 * own account.
 */
export function listTarget(scope: ListScope): ListTarget {
  return scope.kind === "folder"
    ? { to: "/app/folder/$folderId", params: { folderId: scope.folderId } }
    : { to: "/app/m/$mailboxId", params: { mailboxId: scope.mailboxId } };
}

// ─── Rail ───────────────────────────────────────────────────────────────────

/** The views in the rail's order. A null is a gap between the two groups. */
export const RAIL_VIEWS: (MailView | null)[] = [
  "inbox",
  "marked",
  "sent",
  "drafts",
  null,
  "spam",
  "trash",
  "all",
];

export const VIEW_LABEL: Record<MailView, string> = {
  inbox: "Inbox",
  marked: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  spam: "Spam",
  trash: "Trash",
  all: "All mail",
};

export interface RailCount {
  value: number;
  /** "unread" is new mail to act on (bold); "total" is just how many there are. */
  kind: "unread" | "total";
}

/**
 * The number next to a view, or null for none. Inbox and Spam count unread
 * conversations, Drafts counts drafts. The other views have nothing to act on,
 * so they show nothing. Zero shows nothing.
 */
export function railCount(view: MailView, counts: FolderCountsDto | undefined): RailCount | null {
  if (!counts) return null;
  const c = counts[view];
  if (view === "inbox") return c.unread > 0 ? { value: c.unread, kind: "unread" } : null;
  if (view === "spam") return c.unread > 0 ? { value: c.unread, kind: "total" } : null;
  if (view === "drafts") return c.total > 0 ? { value: c.total, kind: "total" } : null;
  return null;
}

// ─── What a user is offered ─────────────────────────────────────────────────

export interface AccountOffers {
  /** The admin area: domains, users, every mailbox, service keys, blocking. */
  admin: boolean;
  /** The page listing the accounts this user owns or was given, from the switcher. */
  manageAccounts: boolean;
}

/** Only an admin is offered the admin area. Everyone can manage their own accounts. */
export function accountOffers(role: string | null | undefined): AccountOffers {
  return { admin: role === "admin", manageAccounts: true };
}
