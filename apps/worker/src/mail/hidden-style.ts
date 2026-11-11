// Whether an element's own attributes hide it from the person reading a mail.
// Used on HTML that is quoted into a reply or forward (sanitize.ts): text the
// user never saw must not go out under their name.
//
// Only inline styles and attributes are read. <style> blocks are removed
// before quoting, so a class has nothing to apply. Where a browser and this
// file could disagree, this file hides: a quote that loses a visible line is
// the cheaper mistake. Every pass is a single scan, as in lib/html-strip.ts,
// because the style attribute is the sender's and can be any size.

// Named character references that decode to an ASCII character. A style can
// only spell a property or a keyword with those, so no other name matters.
const ENTITIES: Record<string, string> = {
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
};
const MAX_ENTITY_NAME = 32;
const UNKNOWN = "�";

function isDigit(code: number, hex: boolean): boolean {
  if (code >= 48 && code <= 57) return true;
  return hex && ((code >= 65 && code <= 70) || (code >= 97 && code <= 102));
}

function isAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function codePoint(digits: string, radix: number): string {
  // More digits than any code point has: the value is out of range anyway.
  const code = digits.length > 8 ? Number.NaN : Number.parseInt(digits, radix);
  const scalar = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return scalar ? String.fromCodePoint(code) : UNKNOWN;
}

// The reference that starts at `amp`, as [decoded text, index after it]. The
// rewriter hands attribute values over undecoded, so this is what turns
// "display:&#110;one" into what the browser applies.
function readEntity(s: string, amp: number): [string, number] {
  let i = amp + 1;
  if (s.charAt(i) === "#") {
    i++;
    const hex = s.charAt(i) === "x" || s.charAt(i) === "X";
    if (hex) i++;
    const start = i;
    while (i < s.length && isDigit(s.charCodeAt(i), hex)) i++;
    if (i === start) return ["&", amp + 1];
    const text = codePoint(s.slice(start, i), hex ? 16 : 10);
    return [text, s.charAt(i) === ";" ? i + 1 : i];
  }
  const start = i;
  while (i < s.length && i - start < MAX_ENTITY_NAME && isAlnum(s.charCodeAt(i))) i++;
  if (i === start || s.charAt(i) !== ";") return ["&", amp + 1];
  return [ENTITIES[s.slice(start, i)] ?? UNKNOWN, i + 1];
}

function decodeEntities(s: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const amp = s.indexOf("&", from);
    if (amp === -1) break;
    const [text, next] = readEntity(s, amp);
    out += s.slice(from, amp) + text;
    from = next;
  }
  return out + s.slice(from);
}

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

// Every value each property is given in a declaration list, lower-cased and
// without "!important". All values are kept, not the last: a browser skips a
// value it does not understand, so "display:none;display:bogus" still hides.
function declarations(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let buf = "";
  let quote = "";
  // Closers of the blocks that are open. A ";" inside a block ends nothing.
  const open: string[] = [];

  const flush = () => {
    const colon = buf.indexOf(":");
    if (colon !== -1) {
      const name = buf.slice(0, colon).trim().toLowerCase();
      let value = buf.slice(colon + 1);
      const bang = value.lastIndexOf("!");
      if (
        bang !== -1 &&
        value
          .slice(bang + 1)
          .trim()
          .toLowerCase() === "important"
      ) {
        value = value.slice(0, bang);
      }
      const values = out.get(name);
      if (values) values.push(value.trim().toLowerCase());
      else out.set(name, [value.trim().toLowerCase()]);
    }
    buf = "";
  };

  for (let i = 0; i < css.length; i++) {
    const ch = css.charAt(i);
    if (ch === "\\") {
      // An escape stands for one character that is never punctuation: up to
      // six hex digits and one space after them, or the next character as is.
      let j = i + 1;
      while (j < css.length && j - i <= 6 && isDigit(css.charCodeAt(j), true)) j++;
      if (j > i + 1) {
        buf += codePoint(css.slice(i + 1, j), 16);
        if (/\s/.test(css.charAt(j))) j++;
      } else if (j < css.length) {
        buf += css.charAt(j);
        j++;
      }
      i = j - 1;
    } else if (quote) {
      // A string ends at its quote, or unclosed at the end of the line.
      if (ch === quote || ch === "\n" || ch === "\r" || ch === "\f") quote = "";
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "/" && css.charAt(i + 1) === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) break;
      // A comment separates what stands on either side of it.
      buf += " ";
      i = end + 1;
    } else if (ch === ";" && open.length === 0) {
      flush();
    } else {
      const closer = CLOSER[ch];
      if (closer) open.push(closer);
      else if (ch === open[open.length - 1]) open.pop();
      buf += ch;
    }
  }
  flush();
  return out;
}

interface Measure {
  n: number;
  unit: string;
}

const UNIT = /^[a-z%]*$/;

