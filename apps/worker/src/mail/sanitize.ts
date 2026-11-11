// Server-side defense-in-depth for stored email HTML, applied at serve time in
// the message-body endpoint. The client sanitizer (DOMPurify-side allowlist)
// remains the primary defense; this strips the highest-risk vectors so a
// client-side bypass alone can't execute script. Stored mail is never modified.
// A rewrite failure serves the message's text instead, never the unstripped HTML.

import { escapeHtml } from "../lib/encoding.ts";
import { elementVisibility, textHidden, VISIBLE_TEXT } from "./hidden-style.ts";
import { htmlToText } from "./mime.ts";

const BLOCKED_ELEMENTS = ["script", "iframe", "object", "embed", "base"];
const URL_ATTRS = ["href", "src"] as const;

// `javascript:` after stripping the control/whitespace chars HTML parsers
// ignore inside a scheme (`java\nscript:`, `\tjavascript:`).
function isScriptUrl(value: string): boolean {
  let cleaned = "";
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) cleaned += ch;
  }
  return cleaned.toLowerCase().startsWith("javascript:");
}

export async function sanitizeEmailHtml(html: string): Promise<string> {
  try {
    let rewriter = new HTMLRewriter();
    for (const tag of BLOCKED_ELEMENTS) {
      rewriter = rewriter.on(tag, {
        element(el) {
          el.remove();
        },
      });
    }
    const res = rewriter
      .on("*", {
        element(el) {
          const eventAttrs: string[] = [];
          for (const [name] of el.attributes) {
            if (name && /^on/i.test(name)) eventAttrs.push(name);
          }
          for (const name of eventAttrs) el.removeAttribute(name);
          for (const attr of URL_ATTRS) {
            const value = el.getAttribute(attr);
            if (value && isScriptUrl(value)) el.removeAttribute(attr);
          }
        },
      })
      .transform(new Response(html));
    return await res.text();
  } catch (err) {
    console.error("server-side html sanitize failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail closed: the text, escaped, keeps the message readable with no markup
    // left to run.
    return `<div style="white-space:pre-wrap">${escapeHtml(htmlToText(html))}</div>`;
  }
}

// ─── Quoted HTML for replies and forwards ───────────────────────────────────
//
// Unlike the denylist above, this one is an allowlist, because its output is
// sent: whatever survives goes to the recipient under the user's name and DKIM
// key (see quote.ts). Everything not named here is dropped.

const QUOTE_TAGS = new Set(
  "p div span br hr a b strong i em u s blockquote pre code ul ol li table thead tbody tr td th h1 h2 h3 h4 h5 h6 img font center small sub sup".split(
    " ",
  ),
);

// Removed together with their content: it is script, style, or something the
// parser treats as opaque text, and must not surface as readable text.
const QUOTE_DROP_WITH_CONTENT = new Set(
  "script style svg math iframe object embed head title noscript template noembed noframes frameset applet xmp plaintext textarea select option audio video canvas".split(
    " ",
  ),
);

const QUOTE_ATTRS = new Set(
  "alt title width height align valign colspan rowspan style dir lang".split(" "),
);
// Presentation attributes the legacy tags in the list are useless without.
const QUOTE_TAG_ATTRS: Record<string, readonly string[]> = {
  font: ["color", "face", "size"],
  table: ["border", "cellpadding", "cellspacing", "bgcolor"],
  td: ["bgcolor"],
  th: ["bgcolor"],
};

// The raw value must itself start with the scheme. lol-html hands attributes
// back undecoded, so "&#106;avascript:" or "java&Tab;script:" never match and
// are dropped, rather than decoded and judged.
const QUOTE_HREF = /^(?:https?:\/\/|mailto:)/i;
const QUOTE_SRC = /^(?:https?:\/\/|cid:)/i;

// A style that cannot fetch anything or run anything: no url(), image-set(),
// expression(), @-rules, escapes (u\72l) or entities (which decode into any of
// those before the CSS parser sees them).
const UNSAFE_STYLE = /url\s*\(|image-set|expression|@|\\|&|behaviou?r|binding|script:/i;

function quoteAttrAllowed(tag: string, name: string, value: string): boolean {
  if (name === "href") return tag === "a" && QUOTE_HREF.test(value.trim());
  if (name === "src") return tag === "img" && QUOTE_SRC.test(value.trim());
  if (name === "style") return !UNSAFE_STYLE.test(value);
  return QUOTE_ATTRS.has(name) || (QUOTE_TAG_ATTRS[tag]?.includes(name) ?? false);
}

// A browser carries one of these into the next block when it is left open
// (`<p><b>x</p><p>y`): "y" is bold too, and hidden too if the <b> was.
const FORMATTING_TAGS = new Set(
  "a b big code em font i nobr s small strike strong tt u".split(" "),
);

const VOID_TAGS = new Set(["br", "hr", "img"]);
const MAX_QUOTE_DEPTH = 200;

// The rewriter does not balance tags, so a stray "</blockquote></div>" in the
// original would close our quote wrapper and let the rest read as the user's
// own words. Drop closers that match nothing, close what was left open, and
// stop nesting past a sane depth. The input is allowlisted output, so tags are
// well-formed; attribute values may still hold a ">" inside quotes.
function balanceTags(html: string): string {
  const open: string[] = [];
  const counts = new Map<string, number>();
  const tag = /<(\/?)([a-z][a-z0-9]*)/iy;
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    tag.lastIndex = lt;
    const m = tag.exec(html);
    if (!m) {
      if (html.charAt(lt + 1) === "!" || html.charAt(lt + 1) === "?") {
        // A doctype: the rewriter removes comments but cannot remove this.
        const gt = html.indexOf(">", lt);
        i = gt === -1 ? html.length : gt + 1;
        continue;
      }
      out += "<";
      i = lt + 1;
      continue;
    }
    let end = tag.lastIndex;
    for (let quote = ""; end < html.length; end++) {
      const ch = html.charAt(end);
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (end >= html.length) break;
    const name = (m[2] ?? "").toLowerCase();
    const text = html.slice(lt, end + 1);
    i = end + 1;
    if (m[1]) {
      if (!(counts.get(name) ?? 0)) continue;
      for (let top = open.pop(); top; top = open.pop()) {
        counts.set(top, (counts.get(top) ?? 1) - 1);
        out += `</${top}>`;
        if (top === name) break;
      }
    } else if (VOID_TAGS.has(name)) {
      out += text;
    } else if (open.length < MAX_QUOTE_DEPTH) {
      out += text;
      open.push(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/**
 * Reduce a message's HTML to ordinary formatting before it is quoted into an
 * outbound reply or forward, without the text its sender hid from the reader
 * (hidden-style.ts). Returns null if the rewrite fails: the caller then
 * sends the plain-text quote only (fail closed), unlike `sanitizeEmailHtml`
 * which serves the original on error.
 */
export async function sanitizeQuoteHtml(html: string): Promise<string | null> {
  try {
    // The state of the text at the current position, restored as elements end.
    let text = VISIBLE_TEXT;
    // A hidden formatting element was closed by another element's end tag. The
    // rewriter cannot tell where a browser stops reopening it, so nothing
    // after that point is kept.
    let reopened = false;
    const res = new HTMLRewriter()
      .on("*", {
        element(el) {
          const tag = el.tagName.toLowerCase();
          if (reopened) {
            el.remove();
            return;
          }
          const seen = elementVisibility(tag, (name) => el.getAttribute(name), text);
          const hides = seen.removed || textHidden(seen.text);
          const outer = text;
          try {
            el.onEndTag((end: { name: string }) => {
              text = outer;
              if (hides && FORMATTING_TAGS.has(tag) && end.name.toLowerCase() !== tag) {
                reopened = true;
              }
            });
            text = seen.text;
          } catch {
            // An element without an end tag has no content to hide.
          }
          if (seen.removed) {
            el.remove();
            return;
          }
          if (QUOTE_DROP_WITH_CONTENT.has(tag)) {
            el.remove();
            return;
          }
          if (!QUOTE_TAGS.has(tag)) {
            el.removeAndKeepContent();
            return;
          }
          const kept = new Map<string, string>();
          const bad = new Set<string>();
          for (const [rawName, value] of el.attributes) {
            if (!rawName) continue;
            if (quoteAttrAllowed(tag, rawName.toLowerCase(), value ?? "")) {
              kept.set(rawName, value ?? "");
            } else bad.add(rawName);
          }
          for (const name of bad) el.removeAttribute(name);
          // Re-set what stays so it is written back double-quoted with any quote
          // escaped. An unquoted `title=a"b` would otherwise reach balanceTags as
          // a stray quote that hides the tags after it.
          for (const [name, value] of kept) el.setAttribute(name, value);
        },
      })
      .onDocument({
        comments(comment) {
          comment.remove();
        },
        text(chunk) {
          if (reopened || textHidden(text)) chunk.remove();
        },
      })
      .transform(new Response(html));
    return balanceTags(await res.text());
  } catch (err) {
    console.error("quote html sanitize failed", err);
    return null;
  }
}
