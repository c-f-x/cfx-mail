import { AlertTriangle } from "lucide-react";
import type * as React from "react";
import type { Contact, MailboxSummary } from "@/lib/queries.ts";
import { AddressField, type RecipientsValue } from "../address-field.tsx";
import { Button } from "../ui/button.tsx";
import { Field, FieldContent, FieldGroup, FieldLabel } from "../ui/field.tsx";
import { FromField } from "./from-field.tsx";
import type { FromAddress } from "./use-from-address.ts";

// Inline value text for a Field's control (Subject), aligned to the label
// baseline and growing only on wrap.
const FIELD_INPUT =
  "w-full bg-transparent py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground";

type Recipients = [RecipientsValue, React.Dispatch<React.SetStateAction<RecipientsValue>>];

// From, To, Cc/Bcc, the blocklist warning and Subject.
export function RecipientFields({
  from,
  sendable,
  contacts,
  to: [to, setTo],
  cc: [cc, setCc],
  bcc: [bcc, setBcc],
  showCc,
  onShowCc,
  blockedRecipients,
  subject,
  onSubjectChange,
  bodyFocusTarget,
}: {
  from: FromAddress;
  sendable: MailboxSummary[];
  contacts: Contact[];
  to: Recipients;
  cc: Recipients;
  bcc: Recipients;
  showCc: boolean;
  onShowCc: () => void;
  blockedRecipients: string[];
  subject: string;
  onSubjectChange: (subject: string) => void;
  /** The body editor, which Tab from Subject moves to. */
  bodyFocusTarget: () => { focus(): void } | null;
}) {
  return (
    <FieldGroup>
      <FromField from={from} sendable={sendable} />
      <AddressField
        label="To"
        value={to}
        onChange={setTo}
        placeholder="name@example.com"
        contacts={contacts}
        trailing={
          !showCc && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onShowCc}
              className="mt-px h-6 px-1.5 text-[11px]"
            >
              Cc/Bcc
            </Button>
          )
        }
      />
      {showCc && (
        <>
          <AddressField
            label="Cc"
            value={cc}
            onChange={setCc}
            placeholder="cc@example.com"
            contacts={contacts}
          />
          <AddressField
            label="Bcc"
            value={bcc}
            onChange={setBcc}
            placeholder="bcc@example.com"
            contacts={contacts}
          />
        </>
      )}
      {blockedRecipients.length > 0 && (
        <div className="my-1.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {blockedRecipients.length === 1
              ? `${blockedRecipients[0]} is on your blocklist`
              : `${blockedRecipients.join(", ")} are on your blocklist`}{" "}
            — they can't reach this server, so you won't receive any reply.
          </span>
        </div>
      )}
      <Field>
        <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
        <FieldContent>
          <input
            id="compose-subject"
            aria-label="Subject"
            value={subject}
            onChange={(e) => onSubjectChange(e.target.value)}
            onKeyDown={(e) => {
              // Skip the format toolbar — Tab from Subject lands in the body.
              if (e.key !== "Tab" || e.shiftKey) return;
              const body = bodyFocusTarget();
              if (!body) return;
              e.preventDefault();
              body.focus();
            }}
            placeholder="Subject"
            className={FIELD_INPUT}
          />
        </FieldContent>
      </Field>
    </FieldGroup>
  );
}
