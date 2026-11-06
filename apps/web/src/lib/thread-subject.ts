import type { ThreadDto } from "@cfx-mail/shared";
import { normalizeSubject } from "@cfx-mail/shared/subject";

// The line a thread is shown under: its first message's subject as sent. The
// stored `subjectNorm` is lowercased and stripped of "Re:" for matching
// replies, so it is not for showing.
export function threadSubject(thread: Pick<ThreadDto, "subject">): string {
  return thread.subject || "(no subject)";
}

// A reply that changes the conversation's subject shows its own, like a new
// email. Compared the way threading compares subjects, so "Re:" alone and a
// change of case are no change.
export function changesSubject(
  message: { subject: string },
  index: number,
  thread: Pick<ThreadDto, "subject">,
): boolean {
  return (
    index > 0 &&
    !!message.subject.trim() &&
    normalizeSubject(message.subject) !== normalizeSubject(thread.subject)
  );
}
