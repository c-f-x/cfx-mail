// Reply and forward quote the original mail. The composer shows the user a
// cleaned preview, but the outbound HTML is built here from the stored `.eml`,
// so whatever survives this path goes out under the user's name and DKIM key
// (audit S11; 03 F6).

import { message } from "@cfmail/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQuote } from "../src/mail/quote.ts";
import { sanitizeQuoteHtml } from "../src/mail/sanitize.ts";
import { applyMigrationsOnce, db, e, resetDb } from "./support/app.ts";
import { MAILBOX_ID, OWNER_ID, seedBase, seedThread } from "./support/seed.ts";

beforeAll(applyMigrationsOnce);
beforeEach(async () => {
  await resetDb();
  await seedBase(db());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function quoteOf(html: string, text?: string, kind: "reply" | "forward" = "reply") {
  const { messageId } = await seedThread(db());
  const key = `raw/${MAILBOX_ID}/in/${messageId}.eml`;
  const parts = text
    ? [
        "Content-Type: multipart/alternative; boundary=b",
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
        "--b--",
      ]
    : ["Content-Type: text/html; charset=utf-8", "", html];
  const eml = [
    "MIME-Version: 1.0",
    "From: sender@elsewhere.test",
    "To: team@example.com",
    "Subject: Hello",
    ...parts,
  ].join("\r\n");
  await e.BLOBS.put(key, eml);
  await db().update(message).set({ rawR2Key: key }).where(eq(message.id, messageId));
  const quote = await buildQuote(e, db(), OWNER_ID, { messageId, kind });
  return quote!;
}

// The F5 payload list from the audit, plus the plain script vectors.
const PAYLOADS: Record<string, string> = {
  "entity-encoded javascript:": `<a href="&#106;avascript:alert(1)">x</a>`,
  "hex entity javascript:": `<a href="&#x6A;avascript:alert(1)">x</a>`,
  "named-entity colon": `<a href="javascript&colon;alert(1)">x</a>`,
  "tab inside scheme": `<a href="java&Tab;script:alert(1)">x</a>`,
  vbscript: `<a href="vbscript:msgbox(1)">x</a>`,
  "data: href": `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  "svg xlink": `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  "svg onload": `<svg/onload=alert(1)></svg>`,
  math: `<math><mtext><script>alert(1)</script></mtext></math>`,
  "form with password": `<form action=https://evil.example><input type=password><button formaction="javascript:alert(1)">go</button></form>`,
  "meta refresh": `<meta http-equiv=refresh content="0;url=https://evil.example">`,
  "link stylesheet": `<link rel=stylesheet href=https://evil.example/a.css>`,
  "video poster": `<video poster=https://evil.example/p.png><source src=https://evil.example/v.mp4></video>`,
  "input image": `<input type=image src=https://evil.example/i.png>`,
  "image-set": `<p style="background:image-set('https://evil.example/t.png' 1x)">x</p>`,
  "escaped url()": `<p style="background:u\\72l(https://evil.example/t.png)">x</p>`,
  "css url()": `<p style="background:url(https://evil.example/t.png)">x</p>`,
  "style block": `<style>body{background:url(https://evil.example/t.png)}</style><p>x</p>`,
  script: `<script>alert(1)</script><script src=https://evil.example/s.js></script>`,
  "event handlers": `<img src="https://ok.example/a.png" onerror="alert(1)"><p onclick="alert(1)">x</p>`,
  iframe: `<iframe src=https://evil.example></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  "object and embed": `<object data=https://evil.example/x.swf></object><embed src=https://evil.example/x.swf>`,
  base: `<base href=https://evil.example/>`,
  "conditional comment": `<!--[if mso]><script>alert(1)</script><![endif]-->`,
  "img with javascript: src": `<img src="javascript:alert(1)">`,
  "img with data: src": `<img src="data:image/svg+xml,<svg onload=alert(1)>">`,
  "relative link": `<a href="/api/stream">x</a>`,
  "protocol-relative link": `<a href="//evil.example/">x</a>`,
};

const FORBIDDEN =
  /<script|<style|<svg|<math|<form|<input|<button|<meta|<link|<video|<source|<iframe|<object|<embed|<base|javascript:|vbscript:|data:|onerror|onclick|onload|formaction|xlink|image-set|url\(|u\\72l|evil\.example|alert\(1\)|<!--|\/api\/stream/i;

describe("buildQuote — hostile original HTML", () => {
  it.each(Object.entries(PAYLOADS))("%s does not reach the outbound quote", async (_name, html) => {
    const body = `<p>before</p>${html}<p>after</p>`;
    const quotes = await Promise.all([
      quoteOf(body, undefined, "reply"),
      quoteOf(body, undefined, "forward"),
    ]);
    for (const quote of quotes) {
      expect(quote.html).not.toMatch(FORBIDDEN);
      expect(quote.html).toContain("before");
      expect(quote.html).toContain("after");
    }
  });

  it("keeps the readable text of removed containers but drops script and svg content", async () => {
    const quote = await quoteOf(
      `<form><label>Name</label><input name=n></form><script>secret()</script><svg><text>vector</text></svg>`,
    );
    expect(quote.html).toContain("Name");
    expect(quote.html).not.toContain("secret()");
    expect(quote.html).not.toContain("vector");
  });

  it("cannot close the quote and write as the user", async () => {
    const quote = await quoteOf(`<p>real</p></blockquote></div><p>I agree to pay 1000</p>`);
    const closers = quote.html.split("</blockquote>").length - 1;
    expect(closers).toBe(1);
    expect(quote.html.endsWith("</blockquote></div>")).toBe(true);
    expect(quote.html.indexOf("I agree")).toBeLessThan(quote.html.lastIndexOf("</blockquote>"));
  });

  it("cannot hide the closers behind a stray quote in an unquoted attribute", async () => {
    const quote = await quoteOf(
      `<p title=a"b>hi</p></blockquote></div><p>I agree to pay 1000</p><p title=c">end</p>`,
    );
    expect(quote.html.split("</blockquote>").length - 1).toBe(1);
    expect(quote.html.endsWith("</blockquote></div>")).toBe(true);
    expect(quote.html.indexOf("I agree")).toBeLessThan(quote.html.lastIndexOf("</blockquote>"));
  });

  it("keeps a title that contains quotes and entities intact", async () => {
    const quote = await quoteOf(`<p title='say "hi" &amp; bye'>x</p>`);
    expect(quote.html).toContain(`<p title="say &quot;hi&quot; &amp; bye">x</p>`);
  });

  it("drops a doctype and an xml declaration", async () => {
    const quote = await quoteOf(`<!DOCTYPE html PUBLIC "x"><?xml version="1.0"?><p>body</p>`);
    expect(quote.html).not.toMatch(/doctype|<\?xml/i);
    expect(quote.html).toContain("<p>body</p>");
  });

  it("closes elements the original left open", async () => {
    const quote = await quoteOf(`<div><b>unclosed bold <i>and italic`);
    expect(quote.html).toMatch(/<\/i><\/b><\/div><\/blockquote><\/div>$/);
  });
});

describe("buildQuote — ordinary mail survives", () => {
  const ORDINARY =
    `<div dir="ltr" lang="en"><h2>Agenda</h2><p style="color:#333;margin:0" align="left">Hello ` +
    `<b>bold</b>, <i>italic</i>, <u>under</u>, <s>strike</s>, <code>code</code>.</p>` +
    `<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><hr>` +
    `<table width="100%"><thead><tr><th colspan="2">Head</th></tr></thead>` +
    `<tbody><tr><td valign="top" rowspan="2">a</td><td>b</td></tr></tbody></table>` +
    `<a href="https://example.com/x?a=1&amp;b=2" title="t">link</a> ` +
    `<a href="mailto:jan@example.com">mail</a> <a href="http://example.com/">plain</a>` +
    `<img src="https://cdn.example/a.png" alt="pic" width="10" height="10">` +
    `<img src="cid:logo@x" alt="logo"><font color="red" face="Arial" size="2">font</font>` +
    `<center>c</center><small>s</small><sub>2</sub><sup>3</sup><blockquote>q</blockquote><pre>pre</pre>` +
    `<span>span</span><br></div>`;

  it("keeps formatting, structure, links and images", async () => {
    const quote = await quoteOf(ORDINARY);
    for (const piece of [
      `<h2>Agenda</h2>`,
      `dir="ltr"`,
      `lang="en"`,
      `style="color:#333;margin:0"`,
      `align="left"`,
      `<b>bold</b>`,
      `<i>italic</i>`,
      `<u>under</u>`,
      `<s>strike</s>`,
      `<code>code</code>`,
      `<li>one</li>`,
      `<ol><li>first</li></ol>`,
      `<hr>`,
      `<th colspan="2">Head</th>`,
      `<td valign="top" rowspan="2">a</td>`,
      `<thead>`,
      `<tbody>`,
      `href="https://example.com/x?a=1&amp;b=2"`,
      `title="t"`,
      `href="mailto:jan@example.com"`,
      `href="http://example.com/"`,
      `src="https://cdn.example/a.png"`,
      `alt="pic"`,
      `width="10"`,
      `src="cid:logo@x"`,
      `<font color="red" face="Arial" size="2">font</font>`,
      `<center>c</center>`,
      `<small>s</small>`,
      `<sub>2</sub>`,
      `<sup>3</sup>`,
      `<blockquote>q</blockquote>`,
      `<pre>pre</pre>`,
      `<span>span</span>`,
    ]) {
      expect(quote.html, piece).toContain(piece);
    }
  });

  it("drops attributes outside the allowlist", async () => {
    const quote = await quoteOf(`<p class="x" id="y" data-k="v" name="n">text</p>`);
    expect(quote.html).toContain("<p>text</p>");
  });

  it("keeps the plain-text quote unchanged", async () => {
    const quote = await quoteOf(`<p>Hello <b>there</b></p>`, "Hello there");
    expect(quote.text).toContain("> Hello there");
  });
});

// A sender can hide text in a mail with CSS. The user never saw it, so it must
// not go out under their name when they reply or forward.
describe("buildQuote — text the reader could not see", () => {
  const HIDING: Record<string, string> = {
    "display:none": `style="display:none"`,
    "display:none in an upper-case attribute": `STYLE="display:none"`,
    "display:none, spaced, upper case and important": `style=" DISPLAY : None  ! IMPORTANT ; color:red"`,
    "display:none after a comment": `style="color:red;/* ; */display:/**/none"`,
    "display:none behind a later invalid value": `style="display:none;display:bogus"`,
    "display:none as an HTML entity": `style="display:&#110;one"`,
    "display:none as a hex entity without semicolon": `style="display&#x3A none"`,
    "display:none as a CSS escape": `style="d\\69splay:n\\6F ne"`,
    "display:none after a string holding a semicolon": `style="font-family:'a;b';display:none"`,
    "display:none after an escaped quote": `style="x:\\';display:none"`,
    "visibility:hidden": `style="visibility:hidden"`,
    "visibility:collapse": `style="visibility:collapse"`,
    "opacity:0": `style="opacity:0"`,
    "opacity:0.0": `style="opacity: 0.0"`,
    "opacity:0%": `style="opacity:0%"`,
    "font-size:0": `style="font-size:0"`,
    "font-size:0px": `style="font-size:0px"`,
    "font-size:0.0em": `style="font-size:0.0em"`,
    "font shorthand 0/0": `style="font:0/0 a"`,
    "max-height:0 with overflow:hidden": `style="max-height:0;overflow:hidden"`,
    "height:0px with overflow:hidden": `style="overflow:hidden;height:0px"`,
    "max-width:0 with overflow-x:hidden": `style="max-width:0;overflow-x:hidden"`,
    "position:absolute with left:-9999px": `style="position:absolute;left:-9999px"`,
    "position:fixed with top:-999em": `style="position:fixed;top:-999em"`,
    "text-indent:-9999px": `style="text-indent:-9999px"`,
    "the hidden attribute": `hidden`,
    'hidden="until-found"': `hidden="until-found"`,
    "white on white, short and long hex": `style="color:#fff;background:#FFFFFF"`,
    "white on white, name and hex": `style="color:white;background-color:#fff"`,
    "a colour name on itself": `style="color:Red;background:red"`,
    "text colour on a bgcolor attribute": `bgcolor="#eeeeee" style="color:#EEE"`,
    "color:transparent": `style="color:transparent"`,
    "opacity:0.01": `style="opacity:0.01"`,
    "opacity:3%": `style="opacity:3%"`,
    "a one-pixel box with overflow:hidden": `style="overflow:hidden;width:1px;height:1px"`,
    "clip:rect(0,0,0,0)": `style="position:absolute;clip:rect(0,0,0,0)"`,
    "clip:rect(0 0 0 0)": `style="position:absolute;clip:rect(0 0 0 0)"`,
    "clip-path:inset(50%)": `style="clip-path:inset(50%)"`,
  };

  it.each(Object.entries(HIDING))("drops text hidden with %s", async (_name, attrs) => {
    const quote = await quoteOf(`<p>Seen</p><div ${attrs}>SECRET <b>CLICK</b></div><p>After</p>`);
    expect(quote.html).not.toMatch(/SECRET|CLICK/);
    expect(quote.html).toContain("<p>Seen</p>");
    expect(quote.html).toContain("<p>After</p>");
    expect(quote.text).not.toMatch(/SECRET|CLICK/);
    expect(quote.text).toContain("Seen");
    expect(quote.text).toContain("After");
  });

  it("drops a hidden element whose tag is not on the allowlist", async () => {
    const quote = await quoteOf(`<section style="display:none">SECRET</section><p>Seen</p>`);
    expect(quote.html).not.toContain("SECRET");
    expect(quote.html).toContain("<p>Seen</p>");
  });

  it("drops the links and images inside an element that is removed", async () => {
    const quote = await quoteOf(
      `<div style="display:none"><a href="https://evil.example/">x</a><img src="https://evil.example/a.png"></div><p>Seen</p>`,
    );
    expect(quote.html).not.toContain("evil.example");
  });

  it("drops text nested inside hidden text, unless it is made visible again", async () => {
    const quote = await quoteOf(
      `<div style="visibility:hidden">SECRET<p>ALSO</p><p style="visibility:visible">Shown</p></div>` +
        `<div style="font-size:0">SECRET<span style="font-size:120%">ALSO</span></div>` +
        `<div style="color:#fff;background:#fff">SECRET<span style="background:transparent">ALSO</span>` +
        `<span style="color:#FFF">ALSO</span></div>` +
        `<div style="color:#fff">Shown<span style="background:#fff">ALSO</span></div>`,
    );
    expect(quote.html).not.toMatch(/SECRET|ALSO/);
    expect(quote.html).toContain("Shown");
  });

  // A browser reopens an unclosed <b> in the next paragraph, hiding style and
  // all. The rewriter does not, so everything after it is treated as hidden.
  it("drops what follows a hidden formatting element that another tag closes", async () => {
    const quote = await quoteOf(
      `<p>Seen</p><p><b style="display:none">x</p><p>SECRET</p>TAIL<img src="https://evil.example/a.png">`,
    );
    expect(quote.html).toContain("<p>Seen</p>");
    expect(quote.html).not.toMatch(/SECRET|TAIL|evil\.example/);
  });

  it("keeps the sender's own plain-text part as the plain-text quote", async () => {
    const quote = await quoteOf(`<p>Seen</p><p style="display:none">SECRET</p>`, "Seen as text");
    expect(quote.text).toContain("> Seen as text");
    expect(quote.html).not.toContain("SECRET");
  });
});

describe("buildQuote — visible styled content survives", () => {
  it("keeps text under a zero font size that a child sets back", async () => {
    // What MJML and most responsive templates produce.
    const quote = await quoteOf(
      `<table><tr><td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center">` +
        `<div style="font-size:13px;line-height:1">Visible</div>` +
        `<div style="font: bold 14px/1.2 Arial">Shorthand</div>` +
        `<font size="3">Legacy</font></td></tr></table>`,
    );
    expect(quote.html).toContain("Visible");
    expect(quote.html).toContain("Shorthand");
    expect(quote.html).toContain("Legacy");
  });

  it("keeps a button whose label has its own colour", async () => {
    const quote = await quoteOf(
      `<table><tr><td bgcolor="#0a0" style="color:#0a0;background:#0a0">` +
        `<a href="https://example.com/" style="color:#ffffff">Label</a> <a href="https://example.com/">Link</a>` +
        `</td></tr></table>`,
    );
    expect(quote.html).toContain("Label");
    expect(quote.html).toContain("Link");
  });

  // Between the two a class may set a dark background, and classes are not read.
  it("does not judge a text colour against a background further out", async () => {
    const quote = await quoteOf(
      `<div style="background:#fff"><div><h1 style="color:#fff">Headline</h1></div></div>`,
    );
    expect(quote.html).toContain("Headline");
  });

  it("keeps text whose style only resembles a hiding one", async () => {
    const styles = [
      "display:block;visibility:visible;opacity:1;font-size:14px",
      "opacity:0.5;font-size:0.8em;height:0;max-height:0",
      "height:20px;overflow:hidden;max-width:600px",
      "position:relative;left:-10px;top:-999px;text-indent:2em",
      "position:absolute;left:-10px;top:0",
      "color:#fff;background:#0a0",
      "color:#333;background:#fff url-less",
      "font-family:'display:none';content:&quot;visibility:hidden&quot;",
      "x:(display:none;opacity:0)",
      "font:700 12px Arial",
    ];
    const quote = await quoteOf(styles.map((s, n) => `<p style="${s}">Visible${n}</p>`).join(""));
    for (const n of styles.keys()) expect(quote.html, styles[n]).toContain(`Visible${n}`);
    expect(quote.html).toContain(
      `style="display:block;visibility:visible;opacity:1;font-size:14px"`,
    );
  });

  it("ends the hiding with the element that asked for it", async () => {
    const quote = await quoteOf(
      `<div><span style="font-size:0">SECRET</span>Visible1<br>Visible2</div>Visible3`,
    );
    expect(quote.html).not.toContain("SECRET");
    expect(quote.html).toContain("Visible1<br>Visible2</div>Visible3");
  });
});

describe("sanitizeQuoteHtml — a hostile style attribute", () => {
  const KB100 = 100_000;
  const HOSTILE_STYLES: Record<string, string> = {
    declarations: "a:b;".repeat(KB100 / 4),
    "unterminated comments": "/*".repeat(KB100 / 2),
    backslashes: "\\".repeat(KB100),
    "entity openers": "&#".repeat(KB100 / 2),
    ampersands: "&".repeat(KB100),
    "open parentheses": "(".repeat(KB100),
    "single quotes": "'".repeat(KB100),
    bangs: `display:${"!".repeat(KB100)}`,
    "one long number": `left:-${"9".repeat(KB100)}px;position:absolute`,
    colons: ":".repeat(KB100),
    spaces: `font:${" 0".repeat(KB100 / 2)}`,
  };

  it.each(Object.entries(HOSTILE_STYLES))("handles 100 KB of %s quickly", async (_name, style) => {
    const html = `<p style="${style}">text</p><p>Seen</p>`;
    const t0 = performance.now();
    const out = await sanitizeQuoteHtml(html);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out).toContain("<p>Seen</p>");
  });
});

describe("buildQuote — fail closed", () => {
  it("falls back to the plain-text quote when the rewriter fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("HTMLRewriter", () => {
      throw new Error("rewriter unavailable");
    });
    const quote = await quoteOf(
      `<p>Hello <b>there</b></p><script>alert(1)</script>`,
      "Hello there & <more>",
    );
    expect(quote.html).not.toMatch(/<script|<b>|<p>/);
    expect(quote.html).toContain("Hello there &amp; &lt;more&gt;");
    expect(logged).toHaveBeenCalledWith("quote html sanitize failed", expect.any(Error));
  });
});

describe("sanitizeQuoteHtml", () => {
  it("returns null when the rewriter fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("HTMLRewriter", () => {
      throw new Error("rewriter unavailable");
    });
    expect(await sanitizeQuoteHtml("<p>x</p>")).toBeNull();
    expect(logged).toHaveBeenCalledWith("quote html sanitize failed", expect.any(Error));
  });
});
