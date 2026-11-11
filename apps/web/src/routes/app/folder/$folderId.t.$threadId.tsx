import { createFileRoute } from "@tanstack/react-router";
import { FolderListPane, MailLayout, ThreadPane } from "@/components/mail-layout.tsx";
import { threadQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/folder/$folderId/t/$threadId")({
  // Start the fetch without waiting: the panes draw their own loading and
  // error states, so the page never sits blank on a slow or failing server.
  loader: ({ params, context }) => {
    void context.queryClient.prefetchQuery(threadQuery(params.threadId));
  },
  component: FolderThreadPage,
});

function FolderThreadPage() {
  const { folderId, threadId } = Route.useParams();
  return (
    <MailLayout list={<FolderListPane folderId={folderId} selectedThreadId={threadId} />}>
      <ThreadPane threadId={threadId} scope={{ kind: "folder", folderId }} />
    </MailLayout>
  );
}
