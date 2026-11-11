import type { EmailTemplate } from "@cfx-mail/shared/responses";
import { Lock, Paperclip, Send, ShieldCheck, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { ButtonGroup } from "../ui/button-group.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { MAX_ATTACHMENTS } from "./compose-utils.ts";
import { FollowUpPopover, TemplatesPopover } from "./footer-popovers.tsx";
import { SchedulePopover } from "./schedule-popover.tsx";

// Send and Send later, attach, templates, "Remind me if no reply", the PGP
// badge, the save/upload status and Discard.
export function ComposeFooter({
  canSend,
  sending,
  scheduling,
  onSend,
  scheduleOpen,
  onScheduleOpenChange,
  onSchedule,
  attachmentCount,
  onFiles,
  templates,
  onInsertTemplate,
  followUp,
  onFollowUpChange,
  followUpDays,
  onFollowUpDaysChange,
  pgpMode,
  uploading,
  noSendable,
  savedHint,
  onDiscard,
}: {
  /** False while sending, scheduling or uploading, or without a sender or recipient. */
  canSend: boolean;
  sending: boolean;
  scheduling: boolean;
  onSend: () => void;
  scheduleOpen: boolean;
  onScheduleOpenChange: (open: boolean) => void;
  onSchedule: (when: Date) => void;
  attachmentCount: number;
  onFiles: (files: File[]) => void;
  templates: EmailTemplate[];
  onInsertTemplate: (t: EmailTemplate) => void;
  followUp: boolean;
  onFollowUpChange: (on: boolean) => void;
  followUpDays: number;
  onFollowUpDaysChange: (days: number) => void;
  pgpMode: string;
  uploading: number;
  noSendable: boolean;
  savedHint: boolean;
  onDiscard: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-2">
      <div className="flex items-center gap-1">
        <ButtonGroup>
          <Button variant="primary" onClick={onSend} disabled={!canSend}>
            {sending ? <Spinner /> : <Send />}
            {sending ? "Sending…" : "Send"}
          </Button>
          <SchedulePopover
            open={scheduleOpen}
            onOpenChange={onScheduleOpenChange}
            disabled={!canSend}
            pending={scheduling}
            onSchedule={onSchedule}
          />
        </ButtonGroup>
        <IconButton
          label="Attach files"
          icon={Paperclip}
          onClick={() => fileInputRef.current?.click()}
          disabled={attachmentCount >= MAX_ATTACHMENTS}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Attach files"
          className="hidden"
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <TemplatesPopover templates={templates} onInsert={onInsertTemplate} />
        <FollowUpPopover
          followUp={followUp}
          onFollowUpChange={onFollowUpChange}
          days={followUpDays}
          onDaysChange={onFollowUpDaysChange}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {pgpMode !== "off" && (
          <Badge variant="primary" className="shrink-0">
            {pgpMode === "sign_encrypt" ? (
              <Lock className="size-3" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            {pgpMode === "sign_encrypt" ? "Encrypt + sign" : "Sign"}
          </Badge>
        )}
        <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          {uploading > 0 ? (
            <>
              <Spinner className="size-3" />
              Uploading {uploading}…
            </>
          ) : noSendable ? (
            "No sendable mailboxes"
          ) : savedHint ? (
            "Draft saved"
          ) : null}
        </span>
        <IconButton
          label="Discard draft"
          icon={Trash2}
          onClick={onDiscard}
          className="hover:bg-destructive/10 hover:text-destructive"
        />
      </div>
    </div>
  );
}
