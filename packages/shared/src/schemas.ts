import {
  BLOCK_ENTRY_TYPES,
  EDITOR_FORMATS,
  MAILBOX_TYPES,
  MESSAGE_DIRECTIONS,
  PGP_MODES,
  QUOTE_KINDS,
  RULE_CONDITION_MODES,
  RULE_FIELDS,
  RULE_OPS,
  SERVICE_MODES,
  SPAM_FILTER_LEVELS,
  USER_ROLES,
} from "@cfmail/db/enums";
import { z } from "zod";

// Enum validators derive from the shared tuples in @cfmail/db/enums, so the
// Zod input contracts can never drift from the DB columns.
export const MailboxType = z.enum(MAILBOX_TYPES);
export type MailboxType = z.infer<typeof MailboxType>;

export const MessageDirection = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof MessageDirection>;

// No "+" — it is reserved for plus/sub-addressing, which routes to the base
// mailbox (see mail/receive.ts). Allowing it in a real local part would shadow
// every "<base>+anything@" alias of an existing mailbox.
const localPart = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i, "invalid local part");

const domainName = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, "invalid domain");

const emailAddress = z.email().max(320);

export const addressObject = z.object({
  name: z.string().max(200).optional(),
  address: emailAddress,
});

// RFC 5322 msg-id shape (<id-left@id-right>). The angle-bracket + no-whitespace
// form blocks CRLF/header injection: these flow verbatim into In-Reply-To /
// References on the real outbound (env.EMAIL.send) and into the archived .eml,
// where mimetext writes custom headers without sanitizing.
const messageId = z
  .string()
  .max(998)
  .regex(/^<[^\s<>]+@[^\s<>]+>$/, "invalid Message-ID");

// References / In-Reply-To are msg-id *lists*. RFC 5322 separates the ids with
// whitespace, but plenty of clients emit "<a>,<b>" and the obsolete syntax
// allows a leading phrase, so pull the bracketed ids out instead of splitting
// on a separator. Anything that isn't a well-formed msg-id is dropped: a chain
// is an advisory threading hint, and a peer's junk header must not fail a send.
export function splitMessageIds(header: string): string[] {
  return header.match(/<[^\s<>]+@[^\s<>]+>/g) ?? [];
}

// Clients build a reply's chain from the parent's stored `references`, which
// can still hold an unsplit header in one entry; flatten before validating.
const referencesList = z
  .preprocess(
    (v) =>
      Array.isArray(v) ? v.flatMap((e) => (typeof e === "string" ? splitMessageIds(e) : e)) : v,
    z.array(messageId).max(100),
  )
  .optional();

// Attachment filename: mimetext interpolates this unescaped into the quoted
// Content-Disposition fil="…", so reject control chars, quotes and backslash.
const attachmentFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) => !Array.from(s).some((c) => c.charCodeAt(0) < 0x20 || c === '"' || c === "\\"),
    "invalid filename",
  );

const allowedKinds = z.number().int().min(0).max(15); // 4 bits

export const createDomain = z.object({
  name: domainName,
  allowedKinds: allowedKinds.default(0),
});

export const updateDomain = z.object({
  allowedKinds: allowedKinds.optional(),
});

export const upsertDomainGrant = z.object({
  userId: z.string().min(1),
  allowedKinds,
});

export const createUserInvite = z.object({
  email: emailAddress,
  role: z.enum(USER_ROLES).default("user"),
});

export const adminCreateUser = z.object({
  email: emailAddress,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  role: z.enum(USER_ROLES).default("user"),
});

export const adminUpdateUser = z.object({
  role: z.enum(USER_ROLES).optional(),
  banned: z.boolean().optional(),
});

