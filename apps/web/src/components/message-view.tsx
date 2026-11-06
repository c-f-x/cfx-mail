import { Flag, hasFlag, setFlag } from "@cfx-mail/shared/flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Forward,
  Inbox,
  type LucideIcon,
  MailMinus,
  Reply,
  ReplyAll,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { canSendFrom, type ListScope, listTarget } from "@/lib/accounts.ts";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import {
  invalidateThreadChange,
  patchMessageFlags,
  removeMessageFromThread,
  removeThreadsFromLists,
} from "@/lib/invalidate.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import {
  listSearch,
  type MailView,
  type MessageRow,
  mailboxesQuery,
  type ThreadRow,
} from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { foldedRun, initialOpen } from "@/lib/thread-fold.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { threadSubject } from "@/lib/thread-subject.ts";
import { useListNavigation } from "@/lib/use-list-navigation.ts";
import { openCompose } from "./compose-dock.tsx";
import { LabelsMenu } from "./labels-menu.tsx";
import { CollapsedMessage, MessageCard } from "./message/message-card.tsx";
import { MoveToFolderMenu } from "./move-to-folder-menu.tsx";
import { ReminderMenu } from "./reminder-menu.tsx";
import { Button } from "./ui/button.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Separator } from "./ui/separator.tsx";
import { Tooltip, TooltipProvider } from "./ui/tooltip.tsx";

interface Props {
  thread: ThreadRow;
  messages: MessageRow[];
  /** The list the conversation was opened from; actions that remove it return there. */
  scope: ListScope;
  view?: MailView;
  /** The list's unread-only filter, carried through when navigating back to it. */
  unread?: boolean;
  /** Open the conversation at this message (a search hit) rather than the newest. */
  focusMessageId?: string;
}

