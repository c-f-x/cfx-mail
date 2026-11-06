import { Flag, hasFlag } from "@cfx-mail/shared/flags";

// Which messages of a conversation open expanded, and which fold away.

interface FoldableMessage {
  id: string;
  direction: "in" | "out";
  flags: number;
}

export interface InitialOpen {
  /** The messages on screen when the conversation opened. */
  ids: Set<string>;
  /** The ones that open expanded. */
  open: Set<string>;
  /** Where the conversation opens: the first expanded message. */
  focus: string | undefined;
}

// A linked message (a search hit) opens alone. Otherwise every unread message
// opens, and the newest one always does.
export function initialOpen(messages: FoldableMessage[], focusId?: string): InitialOpen {
  const target = focusId ? messages.find((m) => m.id === focusId) : undefined;
  const open = target
    ? [target]
    : messages.filter(
        (m, i) =>
          i === messages.length - 1 || (m.direction === "in" && !hasFlag(m.flags, Flag.SEEN)),
      );
  return {
    ids: new Set(messages.map((m) => m.id)),
    open: new Set(open.map((m) => m.id)),
    focus: open[0]?.id,
  };
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
