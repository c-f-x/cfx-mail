import { describe, expect, it } from "vitest";
import { inviteNotSentReason } from "./invite-notice.ts";

// When an invite email does not go out, the admin must learn it, and why, so
// they can pass the link on by hand or fix the cause.
describe("inviteNotSentReason", () => {
  it("names the missing sender address and where to set it", () => {
    expect(inviteNotSentReason("no_sender")).toBe(
      "No sender address is set. Add one under Admin, Domains, Transactional email, then invite again, or send the link yourself.",
    );
  });

  it("says the send failed when a sender is set", () => {
    expect(inviteNotSentReason("send_failed")).toBe(
      "Sending failed. Send the link yourself, or try again later.",
    );
  });
});
