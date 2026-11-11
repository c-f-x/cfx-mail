import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ALL_MAILBOXES } from "@/lib/accounts.ts";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import { mailboxesQuery, type SearchResult, searchQuery } from "@/lib/queries.ts";
import { type DateTimeFmt, formatStamp } from "@/lib/time.ts";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";

const SEARCH_DEBOUNCE_MS = 200;
const MIN_SEARCH_CHARS = 2;

/**
 * The search field above the list. It searches the account on screen, or every
 * account in All accounts; the advanced search page takes over from Enter.
 * Its label stays "Search mail": the `/` shortcut finds it by that.
 */
export function SearchBox({ scope }: { scope: string }) {
  const nav = useNavigate();
  const fmt = useDateTimeFmt();
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = raw.trim();
    if (trimmed.length < MIN_SEARCH_CHARS) {
      setDebounced("");
      return;
    }
    const handle = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [raw]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const account =
    scope === ALL_MAILBOXES ? undefined : mailboxesData?.mailboxes.find((m) => m.id === scope);
  const { data, isLoading, isError, refetch } = useQuery(
    searchQuery({ q: debounced, mailboxId: account?.id }),
  );
  const results = data?.results ?? [];

  function go(result: SearchResult) {
    setOpen(false);
    setRaw("");
    inputRef.current?.blur();
    nav({
      to: "/app/m/$mailboxId/t/$threadId",
      // Stay in All accounts when searching from there.
      params: { mailboxId: account ? result.mailboxId : ALL_MAILBOXES, threadId: result.threadId },
      search: { view: "inbox" },
    });
  }

  function goToSearch() {
    const q = raw.trim();
    setOpen(false);
    inputRef.current?.blur();
    nav({
      to: "/app/search",
      search: { ...(q ? { q } : {}), ...(account ? { mailboxId: account.id } : {}) },
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[activeIdx];
      if (hit) go(hit);
      else goToSearch();
    }
  }

  const showDropdown = open && raw.trim().length >= MIN_SEARCH_CHARS;

  return (
    <div ref={rootRef} className="relative w-full">
      <label className="flex h-8 items-center gap-2 rounded-full border bg-muted/60 pr-1 pl-3 text-[13px] text-muted-foreground transition focus-within:border-ring focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/30">
        <Search className="h-3.5 w-3.5" />
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={account ? `Search ${account.address}` : "Search all accounts"}
          className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          aria-label="Search mail"
          aria-expanded={showDropdown}
          aria-controls="search-results"
          // plain text input is not a combobox by default; role is required to pair with aria-expanded/aria-controls for this custom search dropdown.
          role="combobox"
        />
        <Kbd className="hidden h-5 min-w-5 shrink-0 bg-card px-1 text-[10px] md:inline-flex">/</Kbd>
        <button
          type="button"
          onClick={goToSearch}
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label="Advanced search"
          title="Advanced search"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </label>

      {showDropdown && (
        <div className="absolute top-full right-0 left-0 z-40 mt-2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-black/10 shadow-lg">
          {isLoading && !data ? (
            <div className="p-3 text-[12px] text-muted-foreground">Searching…</div>
          ) : isError ? (
            <div className="flex items-center justify-between gap-2 p-3 text-[12px]">
              <span className="text-destructive">Search failed</span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-[12px] text-muted-foreground">No matches</div>
          ) : (
            <ul id="search-results" className="max-h-[60vh] overflow-y-auto p-1">
              {results.map((r, i) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left text-[13px]",
                      i === activeIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{r.fromName ?? r.fromAddr}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatWhen(r.receivedAt ?? r.sentAt, fmt)}
                      </span>
                    </div>
                    <div className="truncate text-[12px]">{r.subject || "(no subject)"}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-muted-foreground">
                        {r.snippet || r.fromAddr}
                      </span>
                      <span className="shrink-0 rounded border bg-muted px-1 text-[10px] text-muted-foreground">
                        {r.mailboxAddress}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={goToSearch}
            className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[12px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {account ? `Search ${account.address} for “` : "Search all accounts for “"}
              <span className="font-medium text-foreground">{raw.trim()}</span>”
            </span>
            <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string | null, fmt: DateTimeFmt): string {
  return iso ? formatStamp(iso, fmt) : "";
}
