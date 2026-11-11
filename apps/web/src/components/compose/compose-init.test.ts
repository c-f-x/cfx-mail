import { describe, expect, it } from "vitest";
import type { DraftRow, MessageRow } from "@/lib/queries.ts";
import {
  composeTitle,
  initialBody,
  initialFormat,
  initialRecipients,
  initialSubject,
  quoteRefOf,
  selfAddresses,
  threading,
} from "./compose-init.ts";

// How the composer fills itself when it opens: from a reopened draft, a reply,
// a forward, or a mailto: seed. These pin what ComposeForm did inline.

const message = (over: Partial<MessageRow> = {}) =>
  ({
    id: "m1",
    mailboxId: "mb1",
    fromAddr: "ann@elsewhere.test",
    fromName: "Ann",
    toAddrs: [{ address: "team@example.com" }, { address: "bob@elsewhere.test", name: "Bob" }],
    ccAddrs: [{ address: "cat@elsewhere.test" }, { address: "Team@example.com" }],
    deliveredTo: "team+sales@example.com",
    subject: "Plans",
    messageIdHdr: "<m1@elsewhere.test>",
    references: ["<root@elsewhere.test>"],
    ...over,
  }) as unknown as MessageRow;

const draft = (over: Partial<DraftRow> = {}) =>
  ({
    id: "d1",
    toAddrs: [{ address: "x@elsewhere.test" }],
    ccAddrs: [],
    bccAddrs: [],
    subject: "Saved",
    format: "text",
    body: "draft body",
    inReplyTo: null,
    references: null,
    quoteMessageId: null,
    quoteKind: null,
    ...over,
  }) as unknown as DraftRow;

const mailboxes = [{ id: "mb1", address: "Team@example.com" }];
const empty = { replyAll: false };

describe("selfAddresses", () => {
  it("holds the replying mailbox's address and the delivered-to address, lowercased", () => {
    expect(selfAddresses(message(), mailboxes)).toEqual(
      new Set(["team@example.com", "team+sales@example.com"]),
    );
  });

  it("is empty without a reply", () => {
    expect(selfAddresses(null, mailboxes)).toEqual(new Set());
  });
});

describe("initialRecipients", () => {
  const self = new Set(["team@example.com", "team+sales@example.com"]);

  it("takes a reopened draft's recipients and shows Cc/Bcc when it has any", () => {
    const r = initialRecipients({
      ...empty,
      draft: draft({ ccAddrs: [{ address: "c@x.test" }] }),
      replyTo: null,
      self,
    });
    expect(r.to.items).toEqual([{ address: "x@elsewhere.test" }]);
    expect(r.cc.items).toEqual([{ address: "c@x.test" }]);
    expect(r.showCc).toBe(true);
  });

  it("replies to the sender only", () => {
    const r = initialRecipients({ ...empty, draft: null, replyTo: message(), self });
    expect(r.to.items).toEqual([{ address: "ann@elsewhere.test", name: "Ann" }]);
    expect(r.cc.items).toEqual([]);
    expect(r.showCc).toBe(false);
  });

  it("replies to all without ourselves and without repeating To in Cc", () => {
    const r = initialRecipients({
      draft: null,
      replyTo: message({
        ccAddrs: [{ address: "cat@elsewhere.test" }, { address: "BOB@elsewhere.test" }],
      }),
      replyAll: true,
      self,
    });
    expect(r.to.items).toEqual([
      { address: "ann@elsewhere.test", name: "Ann" },
      { address: "bob@elsewhere.test", name: "Bob" },
    ]);
    expect(r.cc.items).toEqual([{ address: "cat@elsewhere.test", name: undefined }]);
    expect(r.showCc).toBe(true);
  });

  it("takes mailto: seeds", () => {
    const r = initialRecipients({
      ...empty,
      draft: null,
      replyTo: null,
      initialTo: ["a@x.test"],
      initialCc: ["c@x.test"],
      initialBcc: ["b@x.test"],
      self,
    });
    expect(r.to.items).toEqual([{ address: "a@x.test" }]);
    expect(r.cc.items).toEqual([{ address: "c@x.test" }]);
    expect(r.bcc.items).toEqual([{ address: "b@x.test" }]);
    expect(r.showCc).toBe(true);
  });

  it("starts empty for a new message", () => {
    const r = initialRecipients({ ...empty, draft: null, replyTo: null, self });
    expect(r).toEqual({
      to: { items: [], input: "" },
      cc: { items: [], input: "" },
      bcc: { items: [], input: "" },
      showCc: false,
    });
  });
});

