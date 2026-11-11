import { createFileRoute, Outlet } from "@tanstack/react-router";
import { draftsQuery, parseMailListSearch, threadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId")({
  validateSearch: parseMailListSearch,
  loaderDeps: ({ search: { view, unread } }) => ({ view, unread }),
  // Start the fetch without waiting: the panes draw their own loading and
  // error states, so the page never sits blank on a slow or failing server.
  loader: ({ params, context, deps }) => {
    void (deps.view === "drafts"
      ? context.queryClient.prefetchInfiniteQuery(draftsQuery(params.mailboxId))
      : context.queryClient.prefetchInfiniteQuery(
          threadsQuery(params.mailboxId, deps.view, deps.unread),
        ));
  },
  component: MailboxLayout,
});

function MailboxLayout() {
  return <Outlet />;
}
