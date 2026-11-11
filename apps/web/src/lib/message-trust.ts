import type { MessageRow } from "./queries.ts";

// Interpret the parsed Authentication-Results summary. "fail" means the sender
// is likely forged; "unverified" means we couldn't confirm it (no/none auth).
export function authStatus(auth: MessageRow["spamAuth"]): "pass" | "fail" | "unverified" | null {
  if (!auth) return null;
  if (auth.dmarc === "pass" || (auth.spf === "pass" && auth.dkim === "pass")) return "pass";
  if (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim === "fail")) return "fail";
  if (!auth.spf && !auth.dkim && !auth.dmarc) return null;
  return "unverified";
}

// The calendar, sign-in/code and unsubscribe banners put controls the sender
// wrote (a link, an address to mail) into the app's own chrome, where they read
// as ours. They are withheld from mail we already distrust: flagged as spam,
// filed in Spam, or sent by a forged address.
export function showSenderControlledBanners(
  msg: Pick<MessageRow, "spamVerdict" | "spamAuth">,
  threadSpam: boolean,
): boolean {
  if (threadSpam) return false;
  if (msg.spamVerdict === "spam") return false;
  return authStatus(msg.spamAuth) !== "fail";
}
