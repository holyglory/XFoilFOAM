// Cross-runtime pin for the engine's worker-boot orphan reconciliation
// message. The sweeper distinguishes "worker restarted mid-solve"
// (infrastructure interruption → release claims for re-solve) from genuine
// solver failure (→ terminal-failed evidence) by EXACT string equality with
// src/airfoilfoam/storage.py ORPHAN_MESSAGE. The literal is hardcoded here on
// purpose: if either side changes the message, that side's pin test fails —
// drift can never silently turn worker restarts back into fake terminal
// failures (incident 2026-07-04: 12 campaign points +3 symmetry mirrors
// terminal-failed with empty error text).
// Python twin: tests/test_orphan_reconcile.py::test_orphan_message_is_pinned_for_node_clients

import { WORKER_RESTART_ORPHAN_MESSAGE } from "@aerodb/engine-client";
import { describe, expect, it } from "vitest";

describe("worker-restart orphan message pin", () => {
  it("matches the engine's storage.py ORPHAN_MESSAGE literal byte-for-byte", () => {
    expect(WORKER_RESTART_ORPHAN_MESSAGE).toBe("worker restarted mid-solve; task lost");
  });
});
