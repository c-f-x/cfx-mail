import { Flag, hasFlag } from "@cfx-mail/shared/flags";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { type ListScope, listTarget } from "@/lib/accounts.ts";
import { rpc, unwrap } from "@/lib/api.ts";
import { invalidateThreadChange } from "@/lib/invalidate.ts";
import { listSearch, type MessageRow, parseMailView, threadQuery } from "@/lib/queries.ts";
import { useKeyboardShortcuts } from "@/lib/shortcuts.ts";
import { useListNavigation } from "@/lib/use-list-navigation.ts";
import { openCompose } from "./compose-dock.tsx";
import {
  ShortcutsDialog,
  setShortcutsHelpOpen,
  useShortcutsHelpOpen,
} from "./shortcuts-dialog.tsx";

export function AppShortcuts() {
  const params = useParams({ strict: false }) as {
    mailboxId?: string;
    folderId?: string;
    threadId?: string;
  };
  const { mailboxId, folderId, threadId } = params;
  const search = useSearch({ strict: false }) as { view?: unknown; unread?: unknown };
  // A folder has no view; its conversations count as live (not spam, not trash).
  const view = parseMailView(search.view);
  const unread = search.unread === true;
  const scope: ListScope | null = folderId
    ? { kind: "folder", folderId }
    : mailboxId
      ? { kind: "mailbox", mailboxId }
      : null;
  const nav = useNavigate();
  const qc = useQueryClient();
  const helpOpen = useShortcutsHelpOpen();
  const listNav = useListNavigation();

  // The open conversation, with its own account: in All accounts and in a
  // folder the URL does not say which account it is in.
  const withThread = async (fn: (t: { mailboxId: string; last?: MessageRow }) => unknown) => {
    if (!threadId) return;
    const data = await qc.ensureQueryData(threadQuery(threadId));
    if (data) await fn({ mailboxId: data.thread.mailboxId, last: data.messages.at(-1) });
  };

  // onSuccess refreshes via invalidateThreadChange
  const setThreadState = useMutation({
    mutationFn: (input: {
      id: string;
      mailboxId: string;
      patch: { trashed?: boolean; spam?: boolean };
    }) => unwrap(rpc.threads[":id"].$patch({ param: { id: input.id }, json: input.patch })),
    onSuccess: (_res, input) =>
      invalidateThreadChange(qc, {
        mailboxId: input.mailboxId,
        threadId: input.id,
        counts: true,
        folders: true,
      }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Back to the list the conversation was opened from (All accounts stays All
  // accounts, a folder stays the folder).
  const backToList = () => {
    if (!scope) return;
    const target = listTarget(scope);
    if (target.to === "/app/folder/$folderId") nav({ to: target.to, params: target.params });
    else nav({ to: target.to, params: target.params, search: listSearch(view, unread) });
  };

  const moveThread = (
    patch: { trashed?: boolean; spam?: boolean },
    label: string,
    undo: typeof patch,
  ) =>
    withThread(({ mailboxId: owner }) => {
      const id = threadId!;
      setThreadState.mutate(
        { id, mailboxId: owner, patch },
        {
          onSuccess: () => {
            toast.success(label, {
              action: {
                label: "Undo",
                onClick: () => setThreadState.mutate({ id, mailboxId: owner, patch: undo }),
              },
            });
          },
        },
      );
      backToList();
    });

  useKeyboardShortcuts((e) => {
    if (e.key === "?") {
      e.preventDefault();
      setShortcutsHelpOpen(!helpOpen);
      return;
    }
    if (e.key === "/") {
      // The list's search field; on pages without one (Settings, Admin), the
      // search page.
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Search mail"], input[aria-label="Search query"]',
      );
      e.preventDefault();
      if (input) input.focus();
      else nav({ to: "/app/search" });
      return;
    }
    if (e.key === "j") {
      e.preventDefault();
      listNav.step(1);
      return;
    }
    if (e.key === "k") {
      e.preventDefault();
      listNav.step(-1);
      return;
    }
    if (e.key === "c") {
      e.preventDefault();
      openCompose();
      return;
    }
    if (!threadId) return;
    if (e.key === "r") {
      e.preventDefault();
      void withThread(({ last }) => last && openCompose({ replyToMessage: last }));
      return;
    }
    if (e.key === "f") {
      e.preventDefault();
      void withThread(({ last }) => last && openCompose({ forwardMessage: last }));
      return;
    }
    if (e.key === "s") {
      e.preventDefault();
      void withThread(async ({ mailboxId: owner, last }) => {
        if (!last) return;
        await unwrap(
          rpc.messages[":id"].$patch({
            param: { id: last.id },
            json: { starred: !hasFlag(last.flags, Flag.STARRED) },
          }),
        );
        invalidateThreadChange(qc, { mailboxId: owner, threadId });
      });
      return;
    }
    if (e.key === "u") {
      e.preventDefault();
      void withThread(async ({ mailboxId: owner, last }) => {
        if (!last) return;
        await unwrap(rpc.messages[":id"].$patch({ param: { id: last.id }, json: { seen: false } }));
        invalidateThreadChange(qc, { mailboxId: owner, threadId, counts: true, folders: true });
      });
      return;
    }
    if (e.key === "!") {
      e.preventDefault();
      if (view === "spam" && !folderId)
        void moveThread({ spam: false }, "Moved to Inbox", { spam: true });
      else void moveThread({ spam: true }, "Marked as spam", { spam: false });
      return;
    }
    if (e.key === "#") {
      e.preventDefault();
      void moveThread({ trashed: true }, "Moved to Trash", { trashed: false });
    }
  });

  return <ShortcutsDialog open={helpOpen} onClose={() => setShortcutsHelpOpen(false)} />;
}
