import { defineConfig } from "vitest/config";

/**
 * Geometry, command and store tests are pure logic, so they run in a node
 * environment with no DOM. Component and canvas tests will need their own
 * project entry with jsdom once they land (TRD §22.1).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/renderer/src/editor/**", "src/renderer/src/document/**"],
    },
  },
});
