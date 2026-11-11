// One crafted mail must not burn minutes of CPU in the `email()` handler or on
// `/body`. Each pass below was quadratic on a long run of an
// unterminated opener. Differential cases pin the rewrites to the regexes they
// replaced, so ordinary mail produces the same output as before.

import type { DB } from "@cfx-mail/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceBlockBreaks,
  replaceBlocks,
  replaceComments,
  stripTags,
} from "../src/lib/html-strip.ts";
import {
  proxyRemoteContent,
  replaceCssUrls,
  rewriteInlineCids,
  stripCssImports,
} from "../src/mail/img-proxy.ts";
import { bodyForIndex, htmlToText, type ParsedEmail } from "../src/mail/mime.ts";
import { evaluateSpam } from "../src/mail/spam.ts";
import { compileRules, stripTrackers } from "../src/mail/trackers.ts";
import { resolveUnsubscribe } from "../src/mail/unsubscribe.ts";

const LIMIT_MS = 500;

async function within<T>(fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
  return result;
}

const HOSTILE_HTML: Record<string, string> = {
  "80,000 '<'": "<".repeat(80_000),
  "40,000 '<p'": "<p".repeat(40_000),
  "20,000 '<script'": "<script".repeat(20_000),
  "20,000 '<style' with one '</script>'": `${"<style".repeat(20_000)}</script>`,
  "20,000 '<!--'": "<!--".repeat(20_000),
  "80,000 spaces": `${" ".repeat(80_000)}x`,
  "40,000 'a.'": "a.".repeat(40_000),
  "40,000 '<>'": "<>".repeat(40_000),
};

describe("htmlToText / bodyForIndex stay linear", () => {
  it.each(Object.entries(HOSTILE_HTML))("htmlToText: %s", async (_name, html) => {
    await within(() => htmlToText(html));
  });

  it("bodyForIndex falls back to the HTML part of an HTML-only mail", async () => {
    await within(() => bodyForIndex(null, "<".repeat(80_000)));
  });
});

// The regex chain htmlToText used before the rewrite.
function referenceHtmlToText(html: string): string {
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  return html
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|table|ul|ol|blockquote|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const NORMAL_HTML = [
  "<html><head><title>T</title><style>p{color:red}</style></head><body><p>Hello <b>world</b></p><div>Second&nbsp;line &amp; more</div></body></html>",
  "<P>Upper</P><BR><DIV class='x'>Case <A HREF=\"http://x.test\">link</A></DIV>",
  "<!-- a comment --><p>kept</p><!-- another\nmultiline\ncomment -->text",
  "<script>var a = '<p>';</script><noscript>no js</noscript><p>after</p>",
  "<ul><li>one</li><li>two</li></ul><table><tr><td>cell</td><td>cell2</td></tr></table>",
  "  leading   and\ttrailing \r\n\r\n  blank   lines \n\n\n and &#8212; entities &copy; &lt;tag&gt;",
  "1 < 2 and 3 > 2 <> <3 not a tag",
  "<a href='x'>unterminated <b",
  "<header>site</header><pre>code</pre><h1>Title</h1><h6>Small</h6>",
  "<!--unterminated comment <p>text</p>",
  "<script>never closed <p>text</p>",
  "<style>a{}</STYLE>mixed <Script>x</sCRIPT> case",
  "<br/><br /><hr><p\nstyle='x'\n>multi-line tag</p>",
  "",
  "plain text without markup",
];

describe("htmlToText matches the regex chain it replaced", () => {
  it.each(NORMAL_HTML.map((h) => [h.slice(0, 40), h]))("%s", (_name, html) => {
    expect(htmlToText(html as string)).toBe(referenceHtmlToText(html as string));
  });
});

describe("html-strip helpers match their regexes", () => {
  const samples = [...NORMAL_HTML, ...Object.values(HOSTILE_HTML).map((h) => h.slice(0, 600))];
  it.each(samples.map((h) => [h.slice(0, 30), h]))("%s", (_name, html) => {
    const s = html as string;
    expect(stripTags(s, " ")).toBe(s.replace(/<[^>]+>/g, " "));
    expect(replaceComments(s, " ")).toBe(s.replace(/<!--[\s\S]*?-->/g, " "));
    expect(replaceBlocks(s, " ")).toBe(
      s.replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, " "),
    );
    expect(replaceBlockBreaks(s, "\n")).toBe(
      s.replace(/<\/?(p|div|br|li|tr|h[1-6]|table|ul|ol|blockquote|section|article)[^>]*>/gi, "\n"),
    );
  });
});

const hostileMail = (body: { text?: string; html?: string }) =>
  ({
    headers: [],
    subject: "Hello",
    from: { address: "sender@elsewhere.com" },
    attachments: [],
    ...body,
  }) as unknown as ParsedEmail;

describe("spam scoring stays linear on hostile bodies", () => {
  const db = { query: { systemConfig: { findFirst: async () => undefined } } } as unknown as DB;

  it.each(Object.entries(HOSTILE_HTML))("evaluateSpam: %s", async (_name, html) => {
    await within(() =>
      evaluateSpam(db, {
        level: "standard",
        parsed: hostileMail({ html }),
        fromEnvelope: "sender@elsewhere.com",
      }),
    );
  });
});

