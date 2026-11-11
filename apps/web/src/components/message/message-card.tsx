import { Flag, hasFlag } from "@cfx-mail/shared/flags";
import type { AttachmentDto } from "@cfx-mail/shared/responses";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Image, Paperclip, ShieldCheck, Star } from "lucide-react";
import { useState } from "react";
import { CodeBanner } from "@/components/code-banner.tsx";
import { EmailFrame } from "@/components/email-frame.tsx";
import { LabelChips } from "@/components/labels-menu.tsx";
import { MessageMenu } from "@/components/message-menu.tsx";
import { SenderAvatar } from "@/components/sender-avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { linkifyText } from "@/lib/linkify.tsx";
import { showSenderControlledBanners } from "@/lib/message-trust.ts";
import { useDateTimeFmt } from "@/lib/prefs.ts";
import type { MessageRow } from "@/lib/queries.ts";
import { messageBodyQuery } from "@/lib/queries.ts";
import { sanitizeEmailHtml } from "@/lib/sanitize-email.ts";
import { formatDateTime } from "@/lib/time.ts";
import { AttachmentPreview, attachmentUrl, isPreviewable } from "./attachment-preview.tsx";
import { PgpBanner, SpamBanner, UnsubscribeBanner } from "./banners.tsx";
import { CalendarBanner } from "./calendar-banner.tsx";
import { SenderLock } from "./sender-lock.tsx";

