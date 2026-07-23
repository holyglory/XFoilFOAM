import { describe, expect, it } from "vitest";

import {
  activeReconcileJobLimit,
  DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
} from "../src/reconcile";

describe("foreground reconciliation budget", () => {
  it("MUST-CATCH: bounds the unconfigured production pass before all high-concurrency jobs", () => {
    expect(activeReconcileJobLimit(undefined)).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
    expect(DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT).toBe(8);
  });

  it("accepts a positive operator override and fails safe on invalid values", () => {
    expect(activeReconcileJobLimit("4")).toBe(4);
    expect(activeReconcileJobLimit("200")).toBe(64);
    expect(activeReconcileJobLimit("0")).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
    expect(activeReconcileJobLimit("not-a-number")).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
  });
});
