import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.ts";

const MAX_RETRIES = 3;

// Retry transient failures (network, 5xx). A 4xx is an answer that will not
// change by asking again, and for a 401 the wait only delays the sign-in screen.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

// `onUnauthorized` runs when any query or mutation fails with 401: the session
// ended (expired, banned, signed out elsewhere) and nothing will load again.
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry },
    },
  });
}
