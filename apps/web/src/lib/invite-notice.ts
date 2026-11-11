// Why an invite email did not go out, in words for the admin. The reasons are
// the worker's `notSentReason` (api/users.ts).
export type InviteNotSentReason = "no_sender" | "send_failed";

export function inviteNotSentReason(reason: InviteNotSentReason): string {
  return reason === "no_sender"
    ? "No sender address is set. Add one under Admin, Domains, Transactional email, then invite again, or send the link yourself."
    : "Sending failed. Send the link yourself, or try again later.";
}
