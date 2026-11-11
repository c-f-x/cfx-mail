// Copy for a user with no account (a mailbox, in the admin's words). Only an admin can fix that, so everyone else
// is told to ask rather than pointed at an Admin page they cannot use.
export function noMailboxCopy(role: string | undefined): { hint: string; short: string } {
  if (role === "admin") {
    return {
      hint: "Create a domain and an account for it on the admin page to start sending and receiving.",
      short: "Create one in Admin.",
    };
  }
  return {
    hint: "You don't have an account yet. Ask your administrator to give you access to one.",
    short: "Ask your administrator for one.",
  };
}
