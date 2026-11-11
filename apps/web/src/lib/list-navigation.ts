// Which conversation `j` / `k` and the toolbar's older / newer arrows open.
// Pure, so the rule is the same in an account, in All accounts and in a folder.

/**
 * The id `delta` steps away from `current` in `ids` (the list as shown, newest
 * first), clamped to the ends. With nothing open, forward opens the first and
 * back opens the last. Undefined when the list is empty.
 */
export function stepThread(
  ids: readonly string[],
  current: string | undefined,
  delta: number,
): string | undefined {
  if (ids.length === 0) return undefined;
  const at = current ? ids.indexOf(current) : -1;
  if (at === -1) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(Math.max(at + delta, 0), ids.length - 1)];
}
