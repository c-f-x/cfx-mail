import { createFileRoute } from "@tanstack/react-router";
import { FolderListPane, MailLayout } from "@/components/mail-layout.tsx";

export const Route = createFileRoute("/app/folder/$folderId/")({
  component: FolderIndex,
});

function FolderIndex() {
  const { folderId } = Route.useParams();
  return <MailLayout list={<FolderListPane folderId={folderId} />} />;
}
