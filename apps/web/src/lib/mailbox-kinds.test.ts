import { MailboxKind } from "@cfmail/shared/permissions";
import { describe, expect, it } from "vitest";
import { formMailboxKinds } from "./mailbox-kinds.ts";

// The "New mailbox" and "Add mailbox" forms make personal and group
// mailboxes. Temp ones come from "New temporary account" and service ones
// from Admin, Service, so the forms never offer those kinds.
describe("formMailboxKinds", () => {
  it("offers personal and group when both are allowed", () => {
    expect(formMailboxKinds(MailboxKind.PERSONAL | MailboxKind.GROUP)).toEqual([
      "personal",
      "group",
    ]);
  });

  it("never offers temp or service", () => {
    expect(formMailboxKinds(15)).toEqual(["personal", "group"]);
    expect(formMailboxKinds(MailboxKind.TEMP | MailboxKind.SERVICE)).toEqual([]);
  });
});
