import { describe, expect, it } from "vitest";

import { remainingAdmissionCpuSlotsForStatus } from "../src/reconcile";
import { fitAdmissionResourcesToAvailableSlots } from "../src/submit-lifecycle";

describe("admission resource fitting", () => {
  it("fills a four-slot hub remainder from an eight-slot case batch", () => {
    expect(
      fitAdmissionResourcesToAvailableSlots(
        { solver_processes: 1, case_concurrency: 8 },
        8,
        4,
      ),
    ).toMatchObject({
      slots: 4,
      resources: { solver_processes: 1, case_concurrency: 4 },
    });
  });

  it("fills the final two remote slots from a seventeen-slot batch", () => {
    expect(
      fitAdmissionResourcesToAvailableSlots(
        { solver_processes: 1, case_concurrency: 17 },
        17,
        2,
      ),
    ).toMatchObject({ slots: 2, resources: { case_concurrency: 2 } });
  });

  it("refuses zero remaining capacity", () => {
    expect(
      fitAdmissionResourcesToAvailableSlots(
        { solver_processes: 1, case_concurrency: 8 },
        8,
        0,
      ),
    ).toBeNull();
  });

  it("never reduces the configured per-case solver process group", () => {
    expect(
      fitAdmissionResourcesToAvailableSlots(
        { solver_processes: 4, case_concurrency: 2 },
        8,
        3,
      ),
    ).toBeNull();
  });
});

describe("running batch tail reservation", () => {
  const status = (
    totalCases: number,
    completedCases: number,
    caseConcurrency: number,
    solverProcesses = 1,
  ) => ({
    job_id: "engine-job",
    state: "running" as const,
    total_cases: totalCases,
    completed_cases: completedCases,
    scheduling: {
      requested_policy: "auto" as const,
      resolved_policy: "auto" as const,
      worker_cpu_budget: 64,
      resolved_cpu_budget: 64,
      resolved_case_concurrency: caseConcurrency,
      solver_processes: solverProcesses,
      mesh_build_count: 1,
      aoa_case_count: totalCases,
      mesh_reuse_mode: "symlink" as const,
    },
  });

  it("releases finished cases only after the unfinished tail drops below concurrency", () => {
    expect(remainingAdmissionCpuSlotsForStatus(8, status(10, 1, 8))).toBe(8);
    expect(remainingAdmissionCpuSlotsForStatus(8, status(10, 5, 8))).toBe(5);
  });

  it("preserves each remaining case's complete solver process group", () => {
    expect(remainingAdmissionCpuSlotsForStatus(8, status(4, 3, 2, 4))).toBe(
      4,
    );
  });

  it("keeps a positive terminal/ingest owner and never grows a fitted job", () => {
    expect(remainingAdmissionCpuSlotsForStatus(16, status(16, 16, 16))).toBe(
      1,
    );
    expect(remainingAdmissionCpuSlotsForStatus(4, status(16, 2, 16))).toBe(4);
  });

  it("fails closed on missing or contradictory engine scheduling metadata", () => {
    const missing = {
      job_id: "legacy",
      state: "running" as const,
      total_cases: 16,
      completed_cases: 8,
    };
    expect(remainingAdmissionCpuSlotsForStatus(16, missing)).toBe(16);
    expect(remainingAdmissionCpuSlotsForStatus(16, status(4, 5, 4))).toBe(16);
  });
});
