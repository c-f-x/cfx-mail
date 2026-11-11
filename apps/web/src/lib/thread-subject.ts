import type { ThreadDto } from "@cfx-mail/shared";

// The line a thread is shown under: its first message's subject as sent. The
// stored `subjectNorm` is lowercased and stripped of "Re:" for matching
// replies, so it is not for showing.
export function threadSubject(thread: Pick<ThreadDto, "subject">): string {
  return thread.subject || "(no subject)";
}
