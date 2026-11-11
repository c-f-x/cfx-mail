import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { linkifyText } from "./linkify.tsx";

const hrefs = (text: string): string[] =>
  linkifyText(text).flatMap((node) =>
    isValidElement(node) ? [(node.props as { href: string }).href] : [],
  );

describe("linkifyText", () => {
  it("links urls, www hosts and addresses", () => {
    expect(hrefs("see https://example.com/a, www.example.org and person@example.com.")).toEqual([
      "https://example.com/a",
      "https://www.example.org",
      "mailto:person@example.com",
    ]);
  });

  it("finishes quickly on 80,000 characters with no space or '@'", () => {
    for (const run of ["a".repeat(80_000), "a.".repeat(40_000), "x@".repeat(40_000)]) {
      const t0 = performance.now();
      const nodes = linkifyText(run);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(nodes.length).toBeGreaterThan(0);
    }
  });
});
