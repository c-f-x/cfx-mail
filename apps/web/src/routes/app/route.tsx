import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell.tsx";
import { signedInUser } from "@/lib/current-user.ts";
import { mailboxesQuery } from "@/lib/queries.ts";
import { connectStream } from "@/lib/sse.ts";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ context }) => {
    if (!(await signedInUser(context.queryClient))) throw redirect({ to: "/login" });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(mailboxesQuery),
  component: AppLayout,
});

function AppLayout() {
  const qc = useQueryClient();
  const nav = useNavigate();
  useEffect(
    () =>
      connectStream(qc, ({ mailboxId, threadId }) => {
        void nav({
          to: "/app/m/$mailboxId/t/$threadId",
          params: { mailboxId, threadId },
          search: { view: "inbox" },
        });
      }),
    [qc, nav],
  );
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
