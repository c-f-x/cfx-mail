import { createContext, useContext } from "react";
import { ALL_MAILBOXES } from "@/lib/accounts.ts";

// What the app shell knows that deeper parts need: how to open the navigation
// drawer on narrow screens, and which account the user is in. The account
// stays put while the user visits a folder, Search or Settings, so the rail and
// the composer still know it there.
export interface Shell {
  openNav: () => void;
  /** An account id, or "all" for All accounts. */
  scope: string;
}

export const ShellContext = createContext<Shell>({ openNav: () => {}, scope: ALL_MAILBOXES });

export function useShell(): Shell {
  return useContext(ShellContext);
}
