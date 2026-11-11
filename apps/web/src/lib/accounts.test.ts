import type { FolderCountsDto, MailboxSummaryDto } from "@cfmail/shared";
import { describe, expect, it } from "vitest";
import {
  accountInitial,
  accountLine,
  accountName,
  accountOffers,
  accountTags,
  allAccountsUnread,
  defaultFromMailboxId,
  listTarget,
  RAIL_VIEWS,
  railCount,
  switcherModel,
  VIEW_LABEL,
} from "./accounts.ts";

function account(
  id: string,
  address: string,
  over: Partial<MailboxSummaryDto> = {},
): MailboxSummaryDto {
  return {
    id,
    address,
    displayName: null,
    type: "personal",
    expiresAt: null,
    role: "owner",
    perms: 7,
    unread: 0,
    pgpMode: "off",
    excludeFromAll: false,
    ...over,
  };
}

// The switcher's order: by domain, personal before shared.
const hello = account("hello", "hello@atlas.example", { type: "group" });
const ada = account("ada", "ada@birch.example");
const support = account("support", "support@birch.example", { type: "group" });
const press = account("press", "press@cobalt.example", { type: "group", role: "member", perms: 1 });
const accounts = [hello, ada, support, press];

describe("defaultFromMailboxId", () => {
  it("sends a new message from the account on screen", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: "support", accounts })).toBe("support");
  });

  it("sends from the first personal account in the unified view, not the first in the list", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: "all", accounts })).toBe("ada");
  });

  it("uses the same default in a folder or anywhere without a single account", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: null, accounts })).toBe("ada");
    expect(defaultFromMailboxId({ accounts })).toBe("ada");
  });

  it("falls back to the first account of any kind when none is personal", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: "all", accounts: [hello, support] })).toBe(
      "hello",
    );
  });

  it("answers from the account the mail arrived in, whatever is on screen", () => {
    expect(
      defaultFromMailboxId({ replyMailboxId: "support", viewingMailboxId: "all", accounts }),
    ).toBe("support");
    expect(
      defaultFromMailboxId({ forwardMailboxId: "hello", viewingMailboxId: "ada", accounts }),
    ).toBe("hello");
  });

  it("reopens a draft in the draft's account", () => {
    expect(
      defaultFromMailboxId({ draftMailboxId: "hello", viewingMailboxId: "support", accounts }),
    ).toBe("hello");
  });

  it("never picks an account the user cannot send from", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: "press", accounts })).toBe("ada");
    expect(defaultFromMailboxId({ replyMailboxId: "press", accounts })).toBe("ada");
    expect(defaultFromMailboxId({ draftMailboxId: "press", accounts })).toBe("ada");
    expect(defaultFromMailboxId({ viewingMailboxId: "press", accounts: [press] })).toBe("");
  });

  it("ignores an account that is not in the list", () => {
    expect(defaultFromMailboxId({ viewingMailboxId: "gone", accounts })).toBe("ada");
    expect(defaultFromMailboxId({ accounts: [] })).toBe("");
  });
});

describe("switcherModel", () => {
  it("offers no unified entry and no headings for a single account", () => {
    expect(switcherModel([ada])).toEqual({
      showAllAccounts: false,
      showFilter: false,
      groups: [{ domain: null, accounts: [ada] }],
    });
  });

  it("lists a few accounts flat, with the unified entry", () => {
    const model = switcherModel(accounts);
    expect(model.showAllAccounts).toBe(true);
    expect(model.groups).toEqual([{ domain: null, accounts }]);
  });

  it("groups by domain above four accounts on several domains, keeping the given order", () => {
    const many = [...accounts, account("jobs", "jobs@cobalt.example", { type: "group" })];
    expect(switcherModel(many).groups.map((g) => [g.domain, g.accounts.map((a) => a.id)])).toEqual([
      ["atlas.example", ["hello"]],
      ["birch.example", ["ada", "support"]],
      ["cobalt.example", ["press", "jobs"]],
    ]);
  });

  it("does not group many accounts that share one domain", () => {
    const one = ["a", "b", "c", "d", "e"].map((n) => account(n, `${n}@atlas.example`));
    expect(switcherModel(one).groups).toEqual([{ domain: null, accounts: one }]);
  });

  it("adds a filter above eight accounts, and the filter narrows by address or name", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      account(`m${i}`, `m${i}@d${i % 3}.example`, { displayName: i === 4 ? "Billing" : null }),
    );
    expect(switcherModel(accounts).showFilter).toBe(false);
    expect(switcherModel(many).showFilter).toBe(true);
    const narrowed = switcherModel(many, " BILL ");
    expect(narrowed.groups.flatMap((g) => g.accounts.map((a) => a.id))).toEqual(["m4"]);
    expect(narrowed.showAllAccounts).toBe(false);
    expect(switcherModel(many, "nothing-matches").groups).toEqual([]);
  });
});

