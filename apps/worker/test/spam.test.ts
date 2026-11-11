import type { DB } from "@cfx-mail/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hblHash } from "../src/mail/dnsbl.ts";
import type { ParsedEmail } from "../src/mail/mime.ts";
import { evaluateSpam, parseAuthResults } from "../src/mail/spam.ts";

function parsed(opts: {
  authResults?: string;
  subject?: string;
  text?: string;
  html?: string;
  from?: string;
  received?: string[];
  attachments?: { filename: string; content: Uint8Array }[];
}): ParsedEmail {
  const headers: { key: string; value: string }[] = [];
  for (const value of opts.received ?? []) headers.push({ key: "received", value });
  if (opts.authResults) headers.push({ key: "authentication-results", value: opts.authResults });
  return {
    headers,
    subject: opts.subject ?? "Hello",
    text: opts.text ?? "Just a normal message.",
    html: opts.html,
    from: { address: opts.from ?? "sender@elsewhere.com" },
    attachments: opts.attachments ?? [],
  } as unknown as ParsedEmail;
}

// The DB is only touched for the one system_config read of the Spamhaus key.
function dbWithDqsKey(key: string | null, hbl = false): DB {
  const value = key ? JSON.stringify({ key, hbl }) : null;
  return {
    query: { systemConfig: { findFirst: async () => (value ? { value } : undefined) } },
  } as unknown as DB;
}

const fakeDb = dbWithDqsKey(null);

function evalStandard(p: ParsedEmail, db: DB = fakeDb) {
  return evaluateSpam(db, {
    level: "standard",
    parsed: p,
    fromEnvelope: "sender@elsewhere.com",
  });
}

describe("parseAuthResults", () => {
  it("extracts spf/dkim/dmarc results case-insensitively", () => {
    const r = parseAuthResults(
      parsed({ authResults: "mx.cloudflare.net; SPF=pass; dkim=FAIL; dmarc=none" }),
    );
    expect(r).toEqual({ spf: "pass", dkim: "fail", dmarc: "none" });
  });

  it("falls back to Received-SPF when SPF is absent", () => {
    const p = {
      headers: [{ key: "received-spf", value: "Pass (google.com: domain of x)" }],
    } as unknown as ParsedEmail;
    expect(parseAuthResults(p).spf).toBe("pass");
  });

  it("returns empty when no auth headers are present", () => {
    expect(parseAuthResults({ headers: [] } as unknown as ParsedEmail)).toEqual({});
  });
});

describe("evaluateSpam — authentication", () => {
  it("trusts fully authenticated mail (dmarc=pass) without running heuristics", async () => {
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass", text: "you won a lottery!!!" }),
    );
    expect(r.verdict).toBe("clean");
    expect(r.folderSpam).toBe(false);
    expect(r.score).toBe(0);
  });

  it("files forged mail (dmarc=fail) as spam with a forgery reason", async () => {
    const r = await evalStandard(parsed({ authResults: "mx; spf=fail; dkim=fail; dmarc=fail" }));
    expect(r.verdict).toBe("spam");
    expect(r.folderSpam).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/DMARC/i);
  });

  it("treats missing DMARC (but passing SPF) as suspicious, not spam", async () => {
    const r = await evalStandard(parsed({ authResults: "mx; spf=pass; dkim=none; dmarc=none" }));
    expect(r.verdict).toBe("suspicious");
    expect(r.folderSpam).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluateSpam — auth-only level ignores content", () => {
  it("does not escalate on spammy content when level is auth", async () => {
    const r = await evaluateSpam(fakeDb, {
      level: "auth",
      parsed: parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=none",
        subject: "CONGRATULATIONS YOU WON",
        text: "claim your prize now!!! free money bitcoin",
      }),
      fromEnvelope: "x@y.com",
    });
    // Only the "no DMARC policy" signal counts at the auth level → suspicious.
    expect(r.verdict).toBe("suspicious");
  });
});

describe("evaluateSpam — heuristics (standard)", () => {
  it("escalates unauthenticated spammy content toward spam", async () => {
    const r = await evalStandard(
      parsed({
        subject: "CONGRATULATIONS, YOU WON THE LOTTERY",
        text: "Claim your prize now!!! Free money via bitcoin. Wire transfer required.",
      }),
    );
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.verdict).toBe("spam");
  });
});

