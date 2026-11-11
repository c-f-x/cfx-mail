import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, FolderInput, Mail, MailOpen } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import { accountLine } from "@/lib/accounts.ts";
import { rpc, unwrap } from "@/lib/api.ts";
import {
  type FolderRow,
  type MessageLabel,
  mailboxesQuery,
  type ThreadRow,
  threadLabelsQuery,
} from "@/lib/queries.ts";
import { useThreadListMutation } from "@/lib/thread-mutations.ts";
import { useUnfileThread } from "@/lib/use-folder-mutations.ts";
import { rowStyle, useListVirtualizer, visibleBlock } from "@/lib/use-list-virtualizer.ts";
import { ListHeader } from "./list-header.tsx";
import {
  FolderSubmenu,
  LabelsSubmenu,
  ReminderSubmenu,
  type RowAction,
  RowContextMenu,
} from "./thread-context-menu.tsx";
import { ThreadRowView } from "./thread-row.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { EmptyState, LoadError, ThreadListSkeleton } from "./ui.tsx";

interface Props {
  folder?: FolderRow;
  folderId: string;
  threads: ThreadRow[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  selectedThreadId?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
}

export function FolderThreadList({
  folder,
  folderId,
  threads,
  loading,
  error = null,
  onRetry,
  selectedThreadId,
  hasMore = false,
  loadingMore = false,
  loadMore,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useListVirtualizer(scrollRef, threads.length, {
    infinite: { hasMore, loadingMore, loadMore: () => loadMore?.() },
    cacheKey: `f:${folderId}`,
  });
  const vItems = virtualizer.getVirtualItems();
  const remeasure = (i: number, el: HTMLLIElement) => virtualizer.resizeItem(i, el.offsetHeight);

  const [from, to] = visibleBlock(virtualizer, threads.length);
  const visibleIds = threads.slice(from, to).map((t) => t.id);
  const { data: labelsData } = useQuery(threadLabelsQuery(visibleIds));
  const labelsByThread: Record<string, MessageLabel[]> | undefined = labelsData?.labels;
  const { data: mailboxesData } = useQuery(mailboxesQuery);
  const accounts = mailboxesData?.mailboxes ?? [];
  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full flex-col bg-card">
        <ListHeader
          title={folder?.name ?? "Folder"}
          subtitle="Folder · every account"
          swatch={folder?.color ?? "#64748b"}
          actions={
            <span className="px-1.5 text-[11px] text-muted-foreground tabular-nums">
              {threads.length}
            </span>
          }
        />
        {loading ? (
          <ThreadListSkeleton />
        ) : error ? (
          <LoadError error={error} onRetry={() => onRetry?.()} className="m-auto" />
        ) : threads.length === 0 ? (
          <EmptyState
            icon={FolderIcon}
            title="This folder is empty"
            hint="Open a conversation and use Move to file it here."
            className="m-auto"
          />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto pb-20 md:pb-0">
            <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map((vi) => {
                const t = threads[vi.index]!;
                return (
                  <FolderRowItem
                    key={t.id}
                    rowRef={virtualizer.measureElement}
                    remeasure={remeasure}
                    dataIndex={vi.index}
                    style={rowStyle(vi.start)}
                    folderId={folderId}
                    thread={t}
                    labels={labelsByThread?.[t.id]}
                    account={accountLine({ kind: "folder", folderId }, t.mailboxId, accounts)}
                    active={t.id === selectedThreadId}
                  />
                );
              })}
            </ul>
            {loadingMore && (
              <div className="py-3 text-center text-[11px] text-muted-foreground">
                Loading more…
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function FolderRowItem({
  folderId,
  thread,
  labels,
  account,
  active,
  rowRef,
  remeasure,
  style,
  dataIndex,
}: {
  folderId: string;
  thread: ThreadRow;
  labels?: MessageLabel[];
  account: string | null;
  active: boolean;
  rowRef: (el: HTMLLIElement | null) => void;
  remeasure: (index: number, el: HTMLLIElement) => void;
  style: CSSProperties;
  dataIndex: number;
}) {
  const unfile = useUnfileThread();
  const unread = thread.unreadCount > 0;

  const setRead = useThreadListMutation<boolean>({
    mailboxId: thread.mailboxId,
    threadId: thread.id,
    mutationFn: (read) =>
      unwrap(rpc.threads[":id"].$patch({ param: { id: thread.id }, json: { read } })),
  });

  const menuActions: RowAction[] = [
    {
      icon: unread ? MailOpen : Mail,
      label: unread ? "Mark as read" : "Mark as unread",
      onClick: () => setRead.mutate(unread),
    },
  ];

  return (
    <RowContextMenu
      leading={
        <>
          <LabelsSubmenu
            mailboxId={thread.mailboxId}
            threadId={thread.id}
            applied={new Set((labels ?? []).map((l) => l.id))}
          />
          <FolderSubmenu
            mailboxId={thread.mailboxId}
            threadId={thread.id}
            currentFolderId={folderId}
          />
          <ReminderSubmenu mailboxId={thread.mailboxId} threadId={thread.id} />
        </>
      }
      actions={menuActions}
    >
      <ThreadRowView
        thread={thread}
        link={{ kind: "folder", folderId }}
        active={active}
        labels={labels}
        account={account}
        rowRef={rowRef}
        remeasure={remeasure}
        style={style}
        dataIndex={dataIndex}
        actions={
          <>
            <IconButton
              icon={unread ? MailOpen : Mail}
              label={unread ? "Mark as read" : "Mark as unread"}
              size="icon-sm"
              className="h-6 w-6 hover:text-foreground"
              disabled={setRead.isPending}
              onClick={() => setRead.mutate(unread)}
            />
            <IconButton
              icon={FolderInput}
              label="Remove from folder"
              size="icon-sm"
              className="h-6 w-6 hover:text-foreground"
              disabled={unfile.isPending}
              onClick={() =>
                unfile.mutate({ folderId, threadId: thread.id, mailboxId: thread.mailboxId })
              }
            />
          </>
        }
      />
    </RowContextMenu>
  );
}
