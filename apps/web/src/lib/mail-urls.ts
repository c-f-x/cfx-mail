// Which URLs a rendered mail body may load. The worker rewrites every remote
// resource to the signed image proxy and every inline `cid:` image to its
// attachment route, so those two same-origin paths (plus inline `data:`) are the
// only legitimate targets. Any other same-origin path, such as "/api/stream" or
// "/api/avatar/domain/u123.evil.example", would load with the reader's session
// cookie and tell the sender when the mail was opened.

const PROXY_PREFIX = "/api/messages/proxy-image?";
// Ids are UUIDs: no dots, so the path cannot climb out with "..".
const ATTACHMENT_PATH =
  /^\/api\/messages\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9_-]+\/raw(?:\?.*)?$/;

// What a browser does to a URL before using it: drops tabs and newlines
// anywhere, and leading/trailing control characters and spaces.
function normalizeUrl(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c !== 9 && c !== 10 && c !== 13) out += ch;
  }
  let start = 0;
  while (start < out.length && out.charCodeAt(start) <= 0x20) start++;
  let end = out.length;
  while (end > start && out.charCodeAt(end - 1) <= 0x20) end--;
  return out.slice(start, end);
}

export function isAllowedMailUrl(value: string): boolean {
  const url = normalizeUrl(value);
  if (/^data:/i.test(url)) return true;
  return url.startsWith(PROXY_PREFIX) || ATTACHMENT_PATH.test(url);
}

// A link must name its own scheme. A relative href resolves against the app's
// origin, so "/compose?mailto=…" would be a click into our own routes.
export function isAbsoluteUrl(value: string): boolean {
  return URL.canParse(normalizeUrl(value));
}

// Keep only the allowed candidates of a srcset. Follows the HTML parsing rules:
// a candidate URL is the run of non-space characters (so the comma inside a
// `data:` URL stays part of it), and commas trailing it end the candidate.
export function filterSrcset(srcset: string): string {
  const kept: string[] = [];
  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && (/\s/.test(srcset.charAt(i)) || srcset.charAt(i) === ",")) i++;
    if (i >= n) break;
    let end = i;
    while (end < n && !/\s/.test(srcset.charAt(end))) end++;
    let url = srcset.slice(i, end);
    i = end;
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const comma = srcset.indexOf(",", i);
      const stop = comma === -1 ? n : comma;
      descriptors = srcset.slice(i, stop).trim();
      i = stop;
    }
    if (url && isAllowedMailUrl(url)) kept.push(descriptors ? `${url} ${descriptors}` : url);
  }
  return kept.join(", ");
}

// ─── CSS ────────────────────────────────────────────────────────────────────

// Functions that fetch an image from a string or url without being `url()`.
const IMAGE_FUNCTIONS = new Set([
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
  "src",
  "image",
  "element",
  "-moz-element",
]);

const isHex = (ch: string) => /[0-9a-fA-F]/.test(ch);
const isSpace = (ch: string) =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isIdentChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80;

// Decode one CSS escape starting at the backslash at `i`.
function readEscape(css: string, i: number): { char: string; next: number } {
  let j = i + 1;
  if (j >= css.length) return { char: "�", next: j };
  if (!isHex(css.charAt(j))) return { char: css.charAt(j), next: j + 1 };
  let hex = "";
  while (j < css.length && hex.length < 6 && isHex(css.charAt(j))) hex += css.charAt(j++);
  if (isSpace(css.charAt(j))) j++;
  const code = Number.parseInt(hex, 16);
  const ok = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return { char: ok ? String.fromCodePoint(code) : "�", next: j };
}

// Read a quoted string starting at the quote at `i`; returns its decoded value
// and the index after the closing quote.
function readString(css: string, i: number): { value: string; next: number } {
  const quote = css.charAt(i);
  let j = i + 1;
  let value = "";
  while (j < css.length && css.charAt(j) !== quote) {
    if (css.charAt(j) === "\\") {
      if (css.charAt(j + 1) === "\n") {
        j += 2;
        continue;
      }
      const esc = readEscape(css, j);
      value += esc.char;
      j = esc.next;
    } else value += css.charAt(j++);
  }
  return { value, next: Math.min(j + 1, css.length) };
}

