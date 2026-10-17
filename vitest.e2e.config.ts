import { defineConfig } from "vitest/config";

/**
 * End-to-end configuration, kept separate from the unit suite (TRD §22.1).
 *
 * These launch the real built Electron binary, so they need long timeouts and
 * must not run in parallel: two instances would contend for the same profile and
 * the same single-instance lock. Run through `npm run test:e2e`, which builds
 * first.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