export const acceptInvite = z.object({
  token: z.string().min(8),
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

export const bootstrapAdmin = z.object({
  email: emailAddress,
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  // The operator's SETUP_TOKEN Worker secret; proves who is doing first-run setup.
  setupToken: z.string().min(1).max(500),
});

export const setAuthFromAddress = z.object({
  address: emailAddress,
});

// IMAP endpoint shown to users next to their app passwords. The host is the
// Spectrum application's hostname; empty clears it.
export const setImapSettings = z.object({
  host: z.union([z.literal(""), domainName]),
  port: z.number().int().min(1).max(65535).default(993),
});

export const createAppPassword = z.object({
  mailboxId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
});

export const updateThread = z.object({
  trashed: z.boolean().optional(),
  spam: z.boolean().optional(),
  read: z.boolean().optional(),
});

export const MAIL_VIEWS = ["inbox", "drafts", "sent", "marked", "spam", "trash", "all"] as const;

// Bulk "mark all as read" over one list view of a mailbox (or the combined
// "all" mailbox). Scoped like the thread list so only what the user is looking
// at flips — spam stays unread when the inbox is cleared.
export const markAllRead = z.object({
  mailboxId: z.string().min(1),
  view: z.enum(MAIL_VIEWS).default("inbox"),
});

// ─── Reminders ──────────────────────────────────────────────────────────────

// `remindAt` is epoch ms, bounded to the future and within a year so a typo
// can't park a reminder indefinitely (mirrors scheduleDraft's bounds).
const MAX_REMIND_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const remindAt = z
  .number()
  .int()
  .refine((ms) => ms > Date.now(), "must be in the future")
  .refine((ms) => ms < Date.now() + MAX_REMIND_AHEAD_MS, "too far in the future");

export const createReminder = z.object({
  mailboxId: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  remindAt,
  note: z.string().max(500).optional(),
});

export const updateReminder = z.object({
  remindAt: remindAt.optional(),
  note: z.string().max(500).nullish(),
  // The bell dismisses a fired reminder by setting it done.
  status: z.enum(["done"]).optional(),
});

// Bare Content-ID token (no angle brackets) for an inline image referenced from
// the HTML body as `cid:<token>`. The server wraps it in <…> for the MIME
// header; the charset is restricted so it can't inject header syntax.
const contentId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._@+-]+$/, "invalid content id");

const draftAttachment = z.object({
  r2Key: z.string().min(1),
  filename: attachmentFilename,
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().min(0),
  // Inline (embedded in the HTML body via cid:) vs a regular attachment.
  inline: z.boolean().optional(),
  contentId: contentId.optional(),
});

// Reference to an original message to quote in a reply/forward. The server
// resolves the quoted body from the raw `.eml` at send time (mail/quote.ts).
export const messageQuoteRef = z.object({
  messageId: z.string().min(1),
  kind: z.enum(QUOTE_KINDS),
});

export const createDraft = z.object({
  mailboxId: z.string().min(1),
  fromAddress: emailAddress.optional(),
  to: z.array(addressObject).max(100).default([]),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).default(""),
  body: z.string().max(5_000_000).default(""),
  markdown: z.boolean().default(false),
  format: z.enum(EDITOR_FORMATS).default("text"),
  inReplyTo: messageId.optional(),
  references: referencesList,
  quote: messageQuoteRef.nullish(),
  attachments: z.array(draftAttachment).max(20).default([]),
});

export const updateDraft = z.object({
  fromAddress: emailAddress.nullish(),
  to: z.array(addressObject).max(100).optional(),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(5_000_000).optional(),
  markdown: z.boolean().optional(),
  format: z.enum(EDITOR_FORMATS).optional(),
  inReplyTo: messageId.optional(),
  references: referencesList,
  quote: messageQuoteRef.nullish(),
  attachments: z.array(draftAttachment).max(20).optional(),
});

