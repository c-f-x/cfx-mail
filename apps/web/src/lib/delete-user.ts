// Wording for the delete-user dialog (components/admin/users-section.tsx).

/** The confirm button, naming how many ticked mailboxes go with the user. */
export function deleteUserButton(ticked: number): string {
  if (ticked === 0) return "Delete user";
  return `Delete user and ${ticked} ${ticked === 1 ? "mailbox" : "mailboxes"}`;
}

/** A note on a mailbox other people use, or null when nobody else does. */
export function sharedWithText(others: number): string | null {
  if (others === 0) return null;
  return `shared with ${others} ${others === 1 ? "person" : "people"}`;
}
