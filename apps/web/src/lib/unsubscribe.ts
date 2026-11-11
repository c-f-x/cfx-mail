import type { UnsubscribeTargetDto } from "@cfmail/shared/responses";

// The confirm dialog shown before an unsubscribe is sent. It names where the
// request goes, because the target comes from the mail's own headers.
export function unsubscribeConfirm(target: UnsubscribeTargetDto): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  switch (target.method) {
    case "email":
      return {
        title: `Send an unsubscribe email to ${target.address}?`,
        description: "The email is sent from your mailbox address.",
        confirmLabel: "Send email",
      };
    case "one-click":
      return {
        title: `Send an unsubscribe request to ${target.host}?`,
        description: "The request is sent from our server, not from your browser.",
        confirmLabel: "Send request",
      };
    case "link":
      return {
        title: `Open the unsubscribe page at ${target.host}?`,
        description: "The page opens in a new tab.",
        confirmLabel: "Open page",
      };
  }
}
