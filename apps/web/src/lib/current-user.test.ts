import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { currentUser } from "./current-user.ts";

const alice = { id: "u1", email: "alice@example.com" };

function setup(cached: { user: typeof alice | null } | undefined, server: typeof alice | null) {
  const qc = new QueryClient();
  const queryFn = vi.fn(async () => ({ user: server }));
  const queryKey = ["me"];
  if (cached) qc.setQueryData(queryKey, cached);
  const ask = () => qc.fetchQuery({ queryKey, queryFn, staleTime: 0 });
  return { qc, queryKey, ask, queryFn };
}

describe("currentUser", () => {
  it("asks again when the cached answer is signed out", async () => {
    // Signing in does not touch the query cache, so the route guard right after
    // it would otherwise still see the signed-out answer and bounce to /login.
    const { qc, queryKey, ask, queryFn } = setup({ user: null }, alice);
    expect(await currentUser(qc, queryKey, ask)).toEqual(alice);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(queryKey)).toEqual({ user: alice });
  });

  it("uses a cached signed-in answer without asking", async () => {
    const { qc, queryKey, ask, queryFn } = setup({ user: alice }, null);
    expect(await currentUser(qc, queryKey, ask)).toEqual(alice);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("asks when nothing is cached", async () => {
    const { qc, queryKey, ask, queryFn } = setup(undefined, null);
    expect(await currentUser(qc, queryKey, ask)).toBeNull();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