// With a Spamhaus key and HBL on, the body is also scanned for links, addresses
// and wallets to look up.
describe("spam content extraction stays linear on hostile bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  const db = {
    query: {
      systemConfig: {
        findFirst: async () => ({ value: JSON.stringify({ key: "testkey123456789", hbl: true }) }),
      },
    },
  } as unknown as DB;

  const bodies: Record<string, string> = {
    "40,000 'a.'": "a.".repeat(40_000),
    "80,000 'a'": "a".repeat(80_000),
    "10,000 'http://'": "http://".repeat(10_000),
    "20,000 'bc1'": "bc1".repeat(20_000),
    "20,000 '0x'": "0x".repeat(20_000),
    "20,000 'a@a.'": "a@a.".repeat(20_000),
  };

  it.each(Object.entries(bodies))("evaluateSpam with HBL: %s", async (_name, text) => {
    vi.stubGlobal("fetch", async () => Response.json({ Status: 3 }));
    await within(() =>
      evaluateSpam(db, {
        level: "standard",
        parsed: hostileMail({ text }),
        fromEnvelope: "sender@elsewhere.com",
      }),
    );
  });
});

const HOSTILE_CSS: Record<string, string> = {
  "20,000 'url('": "url(".repeat(20_000),
  "20,000 'url(\"'": 'url("'.repeat(20_000),
  "20,000 'url(a'": "url(a'".repeat(20_000),
  "10,000 '@import '": "@import ".repeat(10_000),
};

describe("CSS url() and @import passes stay linear", () => {
  it.each(Object.entries(HOSTILE_CSS))("proxyRemoteContent <style>: %s", async (_name, css) => {
    await within(() => proxyRemoteContent(`<style>${css}</style><p>x</p>`, "secret"));
  });

  it.each(Object.entries(HOSTILE_CSS))("proxyRemoteContent style=: %s", async (_name, css) => {
    await within(() =>
      proxyRemoteContent(`<div style="${css.replaceAll('"', "&quot;")}">x</div>`, "secret"),
    );
  });

  it.each(Object.entries(HOSTILE_CSS))("stripTrackers <style>: %s", async (_name, css) => {
    await within(() => stripTrackers(`<style>${css}</style>`, compileRules([])));
  });

  it("rewriteInlineCids <style>: 20,000 'url('", async () => {
    await within(() =>
      rewriteInlineCids(`<style>${"url(".repeat(20_000)}</style>`, "m", new Map([["a", "b"]])),
    );
  });
});

// The regexes the CSS passes used before they were rewritten as scans.
const OLD_CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const OLD_CSS_IMPORT_RE = /@import[^;]+;/gi;

const NORMAL_CSS = [
  "background:url(http://x.test/a.png)",
  'background:URL( "http://x.test/a b.png" ) no-repeat',
  "background:url('cid:logo@x')",
  "background:url(data:image/png;base64,AAAA) , url(/a.png)",
  "background:url() url( ) url('') ",
  "a{b:url(x)}c{d:url(y)}",
  "url(a'b) url(\"c'd\") url('e\"f')",
  "url(unterminated",
  'url("unterminated',
  "url(a) url(b",
  'url("a" x) url(b)',
  "url('a'\n) url(\n'b')",
  "url(url(inner)) url( url(x)",
  'x url("a url(b) c" y',
  "@import url(http://x.test/a.css); a{b:c}",
  "@import 'x';@import \"y\"; a{}",
  "@IMPORT;a{} @import x;",
  "@import never ends",
  "@import a @import b; c",
  "",
];

describe("replaceCssUrls and stripCssImports match their regexes", () => {
  it.each(NORMAL_CSS.map((c) => [c, c]))("%j", (_name, css) => {
    const seen: [string, string][] = [];
    const out = replaceCssUrls(css as string, (full, target) => {
      seen.push([full, target]);
      return `<${target}>`;
    });
    const expectedSeen: [string, string][] = [];
    const expected = (css as string).replace(OLD_CSS_URL_RE, (full, _q, target: string) => {
      expectedSeen.push([full, target]);
      return `<${target}>`;
    });
    expect(out).toBe(expected);
    expect(seen).toEqual(expectedSeen);
    expect(stripCssImports(css as string)).toBe((css as string).replace(OLD_CSS_IMPORT_RE, ""));
  });
});

describe("List-Unsubscribe parsing stays linear", () => {
  it("80,000 '<' is read as no target, quickly", async () => {
    const result = await within(() => resolveUnsubscribe("<".repeat(80_000), null));
    expect(result.ok).toBe(false);
  });

  it("still finds the targets in an ordinary header", () => {
    const r = resolveUnsubscribe("<mailto:u@news.example>, <https://news.example/u/1>", null);
    expect(r).toMatchObject({ ok: true, plan: { method: "email", address: "u@news.example" } });
  });
});
