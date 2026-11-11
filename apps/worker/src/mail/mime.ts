import { isAutoReplySubject } from "@cfx-mail/shared/subject";
import { createMimeMessage, Mailbox } from "mimetext";
import PostalMime, { type Email as ParsedEmail } from "postal-mime";
import {
  replaceBlockBreaks,
  replaceBlocks,
  replaceComments,
  stripTags,
} from "../lib/html-strip.ts";

export type { ParsedEmail };

export async function parseMime(raw: ArrayBuffer | string | ReadableStream): Promise<ParsedEmail> {
  return await PostalMime.parse(raw);
}

// The stream held more bytes than the cap: the message can never be stored.
export class MessageTooLargeError extends Error {
  constructor(maxSize: number) {
    super(`message exceeds max size ${maxSize}`);
    this.name = "MessageTooLargeError";
  }
}

export async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxSize) throw new MessageTooLargeError(maxSize);
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

// Pull the RFC 2369/8058 unsubscribe headers off a parsed message. `headers` is
// postal-mime's flat `{ key, value }[]` with lowercased keys; we keep the raw
// values and interpret them later (mailto vs https, one-click) at action time.
export function extractUnsubscribe(parsed: ParsedEmail): {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
} {
  const headers = parsed.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.key.toLowerCase() === name)?.value?.trim() || null;
  return {
    listUnsubscribe: get("list-unsubscribe"),
    listUnsubscribePost: get("list-unsubscribe-post"),
  };
}

// The list's identifier from a List-Id header (RFC 2919): the part in angle
// brackets, lower-cased. Null for mail that came through no list.
export function extractListId(parsed: ParsedEmail): string | null {
  const value = (parsed.headers ?? []).find((h) => h.key.toLowerCase() === "list-id")?.value;
  if (!value) return null;
  const id = (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return id || null;
}

// Whether a vacation/out-of-office responder sent this. RFC 3834's
// `Auto-Submitted: auto-replied` and the older X-Autoreply family say so
// outright; Exchange marks its responder only `auto-generated` (which plain
// notifications use too), so a responder subject prefix decides the rest.
export function isAutoReply(parsed: ParsedEmail): boolean {
  const headers = parsed.headers ?? [];
  const get = (name: string) =>
    headers
      .find((h) => h.key.toLowerCase() === name)
      ?.value?.trim()
      .toLowerCase() ?? null;
  if (get("auto-submitted")?.startsWith("auto-replied")) return true;
  if (get("x-autoreply") || get("x-autorespond") || get("x-autoresponse")) return true;
  if (get("precedence") === "auto_reply") return true;
  return isAutoReplySubject(parsed.subject ?? "");
}

export interface ThreadingHeaders {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

export function buildThreadingHeaders(input: ThreadingHeaders): Record<string, string> {
  const headers: Record<string, string> = { "Message-ID": input.messageId };
  if (input.inReplyTo) headers["In-Reply-To"] = input.inReplyTo;
  if (input.references?.length) headers.References = input.references.join(" ");
  return headers;
}

export interface BuildMimeInput extends ThreadingHeaders {
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  bcc?: { name?: string; address: string }[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: {
    filename: string;
    contentType: string;
    data: Uint8Array;
    // Inline body parts (cid: images). `contentId` is matched by the HTML's
    // `cid:` references; set `inline` so it lands in the related/inline part.
    inline?: boolean;
    contentId?: string;
  }[];
  // Extra raw headers (e.g. Auto-Submitted for automated rule sends). Applied
  // after threading headers; don't use this to override Message-ID/From/To.
  extraHeaders?: Record<string, string>;
}

export function buildMime(input: BuildMimeInput): string {
  const msg = createMimeMessage();
  msg.setSender({ name: input.from.name ?? "", addr: input.from.address });
  msg.setRecipients(input.to.map((r) => ({ name: r.name ?? "", addr: r.address })));
  if (input.cc?.length) {
    msg.setCc(input.cc.map((r) => ({ name: r.name ?? "", addr: r.address })));
  }
  if (input.bcc?.length) {
    msg.setBcc(input.bcc.map((r) => ({ name: r.name ?? "", addr: r.address })));
  }
  msg.setSubject(input.subject);
  for (const [name, value] of Object.entries(buildThreadingHeaders(input))) {
    msg.setHeader(name, value);
  }
  // mimetext rejects a plain string for address headers.
  if (input.replyTo) msg.setHeader("Reply-To", new Mailbox(input.replyTo));
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    msg.setHeader(name, value);
  }

  if (input.text) msg.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) msg.addMessage({ contentType: "text/html", data: input.html });

  for (const att of input.attachments ?? []) {
    const cid = att.contentId ? normalizeContentId(att.contentId) : undefined;
    msg.addAttachment({
      filename: sanitizeFilename(att.filename),
      contentType: att.contentType,
      data: uint8ToBase64(att.data),
      encoding: "base64",
      inline: att.inline || undefined,
      headers: cid ? { "Content-ID": cid } : undefined,
    });
  }

  return msg.asRaw();
}

// Strip control chars (incl. CR/LF) so a crafted attachment name can't inject
// MIME headers into the archived .eml. Quotes/backslashes break param encoding.
function sanitizeFilename(name: string): string {
  let clean = "";
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || ch === '"' || ch === "\\") continue;
    clean += ch;
  }
  return clean.trim().slice(0, 200) || "attachment";
}

