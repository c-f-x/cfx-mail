import { describe, expect, it } from "vitest";
import { filterSrcset, isAbsoluteUrl, isAllowedMailUrl, neutralizeCssUrls } from "./mail-urls.ts";

describe("isAllowedMailUrl", () => {
  it.each([
    "/api/messages/proxy-image?u=a&s=b",
    "/api/messages/abc-123/attachments/def-456/raw",
    "/api/messages/abc-123/attachments/def-456/raw?download=1",
    "data:image/png;base64,AAAA",
    "DATA:image/gif;base64,AAAA",
  ])("allows %s", (url) => {
    expect(isAllowedMailUrl(url)).toBe(true);
  });

  it.each([
    "/api/stream",
    "/api/avatar/domain/x.evil.example",
    "/api/messages/proxy-image",
    "/api/messages/a/attachments/../../../stream",
    "/api/messages/a/attachments/%2e%2e/raw",
    "/api/messages/a/attachments/b/other",
    "https://tracker.example/p.gif",
    "//tracker.example/p.gif",
    "cid:unresolved",
    "relative.png",
    "\\api\\stream",
    "",
  ])("rejects %j", (url) => {
    expect(isAllowedMailUrl(url)).toBe(false);
  });

  it("sees through the whitespace a browser ignores", () => {
    expect(isAllowedMailUrl("  /api/messages/proxy-image?u=a")).toBe(true);
    expect(isAllowedMailUrl("/api/str\neam")).toBe(false);
    expect(isAllowedMailUrl("\t/api/stream")).toBe(false);
  });
});

describe("isAbsoluteUrl", () => {
  it("accepts a URL that names its scheme and rejects anything relative", () => {
    expect(isAbsoluteUrl("https://example.com/a")).toBe(true);
    expect(isAbsoluteUrl("mailto:a@example.com")).toBe(true);
    expect(isAbsoluteUrl("/compose?x=1")).toBe(false);
    expect(isAbsoluteUrl("//example.com/")).toBe(false);
    expect(isAbsoluteUrl("#top")).toBe(false);
    expect(isAbsoluteUrl("page.html")).toBe(false);
  });
});

describe("filterSrcset", () => {
  it("keeps allowed candidates with their descriptors", () => {
    expect(
      filterSrcset(
        "/api/messages/proxy-image?u=a 1x, /api/stream 2x, /api/messages/proxy-image?u=b 3x",
      ),
    ).toBe("/api/messages/proxy-image?u=a 1x, /api/messages/proxy-image?u=b 3x");
  });

  it("treats the comma inside a data: URL as part of the URL", () => {
    expect(filterSrcset("data:image/gif;base64,R0lGOD 1x, /api/stream 2x")).toBe(
      "data:image/gif;base64,R0lGOD 1x",
    );
  });

  it("is empty when nothing is allowed", () => {
    expect(filterSrcset("/api/a 1x, https://t.example/b 2x")).toBe("");
    expect(filterSrcset("")).toBe("");
  });
});

describe("neutralizeCssUrls", () => {
  it("replaces a disallowed url() in every quoting style", () => {
    expect(neutralizeCssUrls("background:url(/api/x)")).toBe("background:none");
    expect(neutralizeCssUrls("background:url('/api/x')")).toBe("background:none");
    expect(neutralizeCssUrls('background:url( "/api/x" ) no-repeat')).toBe(
      "background:none no-repeat",
    );
    expect(neutralizeCssUrls("background:URL(https://t.example/p.gif)")).toBe("background:none");
  });

  it("sees through CSS escapes in the function name and the URL", () => {
    expect(neutralizeCssUrls("background:u\\72l(/api/x)")).toBe("background:none");
    expect(neutralizeCssUrls("background:\\75rl(/api/x)")).toBe("background:none");
    expect(neutralizeCssUrls("background:url(\\2fapi\\2fx)")).toBe("background:none");
  });

  it("keeps allowed urls and ordinary declarations byte for byte", () => {
    const css =
      'a{color:red;background:url("/api/messages/proxy-image?u=a&s=b") 0 0/cover}/* url(/api/x) */';
    expect(neutralizeCssUrls(css)).toBe(css);
    expect(neutralizeCssUrls("background:url(data:image/png;base64,AAAA)")).toBe(
      "background:url(data:image/png;base64,AAAA)",
    );
    expect(neutralizeCssUrls('content:"url(/api/x)"')).toBe('content:"url(/api/x)"');
  });

  it("neutralises image-set(), src() and cross-fade() with string URLs", () => {
    expect(neutralizeCssUrls("background:image-set('/api/z' 1x, url(/api/y) 2x)")).toBe(
      "background:none",
    );
    expect(neutralizeCssUrls('background:-webkit-image-set("/api/z" 1x)')).toBe("background:none");
    expect(neutralizeCssUrls("background:src('/api/z')")).toBe("background:none");
  });

  it("drops @import rules", () => {
    expect(neutralizeCssUrls("@import url(/api/x);a{color:red}")).toBe("a{color:red}");
    expect(neutralizeCssUrls('@import "/api/x"; a{color:red}')).toBe(" a{color:red}");
    expect(neutralizeCssUrls("@IMPORT 'x';b{}")).toBe("b{}");
  });

  it("treats a malformed url() as disallowed", () => {
    expect(neutralizeCssUrls("background:url(/api/x 'y')")).toBe("background:none");
  });

  it("finishes quickly on hostile input", () => {
    for (const hostile of [
      "url(".repeat(20_000),
      "u".repeat(80_000),
      "\\".repeat(40_000),
      "@import ".repeat(10_000),
      "image-set(".repeat(20_000),
    ]) {
      const t0 = performance.now();
      neutralizeCssUrls(hostile);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
