import { describe, expect, it } from "vitest";
import { noMailboxCopy } from "./mailbox-empty.ts";

describe("noMailboxCopy", () => {
  it("points an admin at the admin page", () => {
    expect(noMailboxCopy("admin").hint).toBe(
      "Create a domain and an account for it on the admin page to start sending and receiving.",
    );
    expect(noMailboxCopy("admin").short).toBe("Create one in Admin.");
  });

  it("tells anyone else to ask the administrator, without sending them to Admin", () => {
    for (const role of ["user", undefined] as const) {
      const copy = noMailboxCopy(role);
      expect(copy.hint).toBe(
        "You don't have an account yet. Ask your administrator to give you access to one.",
      );
      expect(copy.short).toBe("Ask your administrator for one.");
      expect(`${copy.hint} ${copy.short}`).not.toMatch(/admin page|from Admin/);
    }
  });
});