export function MessageView({
  thread,
  messages,
  scope,
  view = "inbox",
  unread,
  focusMessageId,
}: Props) {
  const nav = useNavigate();
  const backSearch = listSearch(view, unread);
  // Inside a custom folder the move menu also offers "move back to the account".
  const folderId = scope.kind === "folder" ? scope.folderId : undefined;
  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const account = mailboxesData?.mailboxes.find((m) => m.id === thread.mailboxId);
  // A member with read access only: no actions that the server would refuse.
  const readOnly = account ? !canSendFrom(account) : false;
  const listNav = useListNavigation();

  // Back to the list this conversation was opened from: All accounts stays All
  // accounts, a folder stays the folder.
  function backToList() {
    const target = listTarget(scope);
    if (target.to === "/app/folder/$folderId") nav({ to: target.to, params: target.params });
    else nav({ to: target.to, params: target.params, search: backSearch });
  }
  const qc = useQueryClient();
  const { confirmDelete } = useConfirmHelpers();

  // stable identity required by the auto-mark-read effect's exhaustive-deps
  const invalidate = useCallback(
    () =>
      invalidateThreadChange(qc, {
        mailboxId: thread.mailboxId,
        threadId: thread.id,
        counts: true,
        folders: true,
      }),
    [qc, thread.mailboxId, thread.id],
  );

  // Trash/spam optimistically drops the thread from the open mailbox's lists;
  // `act()` navigates away, so the row vanishes instantly. Settle reconciles.
  const setState = useThreadListMutation<{ trashed?: boolean; spam?: boolean }>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (patch) =>
      unwrap(rpc.threads[":id"].$patch({ param: { id: thread.id }, json: patch })),
    optimistic: (_patch, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  // Permanent delete: irreversible, so no undo — confirm then drop the row.
  const del = useThreadListMutation<void>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: () => unwrap(rpc.threads[":id"].$delete({ param: { id: thread.id } })),
    optimistic: (_v, client) => removeThreadsFromLists(client, thread.mailboxId, [thread.id]),
  });

  // Permanently delete a single message out of the thread. The server drops the
  // whole thread when it was the last message — navigate away in that case,
  // otherwise just remove the card from the open thread.
  // reconciles cache via onSettled invalidate + removeThreadsFromLists/removeMessageFromThread
  const delMsg = useMutation({
    mutationFn: (id: string) => unwrap(rpc.messages[":id"].$delete({ param: { id } })),
    onSuccess: (res, id) => {
      toast.success("Message deleted");
      if (res.threadDeleted) {
        removeThreadsFromLists(qc, thread.mailboxId, [thread.id]);
        backToList();
      } else {
        removeMessageFromThread(qc, thread.id, id);
      }
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
    onSettled: invalidate,
  });

  async function removeMessage(id: string) {
    // The thread's last message — deleting it drops the whole conversation.
    const subject = messages.length <= 1 ? "this conversation" : "this message";
    if (!(await confirmDelete(subject))) return;
    delMsg.mutate(id);
  }

  const setMsg = useMutation({
    mutationFn: (input: {
      id: string;
      patch: { seen?: boolean; starred?: boolean; trash?: boolean };
    }) => unwrap(rpc.messages[":id"].$patch({ param: { id: input.id }, json: input.patch })),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.thread(thread.id) });
      const prev = qc.getQueryData<{ messages: MessageRow[] }>(keys.thread(thread.id));
      const current = prev?.messages.find((m) => m.id === id);
      if (current) {
        let flags = current.flags;
        if (patch.seen !== undefined) flags = setFlag(flags, Flag.SEEN, patch.seen);
        if (patch.starred !== undefined) flags = setFlag(flags, Flag.STARRED, patch.starred);
        // Trashing/restoring flips Flag.TRASH; the message then drops in or out of
        // the visible list (which filters on it) for instant feedback.
        if (patch.trash !== undefined) flags = setFlag(flags, Flag.TRASH, patch.trash);
        patchMessageFlags(qc, thread.id, id, flags);
      }
      return { prev };
    },
    onError: (e: unknown, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.thread(thread.id), ctx.prev);
      toast.error(e instanceof Error ? e.message : "Failed");
    },
    onSettled: invalidate,
  });

  function trashMessage(id: string) {
    setMsg.mutate(
      { id, patch: { trash: true } },
      {
        onSuccess: () =>
          toast.success("Message deleted", {
            action: {
              label: "Undo",
              onClick: () => setMsg.mutate({ id, patch: { trash: false } }),
            },
          }),
      },
    );
  }

  function restoreMessage(id: string) {
    setMsg.mutate({ id, patch: { trash: false } }, { onSuccess: () => toast.success("Restored") });
  }

  // Auto-mark inbound messages as read when the thread is opened.
  const { prefs } = useUserPrefs();
  const autoMarkRead = prefs.autoMarkRead !== false;
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !autoMarkRead || markedRef.current === thread.id) return;
    const unseen = messages.filter(
      (m) => m.direction === "in" && !hasFlag(m.flags, Flag.SEEN) && !hasFlag(m.flags, Flag.TRASH),
    );
    if (unseen.length === 0) return;
    markedRef.current = thread.id;
    void Promise.all(
      unseen.map((m) =>
        unwrap(rpc.messages[":id"].$patch({ param: { id: m.id }, json: { seen: true } })),
      ),
    ).then(invalidate);
  }, [thread.id, messages, readOnly, autoMarkRead, invalidate]);

  function act(patch: { trashed?: boolean; spam?: boolean }, label: string, undo: typeof patch) {
    setState.mutate(patch, {
      onSuccess: () => {
        toast.success(label, {
          action: { label: "Undo", onClick: () => setState.mutate(undo) },
        });
        backToList();
      },
    });
  }

  async function remove() {
    if (!(await confirmDelete("this conversation"))) return;
    del.mutate(undefined, {
      onSuccess: () => {
        toast.success("Deleted permanently");
        backToList();
      },
    });
  }

  function markUnread() {
    const last = messages.findLast((m) => m.direction === "in" && !hasFlag(m.flags, Flag.TRASH));
    if (last) setMsg.mutate({ id: last.id, patch: { seen: false } });
  }

  // Individually-trashed messages are hidden from the active folders. The Trash
  // view shows the whole conversation when the thread itself is trashed, else
  // only its deleted messages; "All" shows everything.
  const visibleMessages =
    view === "trash"
      ? thread.trashed
        ? messages
        : messages.filter((m) => hasFlag(m.flags, Flag.TRASH))
      : view === "all"
        ? messages
        : messages.filter((m) => !hasFlag(m.flags, Flag.TRASH));

  // Which messages open expanded (lib/thread-fold.ts). Taken once when the
  // conversation opens (the view is keyed per thread), so marking them read
  // doesn't fold them away. Mail that arrives while it is open opens expanded.
  const [initial] = useState(() => initialOpen(visibleMessages, focusMessageId));
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [unfolded, setUnfolded] = useState(false);
  const isOpen = (m: MessageRow) =>
    overrides.get(m.id) ?? (initial.open.has(m.id) || !initial.ids.has(m.id));
  const setOpen = (id: string, open: boolean) =>
    setOverrides((prev) => new Map(prev).set(id, open));
  const allOpen = visibleMessages.every(isOpen);
  const setAll = (open: boolean) => {
    setUnfolded(true);
    setOverrides(new Map(visibleMessages.map((m) => [m.id, open])));
  };
  const hidden = unfolded ? null : foldedRun(visibleMessages.map(isOpen));

  // Land on the first expanded message, with only folded rows above it, so the
  // position holds while bodies stream in below.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const card = container?.querySelector<HTMLElement>(
      `[data-message-id="${initial.focus ?? ""}"]`,
    );
    if (!container || !card || card === container.firstElementChild) return;
    const padTop = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
    container.scrollTop =
      card.getBoundingClientRect().top - container.getBoundingClientRect().top - padTop;
  }, [initial.focus]);

  // Side nav arrows: "up" goes to the oldest message, "down" to the newest.
  // Each shows only while there's room to travel that way.
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the cards when they fold or unfold
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () => {
      setCanUp(container.scrollTop > 8);
      setCanDown(container.scrollTop < container.scrollHeight - container.clientHeight - 8);
    };
    // reads live scroll offsets from the DOM; not derivable during render
    update();
    const opts: AddEventListenerOptions = { passive: true };
    container.addEventListener("scroll", update, opts);
    const ro = new ResizeObserver(update);
    ro.observe(container);
    for (const child of Array.from(container.children)) ro.observe(child);
    return () => {
      container.removeEventListener("scroll", update, opts);
      ro.disconnect();
    };
  }, [overrides, unfolded, visibleMessages.length]);
  const scrollTo = (top: number) => scrollRef.current?.scrollTo({ top, behavior: "smooth" });

  // Reply bar answers the newest message on screen (r / f do the same).
  const newest = visibleMessages.at(-1);

  // Per-message actions depend on its state: a trashed message can be restored or
  // permanently deleted; a live message in a trashed thread can only be purged;
  // otherwise it can be soft-deleted into the Trash.
  function messageActions(m: MessageRow) {
    if (readOnly) return {};
    if (hasFlag(m.flags, Flag.TRASH))
      return { onRestore: () => restoreMessage(m.id), onDelete: () => removeMessage(m.id) };
    if (thread.trashed) return { onDelete: () => removeMessage(m.id) };
    return { onTrash: () => trashMessage(m.id) };
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-background">
        <div
          role="toolbar"
          aria-label="Conversation actions"
          className="flex h-12 shrink-0 items-center gap-0.5 border-b bg-card px-1.5 sm:px-3"
        >
          <IconButton
            icon={ArrowLeft}
            label="Back to the list"
            onClick={backToList}
            className="md:hidden"
          />
          {!readOnly &&
            (view === "trash" ? (
              // Whole-thread restore/delete only apply when the thread itself is
              // trashed. A live thread shown here for one deleted message keeps
              // its other messages; that message is restored or deleted from its
              // own menu.
              thread.trashed && (
                <>
                  <ToolButton
                    icon={ArchiveRestore}
                    label="Restore"
                    text="Restore"
                    onClick={() => act({ trashed: false }, "Restored", { trashed: true })}
                    disabled={setState.isPending}
                  />
                  <ToolButton
                    icon={Trash2}
                    label="Delete permanently"
                    text="Delete"
                    onClick={remove}
                    disabled={del.isPending}
                    className="hover:bg-destructive/10 hover:text-destructive"
                  />
                </>
              )
            ) : (
              <ToolButton
                icon={Trash2}
                label="Trash (#)"
                text="Trash"
                onClick={() => act({ trashed: true }, "Moved to Trash", { trashed: false })}
                disabled={setState.isPending}
                className="hover:bg-destructive/10 hover:text-destructive"
              />
            ))}
          {!readOnly && (
            <MoveToFolderMenu
              threadIds={[thread.id]}
              mailboxId={thread.mailboxId}
              currentFolderId={folderId}
              tooltip="Move to folder"
              text="Move"
              onMoved={(folderName) => {
                toast.success(`Moved to ${folderName}`);
                backToList();
              }}
            />
          )}
          {!readOnly && (
            <ToolButton
              icon={MailMinus}
              label="Mark unread (u)"
              text="Unread"
              onClick={markUnread}
              disabled={setMsg.isPending}
            />
          )}
          {!readOnly &&
            view !== "trash" &&
            (view === "spam" ? (
              <ToolButton
                icon={Inbox}
                label="Not spam"
                onClick={() => act({ spam: false }, "Moved to Inbox", { spam: true })}
                disabled={setState.isPending}
              />
            ) : (
              <ToolButton
                icon={ShieldAlert}
                label="Mark as spam (!)"
                onClick={() => act({ spam: true }, "Marked as spam", { spam: false })}
                disabled={setState.isPending}
              />
            ))}
          {!readOnly && messages.at(-1) && (
            <LabelsMenu
              mailboxId={thread.mailboxId}
              messageId={messages.at(-1)!.id}
              tooltip="Labels"
            />
          )}
          {!readOnly && (
            <ReminderMenu
              threadId={thread.id}
              mailboxId={thread.mailboxId}
              messageId={messages.at(-1)?.id}
            />
          )}
          <div className="ml-auto hidden items-center gap-0.5 md:flex">
            {listNav.index >= 0 && (
              <span className="mr-1 text-[11px] text-muted-foreground tabular-nums">
                {listNav.index + 1} of {listNav.total}
              </span>
            )}
            <IconButton
              icon={ChevronUp}
              label="Newer conversation (k)"
              onClick={() => listNav.step(-1)}
              disabled={listNav.index <= 0}
            />
            <IconButton
              icon={ChevronDown}
              label="Older conversation (j)"
              onClick={() => listNav.step(1)}
              disabled={listNav.index < 0 || listNav.index >= listNav.total - 1}
            />
          </div>
        </div>

        {/* Text lines up with the message text inside the cards below. */}
        <header className="shrink-0 border-b bg-background px-7 pt-4 pb-3 sm:px-8">
          <div className="flex items-start gap-2">
            <h1 className="flex-1 font-semibold text-[20px] leading-snug tracking-tight [overflow-wrap:anywhere]">
              {threadSubject(thread)}
            </h1>
            {visibleMessages.length > 1 && (
              <IconButton
                icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
                label={allOpen ? "Collapse all" : "Expand all"}
                onClick={() => setAll(!allOpen)}
                className="-mr-2 shrink-0"
              />
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            {account && (
              <span className="font-mono tracking-normal">
                {readOnly ? "in" : "to"} {account.address}
              </span>
            )}
            {account && messages.length > 1 && <span aria-hidden>·</span>}
            {messages.length > 1 && <span>{messages.length} messages</span>}
          </p>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3 sm:space-y-4 sm:p-4">
            {visibleMessages.map((m, i) => {
              if (hidden && i >= hidden.from && i < hidden.to) {
                if (i > hidden.from) return null;
                return (
                  <div key="fold" className="flex items-center gap-3">
                    <Separator className="flex-1" />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setUnfolded(true)}
                      className="rounded-full"
                    >
                      {hidden.to - hidden.from} more messages
                    </Button>
                    <Separator className="flex-1" />
                  </div>
                );
              }
              if (!isOpen(m))
                return <CollapsedMessage key={m.id} msg={m} onExpand={() => setOpen(m.id, true)} />;
              return (
                <MessageCard
                  key={m.id}
                  msg={m}
                  readOnly={readOnly}
                  highlight={m.id === focusMessageId}
                  onCollapse={visibleMessages.length > 1 ? () => setOpen(m.id, false) : undefined}
                  busy={setMsg.isPending || delMsg.isPending}
                  threadSpam={thread.spam}
                  {...messageActions(m)}
                  onToggleStar={() =>
                    setMsg.mutate({
                      id: m.id,
                      patch: { starred: !hasFlag(m.flags, Flag.STARRED) },
                    })
                  }
                />
              );
            })}
          </div>
          {canUp && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Oldest message"
              onClick={() => scrollTo(0)}
              className="absolute top-2 right-3 z-10 rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            >
              <ChevronUp />
            </Button>
          )}
          {canDown && (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Newest message"
              onClick={() => scrollTo(scrollRef.current?.scrollHeight ?? 0)}
              className="absolute right-3 bottom-2 z-10 rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            >
              <ChevronDown />
            </Button>
          )}
        </div>

        {!readOnly && newest && (
          <div className="flex shrink-0 items-center gap-2 border-t bg-card px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4">
            <Button
              className="flex-1 sm:flex-none"
              onClick={() => openCompose({ replyToMessage: newest })}
            >
              <Reply /> Reply
            </Button>
            <Button
              className="flex-1 sm:flex-none"
              onClick={() => openCompose({ replyToMessage: newest, replyAll: true })}
            >
              <ReplyAll /> Reply all
            </Button>
            <Button
              className="flex-1 sm:flex-none"
              onClick={() => openCompose({ forwardMessage: newest })}
            >
              <Forward /> Forward
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// A toolbar action: icon always, its word from 1024 px, the full label as tooltip.
function ToolButton({
  icon: Icon,
  label,
  text,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  text?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "size-8 px-0 lg:w-auto lg:gap-1.5 lg:px-2.5",
          !text && "lg:w-8 lg:px-0",
          className,
        )}
      >
        <Icon />
        {text && <span className="hidden lg:inline">{text}</span>}
      </Button>
    </Tooltip>
  );
}