const labelColor = z.string().regex(/^#[0-9a-f]{6}$/i, "expected hex color (#rrggbb)");

export const createLabel = z.object({
  mailboxId: z.string().min(1),
  name: z.string().min(1).max(64),
  color: labelColor.optional(),
});

export const updateLabel = z.object({
  name: z.string().min(1).max(64).optional(),
  color: labelColor.optional(),
});

// ─── Custom folders ─────────────────────────────────────────────────────────

export const createFolder = z.object({
  name: z.string().min(1).max(64),
  color: labelColor.optional(),
});

export const updateFolder = z.object({
  name: z.string().min(1).max(64).optional(),
  color: labelColor.optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export const fileThreads = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(200),
});

// ─── Inbound rules / filters ────────────────────────────────────────────────

export type {
  RuleActionType,
  RuleConditionMode,
  RuleField,
  RuleOp,
} from "@cfmail/db/enums";
// Re-export the rule enum tuples + types so the web UI can build pickers without
// importing @cfmail/db directly.
export {
  RULE_ACTION_TYPES,
  RULE_CONDITION_MODES,
  RULE_FIELDS,
  RULE_OPS,
} from "@cfmail/db/enums";

// A regex condition's pattern, compiled the way inbound evaluation
// (mail/rules.ts) compiles it: case-insensitive. Null when it does not compile.
export function compileRuleRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

const ruleCondition = z
  .object({
    field: z.enum(RULE_FIELDS),
    op: z.enum(RULE_OPS),
    // Capped to keep regex/wildcard compilation on the inbound hot path bounded.
    value: z.string().min(1).max(512),
  })
  // A pattern that does not compile would save and then never match.
  .refine((c) => c.op !== "regex" || compileRuleRegex(c.value) !== null, {
    message: "not a valid regular expression",
    path: ["value"],
  });

// Actions are a discriminated union on `type`. applyLabel/moveFolder carry a
// target id; forward carries an external address; autoReply carries the canned
// body (+ optional subject). Order is preserved (hardBlock/stopProcessing
// short-circuit eval).
const ruleAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("applyLabel"), labelId: z.string().min(1) }),
  z.object({ type: z.literal("moveFolder"), folderId: z.string().min(1) }),
  z.object({ type: z.literal("markRead") }),
  z.object({ type: z.literal("markSpam") }),
  z.object({ type: z.literal("forward"), to: z.string().email().max(254) }),
  z.object({
    type: z.literal("autoReply"),
    subject: z.string().max(255).optional(),
    body: z.string().min(1).max(5000),
  }),
  z.object({ type: z.literal("hardBlock") }),
  z.object({ type: z.literal("stopProcessing") }),
]);

export const createRule = z.object({
  mailboxId: z.string().min(1),
  name: z.string().min(1).max(100),
  conditions: z.array(ruleCondition).min(1).max(20),
  conditionMode: z.enum(RULE_CONDITION_MODES).default("all"),
  actions: z.array(ruleAction).min(1).max(10),
  priority: z.number().int().min(0).max(100_000).optional(),
  enabled: z.boolean().optional(),
});

export const updateRule = z.object({
  name: z.string().min(1).max(100).optional(),
  conditions: z.array(ruleCondition).min(1).max(20).optional(),
  conditionMode: z.enum(RULE_CONDITION_MODES).optional(),
  actions: z.array(ruleAction).min(1).max(10).optional(),
  priority: z.number().int().min(0).max(100_000).optional(),
  enabled: z.boolean().optional(),
});

export const cloneRule = z.object({
  // Target mailbox for the copy; defaults to the source mailbox when omitted.
  mailboxId: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
});

// A mailbox's sender name, shown on its outgoing mail. Trimmed; an empty one
// means no name. The one rule for every route that sets it.
const senderName = z
  .string()
  .max(200)
  .transform((v) => v.trim() || null);

// How long a temp mailbox lives: an hour unless asked otherwise, at most 7
// days. The one rule for every route that creates temp mailboxes.
export const TEMP_TTL_DEFAULT_SECONDS = 3600;
const tempTtlSeconds = z
  .number()
  .int()
  .min(60)
  .max(60 * 60 * 24 * 7);

export const createMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  displayName: senderName.optional(),
  type: MailboxType,
  signature: z.string().max(5000).optional(),
  replyTo: emailAddress.optional(),
  // Only for a temp mailbox; other kinds never expire.
  ttlSeconds: tempTtlSeconds.optional(),
});

export const ServiceMode = z.enum(SERVICE_MODES);
export type ServiceMode = z.infer<typeof ServiceMode>;

// Admin: create a key-driven service mailbox. No owner/members — access is the
// API key alone. `duplex` accepts inbound (poll via API); `send` is send-only.
export const createServiceMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  displayName: senderName.optional(),
  mode: ServiceMode.default("duplex"),
});

// Admin: edit a service mailbox's identity / direction.
export const updateServiceMailbox = z.object({
  displayName: senderName.nullable().optional(),
  mode: ServiceMode.optional(),
});

// Admin: create a mailbox owned by an arbitrary user.
export const adminCreateMailbox = z.object({
  domainId: z.string().min(1),
  localPart,
  ownerUserId: z.string().min(1),
  type: MailboxType,
  displayName: senderName.optional(),
});

// Admin: delete a user. The mailboxes named here go with them; every other
// mailbox they own is handed to the admin who deletes them.
export const deleteUser = z.object({
  deleteMailboxIds: z.array(z.string().min(1)).max(1000).default([]),
});

