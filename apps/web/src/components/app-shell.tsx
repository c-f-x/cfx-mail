import { useLocation, useParams } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ALL_MAILBOXES } from "@/lib/accounts.ts";
import { useMailtoLinks } from "@/lib/use-mailto-links.ts";
import { AppShortcuts } from "./app-shortcuts.tsx";
import { ComposeDock } from "./compose-dock.tsx";
import { Rail } from "./rail.tsx";
import { ShellContext } from "./shell-context.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Sheet, SheetContent } from "./ui/sheet.tsx";

const PAGE_TITLES: [RegExp, string][] = [
  [/^\/app\/settings/, "Settings"],
  [/^\/app\/admin/, "Accounts and admin"],
  [/^\/app\/search/, "Search"],
];

/**
 * The signed-in frame: the rail on the left (a drawer below 1280 px), the page
 * beside it, and the floating composer above everything.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useMailtoLinks();

  // The account in view. A folder, Search or Settings has no account in its
  // URL, so the last one stays current there: the rail keeps its views and a
  // new message keeps its sender.
  const { mailboxId } = useParams({ strict: false }) as { mailboxId?: string };
  const [scope, setScope] = useState(mailboxId ?? ALL_MAILBOXES);
  if (mailboxId && mailboxId !== scope) setScope(mailboxId);

  const mailRoute = /^\/app\/(m|folder)\//.test(pathname);
  const title = PAGE_TITLES.find(([re]) => re.test(pathname))?.[1] ?? "";
  const closeNav = () => setNavOpen(false);
  const shell = useMemo(() => ({ openNav: () => setNavOpen(true), scope }), [scope]);

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-dvh bg-background pt-[env(safe-area-inset-top)] text-foreground">
        <a
          href="#main"
          className="sr-only z-50 rounded-md border bg-card px-3 py-1.5 text-[13px] shadow-lg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to messages
        </a>
        <aside className="hidden w-64 shrink-0 border-sidebar-border border-r bg-sidebar text-sidebar-foreground xl:block">
          <Rail />
        </aside>
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" aria-label="Navigation" className="w-72 xl:hidden">
            <Rail onNavigate={closeNav} />
          </SheetContent>
        </Sheet>
        <main
          id="main"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
        >
          {!mailRoute && (
            <div className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-card px-1.5 xl:hidden">
              <IconButton icon={Menu} label="Open navigation" onClick={() => setNavOpen(true)} />
              <span className="truncate font-semibold text-[14px] tracking-tight">{title}</span>
            </div>
          )}
          <div className="min-h-0 flex-1">{children}</div>
        </main>
        <ComposeDock />
        <AppShortcuts />
      </div>
    </ShellContext.Provider>
  );
}
