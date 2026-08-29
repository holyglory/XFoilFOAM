import {
  type CampaignLaneKey,
  claimNextResultMediaRepair,
  completeResultMediaRepairFinalization,
  completeSatisfiedResultMediaRepair,
  type DB,
  discoverMissingResultMediaRepairs,
  enqueuePrecalcVerifications,
  failClaimedResultMediaRepair,
  healExpiredResultMediaRepairClaims,
  invalidateSatisfiedResultMediaRepair,
  laneKeyId,
  onResultIngested,
  probeCampaignCompletion,
  reconcileBlockedFinalMediaRepairVerifications,
  resultMediaRepairs,
  renewResultMediaRepairClaim,
  settleFinalUransVerificationAfterMediaRepair,
  satisfyPrecalcObligationFromAcceptedResult,
  satisfiedResultMediaRepairs,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { eq, sql } from "drizzle-orm";

import {
  publishRepairedResultAttempt,
  repairDefaultMediaForStoredResult,
  verifyStoredDefaultMediaForResult,
} from "./ingest";

interface CampaignOwner {
  campaign_id: string;
  status: string;
}

export interface ResultMediaRepairTickOutcome {
  discovered: number;
  finalized: number;
  claimed: boolean;
  repairedMedia: number;
  retrying: number;
  blocked: number;
  dirtyLanes: CampaignLaneKey[];
}

export interface ResultMediaRepairBatchOutcome extends ResultMediaRepairTickOutcome {
  claimedCount: number;
}

export interface ResultMediaRepairTickOptions {
  discoveryLimit?: number;
  finalizeLimit?: number;
  resultId?: string;
  preferNewestLive?: boolean;
  /** The scheduler owns sweeper liveness. A dedicated media-repair process
   * deliberately leaves it untouched, while still renewing its own durable
   * repair lease around each expensive engine operation. */
  heartbeat?: () => Promise<void>;
}

/** Resolve ownership one row at a time, then run only those fenced owners in
 * parallel. Sequential claiming makes each committed running scale scope
 * visible to the next selector while preserving bounded render concurrency. */
export async function runBoundedClaimBatch<Claim, Outcome>(opts: {
  concurrency: number;
  claim: (index: number) => Promise<Claim | null>;
  run: (claim: Claim) => Promise<Outcome>;
}): Promise<Outcome[]> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error("claim batch concurrency must be a positive integer");
  }
  const claims: Claim[] = [];
  for (let index = 0; index < opts.concurrency; index++) {
    const claim = await opts.claim(index);
    if (claim == null) break;
    claims.push(claim);
  }
  return Promise.all(claims.map((claim) => opts.run(claim)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function campaignOwnersForResult(
  db: DB,
  resultId: string,
): Promise<CampaignOwner[]> {
  return (await db.execute(sql`
    SELECT DISTINCT campaign.id AS campaign_id, campaign.status
    FROM sim_campaign_points point
    JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
    WHERE point.result_id = ${resultId}
    ORDER BY campaign.id
  `)) as unknown as CampaignOwner[];
}

/**
 * Finish every repair whose media rows are already complete. This is run
 * before lease healing/claiming and again after a render. Therefore a process
 * that dies after the media transaction but before classification, verify
 * enqueue, or queue settlement is repaired idempotently on the next pass.
 */
export async function finalizeSatisfiedResultMediaRepairs(
  db: DB,
  opts: { limit?: number; resultId?: string } = {},
): Promise<{ finalized: number; dirtyLanes: CampaignLaneKey[] }> {
  const satisfied = await satisfiedResultMediaRepairs(db, opts);
  const dirty = new Map<string, CampaignLaneKey>();
  let finalized = 0;
  for (const repair of satisfied) {
    try {
      await verifyStoredDefaultMediaForResult(
        db,
        repair.resultId,
        repair.resultAttemptId,
      );
    } catch (error) {
      const reason = errorMessage(error);
      const state = await invalidateSatisfiedResultMediaRepair(
        db,
        repair.id,
        repair.resultAttemptId,
        repair.evidenceSignature,
        reason,
      );
      console.error(
        `[sweeper] result media byte verification ${state ?? "lost ownership"} ` +
          `(repair ${repair.id}, result ${repair.resultId}): ${reason}`,
      );
      continue;
    }
    // Atomically re-prove manifest/profile/media completeness before any
    // downstream acceptance work. This also transitions crash-recovered rows
    // to done; the separate finalization marker below makes that transition
    // resumable if a later hook throws.
    if (
      !(await completeSatisfiedResultMediaRepair(
        db,
        repair.id,
        repair.resultAttemptId,
        repair.evidenceSignature,
      ))
    ) {
      continue;
    }
    // Reclassify the exact repaired attempt and advance the public pointer only
    // if it is now accepted/provisional. Rejected evidence remains history.
    const published = await publishRepairedResultAttempt({
      db,
      resultId: repair.resultId,
      resultAttemptId: repair.resultAttemptId,
      repairId: repair.id,
      evidenceSignature: repair.evidenceSignature,
    });
    if (!published) {
      if (
        await completeResultMediaRepairFinalization(
          db,
          repair.id,
          repair.resultAttemptId,
          repair.evidenceSignature,
        )
      ) {
        finalized++;
      }
      continue;
    }
    if (repair.fidelity === "urans_full") {
      await settleFinalUransVerificationAfterMediaRepair(
        db,
        repair.resultAttemptId,
      );
    }
    // Missing media can be the sole reason an otherwise-real PRECALC attempt
    // was rejected and its physical obligation became blocked. Project the
    // refreshed accepted truth back into that exact obligation ledger before
    // any completion probe. The helper is idempotent and never schedules or
    // creates solver work; a still-rejected attempt leaves the ledger intact.
    await satisfyPrecalcObligationFromAcceptedResult(db, repair.resultId);

    const owners = await campaignOwnersForResult(db, repair.resultId);
    const liveOwners = owners.filter((owner) =>
      ["active", "attention", "paused"].includes(owner.status),
    );
    if (repair.fidelity === "urans_precalc" && liveOwners.length) {
      for (const owner of liveOwners) {
        await enqueuePrecalcVerifications(db, {
          airfoilId: repair.airfoilId,
          revisionId: repair.revisionId,
          campaignId: owner.campaign_id,
        });
      }
    }
    if (repair.fidelity === "urans_precalc" && repair.backgroundOwner) {
      // Background origin is captured durably at discovery. A campaign may
      // later share the result without erasing that independent obligation;
      // conversely, cancelled campaign-only work never becomes background by
      // inference at finalization time.
      await enqueuePrecalcVerifications(db, {
        airfoilId: repair.airfoilId,
        revisionId: repair.revisionId,
        campaignId: null,
      });
    }

    const laneKeys = await onResultIngested(db, {
      airfoilId: repair.airfoilId,
      revisionId: repair.revisionId,
      aoaDeg: Number(repair.aoaDeg),
      resultId: repair.resultId,
      status: repair.status as "done" | "failed",
      regime: repair.regime,
    });
    for (const lane of laneKeys) dirty.set(laneKeyId(lane), lane);

    // onResultIngested may have probed before the durable repair settled.
    // Re-probe so an otherwise-complete campaign can close now.
    for (const owner of liveOwners) {
      await probeCampaignCompletion(db, owner.campaign_id);
    }
    // LAST: every hook above is idempotent. A crash leaves this NULL and the
    // done row is selected again next tick to resume downstream finalization.
    if (
      await completeResultMediaRepairFinalization(
        db,
        repair.id,
        repair.resultAttemptId,
        repair.evidenceSignature,
      )
    ) {
      finalized++;
    }
  }
  return { finalized, dirtyLanes: [...dirty.values()] };
}

export async function prepareResultMediaRepairPass(
  db: DB,
  opts: ResultMediaRepairTickOptions,
): Promise<ResultMediaRepairTickOutcome> {
  const dirty = new Map<string, CampaignLaneKey>();
  const discovered = await discoverMissingResultMediaRepairs(db, {
    limit: opts.discoveryLimit,
    resultId: opts.resultId,
  });

  const pre = await finalizeSatisfiedResultMediaRepairs(db, {
    limit: opts.finalizeLimit,
    resultId: opts.resultId,
  });
  for (const lane of pre.dirtyLanes) dirty.set(laneKeyId(lane), lane);

  // Older releases could persist a blocked repair before projecting that
  // terminal state into the exact final-verification owner. Reconcile that
  // bounded crash window before accepting new renderer work.
  const reconciledBlocked = await reconcileBlockedFinalMediaRepairVerifications(
    db,
    {
      limit: opts.finalizeLimit,
      resultId: opts.resultId,
    },
  );

  // A media-complete running row was finalized above; only genuinely
  // incomplete expired owners consume another bounded attempt here.
  const healed = await healExpiredResultMediaRepairClaims(db);
  return {
    discovered,
    finalized: pre.finalized,
    claimed: false,
    repairedMedia: 0,
    retrying: healed.retrying,
    blocked: reconciledBlocked + healed.blocked,
    dirtyLanes: [...dirty.values()],
  };
}

type ClaimedResultMediaRepair = NonNullable<
  Awaited<ReturnType<typeof claimNextResultMediaRepair>>
>;

async function repairClaimedResultMedia(
  db: DB,
  engine: EngineClient,
  opts: ResultMediaRepairTickOptions,
  claim: ClaimedResultMediaRepair,
): Promise<ResultMediaRepairTickOutcome> {
  const dirty = new Map<string, CampaignLaneKey>();
  let repairedMedia = 0;
  let retrying = 0;
  let blocked = 0;
  try {
    if (!claim.claimToken) {
      throw new Error("claimed result media repair has no ownership token");
    }
    const heartbeat = async () => {
      await opts.heartbeat?.();
      if (!(await renewResultMediaRepairClaim(db, claim))) {
        throw new Error("result media repair lease lost to another renderer");
      }
    };
    const repaired = await repairDefaultMediaForStoredResult({
      db,
      engine,
      resultId: claim.resultId,
      resultAttemptId: claim.resultAttemptId,
      heartbeat,
      repairFence: {
        repairId: claim.id,
        resultAttemptId: claim.resultAttemptId,
        claimToken: claim.claimToken,
        evidenceSignature: claim.evidenceSignature,
      },
    });
    repairedMedia = repaired.mediaCount;
    const post = await finalizeSatisfiedResultMediaRepairs(db, {
      limit: opts.finalizeLimit,
      // Parallel workers finalize only their own result. This prevents two
      // otherwise independent claims from racing the same downstream hooks.
      resultId: claim.resultId,
    });
    for (const lane of post.dirtyLanes) dirty.set(laneKeyId(lane), lane);
    const [settled] = await db
      .select({ state: resultMediaRepairs.state })
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.id, claim.id))
      .limit(1);
    if (settled?.state !== "done") {
      throw new Error(
        "render returned but complete media could not be proven and the repair obligation did not settle",
      );
    }
    return {
      discovered: 0,
      finalized: post.finalized,
      claimed: true,
      repairedMedia,
      retrying,
      blocked,
      dirtyLanes: [...dirty.values()],
    };
  } catch (error) {
    const state = await failClaimedResultMediaRepair(
      db,
      claim,
      errorMessage(error),
    );
    if (state === "retry_wait") retrying++;
    if (state === "blocked") {
      blocked++;
    }
    console.error(
      `[sweeper] result media repair ${state ?? "lost ownership"} ` +
        `(repair ${claim.id}, result ${claim.resultId}, attempt ${claim.attemptCount}/${claim.maxAttempts}): ${errorMessage(error)}`,
    );
    return {
      discovered: 0,
      finalized: 0,
      claimed: true,
      repairedMedia,
      retrying,
      blocked,
      dirtyLanes: [...dirty.values()],
    };
  }
}

