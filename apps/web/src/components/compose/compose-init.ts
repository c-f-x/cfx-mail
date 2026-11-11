// How the composer fills itself when it opens: from a reopened draft, a reply,
// a forward, or a mailto: seed. Pure, so ComposeForm only holds the state.
import type { DraftRow, MessageRow } from "@/lib/queries.ts";
import type { RecipientsValue } from "../address-field.tsx";
import { type BodyFormat, prefixSubject, uniqueRecipients } from "./compose-utils.ts";

export type QuoteRef = { messageId: string; kind: "reply" | "forward" };

// Addresses that are "us" — excluded from reply-all recipients so we don't
// reply to ourselves. The reply mailbox's own address plus the envelope
// recipient the mail was delivered to.
export function selfAddresses(
  replyTo: MessageRow | null,
  mailboxes: { id: string; address?: string | null }[],
): Set<string> {
  const set = new Set<string>();
  const mbAddr = mailboxes.find((m) => m.id === replyTo?.mailboxId)?.address?.toLowerCase();
  if (mbAddr) set.add(mbAddr);
  if (replyTo?.deliveredTo) set.add(replyTo.deliveredTo.toLowerCase());
  return set;
}

export function initialRecipients({
  draft,
  replyTo,
  replyAll,
  initialTo,
  initialCc,
  initialBcc,
  self,
}: {
  draft: DraftRow | null | undefined;
  replyTo: MessageRow | null;
  replyAll?: boolean;
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  self: Set<string>;
}): { to: RecipientsValue; cc: RecipientsValue; bcc: RecipientsValue; showCc: boolean } {
  const to: RecipientsValue = (() => {
    if (draft) return { items: draft.toAddrs ?? [], input: "" };
    if (replyTo) {
      const items = uniqueRecipients(
        [
          { address: replyTo.fromAddr, name: replyTo.fromName ?? undefined },
          ...(replyAll ? (replyTo.toAddrs ?? []) : []),
        ],
        self,
      );
      return { items, input: "" };
    }
    if (initialTo?.length) return { items: initialTo.map((address) => ({ address })), input: "" };
    return { items: [], input: "" };
  })();
  const cc: RecipientsValue = (() => {
    if (draft) return { items: draft.ccAddrs ?? [], input: "" };
    if (replyTo && replyAll) {
      const exclude = new Set(self);
      for (const a of to.items) exclude.add(a.address.toLowerCase());
      return { items: uniqueRecipients(replyTo.ccAddrs ?? [], exclude), input: "" };
    }
    if (initialCc?.length) return { items: initialCc.map((address) => ({ address })), input: "" };
    return { items: [], input: "" };
  })();
  const bcc: RecipientsValue = {
    items: draft?.bccAddrs ?? initialBcc?.map((address) => ({ address })) ?? [],
    input: "",
  };
  return { to, cc, bcc, showCc: cc.items.length > 0 || bcc.items.length > 0 };
}

export function initialSubject({
  draft,
  replyTo,
  forward,
  seed,
}: {
  draft: DraftRow | null | undefined;
  replyTo: MessageRow | null;
  forward: MessageRow | null;
  seed?: string;
}): string {
  if (draft) return draft.subject;
  if (replyTo) return prefixSubject(replyTo.subject, "Re");
  if (forward) return prefixSubject(forward.subject, "Fwd");
  return seed ?? "";
}

// Body editor format. Default is a plain-text email; it only becomes an HTML
// mail once rich formatting is actually used (or markdown is rendered).
// A seeded body (a mailto: link) opens in plain text so it lands in the text
// buffer regardless of the user's default editor.
export function initialFormat({
  draft,
  seedBody,
  defaultMode,
}: {
  draft: DraftRow | null | undefined;
  seedBody?: string;
  defaultMode?: BodyFormat;
}): BodyFormat {
  return draft?.format ?? (seedBody ? "text" : (defaultMode ?? "text"));
}

// `text` holds the plain/markdown source; `html` holds the rich-mode body.
export function initialBody(
  draft: DraftRow | null | undefined,
  format: BodyFormat,
  seedBody?: string,
): { text: string; html: string } {
  return {
    text: draft && format !== "html" ? draft.body : (seedBody ?? ""),
    html: draft && format === "html" ? draft.body : "",
  };
}

// Threading context: a reopened draft carries it; a fresh reply derives it
// from the message being answered.
export function threading(
  draft: DraftRow | null | undefined,
  replyTo: MessageRow | null,
): { inReplyTo: string | undefined; references: string[] | undefined } {
  return {
    inReplyTo: draft?.inReplyTo ?? replyTo?.messageIdHdr ?? undefined,
    references:
      draft?.references ??
      (replyTo
        ? [...(replyTo.references ?? []), replyTo.messageIdHdr].filter((x): x is string =>
            Boolean(x),
          )
        : undefined),
  };
}

// The original message to quote. Works for a live reply/forward and for a
// reopened draft that persisted its quote.
export function quoteRefOf(
  replyTo: MessageRow | null,
  forward: MessageRow | null,
  draft: DraftRow | null | undefined,
): QuoteRef | null {
  if (replyTo) return { messageId: replyTo.id, kind: "reply" };
  if (forward) return { messageId: forward.id, kind: "forward" };
  if (draft?.quoteMessageId && draft.quoteKind)
    return { messageId: draft.quoteMessageId, kind: draft.quoteKind };
  return null;
}

export function composeTitle({
  replyTo,
  replyAll,
  forward,
  quote,
}: {
  replyTo: MessageRow | null;
  replyAll?: boolean;
  forward: MessageRow | null;
  quote: QuoteRef | null;
}): string {
  if (replyTo) return replyAll ? "Reply all" : "Reply";
  if (forward) return "Forward";
  if (quote?.kind === "reply") return "Reply";
  if (quote?.kind === "forward") return "Forward";
  return "New message";
}
