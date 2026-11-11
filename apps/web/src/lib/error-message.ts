// The one place a failed request becomes words for a person. The API answers
// most failures with a bare code ("internal_error", "forbidden", "not found");
// nobody can act on that, so the status picks a plain sentence with a next step.

/** Status of a request that got no response at all (offline, server down). */
export const NO_RESPONSE = 0;

/** For a failure with no sentence of its own, and for one that is not a request at all. */
export const GENERAL_ERROR_MESSAGE = "Something went wrong. Try again.";

// Phrases the API uses that only restate the status.
const STOCK_PHRASES = new Set(["not found", "rate limit exceeded", "admin only", "owner only"]);

// A bare code tells a person nothing the status does not: a single token such
// as "internal_error", or a stock phrase. Anything else the server wrote says
// what happened ("Delete this domain's mailboxes first.") and is shown as is.
function isBareCode(message: string): boolean {
  return !/\s/.test(message) || STOCK_PHRASES.has(message.toLowerCase());
}

export function plainErrorMessage(status: number, serverMessage?: string | null): string {
  const message = serverMessage?.trim() ?? "";
  if (message && !isBareCode(message)) return message;
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "This doesn't exist any more.";
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  if (status === NO_RESPONSE || status >= 500)
    return "The server didn't respond. Try again in a moment.";
  return GENERAL_ERROR_MESSAGE;
}