export async function repairNextResultMediaClaim(
  db: DB,
  engine: EngineClient,
  opts: ResultMediaRepairTickOptions,
): Promise<ResultMediaRepairTickOutcome> {
  const claim = await claimNextResultMediaRepair(db, {
    resultId: opts.resultId,
    preferNewestLive: opts.preferNewestLive,
  });
  if (!claim) {
    return {
      discovered: 0,
      finalized: 0,
      claimed: false,
      repairedMedia: 0,
      retrying: 0,
      blocked: 0,
      dirtyLanes: [],
    };
  }
  return repairClaimedResultMedia(db, engine, opts, claim);
}

/** One bounded production repair pass (at most one expensive render claim). */
export async function resultMediaRepairTick(
  db: DB,
  engine: EngineClient,
  opts: ResultMediaRepairTickOptions = {},
): Promise<ResultMediaRepairTickOutcome> {
  const prepared = await prepareResultMediaRepairPass(db, opts);
  const repaired = await repairNextResultMediaClaim(db, engine, opts);
  const dirty = new Map<string, CampaignLaneKey>();
  for (const lane of [...prepared.dirtyLanes, ...repaired.dirtyLanes]) {
    dirty.set(laneKeyId(lane), lane);
  }
  return {
    discovered: prepared.discovered,
    finalized: prepared.finalized + repaired.finalized,
    claimed: repaired.claimed,
    repairedMedia: repaired.repairedMedia,
    retrying: prepared.retrying + repaired.retrying,
    blocked: prepared.blocked + repaired.blocked,
    dirtyLanes: [...dirty.values()],
  };
}

