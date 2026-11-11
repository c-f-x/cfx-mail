import { MailboxKind } from "@cfmail/shared/permissions";

// The kinds the mailbox forms can create, out of those a domain (and grant)
// allows. Temp mailboxes are made with "New temporary account" and service
// ones under Admin, Service, each with the settings that kind needs.
export function formMailboxKinds(allowed: number): ("personal" | "group")[] {
  const kinds: ("personal" | "group")[] = [];
  if (allowed & MailboxKind.PERSONAL) kinds.push("personal");
  if (allowed & MailboxKind.GROUP) kinds.push("group");
  return kinds;
}