// Admin: hand a mailbox to a different owner and/or switch it between the
// personal and group types. At least one change must be supplied.
export const migrateMailbox = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    type: z.enum(["personal", "group"]).optional(),
  })
  .refine((v) => v.ownerUserId !== undefined || v.type !== undefined, {
    message: "nothing to change",
  });

// Admin: delete a mailbox, optionally leaving a redirect at its old address.
export const adminDeleteMailbox = z.object({
  redirectToMailboxId: z.string().min(1).optional(),
});

// Admin: standalone redirect creation. "*" is the domain catch-all, which
// receives any address with no matching mailbox or specific redirect.
const redirectLocalPart = z.union([localPart, z.literal("*")]);

export const createRedirect = z.object({
  domainId: z.string().min(1),
  localPart: redirectLocalPart,
  targetMailboxId: z.string().min(1),
});

// Admin: re-point an existing redirect at a different target mailbox.
export const updateRedirect = z.object({
  targetMailboxId: z.string().min(1),
});

// ─── Manual blocklist ───────────────────────────────────────────────────────

export const BlockEntryType = z.enum(BLOCK_ENTRY_TYPES);
export type BlockEntryType = z.infer<typeof BlockEntryType>;

// Admin: add a blocklist entry. The value must parse as an email (type=email)
// or a bare domain (type=domain); the server additionally refuses domain entries
// for protected providers (gmail, outlook, …).
export const createBlockEntry = z
  .object({
    type: BlockEntryType,
    value: z.string().trim().min(1).max(320),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.type === "email"
        ? emailAddress.safeParse(v.value).success
        : domainName.safeParse(v.value).success,
    { message: "value must be a valid email or domain", path: ["value"] },
  );

// GET /api/threads/:id/bodies: the messages whose bodies to render, as one
// comma-separated parameter. The cap bounds the work of one request; the web
// app splits a longer conversation into several requests.
export const MAX_BODIES_PER_REQUEST = 50;
export const threadBodiesQuery = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(",").map((id) => id.trim()))].filter(Boolean))
    .pipe(z.array(z.string().max(100)).min(1).max(MAX_BODIES_PER_REQUEST)),
});

// A reader requesting a sender be blocked. The sender identity comes from the
// message (server-side); only an optional note is supplied.
export const createBlockRequest = z.object({
  note: z.string().max(500).optional(),
});

// Admin: replace the protected-domains whitelist.
export const setProtectedDomains = z.object({
  domains: z.array(domainName).max(500),
});

// Admin: the Spamhaus DQS query key used for IP and domain reputation lookups.
// Empty clears it, which turns every lookup off.
export const setDqsKey = z.object({
  key: z.union([
    z.literal(""),
    z
      .string()
      .trim()
      .regex(/^[a-z0-9]{8,64}$/i),
  ]),
});

// Any reader: check which of a set of recipient addresses are blocked, to warn
// before composing/sending. Loose strings so partial/odd input never 400s.
export const checkBlockRecipients = z.object({
  addresses: z.array(z.string().max(320)).max(200),
});

export const spamFilterLevel = z.enum(SPAM_FILTER_LEVELS);
export type SpamFilterLevel = z.infer<typeof spamFilterLevel>;

export const pgpMode = z.enum(PGP_MODES);
export type PgpMode = z.infer<typeof pgpMode>;

export const updateMailboxSettings = z.object({
  displayName: senderName.nullable().optional(),
  signature: z.string().max(5000).nullable().optional(),
  replyTo: z
    .union([emailAddress, z.literal("")])
    .nullable()
    .optional(),
  spamFilter: spamFilterLevel.optional(),
  pgpMode: pgpMode.optional(),
  pgpAutoFetch: z.boolean().optional(),
  excludeFromAll: z.boolean().optional(),
});

// Import an existing armored PGP private key for a mailbox. Bounded so a giant
// blob can't bloat a request.
export const importPgpKey = z.object({
  privateKey: z.string().min(1).max(200_000),
  passphrase: z.string().max(1000).optional(),
});

// Add a correspondent public key. `email` is optional — if omitted the first
// address in the key's user IDs is used.
export const addContactKey = z.object({
  publicKey: z.string().min(1).max(200_000),
  email: emailAddress.optional(),
});