// ─── Spamhaus DQS ────────────────────────────────────────────────────────────

const DQS_KEY = "testkey123456789";

// Answers keyed by the leading labels of the query name, so a test only has to
// say "this domain is on DBL" — anything unlisted falls through to NXDOMAIN.
function stubDoh(listings: Record<string, string[]>): () => string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const name = new URL(String(input)).searchParams.get("name") ?? "";
    asked.push(name);
    const zone = name.split(`.${DQS_KEY}.`)[1]?.split(".dq.")[0] ?? "";
    const subject = name.split(`.${DQS_KEY}.`)[0] ?? "";
    const codes = listings[`${subject}/${zone}`] ?? [];
    return Response.json({
      Status: codes.length ? 0 : 3,
      Answer: codes.map((data) => ({ name, type: 1, TTL: 60, data })),
    });
  });
  return () => asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("evaluateSpam — Spamhaus DQS", () => {
  it("skips every lookup when no key is configured", async () => {
    const asked = stubDoh({});
    const r = await evalStandard(
      parsed({ received: ["from x (x [69.72.37.164]) by mx.cloudflare.net"] }),
    );
    expect(asked()).toEqual([]);
    expect(r.reasons.join(" ")).not.toMatch(/Spamhaus/);
  });

  // An aligned signature proves the domain owner sent it. A bounce loses the
  // mail for good, where the Spam folder does not.
  // The listing scores instead, and no listing reaches the spam line alone.
  it("scores a DBL-listed sender, without refusing it, when DMARC passes", async () => {
    stubDoh({ "elsewhere.com/dbl": ["127.0.1.4"] });
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.verdict).toBe("suspicious");
    expect(r.reasons.join(" ")).toMatch(/sender domain \(elsewhere\.com\) is listed.*phishing/i);
    expect(r.reject).toBeNull();
  });

  it("refuses a DBL-listed sender domain when DMARC fails", async () => {
    stubDoh({ "elsewhere.com/dbl": ["127.0.1.4"] });
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=fail; dkim=fail; dmarc=fail" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reject).toBe(
      "elsewhere.com is listed by Spamhaus (DBL) — " +
        "https://check.spamhaus.org/listed/?searchterm=elsewhere.com",
    );
  });

  // A listed subdomain such as an ESP's bounce host is one sending stream,
  // not the organisation behind the registered domain.
  it("scores but does not refuse a listed sender subdomain, even when DMARC fails", async () => {
    stubDoh({ "em1234.elsewhere.com/dbl": ["127.0.1.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=fail; dkim=fail; dmarc=fail",
        from: "bounce@em1234.elsewhere.com",
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reasons.join(" ")).toMatch(/sender domain \(em1234\.elsewhere\.com\) is listed/);
    expect(r.reject).toBeNull();
  });

  it("scores but does not refuse an abused-legit domain or a listed link", async () => {
    stubDoh({ "elsewhere.com/dbl": ["127.0.1.103"], "spammy.example/dbl": ["127.0.1.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        html: '<a href="https://spammy.example/x">click</a>',
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reject).toBeNull();
    expect(r.score).toBe(4); // 2 abused-legit sender + 2 (half-weight) link
    expect(r.verdict).toBe("suspicious");
  });

  it("refuses a ZEN-listed connecting host", async () => {
    stubDoh({ "90.89.168.199/zen": ["127.0.0.10"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=none; dmarc=none",
        received: ["from pbl-dqs.blt.spamhaus.net (unknown [199.168.89.90]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reject).toMatch(/199\.168\.89\.90 is listed by Spamhaus \(PBL\)/);
  });

  it("scores but does not refuse a PBL hit on a hop that did not reach us", async () => {
    stubDoh({ "9.9.9.9/zen": ["127.0.0.11"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=none; dmarc=none",
        received: [
          "from relay.example (relay.example) by mx.cloudflare.net", // no IP on the top hop
          "from laptop (laptop [9.9.9.9]) by relay.example",
        ],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reject).toBeNull();
    expect(r.score).toBe(4); // 2 no-DMARC + 2 PBL
    expect(r.verdict).toBe("suspicious");
  });

  it("leaves authenticated mail from unlisted domains clean", async () => {
    stubDoh({});
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r).toMatchObject({ verdict: "clean", score: 0, reasons: [] });
  });

  it("reports a ZRD-listed sender domain with its age", async () => {
    stubDoh({ "elsewhere.com/zrd": ["127.0.2.7"] });
    const r = await evalStandard(
      parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=pass" }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.score).toBe(2);
    expect(r.reasons.join(" ")).toMatch(/first seen 7 hours ago/);
  });

  it("queries the reversed relay IP from the topmost Received header first", async () => {
    const asked = stubDoh({ "4.3.2.1/zen": ["127.0.0.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=none; dmarc=none",
        received: [
          "from relay.example (relay.example [1.2.3.4]) by mx.cloudflare.net",
          "from laptop (laptop [9.9.9.9]) by relay.example",
        ],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(asked()).toContain(`4.3.2.1.${DQS_KEY}.zen.dq.spamhaus.net`);
    // Hops behind the connecting one are checked too, but reported second.
    expect(asked()).toContain(`9.9.9.9.${DQS_KEY}.zen.dq.spamhaus.net`);
    // +2 no DMARC policy, +4 SBL → spam.
    expect(r.score).toBe(6);
    expect(r.verdict).toBe("spam");
    expect(r.reasons.join(" ")).toMatch(/sending IP \(1\.2\.3\.4\).*known spam source/i);
  });

  it("treats a PBL-only listing as a soft signal", async () => {
    stubDoh({ "4.3.2.1/zen": ["127.0.0.10", "127.0.0.11"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        received: ["from relay (relay [1.2.3.4]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    // DMARC passed, so the IP is never looked up at all.
    expect(r.verdict).toBe("clean");
  });

  it("scores a listed link domain below a listed sender domain, capped", async () => {
    stubDoh({ "spammy.example/dbl": ["127.0.1.2"], "worse.example/dbl": ["127.0.1.5"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        html: '<a href="https://a.spammy.example/x?y=1">click</a> <a href="http://worse.example">or</a>',
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.score).toBe(3); // 2 + 2, capped at LINK_SCORE_CAP
    expect(r.reasons.join(" ")).toMatch(/links to spammy\.example/);
  });

  it("ignores the 127.255.255.x error codes instead of reading them as listings", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubDoh({
      "4.3.2.1/zen": ["127.255.255.254"],
      "elsewhere.com/dbl": ["127.255.255.250"],
      "elsewhere.com/zrd": ["127.255.255.254"],
    });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        received: ["from relay (relay [1.2.3.4]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r).toMatchObject({ verdict: "clean", score: 0 });
    // The error codes are reported, so a disabled key does not go unnoticed.
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^spamhaus dqs: /));
    logged.mockRestore();
  });

  // The Spamhaus Blocklist Tester lists the full test hostname, never the
  // registered domain it sits under.
  it("checks the full sender hostname, not just the domain under it", async () => {
    const asked = stubDoh({ "dbl-dqs.blt.spamhaus.net/dbl": ["127.0.1.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=pass; dmarc=pass",
        from: "test@dbl-dqs.blt.spamhaus.net",
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(asked()).toContain(`dbl-dqs.blt.spamhaus.net.${DQS_KEY}.dbl.dq.spamhaus.net`);
    expect(asked()).toContain(`spamhaus.net.${DQS_KEY}.dbl.dq.spamhaus.net`);
    expect(r.reasons.join(" ")).toMatch(/sender domain \(dbl-dqs\.blt\.spamhaus\.net\)/);
    // A listed subdomain on signed mail scores; it does not refuse.
    expect(r.reject).toBeNull();
  });

  // The EHLO name is the relay's own, so a listed subdomain of it refuses too,
  // on mail that fails DMARC.
  it("checks the EHLO name the relay gave", async () => {
    stubDoh({ "zrd-dqs.blt.spamhaus.net/zrd": ["127.0.2.2"] });
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=fail; dkim=fail; dmarc=fail",
        from: "test@unlisted.blt.spamhaus.net",
        received: ["from zrd-dqs.blt.spamhaus.net (unknown [199.168.89.101]) by mx.cloudflare.net"],
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.reasons.join(" ")).toMatch(
      /identified itself as zrd-dqs\.blt\.spamhaus\.net, first seen 2 hours ago/,
    );
    expect(r.reject).toMatch(/zrd-dqs\.blt\.spamhaus\.net is listed by Spamhaus \(ZRD\)/);
  });

  it("makes no DQS query at the auth level", async () => {
    const asked = stubDoh({ "elsewhere.com/dbl": ["127.0.1.2"] });
    await evaluateSpam(dbWithDqsKey(DQS_KEY), {
      level: "auth",
      parsed: parsed({ authResults: "mx; spf=pass; dkim=pass; dmarc=none" }),
      fromEnvelope: "sender@elsewhere.com",
    });
    expect(asked()).toEqual([]);
  });
});

describe("evaluateSpam — content scanning", () => {
  const authed = "mx; spf=pass; dkim=pass; dmarc=pass";

  it("does not let spam phrasing alone flag authenticated mail", async () => {
    stubDoh({});
    const r = await evalStandard(
      parsed({
        authResults: authed,
        subject: "CONGRATULATIONS, YOU WON",
        text: "Claim your prize now!!! Limited time offer, act now.",
      }),
      dbWithDqsKey(DQS_KEY),
    );
    // Legitimate marketing reads like this; only reputation may flag a message
    // whose sender is verified.
    expect(r).toMatchObject({ verdict: "clean", score: 0 });
  });

  it("still counts spam phrasing when the sender is not authenticated", async () => {
    stubDoh({});
    const r = await evalStandard(
      parsed({
        authResults: "mx; spf=pass; dkim=none; dmarc=none",
        subject: "CONGRATULATIONS, YOU WON",
        text: "Claim your prize now!!! Limited time offer, act now.",
      }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(r.verdict).toBe("spam");
  });

  it("flags an authenticated message that links to an HBL-listed URL", async () => {
    const hash = await hblHash("www.hbltest.com/test");
    stubDoh({ [`${hash}._url/hbl`]: ["127.0.3.30"] });
    const r = await evalStandard(
      parsed({ authResults: authed, html: '<a href="https://www.hbltest.com/test">go</a>' }),
      dbWithDqsKey(DQS_KEY, true),
    );
    expect(r.score).toBe(3);
    expect(r.verdict).toBe("suspicious");
    expect(r.reasons.join(" ")).toMatch(/links to https:\/\/www\.hbltest\.com\/test, a URL/);
    expect(r.reject).toBeNull();
  });

  it("files a known-malware attachment as spam on its own", async () => {
    const bytes = new TextEncoder().encode("evil");
    const hash = await hblHash(bytes);
    stubDoh({ [`${hash}._file/hbl`]: ["127.0.3.10"] });
    const r = await evalStandard(
      parsed({ authResults: authed, attachments: [{ filename: "invoice.pdf", content: bytes }] }),
      dbWithDqsKey(DQS_KEY, true),
    );
    expect(r).toMatchObject({ verdict: "spam", score: 5, folderSpam: true, reject: null });
    expect(r.reasons.join(" ")).toMatch(/invoice\.pdf is a file Spamhaus knows as malware/);
  });

  it("looks up addresses and wallets found in the body", async () => {
    const wallet = "0x0123456789abcdef0123456789ABCDEF01234567";
    const [mailHash, walletHash] = await Promise.all([
      hblHash("scammer@hbltest.com"),
      hblHash(wallet.toLowerCase()),
    ]);
    stubDoh({
      [`${mailHash}._email/hbl`]: ["127.0.3.2"],
      [`${walletHash}._cw/hbl`]: ["127.0.3.20"],
    });
    const r = await evalStandard(
      parsed({
        authResults: authed,
        text: `Send payment to ${wallet} and reply to scammer@hbltest.com`,
      }),
      dbWithDqsKey(DQS_KEY, true),
    );
    expect(r.score).toBe(6);
    expect(r.reasons.join(" ")).toMatch(/scammer@hbltest\.com has been seen in spam/);
    expect(r.reasons.join(" ")).toMatch(/crypto address 0x0123/i);
  });

  it("makes no HBL query when the key's plan does not include it", async () => {
    const asked = stubDoh({});
    await evalStandard(
      parsed({ authResults: authed, html: '<a href="https://www.hbltest.com/test">go</a>' }),
      dbWithDqsKey(DQS_KEY),
    );
    expect(asked().join(" ")).not.toMatch(/hbl\.dq\.spamhaus\.net/);
  });
});
