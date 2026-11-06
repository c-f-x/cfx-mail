import { Flag } from "@cfx-mail/shared/flags";
import { describe, expect, it } from "vitest";
import { foldedRun, initialOpen } from "./thread-fold.ts";

const read = (id: string) => ({ id, direction: "in" as const, flags: Flag.SEEN });
const unread = (id: string) => ({ id, direction: "in" as const, flags: 0 });
const sent = (id: string) => ({ id, direction: "out" as const, flags: 0 });

describe("initialOpen", () => {
  it("folds read messages and opens the newest", () => {
    const opened = initialOpen([read("a"), read("b"), sent("c"), read("d")]);
    expect([...opened.open]).toEqual(["d"]);
    expect(opened.focus).toBe("d");
  });

  it("opens every unread message, and lands on the first of them", () => {
    const opened = initialOpen([read("a"), unread("b"), read("c"), unread("d"), read("e")]);
    expect([...opened.open]).toEqual(["b", "d", "e"]);
    expect(opened.focus).toBe("b");
  });

  it("never opens one of our own sent messages for being unread", () => {
    expect([...initialOpen([sent("a"), read("b")]).open]).toEqual(["b"]);
  });

  it("opens a linked message alone", () => {
    const opened = initialOpen([read("a"), unread("b"), read("c")], "a");
    expect([...opened.open]).toEqual(["a"]);
    expect(opened.focus).toBe("a");
  });

  it("falls back to the usual rule when the linked message is not on screen", () => {
    expect([...initialOpen([read("a"), read("b")], "gone").open]).toEqual(["b"]);
  });

  it("remembers which messages were there when the conversation opened", () => {
    expect([...initialOpen([read("a"), read("b")]).ids]).toEqual(["a", "b"]);
  });
});

describe("foldedRun", () => {
  it("hides the run between the first message and the one before the first open one", () => {
    // 0 stays, 1-3 fold away, 4 stays as context, 5 is open.
    expect(foldedRun([false, false, false, false, false, true])).toEqual({ from: 1, to: 4 });
  });

  it("hides nothing when only one message would fold away", () => {
    expect(foldedRun([false, false, false, true])).toBeNull();
  });

  it("starts hiding at two", () => {
    expect(foldedRun([false, false, false, false, true])).toEqual({ from: 1, to: 3 });
  });

  it("hides nothing when the first message is open", () => {
    expect(foldedRun([true, false, false, false, false])).toBeNull();
  });

  it("keeps the first and the last when nothing is open", () => {
    expect(foldedRun([false, false, false, false, false])).toEqual({ from: 1, to: 4 });
  });
});
