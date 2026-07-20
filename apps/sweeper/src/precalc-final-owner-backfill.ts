import {
  enqueuePrecalcVerifications,
  hasExactVerifiedRestartableEvidenceArchive,
  onResultIngested,
  type DB,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignPoints,
  simCampaigns,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
} from "@aerodb/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";

interface LegacyPrecalcOwnerCandidate {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  status: string;
  regime: string | null;
}

export interface PrecalcFinalOwnerBackfillReport {
  resultId: string;
  resultAttemptId: string;
  aoaDeg: number;
  campaignIds: string[];
  finalQueueId: string | null;
  state: "verified" | "reconciled";
}

async function liveCampaignIdsForResult(
  db: DB,
  resultId: string,
  resultAttemptId?: string,
): Promise<string[]> {
  const rows = await db
    .select({ campaignId: simCampaignPoints.campaignId })
    .from(simCampaignPoints)
    .innerJoin(simCampaigns, eq(simCampaigns.id, simCampaignPoints.campaignId))
    .where(
      and(
        eq(simCampaignPoints.resultId, resultId),
        resultAttemptId
          ? eq(simCampaignPoints.resultAttemptId, resultAttemptId)
          : undefined,
        eq(simCampaignPoints.state, "terminal"),
        eq(simCampaignPoints.derivedBySymmetry, false),
        inArray(simCampaigns.status, ["active", "attention", "paused"]),
      ),
    );
  return [...new Set(rows.map((row) => row.campaignId))].sort();
}

async function legacyAcceptedPrecalcCandidates(
  db: DB,
  opts: { limit: number },
): Promise<LegacyPrecalcOwnerCandidate[]> {
  const rows = await db
    .selectDistinct({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      airfoilId: results.airfoilId,
      revisionId: results.simulationPresetRevisionId,
      aoaDeg: results.aoaDeg,
      status: results.status,
      regime: results.regime,
      attemptResultId: resultAttempts.resultId,
      attemptAirfoilId: resultAttempts.airfoilId,
      attemptRevisionId: resultAttempts.simulationPresetRevisionId,
      attemptAoaDeg: resultAttempts.aoaDeg,
    })
    .from(simCampaignPoints)
    .innerJoin(simCampaigns, eq(simCampaigns.id, simCampaignPoints.campaignId))
    .innerJoin(results, eq(results.id, simCampaignPoints.resultId))
    .innerJoin(
      resultAttempts,
      eq(resultAttempts.id, results.currentResultAttemptId),
    )
    .innerJoin(
      resultClassifications,
      and(
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
        eq(resultClassifications.state, "accepted"),
      ),
    )
    .where(
      and(
        inArray(simCampaigns.status, ["active", "attention", "paused"]),
        eq(simCampaignPoints.state, "terminal"),
        eq(simCampaignPoints.derivedBySymmetry, false),
        isNull(simCampaignPoints.resultAttemptId),
        eq(results.status, "done"),
        eq(results.source, "solved"),
        sql`${results.simulationPresetRevisionId} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1
          FROM result_classifications canonical_classification
          WHERE canonical_classification.result_id = ${results.id}
            AND canonical_classification.state = 'accepted'
        )`,
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        eq(resultAttempts.validForPolar, true),
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
      ),
    )
    .orderBy(results.id)
    .limit(opts.limit);
  return rows.map((row) => {
    if (!row.revisionId) {
      throw new Error(`accepted PRECALC ${row.resultId} lost its revision`);
    }
    if (
      row.attemptResultId !== row.resultId ||
      row.attemptAirfoilId !== row.airfoilId ||
      row.attemptRevisionId !== row.revisionId ||
      row.attemptAoaDeg !== row.aoaDeg
    ) {
      throw new Error(
        `accepted PRECALC ${row.resultAttemptId} changed its immutable owner`,
      );
    }
    return {
      resultId: row.resultId,
      resultAttemptId: row.resultAttemptId,
      airfoilId: row.airfoilId,
      revisionId: row.revisionId,
      aoaDeg: row.aoaDeg,
      status: row.status,
      regime: row.regime,
    };
  });
}

