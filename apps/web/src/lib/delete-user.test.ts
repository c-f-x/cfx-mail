import { describe, expect, it } from "vitest";
import { deleteUserButton, sharedWithText } from "./delete-user.ts";

// The delete-user dialog says on its button exactly what will go.
describe("deleteUserButton", () => {
  it("says only the user goes when no mailbox is ticked", () => {
    expect(deleteUserButton(0)).toBe("Delete user");
  });

  it("counts the ticked mailboxes", () => {
    expect(deleteUserButton(1)).toBe("Delete user and 1 mailbox");
    expect(deleteUserButton(3)).toBe("Delete user and 3 mailboxes");
  });
});

describe("sharedWithText", () => {
  it("names how many other people use a mailbox", () => {
    expect(sharedWithText(1)).toBe("shared with 1 person");
    expect(sharedWithText(4)).toBe("shared with 4 people");
  });

  it("says nothing for a mailbox nobody else uses", () => {
    expect(sharedWithText(0)).toBeNull();
  });
});
