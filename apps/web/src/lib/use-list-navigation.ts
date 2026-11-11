import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { stepThread } from "./list-navigation.ts";
import { listSearch, parseMailView } from "./queries.ts";
import { useFolderFeed, useThreadFeed } from "./use-feeds.ts";

/**
 * The list the open conversation belongs to (an account, All accounts or a
 * folder), its position in it, and a step to the newer or older one. Backs
 * both `j` / `k` and the reading pane's arrows.
 */
export function useListNavigation() {
  const params = useParams({ strict: false }) as {
    mailboxId?: string;
    folderId?: string;
    threadId?: string;
  };
  const search = useSearch({ strict: false }) as { view?: unknown; unread?: unknown };
  const view = parseMailView(search.view);
  const unread = search.unread === true;
  const nav = useNavigate();
  const mailboxFeed = useThreadFeed(
    params.mailboxId ?? "",
    view,
    Boolean(params.mailboxId),
    unread,
  );
  const folderFeed = useFolderFeed(params.folderId ?? "");
  const ids = (params.folderId ? folderFeed.items : mailboxFeed.items).map((t) => t.id);

  function step(delta: number) {
    const target = stepThread(ids, params.threadId, delta);
    if (!target || target === params.threadId) return;
    if (params.folderId) {
      nav({
        to: "/app/folder/$folderId/t/$threadId",
        params: { folderId: params.folderId, threadId: target },
      });
    } else if (params.mailboxId) {
      nav({
        to: "/app/m/$mailboxId/t/$threadId",
        params: { mailboxId: params.mailboxId, threadId: target },
        search: listSearch(view, unread),
      });
    }
  }

  return {
    /** Zero-based; -1 when the open conversation is not in the loaded list. */
    index: params.threadId ? ids.indexOf(params.threadId) : -1,
    total: ids.length,
    step,
  };
}
