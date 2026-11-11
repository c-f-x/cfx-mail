import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "../src/index.ts";

const headers = () => withSecurityHeaders(new Response("<html></html>")).headers;

describe("withSecurityHeaders", () => {
  it("lets the PDF preview frame a blob: URL and nothing else beyond the app", () => {
    const csp = headers().get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src 'self' blob:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets HSTS, Permissions-Policy and COOP", () => {
    const h = headers();
    expect(h.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(h.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("keeps the existing headers", () => {
    const h = headers();
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});