describe("account labels", () => {
  it("names an account by its display name, else the part before the @", () => {
    expect(
      accountName(account("x", "support@birch.example", { displayName: " Birch support " })),
    ).toBe("Birch support");
    expect(accountName(ada)).toBe("ada");
  });

  it("marks the tile with the domain's first letter", () => {
    expect(accountInitial(ada)).toBe("B");
    expect(accountInitial(hello)).toBe("A");
  });

  it("tags shared, temporary and read-only accounts", () => {
    expect(accountTags(ada)).toEqual([]);
    expect(accountTags(support)).toEqual(["shared"]);
    expect(accountTags(press)).toEqual(["shared", "read-only"]);
    expect(accountTags(account("t", "t-1@atlas.example", { type: "temp" }))).toEqual(["temporary"]);
  });

  it("leaves accounts opted out of the unified view out of its unread count", () => {
    expect(
      allAccountsUnread([
        account("a", "a@x.example", { unread: 2 }),
        account("b", "b@x.example", { unread: 5, excludeFromAll: true }),
        account("c", "c@x.example", { unread: 1 }),
      ]),
    ).toBe(3);
  });
});

describe("accountLine", () => {
  const all = { kind: "mailbox", mailboxId: "all" } as const;

  it("says which account a conversation is in, in the unified view", () => {
    expect(accountLine(all, "support", accounts)).toBe("to support@birch.example");
  });

  it("says where it was sent from in Sent and Drafts", () => {
    expect(accountLine(all, "ada", accounts, "sent")).toBe("from ada@birch.example");
    expect(accountLine(all, "ada", accounts, "drafts")).toBe("from ada@birch.example");
  });

  it("says it in a folder, which mixes accounts too", () => {
    expect(accountLine({ kind: "folder", folderId: "f1" }, "hello", accounts)).toBe(
      "to hello@atlas.example",
    );
  });

  it("stays silent inside a single account, and for an account it does not know", () => {
    expect(accountLine({ kind: "mailbox", mailboxId: "ada" }, "ada", accounts)).toBeNull();
    expect(accountLine(all, "gone", accounts)).toBeNull();
  });
});

describe("listTarget", () => {
  it("returns to the unified view from a conversation opened there", () => {
    expect(listTarget({ kind: "mailbox", mailboxId: "all" })).toEqual({
      to: "/app/m/$mailboxId",
      params: { mailboxId: "all" },
    });
  });

  it("returns to the account or the folder the conversation was opened in", () => {
    expect(listTarget({ kind: "mailbox", mailboxId: "ada" }).params).toEqual({ mailboxId: "ada" });
    expect(listTarget({ kind: "folder", folderId: "f1" })).toEqual({
      to: "/app/folder/$folderId",
      params: { folderId: "f1" },
    });
  });
});

describe("rail", () => {
  const counts: FolderCountsDto = {
    inbox: { total: 40, unread: 3 },
    drafts: { total: 2, unread: 0 },
    sent: { total: 12, unread: 0 },
    marked: { total: 4, unread: 0 },
    spam: { total: 9, unread: 1 },
    trash: { total: 5, unread: 0 },
    all: { total: 70, unread: 0 },
  };

  it("lists the views as words, Starred and All mail included", () => {
    expect(RAIL_VIEWS.map((v) => (v ? VIEW_LABEL[v] : null))).toEqual([
      "Inbox",
      "Starred",
      "Sent",
      "Drafts",
      null,
      "Spam",
      "Trash",
      "All mail",
    ]);
  });

  it("counts unread in Inbox, drafts in Drafts, and unread quietly in Spam", () => {
    expect(railCount("inbox", counts)).toEqual({ value: 3, kind: "unread" });
    expect(railCount("drafts", counts)).toEqual({ value: 2, kind: "total" });
    expect(railCount("spam", counts)).toEqual({ value: 1, kind: "total" });
  });

  it("shows no number where there is nothing to act on, at zero, or before counts load", () => {
    for (const view of ["sent", "marked", "trash", "all"] as const) {
      expect(railCount(view, counts)).toBeNull();
    }
    const zero = { ...counts, inbox: { total: 40, unread: 0 }, drafts: { total: 0, unread: 0 } };
    expect(railCount("inbox", zero)).toBeNull();
    expect(railCount("drafts", zero)).toBeNull();
    expect(railCount("inbox", undefined)).toBeNull();
  });
});

describe("accountOffers", () => {
  it("offers the admin area to admins only", () => {
    expect(accountOffers("admin").admin).toBe(true);
    for (const role of ["user", undefined, null]) expect(accountOffers(role).admin).toBe(false);
  });

  it("lets everyone manage their own accounts", () => {
    expect(accountOffers("user").manageAccounts).toBe(true);
    expect(accountOffers("admin").manageAccounts).toBe(true);
  });
});
