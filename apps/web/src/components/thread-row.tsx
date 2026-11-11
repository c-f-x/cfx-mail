import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type LucideIcon, Mails } from "lucide-react";
import type * as React from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";
import { useDateTimeFmt, useUserPrefs } from "@/lib/prefs.ts";
import {
  listSearch,
  type MailView,
  type MessageLabel,
  messageBodyQuery,
  type ThreadRow,
  threadQuery,
} from "@/lib/queries.ts";
import { threadSubject } from "@/lib/thread-subject.ts";
import { formatStamp } from "@/lib/time.ts";
import { useSwipeRow } from "@/lib/use-swipe-row.ts";
import { SenderAvatar } from "./sender-avatar.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { LabelChip } from "./ui.tsx";

/** One side of a swipe gesture: the reveal colour/icon and the action to run. */
export interface SwipeAction {
  icon: LucideIcon;
  label: string;
  /** Background colour class for the revealed panel, e.g. "bg-destructive". */
  className: string;
  onCommit: () => void;
}

export interface RowSwipe {
  /** Dragging the row right (→). */
  right?: SwipeAction;
  /** Dragging the row left (←). */
  left?: SwipeAction;
  onLongPress?: () => void;
}

// Where the row links to; both list flavors share one row body.
type RowLink =
  | { kind: "mailbox"; mailboxId: string; view: MailView; unread?: boolean }
  | { kind: "folder"; folderId: string };

interface Props {
  thread: ThreadRow;
  link: RowLink;
  active: boolean;
  /** Multi-select highlight (mailbox lists only). */
  selected?: boolean;
  /** Distinct labels across the thread's messages, shown as chips. */
  labels?: MessageLabel[];
  /** Which account the conversation is in, where rows of several accounts mix. */
  account?: string | null;
  /** Multi-select checkbox, drawn over the avatar (mailbox lists only). */
  select?: { selecting: boolean; onToggle: () => void };
  /** Hover action cluster; omit to hide it (e.g. while selecting). */
  actions?: React.ReactNode;
  /** Virtualizer measurement ref + position; set together when windowed. */
  rowRef?: (el: HTMLLIElement | null) => void;
  style?: React.CSSProperties;
  dataIndex?: number;
  /** Force a fresh height re-measure for this row (async content changed it). */
  remeasure?: (index: number, el: HTMLLIElement) => void;
  /** Touch swipe + long-press gestures (mailbox lists only). */
  swipe?: RowSwipe;
}

