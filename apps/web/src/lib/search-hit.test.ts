import { Flag } from "@cfx-mail/shared/flags";
import { describe, expect, it } from "vitest";
import { searchHitView } from "./queries.ts";

describe("searchHitView", () => {
  it("opens a received message beside the inbox", () => {
    expect(searchHitView({ flags: Flag.SEEN, direction: "in" })).toBe("inbox");
  });

  it("opens a sent message beside Sent", () => {
    expect(searchHitView({ flags: 0, direction: "out" })).toBe("sent");
  });

  it("opens a deleted message beside Trash, whichever way it went", () => {
    expect(searchHitView({ flags: Flag.TRASH, direction: "in" })).toBe("trash");
    expect(searchHitView({ flags: Flag.TRASH, direction: "out" })).toBe("trash");
  });
});
