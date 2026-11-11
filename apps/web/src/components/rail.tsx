import type { MailView } from "@cfx-mail/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { PenSquare } from "lucide-react";
import { RAIL_VIEWS, railCount } from "@/lib/accounts.ts";
import { cn } from "@/lib/cn.ts";
import { folderCountsQuery, listSearch, mailboxesQuery, parseMailView } from "@/lib/queries.ts";
import { AccountSwitcher } from "./account-switcher.tsx";
import { openCompose } from "./compose-dock.tsx";
import { FoldersNav } from "./folders-nav.tsx";
import { railRowActiveClass, railRowClass, VIEW_META } from "./mail-views.ts";
import { NotificationBell } from "./notification-bell.tsx";
import { useShell } from "./shell-context.tsx";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { StreamStatusIndicator, UserMenu } from "./user-menu.tsx";

/**
 * The left rail: account switcher, Compose, the views of the current account,
 * the user's folders, and the person's own menu with reminders at the foot.
 * The same rail sits in the drawer on narrow screens; `onNavigate` closes it.
 */
export function Rail({ onNavigate }: { onNavigate?: () => void }) {
  const { scope } = useShell();
  const params = useParams({ strict: false }) as { mailboxId?: string };
  const search = useSearch({ strict: false }) as { view?: unknown; unread?: unknown };
  const onList = Boolean(params.mailboxId);
  const activeView: MailView | null = onList ? parseMailView(search.view) : null;
  const unread = onList && search.unread === true;
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const hasAccounts = (mailboxes?.mailboxes.length ?? 0) > 0;
  const { data: counts } = useQuery({ ...folderCountsQuery(scope), enabled: hasAccounts });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center border-sidebar-border border-b px-2">
        <AccountSwitcher onNavigate={onNavigate} />
      </div>
      <div className="px-3 pt-3 pb-1">
        <Button
          variant="primary"
          className="h-9 w-full justify-start gap-2.5 rounded-lg px-3"
          disabled={!hasAccounts}
          onClick={() => {
            openCompose();
            onNavigate?.();
          }}
        >
          <PenSquare /> Compose
          <Kbd className="ml-auto hidden h-5 min-w-5 border-primary-foreground/30 bg-transparent px-1 text-[10px] text-primary-foreground/80 xl:inline-flex">
            c
          </Kbd>
        </Button>
      </div>
      <nav aria-label="Views and folders" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {hasAccounts && (
          <ul className="flex flex-col gap-px">
            {RAIL_VIEWS.map((view) => {
              if (!view) return <li key="gap" aria-hidden className="h-2" />;
              const meta = VIEW_META[view];
              const count = railCount(view, counts?.counts);
              const active = activeView === view;
              return (
                <li key={view}>
                  <Link
                    to="/app/m/$mailboxId"
                    params={{ mailboxId: scope }}
                    search={listSearch(view, unread)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(railRowClass, active && railRowActiveClass)}
                  >
                    <meta.icon />
                    <span className="truncate">{meta.label}</span>
                    {count && (
                      <span
                        className={cn(
                          "ml-auto text-[11px] tabular-nums",
                          count.kind === "unread"
                            ? "font-semibold text-foreground"
                            : "font-normal text-muted-foreground",
                        )}
                      >
                        {count.value}
                        {count.kind === "unread" && <span className="sr-only"> unread</span>}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <FoldersNav onClose={onNavigate} />
      </nav>
      <div className="flex shrink-0 items-center gap-1 border-sidebar-border border-t px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <UserMenu onNavigate={onNavigate} />
        <StreamStatusIndicator />
        <NotificationBell />
      </div>
    </div>
  );
}