// Content-ID must be angle-bracketed (`<id>`) in the header; HTML refers to the
// bare id via `cid:id`. Strip stray brackets/whitespace, then re-wrap so both
// agree regardless of how the source labelled it.
function normalizeContentId(id: string): string {
  const bare = id.trim().replace(/^<|>$/g, "");
  return bare ? `<${bare}>` : "";
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function snippet(body: string, len = 180): string {
  return body.replace(/\s+/g, " ").trim().slice(0, len);
}

// Upper bound on the plaintext body we store/index per message. Search relevance
// past this is negligible and it keeps D1 row sizes bounded.
export const BODY_CAP = 64_000;

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

const HTML_NUM_ENTITY_RE = /&#(\d+);/g;
const HTML_NAMED_ENTITY_RE = /&[a-z#0-9]+;/gi;
const HTML_INLINE_WS_RE = /[^\S\n]+/g;
const HTML_WS_RUN_RE = /\s+/g;

// A numeric entity names any number; only Unicode scalar values are text.
// `String.fromCodePoint` throws above U+10FFFF, and a lone surrogate is not
// valid in stored text.
function decodeCodePoint(code: number): string {
  const scalar = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return scalar ? String.fromCodePoint(code) : " ";
}

// Convert HTML to readable plaintext for indexing: drop script/style blocks
// entirely (otherwise CSS/JS pollutes the index), turn block-level tags into
// newlines, strip remaining tags, decode common entities, collapse whitespace.
// Runs on delivery for HTML-only mail, so every pass is linear (lib/html-strip.ts).
export function htmlToText(html: string): string {
  return stripTags(replaceBlockBreaks(replaceComments(replaceBlocks(html, " "), " "), "\n"), " ")
    .replace(HTML_NUM_ENTITY_RE, (_, code) => decodeCodePoint(Number(code)))
    .replace(HTML_NAMED_ENTITY_RE, (m) => HTML_ENTITIES[m.toLowerCase()] ?? " ")
    .replace(HTML_INLINE_WS_RE, " ")
    .replace(HTML_WS_RUN_RE, (run) => (run.includes("\n") ? "\n" : run))
    .trim();
}

// Best plaintext body for indexing: prefer the text part, fall back to HTML.
export function bodyForIndex(text?: string | null, html?: string | null): string {
  const body = text?.trim() || htmlToText(html ?? "");
  return body.slice(0, BODY_CAP);
}

// Flatten recipient lists into searchable "Name address Name address" text.
export function addrsToText(addrs: { name?: string; address: string }[]): string {
  return addrs
    .flatMap((a) => [a.name, a.address])
    .filter(Boolean)
    .join(" ")
    .slice(0, BODY_CAP);
}
