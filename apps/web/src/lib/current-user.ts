import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { meQuery } from "./queries.ts";

// Who is signed in, for route guards. A cached signed-in answer is used as is.
// A cached signed-out answer is asked again: signing in does not touch the
// query cache, so the guard that runs right after it would otherwise still see
// "nobody" and send the user back to /login.
export async function currentUser<U>(
  qc: QueryClient,
  queryKey: QueryKey,
  ask: () => Promise<{ user: U | null }>,
): Promise<U | null> {
  const cached = qc.getQueryData<{ user: U | null }>(queryKey);
  if (cached?.user) return cached.user;
  return (await ask()).user;
}

export const signedInUser = (qc: QueryClient) =>
  currentUser(qc, meQuery.queryKey, () => qc.fetchQuery({ ...meQuery, staleTime: 0 }));
