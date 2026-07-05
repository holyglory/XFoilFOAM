import { defineConfig } from "vitest/config";

// Every API test file is a shared-database integration test (real Postgres
// state: presets, campaigns, sync claims). Running the files in parallel
// races them against each other — e.g. the catalog sync-claim test can claim
// a pending sweep created by the concurrently-running campaigns test, whose
// preset revision is purged before the promise insert (FK 23503 → 500).
// Serialize test files; tests inside a file already run sequentially.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
