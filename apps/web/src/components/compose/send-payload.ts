// What the composer saves as a draft and what it sends. Pure: the form hands
// in its state, already collected.
import type { Recipient, RecipientsValue } from "../address-field.tsx";
import type { QuoteRef } from "./compose-init.ts";
import type { BodyFormat, UploadedAttachment } from "./compose-utils.ts";
import type { DraftSnapshot } from "./use-draft-persistence.ts";

// The form state as a draft snapshot, and whether it is effectively blank.
// `composedText` is the body as plain text, whatever the editor.
export function draftSnapshot(f: {
  fromAddress: string | null;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  mode: BodyFormat;
  text: string;
  html: string;
  composedText: string;
  attachments: UploadedAttachment[];
}): { snap: DraftSnapshot; isEmpty: boolean } {
  const snap: DraftSnapshot = {
    fromAddress: f.fromAddress,
    to: f.to,
    cc: f.cc,
    bcc: f.bcc,
    subject: f.subject,
    body: f.mode === "html" ? f.html : f.text,
    format: f.mode,
    attachments: f.attachments,
  };
  const isEmpty =
    !f.to.length &&
    !f.cc.length &&
    !f.bcc.length &&
    !f.subject &&
    !f.composedText.trim() &&
    f.attachments.length === 0;
  return { snap, isEmpty };
}

// Drop inline images whose <img> was removed from the body; they're dead
// weight that would arrive as orphaned, never-rendered attachments.
export function outboundAttachments(
  attachments: UploadedAttachment[],
  usedCids: Set<string>,
): UploadedAttachment[] {
  return attachments.filter((a) => !a.inline || (a.contentId ? usedCids.has(a.contentId) : false));
}

// The full outbound payload — identical whether the send fires now or later.
export function sendPayload(f: {
  mailboxId: string;
  fromAddress: string | null;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  body: { text: string | undefined; html: string | undefined };
  inReplyTo: string | undefined;
  references: string[] | undefined;
  quote: QuoteRef | null;
  attachments: UploadedAttachment[];
  followUpDays: number | undefined;
}) {
  return {
    mailboxId: f.mailboxId,
    fromAddress: f.fromAddress ?? undefined,
    to: f.to,
    cc: f.cc.length ? f.cc : undefined,
    bcc: f.bcc.length ? f.bcc : undefined,
    subject: f.subject,
    text: f.body.text,
    html: f.body.html,
    inReplyTo: f.inReplyTo,
    references: f.references,
    quote: f.quote ?? undefined,
    attachments: f.attachments.length
      ? f.attachments.map((a) => ({
          r2Key: a.r2Key,
          filename: a.filename,
          contentType: a.contentType,
          ...(a.inline ? { inline: true, contentId: a.contentId } : {}),
        }))
      : undefined,
    followUpDays: f.followUpDays,
  };
}

// Why a scheduled send cannot go at `when`, or null when it can.
export function scheduleProblem(when: Date, now: number): string | null {
  if (Number.isNaN(when.getTime())) return "Pick a valid date and time";
  if (when.getTime() < now + 60_000) return "Pick a time at least a minute from now";
  return null;
}

// The committed recipient addresses (not the in-progress input), once each and
// lowercased, for the blocklist check.
export function recipientAddresses(...fields: RecipientsValue[]): string[] {
  const all = fields.flatMap((f) => f.items).map((a) => a.address.trim().toLowerCase());
  return [...new Set(all)].filter((a) => a.includes("@"));
}