// Toggle a stored contact key's verified flag (owner confirmed the fingerprint).
export const verifyContactKey = z.object({ verified: z.boolean() });

export const grantMember = z.object({
  mailboxId: z.string().min(1),
  userId: z.string().min(1),
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  manage: z.boolean().default(false),
});

export const sendMessage = z.object({
  mailboxId: z.string().min(1),
  // Optional sender override. Must be the mailbox's own address or a plus-alias
  // of it (same base local part + domain); enforced server-side in mail/send.ts.
  fromAddress: emailAddress.optional(),
  to: z.array(addressObject).min(1).max(100),
  cc: z.array(addressObject).max(100).optional(),
  bcc: z.array(addressObject).max(100).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(5_000_000).optional(),
  inReplyTo: messageId.optional(),
  references: referencesList,
  // Reply/forward: the original message to quote below the composed body. The
  // server fetches its raw `.eml` and appends a formatted quote at send time.
  quote: messageQuoteRef.optional(),
  attachments: z
    .array(
      z.object({
        r2Key: z.string().min(1),
        filename: attachmentFilename,
        contentType: z.string().min(1).max(127),
        // Inline image embedded in the HTML body via `cid:<contentId>`.
        inline: z.boolean().optional(),
        contentId: contentId.optional(),
      }),
    )
    .max(20)
    .optional(),
  // Follow-up reminder: when set, a "remind me if no reply" reminder is created
  // for the sender, due `followUpDays` from now, auto-cancelled if a reply lands.
  followUpDays: z.number().int().min(1).max(30).optional(),
});
export type SendMessageInput = z.infer<typeof sendMessage>;

// Defer a draft's send. `sendAt` is epoch ms; bounded to the future and within a
// year so a typo can't park mail indefinitely. `payload` is the same resolved
// body a normal send posts — the cron replays it verbatim at the chosen time.
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
export const scheduleDraft = z.object({
  sendAt: z
    .number()
    .int()
    .refine((ms) => ms > Date.now() + 30_000, "must be at least a minute in the future")
    .refine((ms) => ms < Date.now() + MAX_SCHEDULE_AHEAD_MS, "too far in the future"),
  payload: sendMessage,
});

// The headers a project may add to a service send: one-click unsubscribe
// (RFC 2369, RFC 8058), which Gmail and Yahoo require of bulk senders. Names
// are matched case-insensitively and come out canonical. The values reach the
// outbound headers and the archived .eml verbatim, so they are held to printable
// ASCII with no CR or LF. The rules and the 2,048 limit are Cloudflare Email
// Sending's own for these headers, checked here so the caller gets a 400.
const LIST_UNSUBSCRIBE = "List-Unsubscribe";
const LIST_UNSUBSCRIBE_POST = "List-Unsubscribe-Post";
const ONE_CLICK = "List-Unsubscribe=One-Click";
const HEADER_VALUE_MAX = 2_048;
type ServiceHeaderName = typeof LIST_UNSUBSCRIBE | typeof LIST_UNSUBSCRIBE_POST;
const SERVICE_HEADER_NAMES = new Map<string, ServiceHeaderName>([
  [LIST_UNSUBSCRIBE.toLowerCase(), LIST_UNSUBSCRIBE],
  [LIST_UNSUBSCRIBE_POST.toLowerCase(), LIST_UNSUBSCRIBE_POST],
]);
// One or two <uri> entries separated by a comma. A uri is printable ASCII
// without space, "<" or ">".
const unsubscribeEntries = /^<([!-;=?-~]+)>(?: *, *<([!-;=?-~]+)>)?$/;

