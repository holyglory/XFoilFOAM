import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sweeper integration files deliberately share one live database. Most
    // files may keep running in parallel, but the rare files which create a
    // production-global admission hazard take an exclusive database advisory
    // lease. `stack` makes the test file's own afterAll cleanup run before the
    // setup file verifies/restores the singleton and releases that lease.
    setupFiles: ["./test/global-admission-test-lease.ts"],
    sequence: { hooks: "stack" },
    hookTimeout: 300_000,
  },
});
