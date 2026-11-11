import { describe, expect, it } from "vitest";
import { NO_RESPONSE, plainErrorMessage } from "./error-message.ts";

describe("plainErrorMessage", () => {
  it.each([
    [403, "forbidden", "You don't have access to this."],
    [403, "admin only", "You don't have access to this."],
    [403, "owner only", "You don't have access to this."],
    [404, "not_found", "This doesn't exist any more."],
    [404, "not found", "This doesn't exist any more."],
    [429, "rate limit exceeded", "Too many requests. Wait a minute and try again."],
    [500, "internal_error", "The server didn't respond. Try again in a moment."],
    [502, null, "The server didn't respond. Try again in a moment."],
    [503, "", "The server didn't respond. Try again in a moment."],
    [NO_RESPONSE, null, "The server didn't respond. Try again in a moment."],
    [401, "unauthenticated", "Something went wrong. Try again."],
    [400, "empty", "Something went wrong. Try again."],
    [415, "unsupported", "Something went wrong. Try again."],
    [418, undefined, "Something went wrong. Try again."],
  ])("replaces the bare code of a %i (%j) with a plain sentence", (status, code, sentence) => {
    expect(plainErrorMessage(status, code)).toBe(sentence);
  });

  it.each([
    [409, "Delete this domain's mailboxes first."],
    [409, "Move it to Trash first."],
    [403, "Wrong setup token."],
    [500, "Setup is locked. Set the SETUP_TOKEN secret on the Worker, then reload."],
  ])("shows a sentence the server wrote for a person as is (%i %j)", (status, sentence) => {
    expect(plainErrorMessage(status, sentence)).toBe(sentence);
  });

  it.each([
    [409, "a mailbox already owns this address"],
    [403, "system folders cannot be deleted"],
    [410, "invite expired"],
    [502, "send failed: recipient refused"],
  ])("keeps a server message that says what happened (%i %j)", (status, message) => {
    expect(plainErrorMessage(status, message)).toBe(message);
  });

  it("ignores case and surrounding space when it recognises a bare code", () => {
    expect(plainErrorMessage(404, " Not Found ")).toBe("This doesn't exist any more.");
  });

  it("leaves its own sentences alone, so mapping twice changes nothing", () => {
    for (const status of [NO_RESPONSE, 400, 403, 404, 429, 500]) {
      const once = plainErrorMessage(status, "x");
      expect(plainErrorMessage(status, once)).toBe(once);
    }
  });
});
