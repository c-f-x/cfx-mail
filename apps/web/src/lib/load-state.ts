// What a list or pane should show for a query: its rows, a loading state, an
// error, or "nothing here". The failure case matters: a failed load that renders
// as "empty" reads as "your mail is gone".
export type LoadView = "loading" | "error" | "empty" | "content";

export function loadView(input: {
  /** Rows (or 1 for a single record) available to show. */
  count: number;
  /** First load in flight, nothing fetched yet. */
  loading: boolean;
  /** The last fetch failed. */
  error: boolean;
  /** A fetch is running, including a retry. */
  fetching: boolean;
}): LoadView {
  // Rows already on screen stay there when a later refresh fails.
  if (input.count > 0) return "content";
  if (input.loading || (input.error && input.fetching)) return "loading";
  if (input.error) return "error";
  return "empty";
}