/** One maintenance pass plus a bounded set of independent expensive claims.
 * Database SKIP LOCKED ownership and per-result repair fences remain the
 * authority; callers never share a claim token across renderers. */
export async function resultMediaRepairBatch(
  db: DB,
  engine: EngineClient,
  opts: ResultMediaRepairTickOptions & { concurrency: number },
): Promise<ResultMediaRepairBatchOutcome> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(
      "result media repair concurrency must be a positive integer",
    );
  }
  // Discovery/finalization scans are independent of already-ready claims.
  // Run them beside the expensive engine work: waiting for a full campaign
  // scan before every two-result batch added ~15 idle seconds in production.
  const preparedPromise = prepareResultMediaRepairPass(db, opts);
  // Claim sequentially so each committed running owner is visible to the next
  // selector's same-scale-scope exclusion. Rendering remains parallel.
  const repairedPromise = runBoundedClaimBatch({
    concurrency: opts.concurrency,
    // One lane keeps newly completed live-campaign evidence close to real
    // time; the remaining lanes start at the oldest debt and drain it.
    claim: (index) =>
      claimNextResultMediaRepair(db, {
        resultId: opts.resultId,
        preferNewestLive: index === 0 && !opts.resultId,
      }),
    run: (claim: ClaimedResultMediaRepair) =>
      repairClaimedResultMedia(db, engine, opts, claim),
  });
  const [prepared, repaired] = await Promise.all([
    preparedPromise,
    repairedPromise,
  ]);
  const dirty = new Map<string, CampaignLaneKey>();
  for (const lane of prepared.dirtyLanes) dirty.set(laneKeyId(lane), lane);
  for (const outcome of repaired) {
    for (const lane of outcome.dirtyLanes) dirty.set(laneKeyId(lane), lane);
  }
  return {
    discovered: prepared.discovered,
    finalized:
      prepared.finalized +
      repaired.reduce((sum, outcome) => sum + outcome.finalized, 0),
    claimed: repaired.some((outcome) => outcome.claimed),
    claimedCount: repaired.filter((outcome) => outcome.claimed).length,
    repairedMedia: repaired.reduce(
      (sum, outcome) => sum + outcome.repairedMedia,
      0,
    ),
    retrying:
      prepared.retrying +
      repaired.reduce((sum, outcome) => sum + outcome.retrying, 0),
    blocked:
      prepared.blocked +
      repaired.reduce((sum, outcome) => sum + outcome.blocked, 0),
    dirtyLanes: [...dirty.values()],
  };
}
