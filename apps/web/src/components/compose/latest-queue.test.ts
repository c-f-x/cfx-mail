import { describe, expect, it } from "vitest";
import { createLatestQueue } from "./latest-queue.ts";

// Draft saves run one at a time, and only the newest waiting state matters.
// The pop-out waits on its own save: before, a save asked for while another
// was running returned at once, before anything was stored, and the new
// window opened without the text.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestQueue", () => {
  it("runs a job at once when idle and resolves with its result", async () => {
    const submit = createLatestQueue<string>();
    expect(await submit(async () => "saved")).toBe("saved");
  });

  it("does not resolve a job asked for during another until it has run", async () => {
    const submit = createLatestQueue<string>();
    const first = deferred<string>();
    const ran: string[] = [];
    const a = submit(() => {
      ran.push("a");
      return first.promise;
    });
    let bDone = false;
    const b = submit(async () => {
      ran.push("b");
      return "b";
    }).then((v) => {
      bDone = true;
      return v;
    });
    await Promise.resolve();
    expect(ran).toEqual(["a"]);
    expect(bDone).toBe(false);
    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(ran).toEqual(["a", "b"]);
  });

  it("replaces a waiting job with a newer one, and both callers get the newer result", async () => {
    const submit = createLatestQueue<string>();
    const first = deferred<string>();
    const ran: string[] = [];
    void submit(() => {
      ran.push("a");
      return first.promise;
    });
    const b = submit(async () => {
      ran.push("b");
      return "b";
    });
    const c = submit(async () => {
      ran.push("c");
      return "c";
    });
    first.resolve("a");
    expect(await Promise.all([b, c])).toEqual(["c", "c"]);
    expect(ran).toEqual(["a", "c"]);
  });

  it("passes a failure to the callers of that job only, and keeps going", async () => {
    const submit = createLatestQueue<string>();
    const failing = submit(async () => {
      throw new Error("offline");
    });
    const next = submit(async () => "saved");
    await expect(failing).rejects.toThrow("offline");
    expect(await next).toBe("saved");
  });
});
