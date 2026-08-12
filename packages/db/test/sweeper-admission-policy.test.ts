import { enforceSweeperAdmissionFence, type DB } from "@aerodb/db";
import { describe, expect, it } from "vitest";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";

describe("disposable-compute admission policy", () => {
  it("does not infer a new fleet stop from solver ledgers", async () => {
    let calls = 0;
    const db = {
      execute: async () => {
        calls += 1;
        return [
          {
            active: false,
            reason: "critical_solver_incident",
            trigger_key: "incident:disposable",
            details: {
              campaignId: CAMPAIGN_ID,
              generation: 2,
              stage: "preliminary",
            },
          },
        ];
      },
    } as unknown as DB;

    expect(
      await enforceSweeperAdmissionFence(db, {
        policy: "disposable_compute",
      }),
    ).toEqual({
      hazardPresent: false,
      fencedNow: false,
      active: false,
      trigger: null,
    });
    expect(calls).toBe(1);
  });

  it("preserves an existing operator latch until explicit Resume", async () => {
    const db = {
      execute: async () => [
        {
          active: true,
          reason: "critical_solver_incident",
          trigger_key: "incident:disposable",
          details: {
            campaignId: CAMPAIGN_ID,
            generation: 2,
            stage: "preliminary",
          },
        },
      ],
    } as unknown as DB;

    expect(
      await enforceSweeperAdmissionFence(db, {
        policy: "disposable_compute",
      }),
    ).toMatchObject({
      hazardPresent: false,
      fencedNow: false,
      active: true,
      trigger: {
        reason: "critical_solver_incident",
        campaignId: CAMPAIGN_ID,
        generation: 2,
      },
    });
  });
});
