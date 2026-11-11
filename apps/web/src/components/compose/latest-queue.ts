// Runs async jobs one at a time. A job submitted while another runs waits; a
// newer submission replaces a waiting one, because only the latest state is
// worth saving. Every submit resolves when the job that stands for it has run:
// its own, or the newer one that replaced it.

interface Waiting<R> {
  job: () => Promise<R>;
  waiters: { resolve: (r: R) => void; reject: (e: unknown) => void }[];
}

export function createLatestQueue<R>(): (job: () => Promise<R>) => Promise<R> {
  let running = false;
  let waiting: Waiting<R> | null = null;

  async function drain() {
    while (waiting) {
      const { job, waiters } = waiting;
      waiting = null;
      running = true;
      try {
        // eslint-disable-next-line no-await-in-loop -- one job at a time is the point
        const result = await job();
        for (const w of waiters) w.resolve(result);
      } catch (err) {
        for (const w of waiters) w.reject(err);
      } finally {
        running = false;
      }
    }
  }

  return (job) =>
    new Promise<R>((resolve, reject) => {
      waiting = { job, waiters: [...(waiting?.waiters ?? []), { resolve, reject }] };
      if (!running) void drain();
    });
}
