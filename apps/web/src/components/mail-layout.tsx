import { useQuery } from "@tanstack/react-query";
import { MailOpen, PenSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { ListScope } from "@/lib/accounts.ts";
import { cn } from "@/lib/cn.ts";
import { loadView } from "@/lib/load-state.ts";
import { foldersQuery, type MailView, mailboxesQuery, threadQuery } from "@/lib/queries.ts";
import { useDraftFeed, useFolderFeed, useThreadFeed } from "@/lib/use-feeds.ts";
import { openCompose } from "./compose-dock.tsx";
import { DraftList } from "./draft-list.tsx";
import { FolderThreadList } from "./folder-thread-list.tsx";
import { MessageView } from "./message-view.tsx";
import { ThreadList } from "./thread-list.tsx";
import { Button } from "./ui/button.tsx";
import { EmptyState, LoadError, MessageSkeleton } from "./ui.tsx";

/**
 * The list and the reading pane, side by side from 768 px. Below that one of
 * them fills the screen: the conversation when one is open, else the list
 * (with a Compose button under the thumb).
 */
export function MailLayout({ list, children }: { list: ReactNode; children?: ReactNode }) {
  const reading = Boolean(children);
  return (
    <div className="flex h-full">
      <aside
        className={cn(
          "w-full shrink-0 border-r md:w-[300px] lg:w-[340px] xl:w-96",
          reading && "hidden md:block",
        )}
      >
        {list}
      </aside>
      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden bg-background",
          reading ? "flex" : "hidden md:flex",
        )}
      >
        {children ?? (
          <EmptyState
            icon={MailOpen}
            title="No conversation selected"
            hint="Pick a conversation from the list to read or reply."
            className="m-auto"
          />
        )}
      </section>
      {!reading && <ComposeButton />}
    </div>
  );
}

function ComposeButton() {
  const { data } = useQuery(mailboxesQuery);
  if (!data?.mailboxes.length) return null;
  return (
    <Button
      variant="primary"
      onClick={() => openCompose()}
      className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 h-12 gap-2 rounded-full pr-5 pl-4 text-[14px] shadow-black/20 shadow-lg md:hidden"
    >
      <PenSquare /> Compose
    </Button>
  );
}

/** An account's (or All accounts') list for one view. */
export function MailboxListPane({
  mailboxId,
  view,
  unread,
  selectedThreadId,
}: {
  mailboxId: string;
  view: MailView;
  unread?: boolean;
  selectedThreadId?: string;
}) {
  const isDrafts = view === "drafts";
  const feed = useThreadFeed(mailboxId, view, !isDrafts, unread);
  const drafts = useDraftFeed(mailboxId, isDrafts);
  return isDrafts ? (
    <DraftList
      mailboxId={mailboxId}
      drafts={drafts.items}
      loading={drafts.loading}
      error={drafts.error}
      onRetry={drafts.refetch}
      hasMore={drafts.hasMore}
      loadingMore={drafts.loadingMore}
      loadMore={drafts.loadMore}
    />
  ) : (
    <ThreadList
      mailboxId={mailboxId}
      view={view}
      unread={unread}
      threads={feed.items}
      loading={feed.loading}
      error={feed.error}
      onRetry={feed.refetch}
      hasMore={feed.hasMore}
      loadingMore={feed.loadingMore}
      loadMore={feed.loadMore}
      selectedThreadId={selectedThreadId}
    />
  );
}

/** One of the user's folders. */
export function FolderListPane({
  folderId,
  selectedThreadId,
}: {
  folderId: string;
  selectedThreadId?: string;
}) {
  const feed = useFolderFeed(folderId);
  const { data } = useQuery(foldersQuery);
  return (
    <FolderThreadList
      folder={data?.folders.find((f) => f.id === folderId)}
      folderId={folderId}
      threads={feed.items}
      loading={feed.loading}
      error={feed.error}
      onRetry={feed.refetch}
      hasMore={feed.hasMore}
      loadingMore={feed.loadingMore}
      loadMore={feed.loadMore}
      selectedThreadId={selectedThreadId}
    />
  );
}

/** The open conversation, with its loading and error states. */
export function ThreadPane({
  threadId,
  scope,
  view,
  unread,
  focusMessageId,
}: {
  threadId: string;
  scope: ListScope;
  view?: MailView;
  unread?: boolean;
  /** Open the conversation at this message (a search hit). */
  focusMessageId?: string;
}) {
  const thread = useQuery(threadQuery(threadId));
  const state = loadView({
    count: thread.data ? 1 : 0,
    loading: thread.isLoading,
    error: thread.isError,
    fetching: thread.isFetching,
  });
  if (thread.data)
    return (
      // Keyed so each conversation, and each message link into it, opens with
      // its own folding and scroll position.
      <MessageView
        key={`${threadId}:${focusMessageId ?? ""}`}
        thread={thread.data.thread}
        messages={thread.data.messages}
        scope={scope}
        view={view}
        unread={unread}
        focusMessageId={focusMessageId}
      />
    );
  if (state === "error")
    return (
      <LoadError error={thread.error} onRetry={() => void thread.refetch()} className="m-auto" />
    );
  return <MessageSkeleton />;
}
