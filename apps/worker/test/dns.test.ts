import { afterEach, describe, expect, it, vi } from "vitest";
import { dohQuery } from "../src/mail/dns.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dohQuery", () => {
  it("gives up on a resolver that never answers", async () => {
    // The cron awaits every step, so a hung lookup would hold up the whole tick.
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const started = Date.now();
    await expect(dohQuery("example.com", "TXT", 50)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("treats a resolver error as a failed lookup, not as no records", async () => {
    // A domain-health check that read "no records" here would mark a domain's
    // SPF and DKIM as missing during a resolver outage.
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await expect(dohQuery("example.com", "TXT")).rejects.toThrow("503");
  });

  it("returns the answers of a resolver that does answer", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ Answer: [{ type: 16, data: '"v=spf1 -all"' }] }),
    );
    expect(await dohQuery("example.com", "TXT")).toEqual(["v=spf1 -all"]);
  });
});
