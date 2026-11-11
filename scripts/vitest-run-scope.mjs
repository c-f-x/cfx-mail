import path from "node:path";
import { openRunScope } from "./run-scope.mjs";

// Vitest global setup: the test run's own scope. Wrangler and the Workers test
// pool write their logs inside it instead of the shared folder in the home
// directory, and the scope is removed when the run ends. A run that leaves
// anything of its own behind fails. Copied from cfx-analytics (decision D-17).
export default function setup() {
  const scope = openRunScope({ installExitHandlers: true });
  process.env.WRANGLER_LOG_PATH = path.join(scope.dir, "wrangler-logs");
  return async () => {
    const { leftovers } = await scope.close();
    if (leftovers.length > 0) {
      throw new Error(`The test run left things behind: ${leftovers.join(", ")}`);
    }
  };
}
