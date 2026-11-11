import { createFileRoute } from "@tanstack/react-router";
import { MailboxListPane, MailLayout } from "@/components/mail-layout.tsx";

export const Route = createFileRoute("/app/m/$mailboxId/")({
  component: MailboxIndex,
});

function MailboxIndex() {
  const { mailboxId } = Route.useParams();
  const { view, unread } = Route.useSearch();
  return (
    <MailLayout list={<MailboxListPane mailboxId={mailboxId} view={view} unread={unread} />} />
  );
}
