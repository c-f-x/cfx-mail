// Finds deployment values and personal data in text: Cloudflare account ids,
// resource ids, hostnames and email addresses. Used by
// scripts/wrangler-config.test.mjs over every tracked file (decision D-16,
// c-f-x conventions section 4). Pure: the caller reads the files.
import { createHash } from "node:crypto";

const ACCOUNT_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;
const RESOURCE_ID =
  /"?(account_id|database_id|namespace_id|zone_id|preview_id)"?\s*[:=]\s*"([^"]*)"/g;
// A placeholder such as "<id from step 1>", or the local development id.
const PLACEHOLDER = /^(<[^>]+>|local)$/;
const EMAIL = /(?<![\w.+%-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w.-]*\d)/g;
// Hostnames under the top-level domains where a real site is likely. Words
// such as `user.email` or `session.run` are code, so .email, .run and the like
// are left out. A name followed by `.`, `(` or a word character is code too.
const HOSTNAME =
  /(?<![\w$.@-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|co|io|me|ai|dev|app|eu|uk|de|no|se|nl|fr|ch|dk|fi|es|it|info|biz|xyz))(?![\w$(-]|\.[\w$])/gi;

const RESERVED = [
  /(^|\.)example\.(com|org|net)$/,
  /\.(example|test|invalid|localhost)$/,
  /^localhost$/,
];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Every suffix of a hostname that is itself a domain: a.b.example.com gives
// a.b.example.com, b.example.com, example.com.
const suffixes = (host) => {
  const parts = host.split(".");
  return parts.slice(0, -1).map((_, i) => parts.slice(i).join("."));
};

// Is this hostname acceptable in a public file? Reserved names always are.
// Others must be on the public list (a listed domain covers its subdomains),
// and never under a domain whose SHA-256 is on the private list.
export function hostAllowed(host, publicHosts, privateHashes) {
  const h = host.toLowerCase();
  if (suffixes(h).some((s) => privateHashes.has(sha256(s)))) return false;
  if (RESERVED.some((r) => r.test(h))) return true;
  return suffixes(h).some((s) => publicHosts.has(s));
}

// The values in `text` that do not belong in a public file. An address is
// flagged when its domain is not allowed, or when the private list holds the
// hash of the whole address (a personal address at a public mail provider). Returns
// [{ kind, value }], deduplicated, in order of appearance.
export function trackedValues(text, publicHosts, privateHashes) {
  const found = new Map();
  const add = (kind, value) => found.set(`${kind}\0${value}`, { kind, value });
  for (const m of text.matchAll(ACCOUNT_ID)) add("account id", m[0]);
  for (const m of text.matchAll(RESOURCE_ID)) {
    if (!PLACEHOLDER.test(m[2])) add("resource id", `${m[1]}: ${m[2]}`);
  }
  for (const m of text.matchAll(EMAIL)) {
    const personal = privateHashes.has(sha256(m[0].toLowerCase()));
    if (personal || !hostAllowed(m[1], publicHosts, privateHashes)) add("email address", m[0]);
  }
  for (const m of text.matchAll(HOSTNAME)) {
    if (!hostAllowed(m[1], publicHosts, privateHashes)) add("hostname", m[1].toLowerCase());
  }
  return [...found.values()];
}

// The public list file: one hostname per line, `#` starts a comment.
export const parseHostList = (text) =>
  new Set(
    text
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
      .filter(Boolean),
  );