export async function reconcileLegacyPrecalcFinalOwners(opts: {
  db: DB;
  limit?: number;
  execute: boolean;
}): Promise<PrecalcFinalOwnerBackfillReport[]> {
  const limit = opts.limit ?? 100;
  const candidates = await legacyAcceptedPrecalcCandidates(opts.db, {
    limit,
  });

  const reports: PrecalcFinalOwnerBackfillReport[] = [];
  for (const candidate of candidates) {
    if (
      !(await hasExactVerifiedRestartableEvidenceArchive(
        opts.db,
        candidate.resultId,
        candidate.resultAttemptId,
      ))
    ) {
      throw new Error(
        `accepted PRECALC ${candidate.resultAttemptId} lacks exact restartable evidence`,
      );
    }
    const campaignIds = await liveCampaignIdsForResult(
      opts.db,
      candidate.resultId,
    );
    if (!campaignIds.length) {
      throw new Error(
        `accepted PRECALC ${candidate.resultAttemptId} lost its live campaign owner`,
      );
    }
    if (!opts.execute) {
      reports.push({
        resultId: candidate.resultId,
        resultAttemptId: candidate.resultAttemptId,
        aoaDeg: candidate.aoaDeg,
        campaignIds,
        finalQueueId: null,
        state: "verified",
      });
      continue;
    }

    await onResultIngested(opts.db, {
      airfoilId: candidate.airfoilId,
      revisionId: candidate.revisionId,
      aoaDeg: candidate.aoaDeg,
      resultId: candidate.resultId,
      resultAttemptId: candidate.resultAttemptId,
      status: candidate.status,
      regime: candidate.regime,
    });
    await enqueuePrecalcVerifications(opts.db, {
      airfoilId: candidate.airfoilId,
      revisionId: candidate.revisionId,
      aoaDeg: candidate.aoaDeg,
    });
    // The first ingest pass repairs the immutable attempt pin. The queue
    // enqueue then adds the campaign owner to an already-existing background
    // FINAL item. Recompute once more after that association exists so the
    // campaign progress row cannot retain the legacy `blockedOther` snapshot
    // that was truthful between those two repairs.
    await onResultIngested(opts.db, {
      airfoilId: candidate.airfoilId,
      revisionId: candidate.revisionId,
      aoaDeg: candidate.aoaDeg,
      resultId: candidate.resultId,
      resultAttemptId: candidate.resultAttemptId,
      status: candidate.status,
      regime: candidate.regime,
    });
    const exactCampaignIds = await liveCampaignIdsForResult(
      opts.db,
      candidate.resultId,
      candidate.resultAttemptId,
    );
    if (
      exactCampaignIds.length !== campaignIds.length ||
      exactCampaignIds.some(
        (campaignId, index) => campaignId !== campaignIds[index],
      )
    ) {
      throw new Error(
        `accepted PRECALC ${candidate.resultAttemptId} did not repair every campaign attempt owner`,
      );
    }
    const [queue] = await opts.db
      .select({ id: simUransVerifyQueue.id })
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(
            simUransVerifyQueue.precalcResultAttemptId,
            candidate.resultAttemptId,
          ),
          inArray(simUransVerifyQueue.state, [
            "pending",
            "running",
            "done",
            "disagreed",
          ]),
        ),
      )
      .orderBy(simUransVerifyQueue.createdAt)
      .limit(1);
    if (!queue) {
      throw new Error(
        `accepted PRECALC ${candidate.resultAttemptId} has no durable FINAL owner`,
      );
    }
    for (const campaignId of campaignIds) {
      const [association] = await opts.db
        .select({ queueId: simUransVerifyQueueCampaigns.queueId })
        .from(simUransVerifyQueueCampaigns)
        .where(
          and(
            eq(simUransVerifyQueueCampaigns.queueId, queue.id),
            eq(simUransVerifyQueueCampaigns.campaignId, campaignId),
            eq(simUransVerifyQueueCampaigns.state, "active"),
          ),
        )
        .limit(1);
      if (!association) {
        throw new Error(
          `accepted PRECALC ${candidate.resultAttemptId} FINAL queue lost campaign ${campaignId}`,
        );
      }
    }
    reports.push({
      resultId: candidate.resultId,
      resultAttemptId: candidate.resultAttemptId,
      aoaDeg: candidate.aoaDeg,
      campaignIds,
      finalQueueId: queue.id,
      state: "reconciled",
    });
  }
  return reports;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  const { db, sql: client } = makeContext();
  try {
    const reports = await reconcileLegacyPrecalcFinalOwners({
      db,
      limit,
      execute,
    });
    for (const report of reports) console.log(JSON.stringify(report));
    console.error(
      JSON.stringify({
        mode: execute ? "execute" : "dry-run",
        processed: reports.length,
      }),
    );
    return 0;
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
