import type { Env } from "../env.ts";

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// Best-effort transactional email (password reset, invites, etc.).
// Failures are logged but never thrown: auth flows should not 5xx on a
// missing or unverified sending domain. Resolves whether the mail went out, for
// callers that must tell the user.
export async function sendMail(env: Env, mail: OutgoingMail): Promise<boolean> {
  try {
    await env.EMAIL.send({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    });
    return true;
  } catch (err) {
    console.error("notify.sendMail failed", err);
    return false;
  }
}