describe("initialSubject", () => {
  it("prefers the draft, then Re:, then Fwd:, then the seed", () => {
    expect(initialSubject({ draft: draft(), replyTo: message(), forward: null })).toBe("Saved");
    expect(initialSubject({ draft: null, replyTo: message(), forward: null })).toBe("Re: Plans");
    expect(
      initialSubject({ draft: null, replyTo: message({ subject: "RE: Plans" }), forward: null }),
    ).toBe("RE: Plans");
    expect(initialSubject({ draft: null, replyTo: null, forward: message() })).toBe("Fwd: Plans");
    expect(initialSubject({ draft: null, replyTo: null, forward: null, seed: "Hi" })).toBe("Hi");
    expect(initialSubject({ draft: null, replyTo: null, forward: null })).toBe("");
  });
});

describe("initialFormat and initialBody", () => {
  it("keeps a draft's format and body", () => {
    expect(initialFormat({ draft: draft({ format: "markdown" }), defaultMode: "html" })).toBe(
      "markdown",
    );
    expect(initialBody(draft({ format: "html", body: "<p>x</p>" }), "html")).toEqual({
      text: "",
      html: "<p>x</p>",
    });
    expect(initialBody(draft(), "text")).toEqual({ text: "draft body", html: "" });
  });

  it("opens a mailto: body in plain text, whatever the default editor", () => {
    expect(initialFormat({ draft: null, seedBody: "hello", defaultMode: "html" })).toBe("text");
    expect(initialBody(null, "text", "hello")).toEqual({ text: "hello", html: "" });
  });

  it("uses the default editor otherwise, plain text when unset", () => {
    expect(initialFormat({ draft: null, defaultMode: "html" })).toBe("html");
    expect(initialFormat({ draft: null })).toBe("text");
    expect(initialBody(null, "html")).toEqual({ text: "", html: "" });
  });
});

describe("threading", () => {
  it("takes a draft's headers", () => {
    expect(threading(draft({ inReplyTo: "<a>", references: ["<r>", "<a>"] }), message())).toEqual({
      inReplyTo: "<a>",
      references: ["<r>", "<a>"],
    });
  });

  it("derives a reply's headers from the message answered", () => {
    expect(threading(null, message())).toEqual({
      inReplyTo: "<m1@elsewhere.test>",
      references: ["<root@elsewhere.test>", "<m1@elsewhere.test>"],
    });
  });

  it("has none for a new message", () => {
    expect(threading(null, null)).toEqual({ inReplyTo: undefined, references: undefined });
  });
});

describe("quoteRefOf and composeTitle", () => {
  it("quotes the reply, the forward or the draft's saved quote", () => {
    expect(quoteRefOf(message(), null, null)).toEqual({ messageId: "m1", kind: "reply" });
    expect(quoteRefOf(null, message({ id: "m2" }), null)).toEqual({
      messageId: "m2",
      kind: "forward",
    });
    expect(quoteRefOf(null, null, draft({ quoteMessageId: "m3", quoteKind: "forward" }))).toEqual({
      messageId: "m3",
      kind: "forward",
    });
    expect(quoteRefOf(null, null, draft())).toBeNull();
  });

  it("titles the window by what is being written", () => {
    expect(composeTitle({ replyTo: message(), replyAll: true, forward: null, quote: null })).toBe(
      "Reply all",
    );
    expect(composeTitle({ replyTo: message(), forward: null, quote: null })).toBe("Reply");
    expect(composeTitle({ replyTo: null, forward: message(), quote: null })).toBe("Forward");
    expect(
      composeTitle({ replyTo: null, forward: null, quote: { messageId: "m", kind: "forward" } }),
    ).toBe("Forward");
    expect(
      composeTitle({ replyTo: null, forward: null, quote: { messageId: "m", kind: "reply" } }),
    ).toBe("Reply");
    expect(composeTitle({ replyTo: null, forward: null, quote: null })).toBe("New message");
  });
});
