// Single source of truth for API *response* shapes. Input schemas live in
// `schemas.ts`; these describe what handlers return so the worker and the web
// app never redefine the same model twice.
//
// Raw-row responses derive straight from the Drizzle table types via type-only
// imports (erased from the browser bundle). The one twist: `c.json()` serializes
// `Date` columns to ISO strings over the wire, so `Serialized<T>` maps every
// `Date` field to `string`. The worker's serializers (api/serialize.ts) are
// typed to return these, so a schema change that breaks the shape is a compile
// error on both sides.

import type {
  ContactKeySource,
  MailboxType,
  MessageDirection,
  PgpMode,
  SpamFilterLevel,
  UserRole,
} from "@cfx-mail/db/enums";
import type {
  draft,
  folder,
  label,
  message,
  RuleAction,
  RuleCondition,
  reminder,
  rule,
  thread,
} from "@cfx-mail/db/schema";
import type { MAIL_VIEWS } from "./schemas.ts";

// Re-exported so the web app gets the rule JSON shapes without importing @cfx-mail/db.
export type { RuleAction, RuleCondition };

/** Map Drizzle `Date` columns to the `string` form `c.json()` actually sends. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : [T[K]] extends [Date | null] ? string | null : T[K];
};

// ─── Raw-row DTOs ───────────────────────────────────────────────────────────

// `subject` is the subject of the thread's first message as it was sent, the
// line to show. The stored `subjectNorm` is lowercased and stripped of "Re:",
// for matching replies.
export type ThreadDto = Serialized<Omit<typeof thread.$inferSelect, "listId">>;
// The stored correspondent key matching a message's sender, attached by the
// thread-detail route so the reader can show which key verified a signature and
// whether the owner has confirmed it out-of-band.
export interface MessagePgpKeyDto {
  fingerprint: string;
  source: ContactKeySource;
  verified: boolean;
}
// The reader's fields only. Stored plaintext (`bodyText`, `toText`), R2 keys, sizes and
// scores stay server-side: the body arrives from `/messages/:id/body`, and a long
// conversation would otherwise ship every message's text twice.
export type MessageDto = Pick<
  Serialized<typeof message.$inferSelect>,
  | "id"
  | "mailboxId"
  | "threadId"
  | "direction"
  | "messageIdHdr"
  | "references"
  | "fromName"
  | "fromAddr"
  | "deliveredTo"
  | "toAddrs"
  | "ccAddrs"
  | "bccAddrs"
  | "subject"
  | "snippet"
  | "flags"
  | "receivedAt"
  | "sentAt"
  | "spamVerdict"
  | "spamReasons"
  | "spamAuth"
  | "listUnsubscribe"
  | "autoReply"
  | "otpCode"
  | "otpOrigin"
  | "pgpEncrypted"
  | "pgpSigned"
  | "pgpVerify"
  | "pgpKeyEvent"
  | "createdAt"
> & {
  pgpKey?: MessagePgpKeyDto | null;
};
// The resolved outbound payload + attempt counter stay server-side — drafts only
// expose `scheduledFor` (pending) and `scheduledError` (terminal failure) so the
// UI can show/cancel/flag a scheduled send.
export type DraftDto = Omit<
  Serialized<typeof draft.$inferSelect>,
  "scheduledPayload" | "scheduledAttempts"
>;
export type LabelDto = typeof label.$inferSelect; // no date columns

export type ReminderDto = Serialized<typeof reminder.$inferSelect>;

/** An inbound rule; `conditions`/`actions` keep their typed JSON shape. */
export type RuleDto = Serialized<typeof rule.$inferSelect>;

/** A custom folder plus its live thread counts (total + unread). */
export type FolderDto = Serialized<typeof folder.$inferSelect> & {
  total: number;
  unread: number;
};

// ─── Computed / mapped DTOs ─────────────────────────────────────────────────

export interface MailboxSummaryDto {
  id: string;
  address: string;
  displayName: string | null;
  type: MailboxType;
  expiresAt: string | null;
  role: "owner" | "member";
  perms: number;
  unread: number;
  pgpMode: PgpMode;
  /** Opted out of the combined All Mail view (list, counts and sidebar badge). */
  excludeFromAll: boolean;
}

export interface SearchResultDto {
  messageId: string;
  threadId: string;
  mailboxId: string;
  mailboxAddress: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromAddr: string;
  direction: MessageDirection;
  flags: number;
  hasAttachments: boolean;
  receivedAt: string | null;
  sentAt: string | null;
}

