import { mentionsAttachment } from "./compose-utils.ts";

export interface SendGuard {
  title: string;
  description: string;
  confirmLabel: string;
}

// Questions to put to the user before a send goes out, in order: a missing
// subject, the classic "forgot the attachment", and a blocked recipient. Only
// the body the user composed is scanned: the quoted original lives server-side
// and never reaches here, so it cannot trip a false attachment warning.
export function sendGuards(input: {
  subject: string;
  composed: string;
  attachments: number;
  uploading: number;
  blockedRecipients: string[];
}): SendGuard[] {
  const guards: SendGuard[] = [];
  if (!input.subject.trim()) {
    guards.push({
      title: "Send without a subject?",
      description: "This message has no subject, so it's easy to miss in the recipient's inbox.",
      confirmLabel: "Send anyway",
    });
  }
  if (input.attachments === 0 && input.uploading === 0 && mentionsAttachment(input.composed)) {
    guards.push({
      title: "Send without an attachment?",
      description: "It looks like you mentioned an attachment, but nothing is attached.",
      confirmLabel: "Send anyway",
    });
  }
  if (input.blockedRecipients.length > 0) {
    guards.push({
      title:
        input.blockedRecipients.length === 1
          ? "Send to a blocked address?"
          : "Send to blocked addresses?",
      description: `You've blocked ${input.blockedRecipients.join(", ")}. They can't reach this server, so you won't receive any reply.`,
      confirmLabel: "Send anyway",
    });
  }
  return guards;
}
