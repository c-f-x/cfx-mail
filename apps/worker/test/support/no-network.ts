// Tests never reach the internet. A real request makes a test slow or flaky
// and hides a dependency the test does not control; the cron test hung this
// way on a DNS lookup. A test that needs fetch replaces it with
// vi.stubGlobal("fetch", ...), and vi.unstubAllGlobals() brings back this guard.
globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(`Test tried to reach the network: ${url}. Stub fetch in this test.`);
};
