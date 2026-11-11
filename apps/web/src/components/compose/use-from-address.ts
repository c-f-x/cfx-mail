import { useState } from "react";
import { defaultFromMailboxId } from "@/lib/accounts.ts";
import type { DraftRow, MailboxSummary, MessageRow } from "@/lib/queries.ts";
import { plusBase } from "./compose-utils.ts";

interface Options {
  draft: DraftRow | null | undefined;
  replyTo: MessageRow | null;
  forward: MessageRow | null;
  sendable: MailboxSummary[];
  /** The account on screen when the composer opened ("all" or none in the unified view). */
  viewingMailboxId?: string;
}

// The composer's "From" identity: the sending mailbox plus an optional
// plus-alias override, including any custom "+tag" aliases typed in compose.
export function useFromAddress({
  draft: d,
  replyTo: rep,
  forward: fwd,
  sendable,
  viewingMailboxId,
}: Options) {
  // The account the user chose in the picker, if any. Until then the account
  // follows the rule in `defaultFromMailboxId`, so it is right even when the
  // account list arrives after the composer opened. The account on screen is
  // fixed at open: browsing elsewhere must not change who a half-written
  // message is from.
  const [picked, setMailboxId] = useState<string | null>(null);
  const [viewingAtOpen] = useState(viewingMailboxId);
  const mailboxId =
    picked ??
    defaultFromMailboxId({
      draftMailboxId: d?.mailboxId,
      replyMailboxId: rep?.mailboxId,
      forwardMailboxId: fwd?.mailboxId,
      viewingMailboxId: viewingAtOpen,
      accounts: sendable,
    });
  // Sender override: a plus-alias of the chosen mailbox, or null for its own
  // address. On reply, default to the sub-address the mail was delivered to
  // (hi+tag@) so the answer goes out from the same alias.
  const [fromAddress, setFromAddress] = useState<string | null>(() => {
    if (d) return d.fromAddress ?? null;
    const dt = rep?.deliveredTo;
    const mbAddr = sendable.find((m) => m.id === rep?.mailboxId)?.address;
    if (
      dt &&
      mbAddr &&
      dt.toLowerCase() !== mbAddr.toLowerCase() &&
      plusBase(dt) === mbAddr.toLowerCase()
    )
      return dt;
    return null;
  });
  const baseAddr = (id: string) => sendable.find((m) => m.id === id)?.address ?? "";
  // Custom plus-aliases the user typed in compose, so they stay selectable.
  const [customAliases, setCustomAliases] = useState<{ address: string; mailboxId: string }[]>(
    () => {
      if (d?.fromAddress && plusBase(d.fromAddress))
        return [{ address: d.fromAddress, mailboxId: d.mailboxId }];
      return [];
    },
  );
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusTag, setPlusTag] = useState("");
  // Selectable "From" addresses: each sendable mailbox, the plus-addressed
  // envelope recipient when replying to one, plus any custom alias the user added.
  const fromOptions = (() => {
    const opts = sendable.map((m) => ({ address: m.address, mailboxId: m.id }));
    const dt = rep?.deliveredTo;
    const mb = sendable.find((m) => m.id === rep?.mailboxId);
    if (
      dt &&
      mb &&
      plusBase(dt) === mb.address.toLowerCase() &&
      !opts.some((o) => o.address.toLowerCase() === dt.toLowerCase())
    )
      opts.push({ address: dt, mailboxId: mb.id });
    for (const c of customAliases)
      if (!opts.some((o) => o.address.toLowerCase() === c.address.toLowerCase())) opts.push(c);
    return opts;
  })();
  const currentFrom = fromAddress ?? baseAddr(mailboxId);
  // The composer fell back to the default sender because nothing pointed at an
  // account (a new message from All accounts, a folder or the mailto window).
  // The From row says so, so nobody sends from the wrong project by accident.
  const isDefaultSender =
    picked === null &&
    !d &&
    !rep &&
    !fwd &&
    sendable.length > 1 &&
    !sendable.some((m) => m.id === viewingAtOpen);
  // Apply the "+tag" typed in the picker as a sub-address of the chosen mailbox.
  const applyPlusTag = () => {
    const base = baseAddr(mailboxId);
    const at = base.lastIndexOf("@");
    if (at <= 0) return;
    const tag = plusTag.trim().replace(/^\++/, "").replace(/\s+/g, "");
    const addr = tag ? `${base.slice(0, at)}+${tag}@${base.slice(at + 1)}` : base;
    if (tag)
      setCustomAliases((prev) =>
        prev.some((c) => c.address.toLowerCase() === addr.toLowerCase())
          ? prev
          : [...prev, { address: addr, mailboxId }],
      );
    setFromAddress(tag ? addr : null);
    setPlusOpen(false);
    setPlusTag("");
  };

  return {
    mailboxId,
    setMailboxId,
    fromAddress,
    setFromAddress,
    baseAddr,
    fromOptions,
    currentFrom,
    isDefaultSender,
    account: sendable.find((m) => m.id === mailboxId),
    plusOpen,
    setPlusOpen,
    plusTag,
    setPlusTag,
    applyPlusTag,
  };
}

export type FromAddress = ReturnType<typeof useFromAddress>;
