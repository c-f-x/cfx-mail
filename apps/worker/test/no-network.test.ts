import { describe, expect, it } from "vitest";

describe("test isolation", () => {
  it("refuses a real network request", async () => {
    await expect(
      fetch("https://cloudflare-dns.com/dns-query?name=example.com&type=TXT"),
    ).rejects.toThrow("Test tried to reach the network");
  });
});
