import { createFileRoute, Outlet } from "@tanstack/react-router";
import { folderThreadsQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/folder/$folderId")({
  // Start the fetch without waiting: the panes draw their own loading and
  // error states, so the page never sits blank on a slow or failing server.
  loader: ({ params, context }) => {
    void context.queryClient.prefetchInfiniteQuery(folderThreadsQuery(params.folderId));
  },
  component: FolderLayout,
});

function FolderLayout() {
  return <Outlet />;
}
