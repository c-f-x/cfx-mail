import type { ThreadDto } from "@cfmail/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThreadChangeCoalescer,
  invalidateThreadChange,
  patchThreadsInLists,
  removeThreadsFromLists,
  restoreSnapshot,
  snapshotMailboxThreads,
} from "./invalidate.ts";
import { keys } from "./query-keys.ts";

function harness() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const invalidatedKeys = () =>
    spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  return { qc, spy, invalidatedKeys };
}

describe("invalidateThreadChange — scope semantics", () => {
  it("a bare mailbox change refreshes only that mailbox's thread root (plus the All view)", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).toEqual([keys.threadsRoot("mb-1"), keys.threadsRoot("all")]);
  });

  it("threadId adds the open thread detail", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1", threadId: "t-1" });
    expect(invalidatedKeys()).toContainEqual(keys.thread("t-1"));
  });

  it("counts gates the mailbox badge refresh", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).not.toContainEqual(keys.mailboxes());

    invalidateThreadChange(qc, { mailboxId: "mb-1", counts: true });
    expect(invalidatedKeys()).toContainEqual(keys.mailboxes());
  });

  it("folders gates the folder list + folder-threads refresh", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "mb-1" });
    expect(invalidatedKeys()).not.toContainEqual(keys.folders());
    expect(invalidatedKeys()).not.toContainEqual(keys.folderThreadsRoot());

    invalidateThreadChange(qc, { mailboxId: "mb-1", folders: true });
    expect(invalidatedKeys()).toContainEqual(keys.folders());
    expect(invalidatedKeys()).toContainEqual(keys.folderThreadsRoot());
  });

  it("a change already scoped to the All view does not double-invalidate it", () => {
    const { qc, invalidatedKeys } = harness();
    invalidateThreadChange(qc, { mailboxId: "all" });
    expect(invalidatedKeys()).toEqual([keys.threadsRoot("all")]);
  });
});

describe("createThreadChangeCoalescer — batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges a burst of pushes into one invalidation cycle with the union scope", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", threadId: "t-1" });
    co.push({ mailboxId: "mb-1", threadId: "t-2", counts: true });
    co.push({ mailboxId: "mb-2", folders: true });

    // Nothing fires inside the window.
    vi.advanceTimersByTime(1499);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    const got = invalidatedKeys();
    // One cycle: each root exactly once, with the merged flags applied.
    expect(got).toContainEqual(keys.threadsRoot("mb-1"));
    expect(got).toContainEqual(keys.threadsRoot("mb-2"));
    expect(got).toContainEqual(keys.threadsRoot("all"));
    expect(got).toContainEqual(keys.thread("t-1"));
    expect(got).toContainEqual(keys.thread("t-2"));
    expect(got).toContainEqual(keys.mailboxes());
    expect(got).toContainEqual(keys.folders());
    expect(got).toContainEqual(keys.folderThreadsRoot());
    expect(got).toHaveLength(8);
  });

  it("a push after a flush opens a fresh window with a clean scope", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", counts: true });
    vi.advanceTimersByTime(1500);
    spy.mockClear();

    co.push({ mailboxId: "mb-2" });
    vi.advanceTimersByTime(1500);
    const got = invalidatedKeys();
    // The earlier counts/mailbox scope must not bleed into the new cycle.
    expect(got).toEqual([keys.threadsRoot("mb-2"), keys.threadsRoot("all")]);
  });

  it("dispose flushes pending work immediately", () => {
    const { qc, spy, invalidatedKeys } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);

    co.push({ mailboxId: "mb-1", threadId: "t-1" });
    co.dispose();
    expect(invalidatedKeys()).toContainEqual(keys.threadsRoot("mb-1"));
    expect(invalidatedKeys()).toContainEqual(keys.thread("t-1"));

    // And nothing fires again when the timer would have elapsed.
    spy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dispose with nothing pending is a no-op", () => {
    const { qc, spy } = harness();
    const co = createThreadChangeCoalescer(qc, 1500);
    co.dispose();
    expect(spy).not.toHaveBeenCalled();
  });
});

const thread = (id: string, mailboxId: string) =>
  ({ id, mailboxId, unreadCount: 1 }) as unknown as ThreadDto;

describe("optimistic list edits reach the All accounts view", () => {
  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData(keys.threads("mb-1", "inbox"), {
      pages: [{ threads: [thread("t1", "mb-1")] }],
    });
    qc.setQueryData(keys.threads("all", "inbox"), {
      pages: [{ threads: [thread("t1", "mb-1"), thread("t2", "mb-2")] }],
    });
    const ids = (mailboxId: string) =>
      (
        qc.getQueryData(keys.threads(mailboxId, "inbox")) as {
          pages: { threads: { id: string; unreadCount: number }[] }[];
        }
      ).pages[0]!.threads;
    return { qc, ids };
  }

  it("removing a thread from its account's lists removes it from the All accounts list", () => {
    const { qc, ids } = seeded();
    removeThreadsFromLists(qc, "mb-1", ["t1"]);
    expect(ids("mb-1").map((t) => t.id)).toEqual([]);
    expect(ids("all").map((t) => t.id)).toEqual(["t2"]);
  });

  it("patching a thread in its account's lists patches it in the All accounts list", () => {
    const { qc, ids } = seeded();
    patchThreadsInLists(qc, "mb-1", ["t1"], { unreadCount: 0 });
    expect(ids("all").find((t) => t.id === "t1")?.unreadCount).toBe(0);
  });

  it("a snapshot covers the All accounts list, so a failed request restores it", () => {
    const { qc, ids } = seeded();
    const snap = snapshotMailboxThreads(qc, "mb-1");
    removeThreadsFromLists(qc, "mb-1", ["t1"]);
    restoreSnapshot(qc, snap);
    expect(ids("all").map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});
