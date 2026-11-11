import type { ThreadDto } from "@cfx-mail/shared";
import { displaySubject, normalizeSubject } from "@cfx-mail/shared/subject";

// The line a thread is shown under: its stored subject in the case it was
// written, without "Re:" or "Fwd:". The stored `subjectNorm` is lowercased for
// matching replies, so it is not for showing.
export function threadSubject(thread: Pick<ThreadDto, "subject">): string {
  return displaySubject(thread.subject) || "(no subject)";
}

// A reply that changes the conversation's subject shows its own, like a new
// email. Compared the way threading compares subjects, so "Re:" alone and a
// change of case are no change. An out-of-office reply's "Automatic reply: …"
// is no change either.
export function changesSubject(
  message: { subject: string; autoReply: boolean },
  index: number,
  thread: Pick<ThreadDto, "subject">,
): boolean {
  return (
    index > 0 &&
    !message.autoReply &&
    !!message.subject.trim() &&
    normalizeSubject(message.subject) !== normalizeSubject(thread.subject)
  );
}