export function ThreadRowView({
  thread,
  link,
  active,
  selected = false,
  labels,
  account,
  select,
  actions,
  rowRef,
  style,
  dataIndex,
  remeasure,
  swipe,
}: Props) {
  const { prefs } = useUserPrefs();
  const fmt = useDateTimeFmt();
  const compact = prefs.density === "compact";
  const firstParticipant = thread.participants[0];
  const label = firstParticipant?.name ?? firstParticipant?.address ?? "(unknown)";
  const unread = thread.unreadCount > 0;

  // Label chips come from a separate query that resolves after the row first
  // measures, growing it a line taller. The virtualizer's ResizeObserver doesn't
  // reliably catch that late change, leaving the rows below overlapped until a
  // re-render. Force a fresh height read when the row's line count can change.
  const node = useRef<HTMLLIElement | null>(null);
  const setRow = (el: HTMLLIElement | null) => {
    node.current = el;
    rowRef?.(el);
  };
  // Anything that adds/removes a line and can land after the first measure:
  // label chips (async query).
  const heightKey = `${labels?.map((l) => l.id).join(",") ?? ""}|${account ?? ""}|${compact ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on height change
  useLayoutEffect(() => {
    // virtualizer height remeasure must run post-layout when the row's line count changes
    if (node.current && dataIndex !== undefined) remeasure?.(dataIndex, node.current);
  }, [heightKey, dataIndex, remeasure]);

  // Router intent-preload already warms the thread's message list on hover, but
  // the per-message bodies (the slow part you see render as a skeleton) are
  // fetched only when the cards mount. Prefetch the newest few bodies (in one
  // request) on hover intent so opening the thread paints the HTML at once.
  // Bodies are immutable (`staleTime: Infinity`), so this is a one-time fetch
  // per message. A short delay keeps a fast scroll-sweep over rows from firing
  // requests.
  const qc = useQueryClient();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefetch = () => {
    hoverTimer.current = setTimeout(() => {
      void qc
        .ensureQueryData(threadQuery(thread.id))
        .then((d) => {
          for (const m of d.messages.slice(-6))
            void qc.prefetchQuery(messageBodyQuery(m.id, thread.id));
        })
        .catch(() => {});
    }, 80);
  };
  const cancelPrefetch = () => clearTimeout(hoverTimer.current);
  useLayoutEffect(() => () => clearTimeout(hoverTimer.current), []);
  const hoverProps = {
    onPointerEnter: prefetch,
    onPointerLeave: cancelPrefetch,
    onFocus: prefetch,
  };

  const { state: sw, handlers } = useSwipeRow({
    onSwipeRight: swipe?.right?.onCommit,
    onSwipeLeft: swipe?.left?.onCommit,
    onLongPress: swipe?.onLongPress,
    disabled: !swipe,
  });

  const rowPadding = compact ? "py-1.5" : "py-2.5";
  const avatarSize = compact ? 22 : 26;
  const linkClassName = cn(
    "flex min-w-0 flex-1 flex-col gap-0.5 pl-2.5 pr-4 text-[13px]",
    rowPadding,
  );

  // The checkbox shares the avatar's footprint instead of a column of its own:
  // the avatar is the resting face and the checkbox takes over while selecting,
  // on hover (pointer devices) or on focus. Below md there is no hover, so the
  // avatar itself is the tap target that starts a selection.
  const showCheck = !!select && (select.selecting || selected);
  const lead = (
    <div className={cn("group/lead relative flex shrink-0 items-start pl-3", rowPadding)}>
      <span className="relative block" style={{ width: avatarSize, height: avatarSize }}>
        <SenderAvatar
          name={firstParticipant?.name}
          address={firstParticipant?.address ?? ""}
          size={avatarSize}
          className={cn(
            "transition-opacity",
            showCheck
              ? "opacity-0"
              : select && "group-focus-within/lead:opacity-0 md:group-hover:opacity-0",
          )}
        />
        {select && (
          <span
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity",
              showCheck
                ? "opacity-100"
                : "opacity-0 group-focus-within/lead:opacity-100 md:group-hover:opacity-100",
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={select.onToggle}
              aria-label={selected ? "Deselect" : "Select"}
              // The pseudo-element widens the hit area to the whole avatar.
              className="relative before:absolute before:-inset-1.5"
            />
          </span>
        )}
      </span>
    </div>
  );

  const body = (
    <>
      <div className="flex items-center justify-between gap-2" style={{ minHeight: avatarSize }}>
        <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>{label}</span>
        <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
          {formatStamp(thread.lastMsgAt, fmt)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "truncate text-[12px]",
            unread ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {threadSubject(thread)}
        </span>
        {unread && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            role="img" // decorative CSS dot conveying unread count via aria-label; not a real image
            aria-label={`${thread.unreadCount} unread`}
          />
        )}
        {thread.msgCount > 1 && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border bg-muted px-1 font-medium text-[10px] text-muted-foreground"
            title={`${thread.msgCount} messages in this thread`}
          >
            <Mails className="h-2.5 w-2.5" />
            {thread.msgCount}
          </span>
        )}
      </div>
      {((labels && labels.length > 0) || account) && (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
          {labels?.map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} />
          ))}
          {account && (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground tracking-normal">
              {account}
            </span>
          )}
        </div>
      )}
    </>
  );

  return (
    <li
      ref={setRow}
      data-index={dataIndex}
      style={style}
      className="group relative flex items-stretch overflow-hidden border-b bg-card"
    >
      {swipe?.right && sw.dx > 0 && (
        <SwipeReveal action={swipe.right} side="left" width={sw.dx} armed={sw.armed} />
      )}
      {swipe?.left && sw.dx < 0 && (
        <SwipeReveal action={swipe.left} side="right" width={-sw.dx} armed={sw.armed} />
      )}
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-stretch",
          sw.dragging ? "" : "transition-transform duration-200",
          active
            ? "bg-primary/10 text-foreground"
            : selected
              ? "bg-primary/5"
              : "bg-card hover:bg-muted/60",
        )}
        style={swipe ? { transform: `translateX(${sw.dx}px)`, touchAction: "pan-y" } : undefined}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onClickCapture={handlers.onClickCapture}
      >
        {active && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
        {lead}
        {link.kind === "mailbox" ? (
          <Link
            to="/app/m/$mailboxId/t/$threadId"
            params={{ mailboxId: link.mailboxId, threadId: thread.id }}
            search={listSearch(link.view, link.unread)}
            draggable={false}
            className={linkClassName}
            {...hoverProps}
          >
            {body}
          </Link>
        ) : (
          <Link
            to="/app/folder/$folderId/t/$threadId"
            params={{ folderId: link.folderId, threadId: thread.id }}
            draggable={false}
            className={linkClassName}
            {...hoverProps}
          >
            {body}
          </Link>
        )}
        {actions && (
          <div className="absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-muted-foreground shadow-sm">
              {actions}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// The coloured panel revealed behind a row mid-swipe. Its icon hugs the edge the
// finger is pulling from and brightens once the swipe passes the commit point.
function SwipeReveal({
  action,
  side,
  width,
  armed,
}: {
  action: SwipeAction;
  side: "left" | "right";
  width: number;
  armed: boolean;
}) {
  const Icon = action.icon;
  return (
    <div
      aria-hidden
      className={cn(
        "absolute inset-y-0 flex items-center text-white transition-opacity",
        action.className,
        side === "left" ? "left-0 justify-start pl-5" : "right-0 justify-end pr-5",
        armed ? "opacity-100" : "opacity-70",
      )}
      style={{ width: Math.max(width, 0) }}
    >
      <Icon className={cn("h-5 w-5 shrink-0 transition-transform", armed && "scale-125")} />
    </div>
  );
}
