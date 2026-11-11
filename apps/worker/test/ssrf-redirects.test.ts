import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRedirectFetch } from "../src/ssrf.ts";

// A fake network: each entry maps a URL to the response the remote host would
// give. The fake records every URL it was asked to fetch, so a test can prove
// that a blocked hop was never contacted.
function stubNetwork(routes: Record<string, () => Response>): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    // Redirects must be followed by our code, never by fetch itself.
    expect(init?.redirect).toBe("manual");
    const route = routes[url];
    if (!route) throw new Error(`Unexpected request to ${url}`);
    return route();
  });
  return requested;
}

const redirect =
  (location: string | null, status = 302) =>
  () =>
    new Response(null, { status, headers: location === null ? {} : { location } });

const ok =
  (body = "ok") =>
  () =>
    new Response(body, { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeRedirectFetch redirect chains", () => {
  it("returns the final response after following public redirects", async () => {
    const requested = stubNetwork({
      "https://a.example/": redirect("https://b.example/next"),
      "https://b.example/next": redirect("https://c.example/end", 301),
      "https://c.example/end": ok("arrived"),
    });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toBeInstanceOf(Response);
    expect(await (res as Response).text()).toBe("arrived");
    expect(requested).toEqual([
      "https://a.example/",
      "https://b.example/next",
      "https://c.example/end",
    ]);
  });

  it.each([
    ["loopback IPv4", "http://127.0.0.1/admin"],
    ["cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["private IPv4", "http://10.0.0.5/"],
    ["decimal-encoded loopback", "http://2130706433/"],
    ["private IPv6 (unique local)", "http://[fd12:3456:789a::1]/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["localhost", "http://localhost:8787/"],
    ["internal name", "http://db.internal/"],
  ])("blocks a public host that redirects to %s, and never contacts it", async (_name, target) => {
    const requested = stubNetwork({
      "https://public.example/": redirect(target),
    });
    const res = await safeRedirectFetch(new URL("https://public.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked host" });
    expect(requested).toEqual(["https://public.example/"]);
  });

  it("re-validates a hop that sits in the middle of the chain", async () => {
    const requested = stubNetwork({
      "https://a.example/": redirect("https://b.example/"),
      "https://b.example/": redirect("http://169.254.169.254/"),
    });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked host" });
    expect(requested).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it.each([
    ["file:", "file:///etc/passwd"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/plain,hello"],
    ["ftp:", "ftp://files.example/secret"],
  ])("blocks a redirect to a %s URL", async (_name, target) => {
    const requested = stubNetwork({
      "https://public.example/": redirect(target),
    });
    const res = await safeRedirectFetch(new URL("https://public.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked scheme" });
    expect(requested).toEqual(["https://public.example/"]);
  });

  it("blocks a start URL that is internal, without any request", async () => {
    const requested = stubNetwork({});
    const res = await safeRedirectFetch(new URL("http://127.0.0.1/"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked host" });
    expect(requested).toEqual([]);
  });

  it("blocks a start URL with a non-http scheme, without any request", async () => {
    const requested = stubNetwork({});
    const res = await safeRedirectFetch(new URL("file:///etc/passwd"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked scheme" });
    expect(requested).toEqual([]);
  });
});

describe("safeRedirectFetch redirect limit", () => {
  // A host that always redirects to the next numbered path.
  function endlessChain(): { requested: string[] } {
    const requested = stubNetwork(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `https://loop.example/${i}`,
          redirect(`https://loop.example/${i + 1}`),
        ]),
      ),
    );
    return { requested };
  }

  it("gives up after the default of 5 redirects", async () => {
    const { requested } = endlessChain();
    const res = await safeRedirectFetch(new URL("https://loop.example/0"), {});
    expect(res).toEqual({ blocked: true, reason: "too many redirects" });
    // The start URL plus 5 redirects.
    expect(requested).toHaveLength(6);
  });

  it("honours a caller-supplied limit", async () => {
    const { requested } = endlessChain();
    const res = await safeRedirectFetch(new URL("https://loop.example/0"), {}, 2);
    expect(res).toEqual({ blocked: true, reason: "too many redirects" });
    expect(requested).toHaveLength(3);
  });

  it("follows exactly as many redirects as the limit allows", async () => {
    stubNetwork({
      "https://x.example/0": redirect("https://x.example/1"),
      "https://x.example/1": redirect("https://x.example/2"),
      "https://x.example/2": ok("done"),
    });
    const res = await safeRedirectFetch(new URL("https://x.example/0"), {}, 2);
    expect(res).toBeInstanceOf(Response);
    expect(await (res as Response).text()).toBe("done");
  });

  it("stops a redirect loop between two hosts", async () => {
    const requested = stubNetwork({
      "https://a.example/": redirect("https://b.example/"),
      "https://b.example/": redirect("https://a.example/"),
    });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "too many redirects" });
    expect(requested).toHaveLength(6);
  });
});

describe("safeRedirectFetch Location handling", () => {
  it("resolves a relative Location against the current URL", async () => {
    const requested = stubNetwork({
      "https://a.example/dir/start": redirect("../moved"),
      "https://a.example/moved": redirect("/final?x=1"),
      "https://a.example/final?x=1": ok("final"),
    });
    const res = await safeRedirectFetch(new URL("https://a.example/dir/start"), {});
    expect(await (res as Response).text()).toBe("final");
    expect(requested).toEqual([
      "https://a.example/dir/start",
      "https://a.example/moved",
      "https://a.example/final?x=1",
    ]);
  });

  it("resolves a protocol-relative Location and validates its host", async () => {
    const requested = stubNetwork({
      "https://a.example/": redirect("//127.0.0.1/secret"),
    });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "blocked host" });
    expect(requested).toEqual(["https://a.example/"]);
  });

  it("returns the redirect response itself when Location is missing", async () => {
    stubNetwork({ "https://a.example/": redirect(null, 302) });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
  });

  it("treats a blank Location like a missing one", async () => {
    // A blank value would resolve to the current URL and loop; the caller gets
    // the redirect response back after a single request instead.
    const requested = stubNetwork({ "https://a.example/": redirect("") });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect(requested).toEqual(["https://a.example/"]);
  });

  it("returns a bad redirect target as blocked", async () => {
    stubNetwork({ "https://a.example/": redirect("http://[bad") });
    const res = await safeRedirectFetch(new URL("https://a.example/"), {});
    expect(res).toEqual({ blocked: true, reason: "bad redirect target" });
  });

  it.each([200, 204, 404, 500])(
    "returns a %i response without following anything",
    async (status) => {
      const requested = stubNetwork({
        "https://a.example/": () => new Response(null, { status }),
      });
      const res = await safeRedirectFetch(new URL("https://a.example/"), {});
      expect((res as Response).status).toBe(status);
      expect(requested).toEqual(["https://a.example/"]);
    },
  );

  it("passes the caller's method and headers on every hop", async () => {
    const seen: Array<{ method?: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      seen.push({ method: init?.method, auth: new Headers(init?.headers).get("x-token") });
      return String(input) === "https://a.example/"
        ? new Response(null, { status: 307, headers: { location: "https://b.example/" } })
        : new Response("ok");
    });
    await safeRedirectFetch(new URL("https://a.example/"), {
      method: "POST",
      headers: { "x-token": "t" },
    });
    expect(seen).toEqual([
      { method: "POST", auth: "t" },
      { method: "POST", auth: "t" },
    ]);
  });
});