// A CSS number with its unit, or null. Scanned by hand: the token can be the
// whole attribute, and a number pattern backtracks on a long run of digits.
function measure(token: string): Measure | null {
  let i = token.charAt(0) === "-" || token.charAt(0) === "+" ? 1 : 0;
  let digits = 0;
  let dot = false;
  for (; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (isDigit(code, false)) digits++;
    else if (code === 46 && !dot) dot = true;
    else break;
  }
  if (!digits) return null;
  if (token.charAt(i) === "e") {
    let j = i + 1;
    if (token.charAt(j) === "-" || token.charAt(j) === "+") j++;
    const exponent = j;
    while (j < token.length && isDigit(token.charCodeAt(j), false)) j++;
    if (j > exponent) i = j;
  }
  const unit = token.slice(i);
  if (!UNIT.test(unit)) return null;
  const n = Number(token.slice(0, i));
  return Number.isNaN(n) ? null : { n, unit };
}

const SMALL_UNITS = new Set(["", "px", "pt"]);

// Too faint to read: an opacity of 5% or less.
function isFaint(value: string): boolean {
  const m = measure(value);
  if (!m || m.n < 0) return false;
  return m.unit === "%" ? m.n <= 5 : m.unit === "" && m.n <= 0.05;
}

// A box of a pixel or less, which shows nothing once its overflow is hidden.
function isTiny(value: string): boolean {
  const m = measure(value);
  return !!m && m.n >= 0 && (m.n === 0 || (m.n <= 1 && SMALL_UNITS.has(m.unit)));
}

// clip: rect(top, right, bottom, left) that leaves no area, such as
// rect(0,0,0,0) or the rect(1px,1px,1px,1px) of screen-reader-only text.
function clipsAll(value: string): boolean {
  const inner = /^rect\((.*)\)$/.exec(value.trim())?.[1];
  if (!inner) return false;
  const edges = inner
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(measure);
  if (edges.length !== 4 || edges.some((m) => !m)) return false;
  const [top, right, bottom, left] = edges.map((m) => m!.n) as [number, number, number, number];
  return bottom <= top || right <= left;
}

// clip-path: inset(50%) or more cuts the box down to nothing.
function clipPathAll(value: string): boolean {
  const inner = /^inset\((.*)\)$/.exec(value.trim())?.[1];
  if (!inner) return false;
  const first = measure(inner.split(/\s+/)[0] ?? "");
  return !!first && first.unit === "%" && first.n >= 50;
}

// Far enough off the page that nobody sees it: -999px, or -99 of a larger unit.
function isOffPage(value: string): boolean {
  const m = measure(value);
  return !!m && m.n <= (SMALL_UNITS.has(m.unit) ? -999 : -99);
}

function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

// What a declaration does to an inherited flag: turns it on, turns it off, or
// leaves the parent's value. A value this file does not know leaves it, as a
// browser does with a value it rejects.
type Effect = "hide" | "show" | "keep";

function settle(effects: Effect[], inherited: boolean): boolean {
  if (effects.includes("hide")) return true;
  return effects.includes("show") ? false : inherited;
}

const ABSOLUTE_UNITS = new Set([
  "px",
  "pt",
  "pc",
  "in",
  "cm",
  "mm",
  "q",
  "rem",
  "vw",
  "vh",
  "vmin",
  "vmax",
]);
const SIZE_KEYWORDS = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
  "xxx-large",
  "initial",
  "revert",
]);
const SYSTEM_FONTS = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "small-caption",
  "status-bar",
]);

// A size in em or % is a share of the parent's, so it leaves a zero at zero.
function fontSizeEffect(value: string): Effect {
  if (SIZE_KEYWORDS.has(value)) return "show";
  const m = measure(value);
  if (!m) return "keep";
  if (m.n === 0) return "hide";
  return m.n > 0 && ABSOLUTE_UNITS.has(m.unit) ? "show" : "keep";
}

// The size in a `font` shorthand is its first length; a bare number other
// than 0 is the weight.
function fontEffect(value: string): Effect {
  if (SYSTEM_FONTS.has(value)) return "show";
  for (const token of tokens(value)) {
    const size = token.split("/", 1)[0] ?? "";
    if (SIZE_KEYWORDS.has(size)) return "show";
    const m = measure(size);
    if (m && (m.unit || m.n === 0)) return fontSizeEffect(size);
  }
  return "keep";
}

function visibilityEffect(value: string): Effect {
  if (value === "hidden" || value === "collapse") return "hide";
  return value === "visible" || value === "initial" || value === "revert" ? "show" : "keep";
}

function indentEffect(value: string): Effect {
  const first = tokens(value)[0] ?? "";
  if (isOffPage(first)) return "hide";
  return measure(first) ? "show" : "keep";
}

