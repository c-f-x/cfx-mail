import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { rpc, unwrap } from "@/lib/api.ts";
import { keys } from "@/lib/query-keys.ts";
import type { DraftSaveResult } from "./compose-store.ts";
import type { BodyFormat, UploadedAttachment } from "./compose-utils.ts";
import { createLatestQueue } from "./latest-queue.ts";

export interface DraftSnapshot {
  // Plus-alias sender override (e.g. "hi+tag@"), or null for the mailbox's own
  // address. Pairs with the snapshot's mailbox (tracked separately).
  fromAddress: string | null;
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  bcc: { name?: string; address: string }[];
  subject: string;
  // For html mode this is the rich HTML; otherwise the plain/markdown source.
  body: string;
  format: BodyFormat;
  attachments: UploadedAttachment[];
}

// A queued/in-flight autosave: the snapshot, whether it's blank (→ delete), and
// `key` so the close/unload paths can mark it persisted. `keepalive` keeps the
// request alive past an unmount or tab close.
interface DraftFlush {
  snap: DraftSnapshot;
  isEmpty: boolean;
  key: string;
  keepalive?: boolean;
}

interface Options {
  initialDraftId: string | null;
  mailboxId: string;
  inReplyTo: string | undefined;
  references: string[] | undefined;
  quoteRef: { messageId: string; kind: "reply" | "forward" } | null;
  // The current form state as a draft snapshot + whether it's effectively blank.
  currentSnapshot: () => { snap: DraftSnapshot; isEmpty: boolean };
}

// Server-persisted drafts: debounced autosave while typing, a close/unload
// flush so the last <700ms of edits survive, and the delete/ensure-saved
// operations the send/schedule/pop-out paths need.
export function useDraftPersistence({
  initialDraftId,
  mailboxId,
  inReplyTo,
  references,
  quoteRef,
  currentSnapshot,
}: Options) {
  const qc = useQueryClient();
  const [savedHint, setSavedHint] = useState(false);

  const draftIdRef = useRef<string | null>(initialDraftId);
  const initialKeyRef = useRef<string | null>(null);
  // Key of the snapshot last persisted (or the initial, untouched state). Lets
  // the close/unload handlers tell whether there's an unsaved edit to flush.
  const savedKeyRef = useRef<string | null>(null);
  // The most recent snapshot, kept current so close/unmount can flush the last
  // <700ms of typing that the debounce timer would otherwise drop.
  const latestRef = useRef<DraftFlush | null>(null);
  // Saves run one at a time; a save asked for meanwhile waits, newest first.
  const [enqueueSave] = useState(() => createLatestQueue<boolean>());

  // stable identity feeds `deleteDraft`/`flush` deps (autosave), which exhaustive-deps requires
  const invalidateDrafts = useCallback(() => {
    if (!mailboxId) return;
    qc.invalidateQueries({ queryKey: keys.drafts(mailboxId) });
    // Refresh the Drafts badge count (keyed under the threads prefix).
    qc.invalidateQueries({ queryKey: keys.folderCounts(mailboxId) });
  }, [qc, mailboxId]);

  // stable identity feeds `flush` deps (autosave), which exhaustive-deps requires
  const deleteDraft = useCallback(
    async (keepalive?: boolean) => {
      const id = draftIdRef.current;
      if (!id) return;
      draftIdRef.current = null;
      await unwrap(rpc.drafts[":id"].$delete({ param: { id } }, { init: { keepalive } }));
      invalidateDrafts();
    },
    [invalidateDrafts],
  );

  // Resolves true once `data` (or a newer snapshot that replaced it) is stored.
  // stable identity feeds the pagehide-flush effect's exhaustive-deps
  const flush = useCallback(
    (data: DraftFlush): Promise<boolean> =>
      enqueueSave(async () => {
        try {
          if (data.isEmpty) {
            await deleteDraft(data.keepalive);
          } else {
            const payload = {
              ...data.snap,
              inReplyTo,
              references,
              quote: quoteRef,
            };
            if (draftIdRef.current) {
              await unwrap(
                rpc.drafts[":id"].$patch(
                  { param: { id: draftIdRef.current }, json: payload },
                  { init: { keepalive: data.keepalive } },
                ),
              );
            } else {
              // createDraft's schema takes `fromAddress` as optional (not null) —
              // updateDraft is the nullish one — so drop a null before sending.
              const res = await unwrap(
                rpc.drafts.$post(
                  {
                    json: { mailboxId, ...payload, fromAddress: payload.fromAddress ?? undefined },
                  },
                  { init: { keepalive: data.keepalive } },
                ),
              );
              draftIdRef.current = res.draft.id;
            }
            setSavedHint(true);
            invalidateDrafts();
          }
          savedKeyRef.current = data.key;
          return true;
        } catch {
          // Autosave is best-effort; surface nothing on transient failures. The
          // pop-out reads the result and keeps the text where it is.
          return false;
        }
      }),
    [enqueueSave, mailboxId, inReplyTo, references, quoteRef, deleteDraft, invalidateDrafts],
  );

  // Latest-`flush` shim so the debounce effect below doesn't re-subscribe (and
  // reset its timer) every time `flush`'s captured form state changes.
  const onFlush = useEffectEvent((data: DraftFlush) => void flush(data));

  // Debounced autosave. Skips while the form is untouched (so merely opening a
  // reply/forward doesn't spawn a draft) and serializes writes via `flush`.
  useEffect(() => {
    const { snap, isEmpty } = currentSnapshot();
    const key = JSON.stringify(snap);
    if (initialKeyRef.current === null) {
      initialKeyRef.current = key;
      savedKeyRef.current = key;
    }
    latestRef.current = { snap, isEmpty, key };
    if (key === savedKeyRef.current) return;
    const handle = setTimeout(() => onFlush({ snap, isEmpty, key }), 700);
    return () => clearTimeout(handle);
  }, [currentSnapshot]);

  // Flush the last edit when the composer closes or the tab is torn down — the
  // debounce timer is cancelled on unmount, so without this the final <700ms of
  // typing is lost. `keepalive` lets the request outlive the page on tab close.
  useEffect(() => {
    const flushPending = (keepalive: boolean) => {
      const latest = latestRef.current;
      if (!latest || latest.key === savedKeyRef.current) return;
      savedKeyRef.current = latest.key;
      void flush({ ...latest, keepalive });
    };
    const onUnload = () => flushPending(true);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      flushPending(false);
    };
  }, [flush]);

  // Persist the current state and resolve the draft id — used by the pop-out so
  // the new window can rehydrate from the server-saved draft. The id is null
  // only when there is genuinely nothing to carry over. It waits for a save
  // already running, which may be the one that creates the draft.
  const ensureDraftSaved = async (): Promise<DraftSaveResult> => {
    const { snap, isEmpty } = currentSnapshot();
    if (isEmpty) return { ok: true, id: draftIdRef.current };
    const ok = await flush({ snap, isEmpty: false, key: JSON.stringify(snap) });
    return ok ? { ok: true, id: draftIdRef.current } : { ok: false };
  };

  // The draft is sent/scheduled/discarded — don't let the close-flush
  // resurrect it on unmount.
  const suppressCloseFlush = () => {
    latestRef.current = null;
  };

  return { savedHint, invalidateDrafts, deleteDraft, ensureDraftSaved, suppressCloseFlush };
}
