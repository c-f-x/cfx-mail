// Acts on a message's RFC 2369/8058 unsubscribe headers. Three channels, in
// order of preference: an RFC 8058 one-click POST (fully server-side, only when
// the sender set List-Unsubscribe-Post), a mailto request sent as a real email
// from the mailbox, or — failing both — an https page handed back for the client
// to open (many are confirmation pages that can't be safely auto-submitted).

import type { DB } from "@cfmail/db";
import { domain, mailbox } from "@cfmail/db/schema";
import type { UnsubscribeResultDto, UnsubscribeTargetDto } from "@cfmail/shared/responses";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { AppError } from "../errors.ts";
import { safeRedirectFetch } from "../ssrf.ts";

// Split "<mailto:...>, <https://...>" into its mailto and https targets. Other
// schemes (bare http:, etc.) are ignored — one-click mandates https and mailto
// is the only other channel we automate.
function parseTargets(header: string): { mailto?: string; https?: string } {
  const out: { mailto?: string; https?: string } = {};
  // indexOf scan, not /<([^>]+)>/g: a header of unclosed "<" would rescan the
  // rest from every one of them.
  let from = 0;
  for (;;) {
    const lt = header.indexOf("<", from);
    if (lt === -1) break;
    const gt = header.indexOf(">", lt + 1);
    if (gt === -1) break;
    from = gt === lt + 1 ? lt + 1 : gt + 1;
    const uri = header.slice(lt + 1, gt).trim();
    if (!uri) continue;
    if (!out.mailto && /^mailto:/i.test(uri)) out.mailto = uri;
    else if (!out.https && /^https:\/\//i.test(uri)) out.https = uri;
  }
  return out;
}

// True when `deliveredTo` is this mailbox's address (base local part + domain),
// optionally carrying a "+tag". Mirrors the plus-addressing match in receive.ts
// so we only ever send from an address we actually own.
function deliveredToMatches(
  deliveredTo: string | null,
  baseLocal: string,
  domainName: string,
): boolean {
  if (!deliveredTo) return false;
  const at = deliveredTo.lastIndexOf("@");
  if (at < 1) return false;
  const local = deliveredTo.slice(0, at);
  const dom = deliveredTo.slice(at + 1);
  if (dom.toLowerCase() !== domainName.toLowerCase()) return false;
  return (local.split("+")[0] || local).toLowerCase() === baseLocal.toLowerCase();
}

// The body is ours, never the sender's: a List-Unsubscribe mailto is attacker
// input, and whatever it carries goes out under the user's address and DKIM key.
const UNSUBSCRIBE_BODY = "Please unsubscribe me from this list.";
const MAX_SUBJECT_LENGTH = 100;

const LOCAL_PART_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// The one recipient of a mailto target: a single plain address, or null. A comma
// list, a display-name form or anything that is not an address is refused, so a
// sender cannot turn the opt-out into mail to people of their choosing. The
// sender's subject is kept only when it is short and free of control characters.
function parseMailto(mailto: string): { address: string; subject: string } | null {
  let path: string;
  let subject: string;
  try {
    const url = new URL(mailto);
    path = decodeURIComponent(url.pathname);
    subject = url.searchParams.get("subject") ?? "";
  } catch {
    return null;
  }
  const at = path.indexOf("@");
  if (at < 1 || at !== path.lastIndexOf("@")) return null;
  const local = path.slice(0, at);
  const host = path.slice(at + 1);
  if (path.length > 254 || !LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(host)) return null;
  const usable =
    subject.length > 0 && subject.length <= MAX_SUBJECT_LENGTH && !hasControlChar(subject);
  return { address: path, subject: usable ? subject : "Unsubscribe" };
}

// What the user is asked to confirm and what `performUnsubscribe` then does. One
// function decides both, so the confirm dialog cannot name a different target
// than the one acted on.
type UnsubscribePlan =
  | { method: "one-click"; url: string; host: string }
  | { method: "email"; address: string; subject: string }
  | { method: "link"; url: string; host: string };

export type ResolvedUnsubscribe =
  | { ok: true; plan: UnsubscribePlan }
  | { ok: false; message: string };

function httpsPlan(method: "one-click" | "link", rawUrl: string): ResolvedUnsubscribe {
  try {
    const url = new URL(rawUrl);
    return { ok: true, plan: { method, url: rawUrl, host: url.hostname } };
  } catch {
    return { ok: false, message: "bad unsubscribe URL" };
  }
}

export function resolveUnsubscribe(
  listUnsubscribe: string,
  listUnsubscribePost: string | null,
): ResolvedUnsubscribe {
  const targets = parseTargets(listUnsubscribe);
  if (/one-click/i.test(listUnsubscribePost ?? "") && targets.https) {
    return httpsPlan("one-click", targets.https);
  }
  if (targets.mailto) {
    const mail = parseMailto(targets.mailto);
    return mail
      ? { ok: true, plan: { method: "email", ...mail } }
      : {
          ok: false,
          message: "This message has no valid unsubscribe address, so nothing was sent.",
        };
  }
  if (targets.https) return httpsPlan("link", targets.https);
  return { ok: false, message: "no supported unsubscribe method" };
}

export function unsubscribeTarget(plan: UnsubscribePlan): UnsubscribeTargetDto {
  return plan.method === "email"
    ? { method: "email", address: plan.address }
    : { method: plan.method, host: plan.host };
}

export async function performUnsubscribe(
  env: Env,
  db: DB,
  msg: {
    mailboxId: string;
    deliveredTo: string | null;
    listUnsubscribe: string | null;
    listUnsubscribePost: string | null;
  },
): Promise<UnsubscribeResultDto> {
  if (!msg.listUnsubscribe) throw new AppError("bad_request", "no unsubscribe info");
  const resolved = resolveUnsubscribe(msg.listUnsubscribe, msg.listUnsubscribePost);
  if (!resolved.ok) throw new AppError("unprocessable", resolved.message);
  const { plan } = resolved;

  switch (plan.method) {
    case "one-click":
      await oneClickPost(plan.url);
      return { status: "unsubscribed", method: "one-click" };
    case "email":
      await sendMailto(env, db, msg.mailboxId, msg.deliveredTo, plan.address, plan.subject);
      return { status: "unsubscribed", method: "email" };
    case "link":
      return { status: "open", method: "link", url: plan.url };
  }
}

// RFC 8058: POST `List-Unsubscribe=One-Click`. Routed through the SSRF guard so
// a sender-controlled URL can't steer us at an internal address.
async function oneClickPost(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("unprocessable", "bad unsubscribe URL");
  }
  const res = await safeRedirectFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  if ("blocked" in res) throw new AppError("bad_request", `unsubscribe blocked: ${res.reason}`);
  if (!res.ok) throw new AppError("upstream", `unsubscribe failed (${res.status})`);
}

