import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { SearchBox } from "./search-box.tsx";
import { useShell } from "./shell-context.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { ToggleGroup, ToggleItem } from "./ui/toggle-group.tsx";

/**
 * Top of the list column: what you are looking at (view or folder) and where
 * (the account address, or All accounts), the All / Unread switch, and the
 * search field. `band` replaces the title row, e.g. with the selection bar.
 */
export function ListHeader({
  title,
  subtitle,
  mono,
  swatch,
  unread,
  onUnreadChange,
  actions,
  band,
}: {
  title: string;
  subtitle: string;
  /** Set when the subtitle is an address. */
  mono?: boolean;
  /** A folder's colour. */
  swatch?: string;
  unread?: boolean;
  onUnreadChange?: (unread: boolean) => void;
  actions?: ReactNode;
  band?: ReactNode;
}) {
  const { openNav, scope } = useShell();
  return (
    <div className="shrink-0">
      {band ?? (
        <div className="flex h-12 items-center gap-1.5 border-b pr-2 pl-1.5 xl:pl-4">
          <IconButton icon={Menu} label="Open navigation" onClick={openNav} className="xl:hidden" />
          <div className="min-w-0 flex-1 leading-tight">
            <h1 className="flex min-w-0 items-center gap-2 font-semibold text-[14px] tracking-tight">
              {swatch && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: swatch }}
                />
              )}
              <span className="truncate">{title}</span>
            </h1>
            <p
              className={cn(
                "mt-0.5 truncate text-[11px] text-muted-foreground",
                mono && "font-mono tracking-normal",
              )}
            >
              {subtitle}
            </p>
          </div>
          {onUnreadChange && (
            <ToggleGroup
              value={unread ? "unread" : "all"}
              onValueChange={(v) => onUnreadChange(v === "unread")}
              className="shrink-0 bg-muted shadow-none"
            >
              <ToggleItem
                value="all"
                variant="accent"
                className="px-2 data-pressed:bg-card data-pressed:shadow-sm"
              >
                All
              </ToggleItem>
              <ToggleItem
                value="unread"
                variant="accent"
                className="px-2 data-pressed:bg-card data-pressed:shadow-sm"
              >
                Unread
              </ToggleItem>
            </ToggleGroup>
          )}
          {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        </div>
      )}
      <div className="border-b px-3 py-2">
        <SearchBox scope={scope} />
      </div>
    </div>
  );
}
