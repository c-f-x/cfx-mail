import { describe, expect, it } from "vitest";
import { sendGuards } from "./send-guards.ts";

const base = { composed: "Hello", attachments: 0, uploading: 0, blockedRecipients: [] };

describe("sendGuards", () => {
  it("asks nothing for an ordinary send", () => {
    expect(sendGuards(base)).toEqual([]);
  });

  it("asks when the body mentions an attachment but none is attached", () => {
    const [guard, ...rest] = sendGuards({ ...base, composed: "Please see the attached file." });
    expect(rest).toEqual([]);
    expect(guard).toMatchObject({
      title: "Send without an attachment?",
      description: "It looks like you mentioned an attachment, but nothing is attached.",
      confirmLabel: "Send anyway",
    });
  });

  it("does not ask when something is attached or still uploading", () => {
    const composed = "Please see the attached file.";
    expect(sendGuards({ ...base, composed, attachments: 1 })).toEqual([]);
    expect(sendGuards({ ...base, composed, uploading: 1 })).toEqual([]);
  });

  it("asks about blocked recipients, naming them", () => {
    const [guard] = sendGuards({ ...base, blockedRecipients: ["a@x.example", "b@y.example"] });
    expect(guard).toMatchObject({
      title: "Send to blocked addresses?",
      confirmLabel: "Send anyway",
    });
    expect(guard?.description).toContain("a@x.example, b@y.example");
  });

  it("asks both questions, attachment first, when both apply", () => {
    const guards = sendGuards({
      ...base,
      composed: "see attachment",
      blockedRecipients: ["a@x.example"],
    });
    expect(guards.map((g) => g.title)).toEqual([
      "Send without an attachment?",
      "Send to a blocked address?",
    ]);
  });
});