export interface ContactDto {
  address: string;
  name?: string;
}

export interface MeUserDto {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: UserRole;
  twoFactorEnabled?: boolean;
  /** Raw JSON string of UserPrefs (see parseUserPrefs). */
  preferences?: string | null;
}

/** App-level, per-user preferences. Stored as a JSON string on the user row. */
export interface UserPrefs {
  // reading & display
  density?: "comfortable" | "compact";
  defaultView?: MailView;
  autoMarkRead?: boolean;
  // compose
  composeInNewWindow?: boolean;
  composeDefaultMode?: "text" | "markdown" | "html";
  sendShortcut?: boolean;
  replyAllDefault?: boolean;
  // date & time
  dateFormat?: DateFormat;
  timeFormat?: "12h" | "24h";
  // which maps service event/address links open in ("auto" picks by device)
  mapProvider?: "auto" | "google" | "apple";
  // reusable compose snippets, insertable at the caret from the composer
  templates?: EmailTemplate[];
}

/** A saved compose snippet. `body` may contain {{placeholder}} tokens. */
export interface EmailTemplate {
  id: string;
  name: string;
  // Optional subject — fills the compose subject only when it's still empty.
  subject?: string;
  body: string;
}

/**
 * Explicit date layouts (order + separator + numeric/named month + year width),
 * not country presets. Rendered by lib/time.ts. Examples assume 2026-06-24:
 *   dmy-dot   24.06.2026   dmy-dot-2   24.06.26
 *   dmy-slash 24/06/2026   dmy-slash-2 24/06/26
 *   mdy-slash 06/24/2026   mdy-slash-2 06/24/26
 *   iso       2026-06-24
 *   d-mon-y   24 Jun 2026  d-month-y   24 June 2026
 *   mon-d-y   Jun 24, 2026 month-d-y   June 24, 2026
 */
export type DateFormat =
  | "dmy-dot"
  | "dmy-dot-2"
  | "dmy-slash"
  | "dmy-slash-2"
  | "mdy-slash"
  | "mdy-slash-2"
  | "iso"
  | "d-mon-y"
  | "d-month-y"
  | "mon-d-y"
  | "month-d-y";

/** Parse the raw `preferences` JSON string into a typed object; never throws. */
export function parseUserPrefs(raw: string | null | undefined): UserPrefs {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as UserPrefs) : {};
  } catch {
    return {};
  }
}

export interface MessageLabelDto {
  id: string;
  name: string;
  color: string;
}

/** A stored attachment's metadata (bytes are fetched from the `/raw` route). */
export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Inline (cid) part embedded in the HTML body rather than a real attachment. */
  inline: boolean;
  contentId: string | null;
}

/** One participant of a calendar invite (organizer or attendee). */
export interface CalendarPersonDto {
  name: string | null;
  email: string | null;
  /** RFC 5545 PARTSTAT (NEEDS-ACTION/ACCEPTED/DECLINED/…); attendees only. */
  status: string | null;
}

/**
 * A calendar invite (RFC 5545 VEVENT) carried by a message, surfaced for the
 * event banner. `start`/`end` are strings `new Date()` can parse; `allDay`
 * means a date-only event. Display-only — we don't manage calendars.
 */
export interface CalendarEventDto {
  /** Calendar METHOD: REQUEST (invite), REPLY, CANCEL, PUBLISH, … */
  method: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  organizer: CalendarPersonDto | null;
  attendees: CalendarPersonDto[];
  /** Raw RRULE when the event recurs (presence ⇒ "Repeats"). */
  rrule: string | null;
  /** Video-conference join URL (Zoom/Meet/Teams/Jitsi/…) when one is found. */
  meetingUrl: string | null;
}

/** Full message body, parsed on demand from the raw `.eml` in R2. */
export interface MessageBodyDto {
  html: string | null;
  text: string | null;
  attachments: AttachmentDto[];
  /** Present when the message carries an iCalendar invite. */
  calendar?: CalendarEventDto | null;
  /** Tracking beacons stripped from `html` before it was served. */
  trackersBlocked: number;
}

/** Bodies of several messages of one thread, keyed by message id. A message
 * without a stored body is left out. */
export interface ThreadBodiesDto {
  bodies: Record<string, MessageBodyDto>;
}

