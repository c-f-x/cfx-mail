import { describe, expect, it } from "vitest";
import { composeWindowUrl, popOutUrl } from "./compose-store.ts";

describe("popOutUrl", () => {
  it("opens the saved draft", () => {
    expect(popOutUrl({ ok: true, id: "d 1" }, {})).toBe("/compose?draft=d%201");
  });

  it("carries the seeded fields when nothing was typed", () => {
    expect(popOutUrl({ ok: true, id: null }, {})).toBe("/compose");
    expect(popOutUrl({ ok: true, id: null }, { initialTo: ["a@example.com"] })).toBe(
      composeWindowUrl({ initialTo: ["a@example.com"] }),
    );
  });

  it("opens nothing when the draft could not be saved, so the text is not lost", () => {
    expect(popOutUrl({ ok: false }, { initialTo: ["a@example.com"] })).toBeNull();
  });
});
