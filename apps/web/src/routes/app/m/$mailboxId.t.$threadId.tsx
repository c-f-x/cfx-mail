import { createFileRoute } from "@tanstack/react-router";
import { MailboxListPane, MailLayout, ThreadPane } from "@/components/mail-layout.tsx";
import { threadQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/m/$mailboxId/t/$threadId")({
  // Start the fetch without waiting: the panes draw their own loading and
  // error states, so the page never sits blank on a slow or failing server.
  loader: ({ params, context }) => {
    void context.queryClient.prefetchQuery(threadQuery(params.threadId));
  },
  component: ThreadPage,
});

function ThreadPage() {
  const { mailboxId, threadId } = Route.useParams();
  const { view, unread } = Route.useSearch();
  return (
    <MailLayout
      list={
        <MailboxListPane
          mailboxId={mailboxId}
          view={view}
          unread={unread}
          selectedThreadId={threadId}
        />
      }
    >
      <ThreadPane
        threadId={threadId}
        scope={{ kind: "mailbox", mailboxId }}
        view={view}
        unread={unread}
      />
    </MailLayout>
  );
}
