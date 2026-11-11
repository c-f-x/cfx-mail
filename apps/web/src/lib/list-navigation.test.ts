import { describe, expect, it } from "vitest";
import { stepThread } from "./list-navigation.ts";

describe("stepThread", () => {
  const ids = ["a", "b", "c"];

  it("moves one conversation older or newer", () => {
    expect(stepThread(ids, "b", 1)).toBe("c");
    expect(stepThread(ids, "b", -1)).toBe("a");
  });

  it("stops at the ends", () => {
    expect(stepThread(ids, "c", 1)).toBe("c");
    expect(stepThread(ids, "a", -1)).toBe("a");
  });

  it("opens the first going forward and the last going back when nothing is open", () => {
    expect(stepThread(ids, undefined, 1)).toBe("a");
    expect(stepThread(ids, undefined, -1)).toBe("c");
    expect(stepThread(ids, "gone", 1)).toBe("a");
  });

  it("does nothing in an empty list", () => {
    expect(stepThread([], "a", 1)).toBeUndefined();
  });
});
