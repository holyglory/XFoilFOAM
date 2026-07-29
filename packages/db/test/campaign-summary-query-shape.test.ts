import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { DB } from "../src/client";
import {
  finalizeCampaignResultLinkBatch,
  materializeCampaignResultLinkProjections,
  probeCampaignCompletion,
  probeCampaignCompletions,
  recomputeProgressForCampaign,
} from "../src/campaign-execution";
import { deriveCampaignCompletion, listCampaigns } from "../src/campaigns";
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
  it("MUST-CATCH: verified URANS evidence still awaiting archive publication keeps a numerically settled campaign active", () => {
    expect(
      deriveCampaignCompletion({
        requested: 1,
        solved: 1,
        failed: 0,
        running: 0,
        superseded: 0,
        derived: 0,
        rejected: 0,
        blocked: 0,
        awaitingArchiveReduction: 1,
        remaining: 0,
      }),
    ).toBe("active");
  });

  it("MUST-CATCH: durable archive-publication work is disjoint from solved and derived counters", async () => {
    const { db, queries } = recordingDb([]);

    await recomputeProgressForCampaign(db, CAMPAIGN_ID);

    const [query] = queries;
    expect(query).toBeDefined();
    // Both real and symmetry-derived usable classifications must exclude the
    // exact archive queue predicate. Otherwise an accepted RANS projection
    // plus a waiting URANS archive double-books one physical campaign cell.
    const usableCounterGuards = query!.match(
      /rc\.state in \('accepted', 'needs_urans', 'superseded_by_urans'\)[\s\S]{0,120}not \(exists \(/g,
    );
    expect(usableCounterGuards).toHaveLength(2);
    expect(query).toContain("awaiting_archive_reduction");
  });

  it("MUST-CATCH: completion probing short-circuits active campaigns before terminal scans", async () => {
    const { db, queries } = recordingDb([{ open: true }]);

    await probeCampaignCompletion(db, CAMPAIGN_ID);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("as open");
    expect(queries[0]).toContain("p.state = 'requested'");
    expect(queries[0]).not.toContain("as lanes_open");
    expect(queries[0]).not.toContain("as automatic_recovery_open");
    expect(queries[0]).not.toContain("as precalc_open");
    expect(queries[0]).not.toContain("as verify_open");
  });

  it("coalesces one completion decision per affected campaign", async () => {
    const { db, queries } = recordingDb([{ open: true }]);
    const secondCampaign = "00000000-0000-0000-0000-000000000002";

    await probeCampaignCompletions(db, [
      CAMPAIGN_ID,
      secondCampaign,
      CAMPAIGN_ID,
      secondCampaign,
    ]);

    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.includes("as open"))).toBe(true);
  });

  it("MUST-CATCH: a multi-point ingest batch probes its campaign once and deduplicates dirty lanes", async () => {
    const { db, queries } = recordingDb([{ open: true }]);
    const lane = {
      campaignId: CAMPAIGN_ID,
      airfoilId: "airfoil-1",
      conditionId: "condition-1",
      objective: "ld_max",
    };

    const dirty = await finalizeCampaignResultLinkBatch(db, [
      { laneKeys: [lane], campaignIds: [CAMPAIGN_ID] },
      { laneKeys: [lane], campaignIds: [CAMPAIGN_ID] },
      { laneKeys: [], campaignIds: [CAMPAIGN_ID] },
    ]);

    expect(dirty).toEqual([lane]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("as open");
  });

  it("MUST-CATCH: a cumulative point payload recomputes progress and discovers lanes once per deduplicated key", async () => {
    const queries: string[] = [];
    const dialect = new PgDialect();
    const progressKey = {
      campaign_id: CAMPAIGN_ID,
      condition_id: "00000000-0000-0000-0000-000000000003",
      airfoil_id: "00000000-0000-0000-0000-000000000004",
    };
    const db = {
      execute: async (query: SQL) => {
        const text = compact(dialect.sqlToQuery(query).sql);
        queries.push(text);
        return text.includes("from sim_campaign_lanes")
          ? [
              {
                ...progressKey,
                objective: "ld_max",
              },
            ]
          : [];
      },
    } as unknown as DB;

    const outcome = await materializeCampaignResultLinkProjections(db, [
      {
        progressKeys: [progressKey],
        terminalProgressKeys: [progressKey],
        doneResultIds: [],
      },
      {
        progressKeys: [progressKey, progressKey],
        terminalProgressKeys: [progressKey],
        doneResultIds: [],
      },
    ]);

    expect(
      queries.filter((query) =>
        query.startsWith("insert into sim_campaign_progress"),
      ),
    ).toHaveLength(1);
    expect(
      queries.filter((query) => query.includes("from sim_campaign_lanes")),
    ).toHaveLength(1);
    expect(outcome).toEqual({
      campaignIds: [CAMPAIGN_ID],
      laneKeys: [
        {
          campaignId: CAMPAIGN_ID,
          airfoilId: progressKey.airfoil_id,
          conditionId: progressKey.condition_id,
          objective: "ld_max",
        },
      ],
    });
  });

  it("coalesces accepted-result incident resolution across a cumulative payload", async () => {
    const firstResult = "00000000-0000-0000-0000-000000000005";
    const secondResult = "00000000-0000-0000-0000-000000000006";
    const queries: string[] = [];
    const dialect = new PgDialect();
    let incidentUpdates = 0;
    const db = {
      execute: async (query: SQL) => {
        const text = compact(dialect.sqlToQuery(query).sql);
        queries.push(text);
        return text.includes("select distinct accepted_result.id")
          ? [{ result_id: firstResult }, { result_id: secondResult }]
          : [];
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              incidentUpdates += 1;
              return [{ id: "incident-1" }, { id: "incident-2" }];
            },
          }),
        }),
      }),
    } as unknown as DB;

    await materializeCampaignResultLinkProjections(db, [
      {
        progressKeys: [],
        terminalProgressKeys: [],
        doneResultIds: [firstResult, firstResult],
      },
      {
        progressKeys: [],
        terminalProgressKeys: [],
        doneResultIds: [secondResult, firstResult],
      },
    ]);

    expect(
      queries.filter((query) =>
        query.includes("select distinct accepted_result.id"),
      ),
    ).toHaveLength(1);
    expect(incidentUpdates).toBe(1);
  });

  it("rechecks newly-open work in the rare terminal snapshot", async () => {
    const queries: string[] = [];
    const dialect = new PgDialect();
    let call = 0;
    const db = {
      execute: async (query: SQL) => {
        queries.push(compact(dialect.sqlToQuery(query).sql));
        call += 1;
        return call === 1
          ? [{ open: false }]
          : [
              {
                open: true,
                lanes_open: false,
                in_flight: false,
                has_failed: false,
                automatic_recovery_open: false,
                has_rejected: false,
                has_blocked: false,
                precalc_open: false,
                verify_open: false,
              },
            ];
      },
    } as unknown as DB;

    await probeCampaignCompletion(db, CAMPAIGN_ID);

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("as open");
    expect(queries[1]).toContain("as lanes_open");
    expect(queries[1]).toContain("as automatic_recovery_open");
    expect(queries[1]).toContain("as verify_open");
  });

  it("preserves terminal completion after the split gate", async () => {
    const updates: Record<string, unknown>[] = [];
    let call = 0;
    const db = {
      execute: async () => {
        call += 1;
        return call === 1
          ? [{ open: false }]
          : [
              {
                open: false,
                lanes_open: false,
                in_flight: false,
                has_failed: false,
                automatic_recovery_open: false,
                has_rejected: false,
                has_blocked: false,
                precalc_open: false,
                verify_open: false,
              },
            ];
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
            return [];
          },
        }),
      }),
    } as unknown as DB;

    await probeCampaignCompletion(db, CAMPAIGN_ID);

    expect(call).toBe(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe("completed");
    expect(updates[0]?.completedAt).toBeInstanceOf(Date);
  });

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