// Send the unsubscribe request as a plain email from the mailbox, to the one
// address the sender named, with our fixed body.
async function sendMailto(
  env: Env,
  db: DB,
  mailboxId: string,
  deliveredTo: string | null,
  address: string,
  subject: string,
): Promise<void> {
  const mb = await db.query.mailbox.findFirst({
    where: eq(mailbox.id, mailboxId),
    columns: { localPart: true, domainId: true, displayName: true },
  });
  if (!mb) throw new AppError("not_found", "mailbox not found");
  const dom = await db.query.domain.findFirst({
    where: eq(domain.id, mb.domainId),
    columns: { name: true },
  });
  if (!dom) throw new AppError("internal", "domain missing");

  // Newsletters are often subscribed under a plus/sub-address ("hi+tag@…") and
  // the sender keys the opt-out on that exact address. Send from the address the
  // mail was actually delivered to when it resolves back to this mailbox; fall
  // back to the bare base address otherwise.
  const baseAddr = `${mb.localPart}@${dom.name}`;
  const fromAddr = deliveredToMatches(deliveredTo, mb.localPart, dom.name)
    ? (deliveredTo as string)
    : baseAddr;

  try {
    await env.EMAIL.send({
      from: mb.displayName ? { name: mb.displayName, email: fromAddr } : fromAddr,
      to: [address],
      subject,
      text: UNSUBSCRIBE_BODY,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("upstream", `unsubscribe email failed: ${detail}`);
  }
}
