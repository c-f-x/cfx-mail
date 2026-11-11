import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  path.resolve(import.meta.dirname, "../../packages/db/drizzle"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Stands in for the Worker secret that gates first-run setup.
          SETUP_TOKEN: "test-setup-token-not-a-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    setupFiles: ["./test/support/no-network.ts"],
    // The run keeps what it creates, such as wrangler's logs, in a scope of its
    // own and removes it at the end (scripts/run-scope.mjs).
    globalSetup: ["../../scripts/vitest-run-scope.mjs"],
    // Tests run in a real workerd against real D1 and R2, and CI runs three
    // jobs side by side on one machine. The default 5 s was hit under load by
    // tests that take well under a second when idle.
    testTimeout: 20_000,
    // Setup hooks apply migrations and create users, whose passwords are
    // hashed slowly on purpose. Vitest's default of 10 s failed route-walk's
    // setup on a CI Mac running seven pull requests at once (run 43090942442).
    // A timeout catches a hang, never slowness.
    hookTimeout: 60_000,
  },
});