// Index just past the `)` that closes a parenthesis opened before `i`.
function skipBalanced(css: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < css.length && depth > 0) {
    const ch = css.charAt(j);
    if (ch === '"' || ch === "'") j = readString(css, j).next;
    else if (ch === "\\") j = readEscape(css, j).next;
    else {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
  }
  return j;
}

// The end of a `url(` token whose `(` is just before `i`, and whether its target
// may load. A malformed token is never allowed.
function readUrlToken(css: string, i: number): { next: number; allowed: boolean } {
  let j = i;
  while (isSpace(css.charAt(j))) j++;
  let value = "";
  let well = true;
  const ch = css.charAt(j);
  if (ch === '"' || ch === "'") {
    const str = readString(css, j);
    value = str.value;
    j = str.next;
    while (isSpace(css.charAt(j))) j++;
    if (css.charAt(j) !== ")") well = false;
  } else {
    while (j < css.length && css.charAt(j) !== ")") {
      const c = css.charAt(j);
      if (c === "\\") {
        const esc = readEscape(css, j);
        value += esc.char;
        j = esc.next;
      } else if (isSpace(c)) {
        j++;
        while (isSpace(css.charAt(j))) j++;
        if (css.charAt(j) !== ")") well = false;
      } else {
        if (c === '"' || c === "'" || c === "(") well = false;
        value += c;
        j++;
      }
    }
  }
  if (!well) return { next: skipBalanced(css, i), allowed: false };
  return { next: Math.min(j + 1, css.length), allowed: isAllowedMailUrl(value) };
}

// Replace every `url(…)` whose target is not allowed, and every other
// image-fetching function, with `none`; drop `@import` rules. A small tokenizer
// rather than a regex: escapes ("u\72l("), comments and strings are handled the
// way CSS handles them, and a single pass keeps hostile input linear.
export function neutralizeCssUrls(css: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css.charAt(i);
    if (ch === "/" && css.charAt(i + 1) === "*") {
      const end = css.indexOf("*/", i + 2);
      const next = end === -1 ? n : end + 2;
      out += css.slice(i, next);
      i = next;
    } else if (ch === '"' || ch === "'") {
      const next = readString(css, i).next;
      out += css.slice(i, next);
      i = next;
    } else if (ch === "@") {
      let j = i + 1;
      let name = "";
      while (j < n && (isIdentChar(css.charAt(j)) || css.charAt(j) === "\\")) {
        if (css.charAt(j) === "\\") {
          const esc = readEscape(css, j);
          name += esc.char;
          j = esc.next;
        } else name += css.charAt(j++);
      }
      if (name.toLowerCase() === "import") {
        while (j < n && css.charAt(j) !== ";") {
          const c = css.charAt(j);
          if (c === '"' || c === "'") j = readString(css, j).next;
          else if (c === "(") j = skipBalanced(css, j + 1);
          else j++;
        }
        i = Math.min(j + 1, n);
      } else {
        out += css.slice(i, j);
        i = j;
      }
    } else if (isIdentChar(ch) || ch === "\\") {
      let j = i;
      let name = "";
      while (j < n && (isIdentChar(css.charAt(j)) || css.charAt(j) === "\\")) {
        if (css.charAt(j) === "\\") {
          const esc = readEscape(css, j);
          name += esc.char;
          j = esc.next;
        } else name += css.charAt(j++);
      }
      const lower = name.toLowerCase();
      if (css.charAt(j) === "(" && lower === "url") {
        const token = readUrlToken(css, j + 1);
        out += token.allowed ? css.slice(i, token.next) : "none";
        i = token.next;
      } else if (css.charAt(j) === "(" && IMAGE_FUNCTIONS.has(lower)) {
        out += "none";
        i = skipBalanced(css, j + 1);
      } else {
        out += css.slice(i, j);
        i = j;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
