import { parseUserPrefs } from "@cfx-mail/shared";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui.tsx";
import { noMailboxCopy } from "@/lib/mailbox-empty.ts";
import { ALL_MAILBOXES, mailboxesQuery, meQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/app/")({
  component: AppIndex,
});

function AppIndex() {
  const { queryClient } = Route.useRouteContext();
  const mailboxes = queryClient.getQueryData(mailboxesQuery.queryKey);
  const me = queryClient.getQueryData(meQuery.queryKey);
  const accounts = mailboxes?.mailboxes ?? [];
  if (accounts.length) {
    const view = parseUserPrefs(me?.user?.preferences).defaultView ?? "inbox";
    // Several accounts open in All accounts; a single one opens as itself.
    const mailboxId = accounts.length === 1 ? accounts[0]!.id : ALL_MAILBOXES;
    return <Navigate to="/app/m/$mailboxId" params={{ mailboxId }} search={{ view }} />;
  }
  return (
    <div className="flex h-full items-center justify-center p-6 sm:p-12">
      <EmptyState
        icon={Inbox}
        title="No accounts yet"
        hint={noMailboxCopy(me?.user?.role).hint}
        className="rounded-lg border bg-card px-8 py-10 shadow-sm"
      />
    </div>
  );
}