/**
 * Outcome of a List-Unsubscribe action. `unsubscribed` = handled server-side (an
 * RFC 8058 one-click POST or a mailto request was sent). `open` = the only target
 * is an https page the client must open in a new tab (carries `url`).
 */
export interface UnsubscribeResultDto {
  status: "unsubscribed" | "open";
  method: "one-click" | "email" | "link";
  url?: string;
}

/**
 * Where an unsubscribe request would go, shown to the user before it is sent.
 * `email` = a mail to one address; `one-click` = a POST to `host`; `link` = an
 * https page on `host` the client opens.
 */
export type UnsubscribeTargetDto =
  | { method: "email"; address: string }
  | { method: "one-click" | "link"; host: string };

export type MailView = (typeof MAIL_VIEWS)[number];
export type FolderCountsDto = Record<MailView, { total: number; unread: number }>;

// ─── Response envelopes (used by handlers via `satisfies`) ──────────────────

export interface ThreadListDto {
  threads: ThreadDto[];
  /** Keyset cursor for the next (older) page, or null when the list is exhausted. */
  nextCursor?: string | null;
}
export interface FolderCountsResponseDto {
  counts: FolderCountsDto;
}
export interface MailboxListDto {
  /** Ordered by domain, then personal before group before temp, then address. */
  mailboxes: MailboxSummaryDto[];
}
export interface MailboxSettingsDto {
  id: string;
  type: MailboxType;
  displayName: string | null;
  signature: string | null;
  replyTo: string | null;
  spamFilter: SpamFilterLevel;
  // Gateway PGP. The private key/passphrase are never sent; `pgpConfigured` says
  // whether a keypair exists, and the armored public key is shareable.
  pgpMode: PgpMode;
  pgpFingerprint: string | null;
  pgpPublicKey: string | null;
  pgpConfigured: boolean;
  // Auto-discover correspondent keys via WKD (see schema). Toggle in settings.
  pgpAutoFetch: boolean;
  // Keep the mailbox out of the combined All Mail view (see schema).
  excludeFromAll: boolean;
}

export interface ContactKeyDto {
  id: string;
  email: string;
  fingerprint: string;
  source: ContactKeySource;
  verified: boolean;
  expiresAt: string | null;
  createdAt: string;
}
export interface ContactKeysDto {
  keys: ContactKeyDto[];
}
/** Returned once when a mailbox keypair is generated or imported. */
export interface PgpKeyResultDto {
  fingerprint: string;
  publicKey: string;
}
/** Result of trusting an inbound sender's key (from the message or via WKD). */
export interface TrustSenderDto {
  fingerprint: string;
  source: ContactKeySource;
  verify: "good" | "bad" | "unknown" | null;
}
export interface MailboxMemberDto {
  userId: string;
  perms: number;
  email: string;
  name: string;
}
export interface MailboxMembersDto {
  members: MailboxMemberDto[];
}
export interface LabelListDto {
  labels: LabelDto[];
}
export interface FolderListDto {
  folders: FolderDto[];
}
export interface RuleListDto {
  rules: RuleDto[];
}
export interface ReminderListDto {
  reminders: ReminderDto[];
}
/** Result of cloning a rule; `strippedLabels` names applyLabel targets that had
 * no counterpart in the destination mailbox and were dropped (cross-mailbox). */
export interface RuleCloneResultDto {
  id: string;
  strippedLabels: string[];
}
export interface MessageLabelsDto {
  labels: Record<string, MessageLabelDto[]>;
}
/** Distinct labels per thread id (aggregated across the thread's messages). */
export interface ThreadLabelsDto {
  labels: Record<string, MessageLabelDto[]>;
}
export interface SearchResultsDto {
  results: SearchResultDto[];
  hasMore: boolean;
}
export interface ContactsDto {
  contacts: ContactDto[];
}

// ─── IMAP / app passwords ───────────────────────────────────────────────────

export interface ImapConnectionDto {
  host: string;
  port: number;
}

export interface AppPasswordDto {
  id: string;
  name: string;
  mailboxId: string;
  mailboxAddress: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AppPasswordListDto {
  passwords: AppPasswordDto[];
  /** Null until an admin sets the IMAP hostname. */
  imap: ImapConnectionDto | null;
}

/** The plaintext is returned exactly once, at creation. */
export interface AppPasswordCreatedDto {
  id: string;
  password: string;
  username: string;
}