function addrList(list: { name?: string; address: string }[]): string {
  return list.map((a) => a.name ?? a.address).join(", ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Real (non-inline) attachments, shown below the body. Images and PDFs open in
// the in-app viewer; anything else is download-only. Inline `cid:` parts are
// embedded in the HTML and rewritten by the body endpoint, so they're filtered
// out here to avoid duplicating them.
function MessageAttachments({
  messageId,
  attachments,
  hasHtml,
}: {
  messageId: string;
  attachments: AttachmentDto[];
  hasHtml: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const visible = attachments.filter((a) => !(hasHtml && a.inline && a.contentId));
  if (visible.length === 0) return null;
  const chip =
    "flex min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted";
  return (
    <div className="flex flex-wrap gap-2 border-t bg-muted/30 px-4 py-3">
      {visible.map((att) => {
        const viewable = isPreviewable(att.contentType);
        const Icon = viewable
          ? att.contentType.startsWith("image/")
            ? Image
            : FileText
          : Paperclip;
        const label = (
          <>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-[12px]">{att.filename}</span>
              <span className="block text-[11px] text-muted-foreground">
                {formatBytes(att.sizeBytes)}
              </span>
            </span>
          </>
        );
        return (
          <div
            key={att.id}
            className="group flex max-w-full items-stretch overflow-hidden rounded-lg border bg-background shadow-black/[0.02] shadow-sm transition-colors hover:border-primary/40"
          >
            {viewable ? (
              <button type="button" onClick={() => setPreview(att.id)} className={chip}>
                {label}
              </button>
            ) : (
              <a
                href={attachmentUrl(messageId, att.id, true)}
                download={att.filename}
                className={chip}
              >
                {label}
              </a>
            )}
            <a
              href={attachmentUrl(messageId, att.id, true)}
              download={att.filename}
              aria-label={`Download ${att.filename}`}
              className="grid shrink-0 place-items-center border-l px-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="size-4" />
            </a>
          </div>
        );
      })}
      <AttachmentPreview
        messageId={messageId}
        attachments={visible}
        openId={preview}
        onOpenChange={setPreview}
      />
    </div>
  );
}

export function MessageCard({
  msg,
  cardRef,
  readOnly,
  onTrash,
  onRestore,
  onDelete,
  busy,
  threadSpam,
  onToggleStar,
}: {
  msg: MessageRow;
  cardRef?: React.Ref<HTMLElement>;
  readOnly: boolean;
  onTrash?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  busy?: boolean;
  /** The thread sits in Spam. */
  threadSpam: boolean;
  onToggleStar: () => void;
}) {
  // The rendered body (HTML, attachments, calendar invite) is not in the thread
  // payload. It loads when the card mounts, in one request with the bodies of
  // the other cards that mount with it (lib/body-batcher.ts).
  const { data: bodyData, isPending: bodyPending } = useQuery(
    messageBodyQuery(msg.id, msg.threadId),
  );
  const fmt = useDateTimeFmt();
  const bodyHtml = bodyData?.html ? sanitizeEmailHtml(bodyData.html) : null;
  const senderBanners = showSenderControlledBanners(msg, threadSpam);
  const starred = hasFlag(msg.flags, Flag.STARRED);
  const when = new Date(msg.sentAt ?? msg.receivedAt ?? msg.createdAt);

  return (
    <article
      ref={cardRef}
      className="overflow-hidden rounded-lg border bg-card shadow-black/[0.02] shadow-sm"
    >
      <header className="flex items-start justify-between gap-4 border-b px-4 py-2.5">
        <SenderAvatar name={msg.fromName ?? undefined} address={msg.fromAddr} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-[13px]">
            <SenderLock msg={msg} />
            <span className="truncate">
              {msg.fromName ?? msg.fromAddr}{" "}
              <span className="hidden font-normal text-muted-foreground sm:inline">
                &lt;{msg.fromAddr}&gt;
              </span>
            </span>
          </div>
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            {/* On a phone the address and date move under the name, out of the crowded row. */}
            <div className="truncate sm:hidden">
              {msg.fromAddr} · {formatDateTime(when, fmt)}
            </div>
            <div className="truncate">
              <span className="text-muted-foreground/70">to</span> {addrList(msg.toAddrs)}
            </div>
            {msg.ccAddrs && msg.ccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">cc</span> {addrList(msg.ccAddrs)}
              </div>
            )}
            {msg.bccAddrs && msg.bccAddrs.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">bcc</span> {addrList(msg.bccAddrs)}
              </div>
            )}
          </div>
          <LabelChips messageId={msg.id} className="mt-1.5" />
        </div>
        <div className="flex shrink-0 items-center">
          <div className="flex items-center gap-1.5">
            {bodyData && bodyData.trackersBlocked > 0 && (
              <Tooltip
                label={`${bodyData.trackersBlocked} tracking ${bodyData.trackersBlocked === 1 ? "pixel" : "pixels"} blocked`}
              >
                <Badge variant="outline" className="gap-1 px-1.5 text-[11px] text-muted-foreground">
                  <ShieldCheck className="size-3" aria-hidden />
                  {bodyData.trackersBlocked}
                  <span className="sr-only">tracking pixels blocked</span>
                </Badge>
              </Tooltip>
            )}
            <time
              className="hidden text-[11px] text-muted-foreground sm:inline"
              title={when.toLocaleString(undefined, { hour12: fmt.hour12 })}
            >
              {formatDateTime(when, fmt)}
            </time>
            {!readOnly && (
              <Tooltip label={starred ? "Unstar" : "Star"}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onToggleStar}
                  className={cn(starred && "text-amber-500 hover:text-amber-500")}
                  aria-label={starred ? "Unstar" : "Star"}
                  aria-pressed={starred}
                >
                  <Star className={cn(starred && "fill-current")} />
                </Button>
              </Tooltip>
            )}
            <MessageMenu
              msg={msg}
              body={bodyData}
              replyable={!readOnly}
              onTrash={onTrash}
              onRestore={onRestore}
              onDelete={onDelete}
              busy={busy}
            />
          </div>
        </div>
      </header>
      <SpamBanner msg={msg} />
      {senderBanners && (
        <CodeBanner
          from={msg.fromAddr}
          subject={msg.subject}
          text={bodyData?.text}
          html={bodyData?.html}
          direction={msg.direction}
        />
      )}
      <PgpBanner msg={msg} readOnly={readOnly} />
      {senderBanners && <UnsubscribeBanner msg={msg} readOnly={readOnly} />}
      {senderBanners && bodyData?.calendar && <CalendarBanner event={bodyData.calendar} />}
      {bodyPending ? (
        // Hold the space with a skeleton while the body loads. Rendering the
        // snippet here flashed a plain-text preview that then got replaced by the
        // HTML frame — the "text first, then HTML" lag.
        <div className="space-y-2 px-4 py-3" aria-hidden>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ) : bodyHtml ? (
        // Untrusted HTML renders in a sandboxed, scriptless iframe so a
        // sanitizer bypass can't reach the app origin or the session.
        <EmailFrame html={bodyHtml} />
      ) : (
        // Plain-text body once loaded (or the snippet if parsing yields neither).
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] px-4 py-3 font-sans text-[13px]">
          {linkifyText(bodyData?.text ?? msg.snippet)}
        </pre>
      )}
      {bodyData?.attachments && bodyData.attachments.length > 0 && (
        <MessageAttachments
          messageId={msg.id}
          attachments={bodyData.attachments}
          hasHtml={Boolean(bodyHtml)}
        />
      )}
    </article>
  );
}