const HEX = /^#[0-9a-f]+$/;
const BARE_HEX = /^[0-9a-f]{6}$/;
const FUNCTIONAL = /^(?:rgba?|hsla?)\([\d.,%/\s]+\)$/;
const MAX_COLOUR = 64;
// The colour names worth knowing. Any other name counts as no colour at all,
// so a made-up one cannot pass for a visible colour.
const COLOUR_NAMES = new Set(
  "red green blue yellow orange purple gray grey silver maroon fuchsia lime olive navy teal aqua".split(
    " ",
  ),
);
const TRANSPARENT = "transparent";

// A colour in one comparable spelling, or null when the value is not a colour
// this file can compare.
function colour(raw: string, legacyAttribute = false): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length > MAX_COLOUR) return null;
  if (value === "white") return "#ffffff";
  if (value === "black") return "#000000";
  if (value === TRANSPARENT || COLOUR_NAMES.has(value)) return value;
  if (legacyAttribute && BARE_HEX.test(value)) return `#${value}`;
  if (FUNCTIONAL.test(value)) return value.replace(/\s+/g, "");
  if (!HEX.test(value)) return null;
  const digits = value.slice(1);
  const long =
    digits.length === 3 || digits.length === 4
      ? Array.from(digits, (d) => d + d).join("")
      : digits.length === 6 || digits.length === 8
        ? digits
        : null;
  if (!long) return null;
  if (long.length === 6) return `#${long}`;
  if (long.endsWith("00")) return TRANSPARENT;
  return long.endsWith("ff") ? `#${long.slice(0, 6)}` : `#${long}`;
}

function known(values: (string | null)[]): string[] {
  return values.filter((v): v is string => v !== null);
}

// The part of an element's state that its descendants inherit, and that a
// descendant can undo: a child of a zero-size parent may set a size again.
export interface TextState {
  zeroFont: boolean;
  invisible: boolean;
  indented: boolean;
  // The text colours that may apply. Empty means unknown, which hides nothing.
  colours: readonly string[];
  // The backgrounds of the text, kept only while one of them is the text's
  // colour. A colour is never judged against a background further out: one
  // set by a class may lie between, and classes are not read.
  backgrounds: readonly string[];
}

export const VISIBLE_TEXT: TextState = {
  zeroFont: false,
  invisible: false,
  indented: false,
  colours: [],
  backgrounds: [],
};

export function textHidden(text: TextState): boolean {
  return (
    text.zeroFont ||
    text.invisible ||
    text.indented ||
    text.colours.some((c) => c === TRANSPARENT || text.backgrounds.includes(c))
  );
}

export interface ElementVisibility {
  // Hidden with everything inside it, whatever a descendant declares.
  removed: boolean;
  // The state for text directly inside the element, and for its descendants.
  text: TextState;
}

export function elementVisibility(
  tag: string,
  attr: (name: string) => string | null,
  inherited: TextState,
): ElementVisibility {
  const style = declarations(decodeEntities(attr("style") ?? ""));
  const all = (property: string) => style.get(property) ?? [];
  const some = (properties: string[], test: (value: string) => boolean) =>
    properties.some((property) => all(property).some(test));

  const clipped = some(["overflow", "overflow-x", "overflow-y"], (v) =>
    tokens(v).some((t) => t === "hidden" || t === "clip"),
  );
  const removed =
    attr("hidden") !== null ||
    all("display").includes("none") ||
    some(["opacity"], isFaint) ||
    (clipped && some(["height", "max-height", "width", "max-width"], isTiny)) ||
    some(["clip-path"], clipPathAll) ||
    (some(["position"], (v) => v === "absolute" || v === "fixed") &&
      (some(["left", "top"], isOffPage) || some(["clip"], clipsAll)));

  const ownColours = known([
    ...all("color").map((v) => colour(v)),
    tag === "font" ? colour(attr("color") ?? "", true) : null,
  ]);
  // A link without a colour of its own takes the browser's link colour.
  const colours = ownColours.length
    ? ownColours
    : tag === "a" && attr("href") !== null
      ? []
      : inherited.colours;

  const painted = [...all("background"), ...all("background-color"), ...all("background-image")];
  const ownBackgrounds = known([
    ...painted.map((v) => colour(v)),
    colour(attr("bgcolor") ?? "", true),
  ]).filter((c) => c !== TRANSPARENT);
  // An image or gradient covers whatever colour lies behind it.
  const behind = painted.some((v) => v.includes("url(") || v.includes("gradient("))
    ? []
    : ownBackgrounds.length
      ? ownBackgrounds
      : inherited.backgrounds;
  const backgrounds = colours.some((c) => behind.includes(c)) ? behind : [];

  return {
    removed,
    text: {
      zeroFont: settle(
        [
          ...all("font-size").map(fontSizeEffect),
          ...all("font").map(fontEffect),
          ...(tag === "font" && attr("size") !== null ? ["show" as const] : []),
        ],
        inherited.zeroFont,
      ),
      invisible: settle(all("visibility").map(visibilityEffect), inherited.invisible),
      indented: settle(all("text-indent").map(indentEffect), inherited.indented),
      colours,
      backgrounds,
    },
  };
}
