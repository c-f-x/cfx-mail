import { describe, expect, it } from "vitest";
import { rowStyle } from "./use-list-virtualizer.ts";

describe("rowStyle", () => {
  it("places a virtualized row absolutely, `start` px down the spacer, full width", () => {
    expect(rowStyle(120)).toEqual({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      transform: "translateY(120px)",
    });
  });
});
