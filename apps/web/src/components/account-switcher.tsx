import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Lock, Mails, Search, SlidersHorizontal, Timer } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  ALL_ACCOUNTS_LABEL,
  ALL_MAILBOXES,
  accountInitial,
  accountName,
  accountTags,
  allAccountsUnread,
  switcherModel,
} from "@/lib/accounts.ts";
import { cn } from "@/lib/cn.ts";
import { noMailboxCopy } from "@/lib/mailbox-empty.ts";
import { type MailboxSummary, mailboxesQuery, meQuery, parseMailView } from "@/lib/queries.ts";
import { formatRemaining, useNow } from "@/lib/time.ts";
import { NewTempMailboxDialog, useTempDomains } from "./new-temp-mailbox.tsx";
import { useShell } from "./shell-context.tsx";
import { Badge } from "./ui/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

/** The account's mark: the first letter of its domain, or the stack for All accounts. */
export function AccountTile({
  account,
  className,
}: {
  account: MailboxSummary | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md border bg-card font-semibold text-[12px] text-foreground",
        className,
      )}
    >
      {account ? accountInitial(account) : <Mails className="size-3.5" />}
    </span>
  );
}

/**
 * Top of the rail: which account you are in, and the list to switch to another
 * one or to All accounts. It also leads to managing accounts and, where a
 * domain allows it, to a new temporary account.
 */
export function AccountSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { scope } = useShell();
  const { data } = useQuery(mailboxesQuery);
  const { data: me } = useQuery(meQuery);
  const accounts = data?.mailboxes ?? [];
  const tempDomains = useTempDomains();
  useNow(60_000);

  // Switching account keeps the view (Sent stays Sent); from a folder or a
  // settings page it lands in the Inbox.
  const params = useParams({ strict: false }) as { mailboxId?: string };
  const search = useSearch({ strict: false }) as { view?: unknown };
  const view = params.mailboxId ? parseMailView(search.view) : "inbox";

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [tempOpen, setTempOpen] = useState(false);
  const model = switcherModel(accounts, filter);

  const single = accounts.length === 1 ? accounts[0] : undefined;
  const current = accounts.find((a) => a.id === scope) ?? single ?? null;
  const total = allAccountsUnread(accounts);

  function done() {
    setOpen(false);
    setFilter("");
    onNavigate?.();
  }

  const name = current
    ? accountName(current)
    : accounts.length === 0
      ? "No accounts"
      : ALL_ACCOUNTS_LABEL;
  const detail = current
    ? current.address
    : accounts.length === 0
      ? noMailboxCopy(me?.user?.role).short
      : `${accounts.length} accounts, one inbox`;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFilter("");
        }}
      >
        <PopoverTrigger
          className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/45 data-popup-open:bg-sidebar-accent"
          aria-label={`Account: ${current ? current.address : name}. Switch account`}
        >
          <AccountTile account={current} />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate font-semibold text-[13px] tracking-tight">{name}</span>
            <span
              className={cn(
                "truncate text-[11px] text-muted-foreground",
                current && "font-mono tracking-normal",
              )}
            >
              {detail}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="flex w-[21rem] max-w-[calc(100vw-1rem)] flex-col p-1"
          aria-label="Accounts"
        >
          {model.showFilter && (
            <label className="mx-0.5 mt-0.5 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-md border bg-muted/60 px-2.5 text-muted-foreground focus-within:border-ring focus-within:bg-card">
              <Search className="size-3.5 shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Find an account"
                aria-label="Find an account"
                className="w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}
          <nav aria-label="Accounts" className="min-h-0 overflow-y-auto">
            {model.showAllAccounts && (
              <>
                <AccountRow
                  to={ALL_MAILBOXES}
                  view={view}
                  active={scope === ALL_MAILBOXES}
                  onPick={done}
                  tile={<AccountTile account={null} />}
                  name={ALL_ACCOUNTS_LABEL}
                  detail="One inbox for every account"
                  unread={total}
                />
                <div className="-mx-1 my-1 h-px bg-border" />
              </>
            )}
            {model.groups.map((g) => (
              <div key={g.domain ?? "accounts"}>
                {g.domain && (
                  <div className="px-2 pt-2 pb-1 font-mono text-[11px] text-muted-foreground">
                    {g.domain}
                  </div>
                )}
                {g.accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    to={a.id}
                    view={view}
                    active={current?.id === a.id && scope !== ALL_MAILBOXES}
                    onPick={done}
                    tile={<AccountTile account={a} />}
                    name={accountName(a)}
                    tags={<Tags account={a} />}
                    detail={a.address}
                    mono
                    unread={a.unread}
                  />
                ))}
              </div>
            ))}
            {accounts.length > 0 && model.groups.length === 0 && (
              <p className="px-2 py-3 text-[12px] text-muted-foreground">No account matches.</p>
            )}
          </nav>
          <div className="-mx-1 my-1 h-px shrink-0 bg-border" />
          <Link
            to="/app/admin"
            search={{ tab: "mailboxes" }}
            onClick={done}
            className="flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-[13px] outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground"
          >
            <SlidersHorizontal /> Manage accounts
          </Link>
          {tempDomains.length > 0 && (
            <button
              type="button"
              onClick={() => {
                done();
                setTempOpen(true);
              }}
              className="flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground"
            >
              <Timer /> New temporary account
            </button>
          )}
        </PopoverContent>
      </Popover>
      <NewTempMailboxDialog open={tempOpen} onOpenChange={setTempOpen} />
    </>
  );
}

