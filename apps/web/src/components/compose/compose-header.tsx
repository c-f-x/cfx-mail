import { Dialog } from "@base-ui/react/dialog";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "../ui/icon-button.tsx";

// The composer's title bar: PGP dot, title, and pop-out / expand / close. In
// the pop-out window it is plain markup; in the dock it titles the dialog.
export function ComposeHeader({
  isWindow,
  title,
  pgpMode,
  expanded,
  onToggleExpanded,
  onPopOut,
}: {
  isWindow: boolean;
  title: string;
  pgpMode: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPopOut: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-2">
      <div className="flex min-w-0 items-center gap-2">
        {pgpMode !== "off" && (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              pgpMode === "sign_encrypt" ? "bg-primary" : "bg-primary/60",
            )}
          />
        )}
        {isWindow ? (
          <span className="truncate font-semibold text-[13px] text-foreground tracking-tight">
            {title}
          </span>
        ) : (
          <Dialog.Title className="truncate font-semibold text-[13px] text-foreground tracking-tight">
            {title}
          </Dialog.Title>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        {!isWindow && (
          <>
            <IconButton
              label="Open in new window"
              icon={ExternalLink}
              size="icon-sm"
              onClick={onPopOut}
              className="hidden sm:inline-flex"
            />
            <IconButton
              label={expanded ? "Shrink" : "Expand"}
              icon={expanded ? Minimize2 : Maximize2}
              size="icon-sm"
              onClick={onToggleExpanded}
              className="hidden sm:inline-flex"
            />
          </>
        )}
        {isWindow ? (
          <IconButton label="Close" icon={X} size="icon-sm" onClick={() => window.close()} />
        ) : (
          <Dialog.Close
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </Dialog.Close>
        )}
      </div>
    </div>
  );
}
