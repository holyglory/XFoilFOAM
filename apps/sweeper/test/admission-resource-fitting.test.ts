import { describe, expect, it } from "vitest";

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
