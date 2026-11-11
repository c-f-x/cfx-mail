import { ApiError } from "./api.ts";
import { GENERAL_ERROR_MESSAGE, plainErrorMessage } from "./error-message.ts";

// Copy for the router's error screen and for a pane that failed to load. A
// 404/403 is final; anything else may be a blip, so it offers a retry. An error that did not come
// from the API (a script error) carries a message for developers, which is
// never shown.
export function describeRouteError(error: unknown): {
  title: string;
  hint?: string;
  retry: boolean;
} {
  if (!(error instanceof ApiError)) return { title: GENERAL_ERROR_MESSAGE, retry: true };
  const title = plainErrorMessage(error.status, error.message);
  if (error.status === 404) return { title, hint: "It may have been deleted.", retry: false };
  if (error.status === 403) {
    return {
      title,
      hint: "Ask the owner of the mailbox to share it with you.",
      retry: false,
    };
  }
  return { title, retry: true };
}
