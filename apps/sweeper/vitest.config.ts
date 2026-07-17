import { defineConfig } from "vitest/config";

// Sweeper test files share one real Postgres database and exercise global
// scheduling state. In particular, remote admission intentionally counts every
// active sim_jobs row, so an unrelated file running concurrently can consume
// the fixture's capacity and turn a required submit into a truthful no-op.
// Serialize files; tests inside each file already run sequentially.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
