// Linear-time HTML stripping for text extraction (search index, spam scoring,
// reply quotes). Each function is a drop-in for the regex it replaced, which
// went quadratic on hostile mail: an unterminated "<", "<!--" or "<script"
// repeated 20,000 times made the regex rescan the rest of the body from every
// start. Here an opener with no terminator ahead ends the whole pass, since no
// later opener can have one either, and a matched span is consumed, so no text
// is scanned twice.

// `<[^>]+>`: every tag, with the text between "<" and the first ">" dropped.
export function stripTags(html: string, replacement: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      from = lt + 1; // "<>" holds no tag name; the pattern needs one or more characters
      continue;
    }
    out += html.slice(last, lt) + replacement;
    last = gt + 1;
    from = last;
  }
  return out + html.slice(last);
}

// `<!--[\s\S]*?-->`: comments.
export function replaceComments(html: string, replacement: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const open = html.indexOf("<!--", from);
    if (open === -1) break;
    const close = html.indexOf("-->", open + 4);
    if (close === -1) break;
    out += html.slice(last, open) + replacement;
    last = close + 3;
    from = last;
  }
  return out + html.slice(last);
}

const BLOCK_OPEN = /<(script|style|head|noscript)/gi;
const BLOCK_CLOSE: Record<string, RegExp> = {
  script: /<\/script>/gi,
  style: /<\/style>/gi,
  head: /<\/head>/gi,
  noscript: /<\/noscript>/gi,
};

// `<(script|style|head|noscript)[\s\S]*?<\/\1>`: whole elements whose content is
// not text. An element name with no closing tag left ahead is remembered and
// skipped from then on.
export function replaceBlocks(html: string, replacement: string): string {
  const unclosed = new Set<string>();
  let out = "";
  let last = 0;
  BLOCK_OPEN.lastIndex = 0;
  for (let m = BLOCK_OPEN.exec(html); m; m = BLOCK_OPEN.exec(html)) {
    const name = (m[1] ?? "").toLowerCase();
    if (unclosed.has(name)) continue;
    const close = BLOCK_CLOSE[name];
    if (!close) continue;
    close.lastIndex = BLOCK_OPEN.lastIndex;
    if (!close.exec(html)) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(last, m.index) + replacement;
    last = close.lastIndex;
    BLOCK_OPEN.lastIndex = last;
  }
  return out + html.slice(last);
}

const BREAK_OPEN = /<\/?(?:p|div|br|li|tr|h[1-6]|table|ul|ol|blockquote|section|article)/gi;

// `<\/?(p|div|…)[^>]*>`: block-level tags, opening or closing.
export function replaceBlockBreaks(html: string, replacement: string): string {
  let out = "";
  let last = 0;
  BREAK_OPEN.lastIndex = 0;
  for (let m = BREAK_OPEN.exec(html); m; m = BREAK_OPEN.exec(html)) {
    const gt = html.indexOf(">", BREAK_OPEN.lastIndex);
    if (gt === -1) break;
    out += html.slice(last, m.index) + replacement;
    last = gt + 1;
    BREAK_OPEN.lastIndex = last;
  }
  return out + html.slice(last);
}
