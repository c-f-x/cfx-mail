import type { MailView } from "@cfx-mail/shared";
import { Flag, hasFlag } from "@cfx-mail/shared/flags";

// Which messages of a conversation open expanded, and which fold away.

interface FoldableMessage {
  id: string;
  direction: "in" | "out";
  flags: number;
  /** An out-of-office responder wrote it, not a person. */
  autoReply: boolean;
}

export interface InitialOpen {
  /** The messages on screen when the conversation opened. */
  ids: Set<string>;
  /** The ones that open expanded. */
  open: Set<string>;
  /** Where the conversation opens: the first expanded message. */
  focus: string | undefined;
}

// The message a conversation is "about" from the list it was opened in: from
// Sent, your latest message; from a received list, the latest one you
// received, so a conversation you replied to opens on their mail, not your
// reply. Lists that hold both (All, Marked, Trash) take the newest. An
// out-of-office reply is never what a conversation is about.
function anchorOf(messages: FoldableMessage[], view: MailView): FoldableMessage | undefined {
  const people = messages.filter((m) => !m.autoReply);
  const anchor =
    view === "sent"
      ? people.findLast((m) => m.direction === "out")
      : view === "inbox" || view === "spam"
        ? people.findLast((m) => m.direction === "in")
        : people.at(-1);
  return anchor ?? messages.at(-1);
}

// A linked message (a search hit) opens alone. Otherwise every unread message
// opens, and so does the anchor. Out-of-office replies stay folded unless they
// are all there is.
export function initialOpen(
  messages: FoldableMessage[],
  view: MailView,
  focusId?: string,
): InitialOpen {
  const target = focusId ? messages.find((m) => m.id === focusId) : undefined;
  const anchor = anchorOf(messages, view);
  const open = target
    ? [target]
    : messages.filter(
        (m) =>
          m === anchor || (m.direction === "in" && !m.autoReply && !hasFlag(m.flags, Flag.SEEN)),
      );
  return {
    ids: new Set(messages.map((m) => m.id)),
    open: new Set(open.map((m) => m.id)),
    focus: open[0]?.id,
  };
}

// Whether a message opens expanded, before the reader opens or folds it. Mail
// that arrives while the conversation is open opens expanded, unless an
// out-of-office responder wrote it.
export function opensExpanded(initial: InitialOpen, message: FoldableMessage): boolean {
  return initial.open.has(message.id) || (!initial.ids.has(message.id) && !message.autoReply);
}

// Folded rows between the first message and the one just before the first
// expanded message collapse further into one "N more messages" divider, once
// there are at least this many.
export const MIN_FOLD = 2;

// The indexes `from` (inclusive) to `to` (exclusive) hidden behind the divider,
// or null when nothing is. The first message and the one right before the
// first expanded message stay as context.
export function foldedRun(open: boolean[]): { from: number; to: number } | null {
  const firstOpen = open.indexOf(true);
  const to = (firstOpen === -1 ? open.length : firstOpen) - 1;
  return to - 1 >= MIN_FOLD ? { from: 1, to } : null;
}
