// Each message card asks for its own body, but the server can render the
// bodies of one thread in one request (GET /api/threads/:id/bodies). The
// batcher collects the loads made in the same task, which is how React mounts
// a thread's cards, and sends one request per thread and per `maxIds` ids.

interface Waiter<T> {
  resolve: (body: T) => void;
  reject: (error: unknown) => void;
}

export interface BodyBatcherOptions<T> {
  /** One request: the bodies the server has for `ids`, keyed by id. */
  fetchMany: (threadId: string, ids: string[]) => Promise<Record<string, T>>;
  maxIds: number;
  /** The error for an id the server left out. */
  missing: (id: string) => Error;
}

export function createBodyBatcher<T>({
  fetchMany,
  maxIds,
  missing,
}: BodyBatcherOptions<T>): (threadId: string, messageId: string) => Promise<T> {
  // threadId → messageId → everyone waiting for that body.
  let pending = new Map<string, Map<string, Waiter<T>[]>>();
  let scheduled = false;

  async function send(threadId: string, batch: [string, Waiter<T>[]][]) {
    try {
      const bodies = await fetchMany(
        threadId,
        batch.map(([id]) => id),
      );
      for (const [id, waiters] of batch) {
        const body = bodies[id];
        for (const w of waiters) {
          if (body === undefined) w.reject(missing(id));
          else w.resolve(body);
        }
      }
    } catch (error) {
      for (const [, waiters] of batch) for (const w of waiters) w.reject(error);
    }
  }

  function flush() {
    const groups = pending;
    pending = new Map();
    scheduled = false;
    for (const [threadId, byId] of groups) {
      const entries = [...byId];
      for (let i = 0; i < entries.length; i += maxIds) {
        void send(threadId, entries.slice(i, i + maxIds));
      }
    }
  }

  return (threadId, messageId) =>
    new Promise<T>((resolve, reject) => {
      let byId = pending.get(threadId);
      if (!byId) {
        byId = new Map();
        pending.set(threadId, byId);
      }
      const waiters = byId.get(messageId);
      if (waiters) waiters.push({ resolve, reject });
      else byId.set(messageId, [{ resolve, reject }]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    });
}
