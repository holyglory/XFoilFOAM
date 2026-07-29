import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sweeper integration files deliberately share one live database. Most
    // files may keep running in parallel, but the rare files which create a
    // production-global admission hazard take an exclusive database advisory
    // lease. `stack` makes the test file's own afterAll cleanup run before the
    // setup file verifies/restores the singleton and releases that lease.
    // Reducer contract tests are intentionally pure and must be runnable
    // without opening the shared development database.  Keep the default
    // integration-safe lease; only an explicit local test command opts out.
    setupFiles:
      process.env.VITEST_PURE_REDUCER_TEST === "1"
        ? []
        : ["./test/global-admission-test-lease.ts"],
    sequence: { hooks: "stack" },
    hookTimeout: 300_000,
  },
});
