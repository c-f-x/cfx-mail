import { describe, expect, it } from "vitest";
import { createBodyBatcher } from "./body-batcher.ts";

// A stand-in for the bodies route: records each request and answers with the
// ids it knows, the way GET /api/threads/:id/bodies leaves unknown ids out.
function fakeServer(known: Set<string>, failThreads: Set<string> = new Set()) {
  const requests: { threadId: string; ids: string[] }[] = [];
  const fetchMany = async (threadId: string, ids: string[]) => {
    requests.push({ threadId, ids });
    if (failThreads.has(threadId)) throw new Error(`thread ${threadId} failed`);
    return Object.fromEntries(ids.filter((id) => known.has(id)).map((id) => [id, `body of ${id}`]));
  };
  return { requests, fetchMany };
}

const missing = (id: string) => new Error(`missing ${id}`);

describe("createBodyBatcher", () => {
  it("sends the loads of one tick for one thread as one request", async () => {
    const server = fakeServer(new Set(["a", "b", "c"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    const bodies = await Promise.all([load("t1", "a"), load("t1", "b"), load("t1", "c")]);
    expect(bodies).toEqual(["body of a", "body of b", "body of c"]);
    expect(server.requests).toEqual([{ threadId: "t1", ids: ["a", "b", "c"] }]);
  });

  it("asks once for an id loaded twice in one tick", async () => {
    const server = fakeServer(new Set(["a"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    expect(await Promise.all([load("t1", "a"), load("t1", "a")])).toEqual([
      "body of a",
      "body of a",
    ]);
    expect(server.requests).toEqual([{ threadId: "t1", ids: ["a"] }]);
  });

  it("splits a long conversation into requests of at most maxIds", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const server = fakeServer(new Set(ids));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 2, missing });
    await Promise.all(ids.map((id) => load("t1", id)));
    expect(server.requests.map((r) => r.ids)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("sends one request per thread", async () => {
    const server = fakeServer(new Set(["a", "b"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    await Promise.all([load("t1", "a"), load("t2", "b")]);
    expect(server.requests).toEqual([
      { threadId: "t1", ids: ["a"] },
      { threadId: "t2", ids: ["b"] },
    ]);
  });

  it("fails only the message the server left out", async () => {
    const server = fakeServer(new Set(["a"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    const [a, gone] = await Promise.allSettled([load("t1", "a"), load("t1", "gone")]);
    expect(a).toEqual({ status: "fulfilled", value: "body of a" });
    expect(gone).toEqual({ status: "rejected", reason: new Error("missing gone") });
  });

  it("fails every load of a failed request with its error, and no other", async () => {
    const server = fakeServer(new Set(["a", "b"]), new Set(["broken"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    const results = await Promise.allSettled([
      load("broken", "a"),
      load("broken", "b"),
      load("t1", "a"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect((results[0] as PromiseRejectedResult).reason).toEqual(new Error("thread broken failed"));
  });

  it("starts a new request for loads after a flush", async () => {
    const server = fakeServer(new Set(["a", "b"]));
    const load = createBodyBatcher({ fetchMany: server.fetchMany, maxIds: 50, missing });
    await load("t1", "a");
    await load("t1", "b");
    expect(server.requests.map((r) => r.ids)).toEqual([["a"], ["b"]]);
  });
});
