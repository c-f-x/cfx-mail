import { describe, expect, it } from "vitest";
import { urlHost } from "./url-host.ts";

describe("urlHost", () => {
  it("returns the host a link really goes to", () => {
    expect(urlHost("https://us02web.zoom.us/j/1?pwd=x")).toBe("us02web.zoom.us");
    expect(urlHost("https://zoom.us.evil.example/j/1")).toBe("zoom.us.evil.example");
    expect(urlHost("https://user@evil.example/zoom.us")).toBe("evil.example");
  });

  it("is null for something that is not an absolute URL", () => {
    expect(urlHost("/relative")).toBeNull();
    expect(urlHost("not a url")).toBeNull();
  });
});
