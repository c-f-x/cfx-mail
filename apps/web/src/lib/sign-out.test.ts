import { describe, expect, it } from "vitest";
import { signOutAndClear } from "./sign-out.ts";

function deps(overrides: Partial<Parameters<typeof signOutAndClear>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      disablePush: async () => void calls.push("disablePush"),
      signOut: async () => void calls.push("signOut"),
      clearCache: () => void calls.push("clearCache"),
      ...overrides,
    },
  };
}

describe("signOutAndClear", () => {
  it("unsubscribes push while the session still exists, then ends it, then clears the cache", async () => {
    const { calls, deps: d } = deps();
    await signOutAndClear(d);
    expect(calls).toEqual(["disablePush", "signOut", "clearCache"]);
  });

  it("still signs out and clears the cache when the push unsubscribe fails", async () => {
    const { calls, deps: d } = deps({
      disablePush: async () => {
        throw new Error("offline");
      },
    });
    await signOutAndClear(d);
    expect(calls).toEqual(["signOut", "clearCache"]);
  });

  it("clears the cache even when ending the session fails, and surfaces the failure", async () => {
    const { calls, deps: d } = deps({
      signOut: async () => {
        throw new Error("server down");
      },
    });
    await expect(signOutAndClear(d)).rejects.toThrow("server down");
    expect(calls).toEqual(["disablePush", "clearCache"]);
  });

  it("treats an error result from the auth client as a failure", async () => {
    // Better Auth's client resolves with `{ error }` when the server refuses.
    const { deps: d } = deps({
      signOut: async () => ({ data: null, error: { message: "Invalid origin" } }),
    });
    await expect(signOutAndClear(d)).rejects.toThrow("Invalid origin");
  });
});
