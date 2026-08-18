import { requiresConservativePrecalcRetry } from "@aerodb/db";
import type { PolarRequest } from "@aerodb/engine-client";
import { describe, expect, it } from "vitest";

import {
  applyConservativeUransRetryPlan,
  conservativeUransRetryPlan,
  MIN_CONSERVATIVE_URANS_RETRY_VERSION,
} from "../src/urans-quality-recovery";

describe("repeated preliminary URANS quality recovery", () => {
  it("keeps a first physical attempt on the adaptive throughput path", () => {
    expect(requiresConservativePrecalcRetry([{ attemptCount: 0 }])).toBe(false);
    expect(conservativeUransRetryPlan(false, null)).toEqual({
      kind: "not_required",
    });
  });

  it("requires the conservative rung when any selected cell was attempted", () => {
    expect(
      requiresConservativePrecalcRetry([
        { attemptCount: 0 },
        { attemptCount: 1 },
      ]),
    ).toBe(true);
  });

  it.each([null, 0, 11, 12])(
    "defers a repeated attempt on pre-v13 engine capability %p",
    (version) => {
      const plan = conservativeUransRetryPlan(true, version);
      expect(plan.kind).toBe("deferred");
      if (plan.kind === "deferred") {
        expect(plan.error).toContain(
          `v${MIN_CONSERVATIVE_URANS_RETRY_VERSION}+`,
        );
      }
    },
  );

  it("pins v13 and selects recovery in both engine and durable job payloads", () => {
    const request = {
      solver: {
        force_transient: true,
        urans_fidelity: "precalc",
      },
    } as PolarRequest;
    const plan = conservativeUransRetryPlan(true, 13);
    expect(plan).toEqual({ kind: "required", recoveryVersion: 13 });
    if (plan.kind !== "required") throw new Error("expected required plan");

    applyConservativeUransRetryPlan(request, plan);

    expect(request.solver?.urans_quality_recovery).toBe(true);
    expect(request.expected_urans_recovery_version).toBe(13);
    expect({
      uransQualityRecovery: true,
      uransRecoveryVersion: plan.recoveryVersion,
    }).toEqual({ uransQualityRecovery: true, uransRecoveryVersion: 13 });
  });
});
