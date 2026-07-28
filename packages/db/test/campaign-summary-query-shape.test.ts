import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { DB } from "../src/client";
import { listCampaigns } from "../src/campaigns";
import {
  campaignOpenTierCounts,
  campaignReviewBucketRows,
  reviewBucketsByCampaign,
} from "../src/urans-ladder";

const CAMPAIGN_ID = "00000000-0000-0000-0000-000000000001";

function compact(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim().toLowerCase();
}

function recordingDb(resultRows: unknown[]) {
  const queries: string[] = [];
  const dialect = new PgDialect();
  let db!: DB;
  db = {
    execute: async (query: SQL) => {
      queries.push(compact(dialect.sqlToQuery(query).sql));
      return resultRows;
    },
    transaction: async (run: (tx: DB) => Promise<unknown>) => run(db),
  } as unknown as DB;
  return { db, queries };
}

describe("campaign summary sparse-query guardrails", () => {
  it("MUST-CATCH: open-tier exceptions start at sparse sources, not the full point ledger", async () => {
    const { db, queries } = recordingDb([
      { rans_open: 11, precalc_open: 7, verify_open: 3 },
    ]);

    await expect(campaignOpenTierCounts(db, CAMPAIGN_ID)).resolves.toEqual({
      ransOpen: 11,
      precalcOpen: 7,
      verifyOpen: 3,
    });

    expect(queries[0]).toBe("set local jit = off");
    const query = queries[1];
    expect(query).toContain(
      "from result_classifications rc join sim_campaign_points p on p.result_id = rc.result_id",
    );
    expect(query).toContain("from results live join sim_campaign_conditions c");
    expect(query).toContain("join sim_campaign_conditions request_condition");
    expect(query).toContain(
      "join sim_campaign_points request_point on request_point.campaign_id = ownership.campaign_id and request_point.condition_id = request_condition.id",
    );
    // A direct airfoils join regressed production into one PK probe per open
    // point when statistics lagged the live campaign.
    expect(query).not.toContain("join airfoils a on a.id = p.airfoil_id");
    expect(query).toContain(
      "p.airfoil_id not in ( select symmetric_airfoil.id from airfoils symmetric_airfoil",
    );
  });

  it("MUST-CATCH: review buckets begin at rejected classifications and open obligations", async () => {
    const { db, queries } = recordingDb([
      {
        condition_id: "condition-1",
        airfoil_id: "airfoil-1",
        awaiting_urans: 2,
        needs_review: 0,
      },
    ]);

    await expect(campaignReviewBucketRows(db, CAMPAIGN_ID)).resolves.toEqual([
      {
        conditionId: "condition-1",
        airfoilId: "airfoil-1",
        awaitingUrans: 2,
        needsReview: 0,
      },
    ]);

    const query = queries[0];
    expect(query).toContain(
      "from result_classifications rc join results r on r.id = rc.result_id join sim_campaign_points p on p.result_id = r.id",
    );
    expect(query).toContain("join sim_precalc_obligations open_obligation");
    expect(query).not.toContain(
      "from sim_campaign_points p join sim_campaign_conditions",
    );
  });

  it("MUST-CATCH: campaign-list review buckets use one sparse batched query", async () => {
    const { db, queries } = recordingDb([
      {
        campaign_id: CAMPAIGN_ID,
        awaiting_urans: 3,
        needs_review: 0,
      },
    ]);

    const buckets = await reviewBucketsByCampaign(db, [
      CAMPAIGN_ID,
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(buckets.get(CAMPAIGN_ID)).toEqual({
      awaitingUrans: 3,
      needsReview: 0,
    });
    expect(buckets.has("00000000-0000-0000-0000-000000000002")).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(
      "from result_classifications rc join results r on r.id = rc.result_id join sim_campaign_points p on p.result_id = r.id",
    );
    expect(queries[0]).toContain(
      "join sim_precalc_obligations open_obligation",
    );
    expect(queries[0]).not.toContain(
      "from sim_campaign_points p join sim_campaign_conditions",
    );
  });

  it("MUST-CATCH: campaign list stays two database reads regardless of card count", async () => {
    const queries: string[] = [];
    const dialect = new PgDialect();
    let call = 0;
    const campaignRows = [
      {
        id: CAMPAIGN_ID,
        slug: "campaign-a",
        name: "Campaign A",
        status: "active",
        priority: 5,
        notes: null,
        closed_with_failed_count: null,
        closed_with_rejected_count: null,
        completed_at: null,
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
        objective_ld_max_enabled: true,
        objective_cl_zero_enabled: false,
        objective_cl_max_enabled: false,
        reynolds_values: [102_000, 205_000],
        campaign_jobs_running: 4,
        lifecycle_action: null,
        lifecycle_actor: null,
        lifecycle_reason: null,
        lifecycle_created_at: null,
        condition_count: 2,
        airfoil_count: 10,
        excluded_airfoil_count: 0,
        requested: 20,
        solved: 5,
        failed: 0,
        running: 4,
        superseded: 0,
        derived: 0,
        rejected: 0,
        blocked: 0,
        precalc_mesh_repairing: 0,
        blocked_mesh_quality: 0,
        blocked_precalc_exhausted: 0,
        blocked_engine_submit: 0,
        blocked_other: 0,
        automatic_precalc_open: 3,
        total: 2,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        slug: "campaign-b",
        name: "Campaign B",
        status: "paused",
        priority: 1,
        notes: null,
        closed_with_failed_count: null,
        closed_with_rejected_count: null,
        completed_at: null,
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
        objective_ld_max_enabled: false,
        objective_cl_zero_enabled: false,
        objective_cl_max_enabled: false,
        reynolds_values: [307_000],
        campaign_jobs_running: 0,
        lifecycle_action: "pause",
        lifecycle_actor: null,
        lifecycle_reason: "maintenance",
        lifecycle_created_at: "2026-07-28T00:00:00.000Z",
        condition_count: 1,
        airfoil_count: 5,
        excluded_airfoil_count: 1,
        requested: 10,
        solved: 2,
        failed: 0,
        running: 0,
        superseded: 0,
        derived: 0,
        rejected: 0,
        blocked: 0,
        precalc_mesh_repairing: 0,
        blocked_mesh_quality: 0,
        blocked_precalc_exhausted: 0,
        blocked_engine_submit: 0,
        blocked_other: 0,
        automatic_precalc_open: 0,
        total: 2,
      },
    ];
    const db = {
      execute: async (query: SQL) => {
        queries.push(compact(dialect.sqlToQuery(query).sql));
        call += 1;
        return call === 1
          ? campaignRows
          : [
              {
                campaign_id: CAMPAIGN_ID,
                awaiting_urans: 3,
                needs_review: 0,
              },
            ];
      },
    } as unknown as DB;

    const listing = await listCampaigns(db, { limit: 50 });
    expect(queries).toHaveLength(2);
    expect(listing.total).toBe(2);
    expect(listing.items).toHaveLength(2);
    expect(listing.items[0]?.card).toEqual({
      objectives: { ldMax: true, clZero: false, clMax: false },
      reynolds: [102_000, 205_000],
      campaignJobsRunning: 4,
    });
    expect(listing.items[0]?.reviewBuckets).toEqual({
      awaitingUrans: 3,
      needsReview: 0,
    });
    expect(listing.items[1]?.reviewBuckets).toEqual({
      awaitingUrans: 0,
      needsReview: 0,
    });
    expect(queries[0]).toContain(
      "left join sim_campaign_plan_revisions current_plan",
    );
    expect(queries[0]).toContain("as reynolds_values");
    expect(queries[0]).toContain("as campaign_jobs_running");
  });
});