// An https URL is a host name (no user info, no IP literal), an optional port,
// then an optional path, query or fragment.
const httpsUri =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?(?:[/?#].*)?$/i;
const mailtoUri = /^mailto:[^@?]+@[^@?.]+(?:\.[^@?.]+)+(?:\?.*)?$/i;

function unsubscribeUriKind(uri: string): "https" | "mailto" | null {
  if (httpsUri.test(uri)) return "https";
  if (mailtoUri.test(uri)) return "mailto";
  return null;
}

const serviceHeaders = z.record(z.string(), z.string()).transform((given, ctx) => {
  const out: Partial<Record<ServiceHeaderName, string>> = {};
  for (const [name, value] of Object.entries(given)) {
    const canonical = SERVICE_HEADER_NAMES.get(name.toLowerCase());
    if (!canonical) {
      ctx.addIssue({
        code: "custom",
        message: "Only List-Unsubscribe and List-Unsubscribe-Post may be set as headers.",
      });
      return z.NEVER;
    }
    if (out[canonical] !== undefined) {
      ctx.addIssue({ code: "custom", message: `${canonical} may be given only once.` });
      return z.NEVER;
    }
    if (/[\r\n]/.test(value)) {
      ctx.addIssue({ code: "custom", message: "A header value must not contain a line break." });
      return z.NEVER;
    }
    out[canonical] = value;
  }

  const list = out[LIST_UNSUBSCRIBE];
  let hasHttps = false;
  if (list !== undefined) {
    const m = list.length <= HEADER_VALUE_MAX ? unsubscribeEntries.exec(list) : null;
    const kinds = m ? [m[1], m[2]].filter((u) => u !== undefined).map(unsubscribeUriKind) : [];
    if (!m || kinds.includes(null)) {
      ctx.addIssue({
        code: "custom",
        message: `List-Unsubscribe must be one or two <https://…> or <mailto:…> entries, separated by a comma, in at most ${HEADER_VALUE_MAX} characters.`,
      });
      return z.NEVER;
    }
    hasHttps = kinds.includes("https");
  }

  const post = out[LIST_UNSUBSCRIBE_POST];
  if (post !== undefined) {
    if (post !== ONE_CLICK) {
      ctx.addIssue({
        code: "custom",
        message: `List-Unsubscribe-Post must be exactly ${ONE_CLICK}.`,
      });
      return z.NEVER;
    }
    if (!hasHttps) {
      ctx.addIssue({
        code: "custom",
        message: "List-Unsubscribe-Post needs a List-Unsubscribe with an https address.",
      });
      return z.NEVER;
    }
  }
  return out;
});

// Key-authed send from a service mailbox — the mailbox is resolved from the
// bearer key; attachments (pre-uploaded R2 keys) and reply/forward quoting
// (resolved from a stored message the key holder can't reference) are omitted.
export const serviceSend = sendMessage
  .omit({
    mailboxId: true,
    attachments: true,
    quote: true,
  })
  .extend({ headers: serviceHeaders.optional() });
export type ServiceSendHeaders = NonNullable<z.infer<typeof serviceSend>["headers"]>;

export const createTempMailbox = z.object({
  domainId: z.string().min(1),
  displayName: senderName.optional(),
  ttlSeconds: tempTtlSeconds.default(TEMP_TTL_DEFAULT_SECONDS),
});

// ─── Advanced search ────────────────────────────────────────────────────────

export const SearchIn = z.enum(["all", "subject", "from", "body"]);
export type SearchIn = z.infer<typeof SearchIn>;

// "any" excludes Trash + Spam (Gmail-like); the rest map to folder state.
export const SearchFolder = z.enum(["any", "inbox", "sent", "marked", "spam", "trash"]);
export type SearchFolder = z.infer<typeof SearchFolder>;

// "relevance" (bm25) only applies to text searches; metadata-only queries fall
// back to newest.
export const SearchSort = z.enum(["newest", "oldest", "relevance"]);
export type SearchSort = z.infer<typeof SearchSort>;

// Query params arrive as strings; coerce/normalize them here so the worker and
// the web client agree on the exact filter contract.
const boolParam = z.preprocess(
  (v) => (v === undefined || v === "" ? undefined : v === "true" || v === "1"),
  z.boolean().optional(),
);
const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .optional();
const textParam = z.string().trim().max(200).optional();

export const searchFilters = z.object({
  q: z.string().trim().max(500).optional().default(""),
  searchIn: SearchIn.optional().default("all"),
  from: textParam,
  to: textParam,
  subject: textParam,
  exclude: textParam,
  after: dateParam,
  before: dateParam,
  direction: MessageDirection.optional(),
  hasAttachment: boolParam,
  folder: SearchFolder.optional().default("any"),
  sort: SearchSort.optional().default("newest"),
  // Blank / "all" → every readable mailbox; a comma-separated list of ids → just those.
  mailboxId: z.string().trim().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  page: z.coerce.number().int().min(0).max(1000).optional().default(0),
});
export type SearchFilters = z.infer<typeof searchFilters>;
