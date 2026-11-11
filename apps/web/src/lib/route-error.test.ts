import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { describeRouteError } from "./route-error.ts";

describe("describeRouteError", () => {
  it("says a missing conversation is gone, and offers no retry", () => {
    expect(describeRouteError(new ApiError(404, null, "not found"))).toEqual({
      title: "This doesn't exist any more.",
      hint: "It may have been deleted.",
      retry: false,
    });
  });

  it("says when access was withdrawn", () => {
    expect(describeRouteError(new ApiError(403, null, "forbidden"))).toEqual({
      title: "You don't have access to this.",
      hint: "Ask the owner of the mailbox to share it with you.",
      retry: false,
    });
  });

  it("offers a retry for anything else", () => {
    expect(describeRouteError(new ApiError(500, null, "internal_error")).retry).toBe(true);
    expect(describeRouteError(new ApiError(429, null, "rate limit exceeded")).retry).toBe(true);
    expect(describeRouteError(new Error("Failed to fetch")).retry).toBe(true);
    expect(describeRouteError("weird").retry).toBe(true);
  });

  it("never shows a machine code or a script error", () => {
    expect(describeRouteError(new ApiError(500, null, "internal_error"))).toEqual({
      title: "The server didn't respond. Try again in a moment.",
      retry: true,
    });
    expect(describeRouteError(new ApiError(429, null, "rate limit exceeded")).title).toBe(
      "Too many requests. Wait a minute and try again.",
    );
    expect(describeRouteError(new ApiError(401, null, "unauthenticated")).title).toBe(
      "Something went wrong. Try again.",
    );
    expect(
      describeRouteError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toEqual({ title: "Something went wrong. Try again.", retry: true });
    expect(describeRouteError("weird").title).toBe("Something went wrong. Try again.");
  });

  it("shows a sentence the server wrote for a person", () => {
    expect(
      describeRouteError(new ApiError(409, null, "Delete this domain's mailboxes first.")).title,
    ).toBe("Delete this domain's mailboxes first.");
  });
});
