import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { canSendFrom } from "@/lib/accounts.ts";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { useUserPrefs } from "@/lib/prefs.ts";
import { contactsQuery, mailboxesQuery, meQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { fillTemplate, type TemplateContext } from "@/lib/templates.ts";
import { collectRecipients, hasRecipients, type RecipientsValue } from "./address-field.tsx";
import { AttachmentList } from "./compose/attachment-list.tsx";
import { ComposeEditor } from "./compose/compose-editor.tsx";
import { ComposeFooter } from "./compose/compose-footer.tsx";
import { ComposeHeader } from "./compose/compose-header.tsx";
import {
  composeTitle,
  initialBody,
  initialFormat,
  initialRecipients,
  initialSubject,
  quoteRefOf,
  selfAddresses,
  threading,
} from "./compose/compose-init.ts";
import {
  type ComposeState,
  closeCompose,
  composeSeedKey,
  popOutUrl,
  registerComposeQueryClient,
  useComposeState,
} from "./compose/compose-store.ts";
import { resolveInlineImages } from "./compose/compose-utils.ts";
import { ImageChoiceDialog } from "./compose/image-choice-dialog.tsx";
import { QuotedMessage } from "./compose/quoted-message.tsx";
import { RecipientFields } from "./compose/recipient-fields.tsx";
import { sendGuards } from "./compose/send-guards.ts";
import {
  draftSnapshot,
  outboundAttachments,
  recipientAddresses,
  scheduleProblem,
  sendPayload,
} from "./compose/send-payload.ts";
import { useAttachments } from "./compose/use-attachments.ts";
import { useComposeBody } from "./compose/use-compose-body.ts";
import { useDraftPersistence } from "./compose/use-draft-persistence.ts";
import { useFromAddress } from "./compose/use-from-address.ts";
import { useConfirm } from "./ui/confirm.tsx";

export type { ComposeState } from "./compose/compose-store.ts";
export { openCompose } from "./compose/compose-store.ts";

export function ComposeDock() {
  const qc = useQueryClient();
  // Let the module-level openCompose() read compose prefs from the Query cache.
  useEffect(() => {
    registerComposeQueryClient(qc);
  }, [qc]);
  const s = useComposeState();
  if (!s.open) return null;
  // Remount when the target changes so the form re-initializes cleanly.
  return (
    <ComposeForm
      key={s.draft?.id ?? s.replyToMessage?.id ?? s.forwardMessage?.id ?? composeSeedKey(s)}
      state={s}
    />
  );
}

const DRAFT_NOT_SAVED = "The draft could not be saved, so it stays here. Try again in a moment.";

export function ComposeForm({
  state: s,
  variant = "dock",
}: {
  state: ComposeState;
  // "dock" = the in-app floating panel; "window" = a standalone pop-out window.
  variant?: "dock" | "window";
}) {
  const isWindow = variant === "window";
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { prefs } = useUserPrefs();
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const { data: contactsData } = useQuery(contactsQuery);
  const { data: meData } = useQuery(meQuery);
  const templates = prefs.templates ?? [];
  const contacts = contactsData?.contacts ?? [];
  const sendable = (mailboxes?.mailboxes ?? []).filter(canSendFrom);
  const d = s.draft;
  const rep = s.replyToMessage;
  const fwd = s.forwardMessage;
  // stable identity feeds `flush`'s deps (autosave), which exhaustive-deps requires
  const quoteRef = useMemo(() => quoteRefOf(rep, fwd, d), [rep, fwd, d]);

  // The account on screen (absent in the standalone window and in folders).
  const { mailboxId: viewingMailboxId } = useParams({ strict: false }) as { mailboxId?: string };
  const from = useFromAddress({
    draft: d,
    replyTo: rep,
    forward: fwd,
    sendable,
    viewingMailboxId,
  });
  const { mailboxId, fromAddress, currentFrom } = from;
  // PGP policy of the selected sending mailbox — drives the compose indicator.
  const pgpMode = sendable.find((m) => m.id === mailboxId)?.pgpMode ?? "off";

  const [initial] = useState(() =>
    initialRecipients({
      draft: d,
      replyTo: rep,
      replyAll: s.replyAll,
      initialTo: s.initialTo,
      initialCc: s.initialCc,
      initialBcc: s.initialBcc,
      self: selfAddresses(rep, mailboxes?.mailboxes ?? []),
    }),
  );
  const [to, setTo] = useState<RecipientsValue>(initial.to);
  const [cc, setCc] = useState<RecipientsValue>(initial.cc);
  const [bcc, setBcc] = useState<RecipientsValue>(initial.bcc);
  const [showCc, setShowCc] = useState(initial.showCc);
  const [subject, setSubject] = useState(() =>
    initialSubject({ draft: d, replyTo: rep, forward: fwd, seed: s.initialSubject }),
  );
  const body = useComposeBody(
    (() => {
      const format = initialFormat({
        draft: d,
        seedBody: s.initialBody,
        defaultMode: prefs.composeDefaultMode,
      });
      return { format, ...initialBody(d, format, s.initialBody) };
    })(),
  );
  const { mode, text, html } = body;

  // Attachment intake; inline images land in the HTML body, promoting a
  // plain-text draft to rich when needed.
  const attach = useAttachments({
    initial: d?.attachments ?? [],
    embedInlineHtml: body.embedInlineHtml,
  });
  const { attachments, uploading } = attach;

  const [expanded, setExpanded] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // "Remind me if no reply" — off until the user opts in; days is the window.
  const [followUp, setFollowUp] = useState(false);
  const [followUpDays, setFollowUpDays] = useState(3);

  const { inReplyTo, references } = threading(d, rep);

  // The current form state as a draft snapshot + whether it's effectively blank.
  // stable identity feeds the debounced-autosave effect's exhaustive-deps
  const currentSnapshot = useCallback(
    () =>
      draftSnapshot({
        fromAddress,
        to: collectRecipients(to),
        cc: collectRecipients(cc),
        bcc: collectRecipients(bcc),
        subject,
        mode,
        text,
        html,
        composedText: body.composedText,
        attachments,
      }),
    [fromAddress, to, cc, bcc, subject, text, html, mode, attachments, body.composedText],
  );

  const { savedHint, invalidateDrafts, deleteDraft, ensureDraftSaved, suppressCloseFlush } =
    useDraftPersistence({
      initialDraftId: d?.id ?? null,
      mailboxId,
      inReplyTo,
      references,
      quoteRef,
      currentSnapshot,
    });

  // The full outbound payload — identical whether the send fires now or later.
  const buildSendPayload = async () =>
    sendPayload({
      mailboxId,
      fromAddress,
      to: collectRecipients(to),
      cc: collectRecipients(cc),
      bcc: collectRecipients(bcc),
      subject,
      body: await body.buildBody(),
      inReplyTo,
      references,
      quote: quoteRef,
      attachments: outboundAttachments(
        attachments,
        mode === "html" ? resolveInlineImages(html).usedCids : new Set<string>(),
      ),
      followUpDays: followUp ? followUpDays : undefined,
    });

  const send = useMutation({
    mutationFn: async () => unwrap(rpc.messages.send.$post({ json: await buildSendPayload() })),
    onSuccess: async (res) => {
      if (res?.pgpWarning) toast.warning(res.pgpWarning);
      else toast.success("Message sent");
      if (mailboxId) qc.invalidateQueries({ queryKey: keys.threadsRoot(mailboxId) });
      // Keep the combined "All" view's lists/counts in sync with the send.
      qc.invalidateQueries({ queryKey: keys.threadsRoot("all") });
      await deleteDraft().catch(() => {});
      // The message is sent and the draft removed — don't let the close-flush
      // resurrect it on unmount.
      suppressCloseFlush();
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  // Defer the send: persist the draft, then hand the server the resolved payload
  // + target time. The draft becomes the scheduled record (visible/cancelable in
  // Drafts) rather than being deleted.
  // onSuccess calls invalidateDrafts() (qc.invalidateQueries) already
  const schedule = useMutation({
    mutationFn: async (sendAt: number) => {
      const saved = await ensureDraftSaved();
      if (!saved.ok) throw new Error(DRAFT_NOT_SAVED);
      const id = saved.id;
      if (!id) throw new Error("Nothing to schedule");
      return unwrap(
        rpc.drafts[":id"].schedule.$post({
          param: { id },
          json: { sendAt, payload: await buildSendPayload() },
        }),
      );
    },
    onSuccess: (_res, sendAt) => {
      toast.success(`Send scheduled for ${new Date(sendAt).toLocaleString()}`);
      invalidateDrafts();
      // The draft now holds the scheduled payload — suppress the close-flush so
      // unmount doesn't PATCH a stale edit over it.
      suppressCloseFlush();
      finish();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to schedule");
    },
  });

  // Warn when a committed recipient is on the deployment blocklist — they can't
  // reach this server, so a reply would bounce. Only committed chips are checked
  // (not the in-progress input), and the query is keyed by the address set so
  // identical sets are served from cache rather than refetched on every keystroke.
  const recipientAddrs = recipientAddresses(to, cc, bcc);
  const { data: blockedData } = useQuery({
    queryKey: ["blocklist-check", recipientAddrs],
    queryFn: () => unwrap(rpc.blocklist.check.$post({ json: { addresses: recipientAddrs } })),
    enabled: recipientAddrs.length > 0,
    staleTime: 30_000,
  });
  const blockedRecipients = recipientAddrs.length ? (blockedData?.blocked ?? []) : [];

  // Close the dock, or close the OS window when running as a pop-out.
  function finish() {
    if (isWindow) window.close();
    else closeCompose();
  }

  function discard() {
    void deleteDraft().catch(() => {});
    // Suppress the close-flush so unmount doesn't re-create the discarded draft.
    suppressCloseFlush();
    finish();
  }

  // Persist the in-progress message and reopen it in a real browser window.
  // window.open must run synchronously inside the click to dodge popup blockers,
  // so the window is created first and pointed at the route once the draft id
  // is known.
  function popOut() {
    const w = window.open("about:blank", "_blank", "popup,width=720,height=860");
    if (!w) {
      toast.error("Allow pop-ups to open the message in a new window");
      return;
    }
    void (async () => {
      const url = popOutUrl(await ensureDraftSaved(), s);
      if (!url) {
        // The new window would open without the text; keep it here instead.
        w.close();
        toast.error(DRAFT_NOT_SAVED);
        return;
      }
      w.location.replace(url);
      closeCompose();
    })();
  }

  // Last checks before mail leaves (compose/send-guards.ts).
  async function passesSendGuards(): Promise<boolean> {
    const guards = sendGuards({
      subject,
      composed: body.composedText,
      attachments: attachments.length,
      uploading,
      blockedRecipients,
    });
    for (const guard of guards) {
      // Sequential on purpose: each question needs an answer before the next.
      // eslint-disable-next-line no-await-in-loop
      if (!(await confirm(guard))) return false;
    }
    return true;
  }

  async function attemptSend() {
    if (await passesSendGuards()) send.mutate();
  }

  // Schedule the send for `when`, applying the same pre-send guards.
  async function scheduleSend(when: Date) {
    const problem = scheduleProblem(when, Date.now());
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!(await passesSendGuards())) return;
    setScheduleOpen(false);
    schedule.mutate(when.getTime());
  }

  // ⌘/Ctrl+Enter sends, when enabled in preferences. Bound on the compose
  // container so it only fires while the composer is focused.
  function onContainerKeyDown(e: React.KeyboardEvent) {
    if (!prefs.sendShortcut) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!send.isPending && uploading === 0 && mailboxId && hasRecipients(to)) void attemptSend();
    }
  }

  // Insert a saved template at the caret. Placeholders are resolved from the
  // current recipient/sender; an unfilled subject is taken from the template.
  function insertTemplate(t: { subject?: string; body: string }) {
    const r = to.items[0];
    const ctx: TemplateContext = {
      recipientName: r?.name,
      recipientEmail: r?.address,
      myName: meData?.user?.name,
      myEmail: currentFrom,
    };
    if (t.subject && !subject.trim()) setSubject(fillTemplate(t.subject, ctx));
    body.insertAtCaret(fillTemplate(t.body, ctx));
  }

  const content = (
    <>
      {attach.dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-primary border-dashed px-8 py-6 text-primary">
            <Paperclip className="size-7" />
            <span className="font-medium text-[13px]">Drop files to attach</span>
          </div>
        </div>
      )}
      <ImageChoiceDialog attach={attach} />
      <ComposeHeader
        isWindow={isWindow}
        title={composeTitle({ replyTo: rep, replyAll: s.replyAll, forward: fwd, quote: quoteRef })}
        pgpMode={pgpMode}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
        onPopOut={popOut}
      />

      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-1">
        <RecipientFields
          from={from}
          sendable={sendable}
          contacts={contacts}
          to={[to, setTo]}
          cc={[cc, setCc]}
          bcc={[bcc, setBcc]}
          showCc={showCc}
          onShowCc={() => setShowCc(true)}
          blockedRecipients={blockedRecipients}
          subject={subject}
          onSubjectChange={setSubject}
          bodyFocusTarget={body.focusTarget}
        />
        <ComposeEditor
          mode={mode}
          text={text}
          onTextChange={body.setText}
          html={html}
          onHtmlChange={body.setHtml}
          preview={body.preview}
          onTogglePreview={() => body.setPreview((v) => !v)}
          previewHtml={body.previewHtml}
          pendingCmd={body.pendingCmdRef.current}
          editorRef={body.editorRef}
          textareaRef={body.bodyTextareaRef}
          onFormat={body.runFormat}
          onToggleMarkdown={body.toggleMarkdown}
          onExitRich={body.exitRich}
        />
        <AttachmentList
          attachments={attachments}
          onRemove={(r2Key) =>
            attach.setAttachments((prev) => prev.filter((x) => x.r2Key !== r2Key))
          }
        />
        {quoteRef && (
          <QuotedMessage quote={quoteRef} snippet={rep?.snippet ?? fwd?.snippet ?? ""} />
        )}
      </div>

      <ComposeFooter
        canSend={
          !send.isPending &&
          !schedule.isPending &&
          uploading === 0 &&
          Boolean(mailboxId) &&
          hasRecipients(to)
        }
        sending={send.isPending}
        scheduling={schedule.isPending}
        onSend={attemptSend}
        scheduleOpen={scheduleOpen}
        onScheduleOpenChange={setScheduleOpen}
        onSchedule={scheduleSend}
        attachmentCount={attachments.length}
        onFiles={(files) => void attach.handleIncomingFiles(files)}
        templates={templates}
        onInsertTemplate={insertTemplate}
        followUp={followUp}
        onFollowUpChange={setFollowUp}
        followUpDays={followUpDays}
        onFollowUpDaysChange={setFollowUpDays}
        pgpMode={pgpMode}
        uploading={uploading}
        noSendable={sendable.length === 0}
        savedHint={savedHint}
        onDiscard={discard}
      />
    </>
  );

  if (isWindow) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: container-level ⌘/Ctrl+Enter send shortcut; inner fields stay the focus targets
      <div // container-level keyboard shortcut wrapper; focus stays on inner fields
        onKeyDown={onContainerKeyDown}
        onPaste={attach.onPaste}
        {...attach.dragHandlers}
        className="relative flex h-dvh flex-col overflow-hidden bg-card text-card-foreground"
      >
        {content}
      </div>
    );
  }
  return (
    <Dialog.Root
      open
      modal="trap-focus"
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) closeCompose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          onKeyDown={onContainerKeyDown}
          onPaste={attach.onPaste}
          {...attach.dragHandlers}
          className={cn(
            "fixed inset-0 z-40 flex flex-col overflow-hidden border bg-card text-card-foreground shadow-black/20 shadow-2xl outline-none transition-all duration-200 data-ending-style:translate-y-3 data-ending-style:opacity-0 data-starting-style:translate-y-3 data-starting-style:opacity-0 sm:inset-auto sm:right-6 sm:bottom-0 sm:rounded-t-xl sm:border-b-0",
            expanded
              ? "sm:h-[88vh] sm:max-h-[860px] sm:w-[760px] sm:max-w-[calc(100vw-3rem)]"
              : "sm:h-[560px] sm:w-[516px]",
          )}
        >
          {content}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