function AccountRow({
  to,
  view,
  active,
  onPick,
  tile,
  name,
  tags,
  detail,
  mono,
  unread,
}: {
  to: string;
  view: ReturnType<typeof parseMailView>;
  active: boolean;
  onPick: () => void;
  tile: ReactNode;
  name: string;
  tags?: ReactNode;
  detail: string;
  mono?: boolean;
  unread: number;
}) {
  return (
    <Link
      to="/app/m/$mailboxId"
      params={{ mailboxId: to }}
      search={{ view }}
      onClick={onPick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
        active && "bg-primary/10 hover:bg-primary/10",
      )}
    >
      {tile}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn("truncate text-[13px]", unread > 0 ? "font-semibold" : "font-medium")}
          >
            {name}
          </span>
          {tags}
        </span>
        <span
          className={cn(
            "mt-0.5 truncate text-[11px] text-muted-foreground",
            mono && "font-mono tracking-normal",
          )}
        >
          {detail}
        </span>
      </span>
      {unread > 0 && (
        <span className="shrink-0 font-semibold text-[11px] tabular-nums">
          {unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
      <span className="grid w-4 shrink-0 place-items-center">
        {active && <Check className="size-4 text-primary" aria-hidden />}
      </span>
    </Link>
  );
}

function Tags({ account }: { account: MailboxSummary }) {
  const tags = accountTags(account);
  const remaining = account.expiresAt ? formatRemaining(account.expiresAt) : null;
  return (
    <>
      {tags.includes("shared") && (
        <Badge variant="outline" className="h-4 shrink-0 rounded px-1 text-[10px]">
          Shared
        </Badge>
      )}
      {tags.includes("temporary") && (
        <Badge
          variant={remaining === "expired" ? "destructive" : "outline"}
          className="h-4 shrink-0 rounded px-1 text-[10px]"
          title={
            account.expiresAt
              ? `Expires ${new Date(account.expiresAt).toLocaleString()}`
              : undefined
          }
        >
          <Timer className="size-2.5" />
          {remaining ?? "Temporary"}
        </Badge>
      )}
      {tags.includes("read-only") && (
        <span
          className="shrink-0 text-muted-foreground"
          title="You can read this account but not send from it"
        >
          <Lock className="size-3" aria-hidden />
          <span className="sr-only">Read only</span>
        </span>
      )}
    </>
  );
}
