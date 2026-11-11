// Sign-out on a shared computer must leave nothing of the account behind: no
// push subscription that keeps showing sender and subject, and no mail in the
// query cache. Dependencies are parameters so the order is testable.
export async function signOutAndClear(deps: {
  /** Unsubscribe this device from push. Needs the session, so it runs first. */
  disablePush: () => Promise<void>;
  /** End the session. Better Auth's client resolves with `{ error }` on refusal. */
  signOut: () => Promise<unknown>;
  /** Drop everything cached for the signed-in user. */
  clearCache: () => void;
}): Promise<void> {
  // A failed unsubscribe (offline, no service worker, push never enabled) must not
  // keep the user signed in.
  await deps.disablePush().catch(() => {});
  try {
    const res = await deps.signOut();
    const error = (res as { error?: { message?: string } | null } | null)?.error;
    if (error) throw new Error(error.message ?? "sign-out failed");
  } finally {
    deps.clearCache();
  }
}
