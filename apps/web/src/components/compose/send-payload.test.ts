import { describe, expect, it } from "vitest";
import type { UploadedAttachment } from "./compose-utils.ts";
import {
  draftSnapshot,
  outboundAttachments,
  recipientAddresses,
  scheduleProblem,
  sendPayload,
} from "./send-payload.ts";

// What the composer saves as a draft and sends. These pin what ComposeForm
// built inline.

const file: UploadedAttachment = {
  r2Key: "draft/u/1-notes.pdf",
  filename: "notes.pdf",
  contentType: "application/pdf",
  sizeBytes: 10,
};
const inlineUsed: UploadedAttachment = {
  r2Key: "draft/u/2-a.png",
  filename: "a.png",
  contentType: "image/png",
  sizeBytes: 5,
  inline: true,
  contentId: "a@cfmail",
};
const inlineRemoved: UploadedAttachment = {
  ...inlineUsed,
  r2Key: "draft/u/3-b.png",
  contentId: "b@cfmail",
};

describe("draftSnapshot", () => {
  const base = {
    fromAddress: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    mode: "text" as const,
    text: "",
    html: "",
    composedText: "",
    attachments: [],
  };

  it("is empty with nothing typed or attached", () => {
    expect(draftSnapshot(base).isEmpty).toBe(true);
    expect(draftSnapshot({ ...base, composedText: "   " }).isEmpty).toBe(true);
  });

  it("is not empty once anything is filled in", () => {
    expect(draftSnapshot({ ...base, to: [{ address: "a@x.test" }] }).isEmpty).toBe(false);
    expect(draftSnapshot({ ...base, subject: "Hi" }).isEmpty).toBe(false);
    expect(draftSnapshot({ ...base, composedText: "hello" }).isEmpty).toBe(false);
    expect(draftSnapshot({ ...base, attachments: [file] }).isEmpty).toBe(false);
  });

  it("saves the rich body in rich mode and the source otherwise", () => {
    const rich = draftSnapshot({ ...base, mode: "html", text: "src", html: "<p>x</p>" });
    expect(rich.snap).toMatchObject({ body: "<p>x</p>", format: "html" });
    const md = draftSnapshot({ ...base, mode: "markdown", text: "*x*", html: "<p>old</p>" });
    expect(md.snap).toMatchObject({ body: "*x*", format: "markdown" });
  });
});

describe("outboundAttachments", () => {
  it("keeps files and the inline images still in the body", () => {
    expect(outboundAttachments([file, inlineUsed, inlineRemoved], new Set(["a@cfmail"]))).toEqual([
      file,
      inlineUsed,
    ]);
  });
});

describe("sendPayload", () => {
  const input = {
    mailboxId: "mb1",
    fromAddress: null,
    to: [{ address: "a@x.test" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: { text: "hello", html: undefined },
    inReplyTo: undefined,
    references: undefined,
    quote: null,
    attachments: [],
    followUpDays: undefined,
  };

  it("leaves out what is empty", () => {
    expect(sendPayload(input)).toEqual({
      mailboxId: "mb1",
      fromAddress: undefined,
      to: [{ address: "a@x.test" }],
      cc: undefined,
      bcc: undefined,
      subject: "Hi",
      text: "hello",
      html: undefined,
      inReplyTo: undefined,
      references: undefined,
      quote: undefined,
      attachments: undefined,
      followUpDays: undefined,
    });
  });

  it("carries the rest, inline images with their content id", () => {
    const out = sendPayload({
      ...input,
      fromAddress: "a+tag@example.com",
      cc: [{ address: "c@x.test" }],
      bcc: [{ address: "b@x.test" }],
      inReplyTo: "<p>",
      references: ["<r>", "<p>"],
      quote: { messageId: "m1", kind: "reply" },
      attachments: [file, inlineUsed],
      followUpDays: 3,
    });
    expect(out).toMatchObject({
      fromAddress: "a+tag@example.com",
      cc: [{ address: "c@x.test" }],
      bcc: [{ address: "b@x.test" }],
      inReplyTo: "<p>",
      references: ["<r>", "<p>"],
      quote: { messageId: "m1", kind: "reply" },
      followUpDays: 3,
    });
    expect(out.attachments).toEqual([
      { r2Key: file.r2Key, filename: "notes.pdf", contentType: "application/pdf" },
      {
        r2Key: inlineUsed.r2Key,
        filename: "a.png",
        contentType: "image/png",
        inline: true,
        contentId: "a@cfmail",
      },
    ]);
  });
});

describe("scheduleProblem", () => {
  const now = Date.UTC(2026, 9, 9, 12);
  it("refuses an invalid date and a time less than a minute ahead", () => {
    expect(scheduleProblem(new Date(Number.NaN), now)).toBe("Pick a valid date and time");
    expect(scheduleProblem(new Date(now + 59_999), now)).toBe(
      "Pick a time at least a minute from now",
    );
    expect(scheduleProblem(new Date(now + 60_000), now)).toBeNull();
  });
});

const v = (items: { address: string }[], input = "") => ({ items, input });

describe("recipientAddresses", () => {
  it("lists the committed addresses once, lowercased, without the half-typed input", () => {
    expect(
      recipientAddresses(
        v([{ address: "A@x.test" }, { address: "not-an-address" }], "typing@x.test"),
        v([{ address: " a@x.test " }]),
        v([{ address: "b@x.test" }]),
      ),
    ).toEqual(["a@x.test", "b@x.test"]);
  });
});
