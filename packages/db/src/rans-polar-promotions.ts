import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { DB } from "./client";
import { lockPrecalcCells } from "./precalc-cell-lock";
import {
  ensurePrecalcObligationsInTransaction,
  type PrecalcObligationOwnership,
} from "./precalc-obligations";
import {
  resultAttempts,
  resultClassifications,
  results,
  simJobs,
  simPrecalcObligations,
  simRansPolarPromotionPoints,
  simRansPolarPromotions,
  syncRemoteResultDeliveries,
  syncSweepPromisePoints,
} from "./schema";

export type RansPolarPromotionOwner =
  | { kind: "campaign"; campaignId: string }
  | { kind: "background" }
  | { kind: "sync_promise"; syncPromiseId: string };

export interface RecordRansPolarPromotionInput {
  parentJobId: string;
  ingestLeaseToken: string;
  airfoilId: string;
  revisionId: string;
  conditionId?: string | null;
  triggerResultAttemptId: string;
  triggerAoaDeg: number;
  requestedAoas: number[];
  intentionallyOmittedAoas?: number[];
  ownership: PrecalcObligationOwnership;
}

export interface RecordedRansPolarPromotion {
  promotionId: string;
  parentJobId: string;
  airfoilId: string;
  revisionId: string;
  conditionId: string | null;
  triggerResultAttemptId: string;
  triggerAoaDeg: number;
  failureDisposition: "hard_solver";
  requestOrigin: "continuous-polar";
  obligationIds: string[];
  requestedAoas: number[];
  intentionallyOmittedAoas: number[];
  owner: RansPolarPromotionOwner;
}

export interface InspectRansPolarPromotionInput {
  parentJobId: string;
  revisionId?: string;
  /** Undefined does not filter; null matches an event without a condition. */
  conditionId?: string | null;
  /** When supplied, the exact parent must still hold this ingest lease. */
  ingestLeaseToken?: string;
}

export interface InspectParentRansPolarPromotionsInput {
  parentJobId: string;
  /** When supplied, every discovered event is replayed only while the exact
   * parent still owns this live ingest lease. */
  ingestLeaseToken?: string;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

class PromotionPreconditionError extends Error {}

function ownerFromPromotion(
  promotion: typeof simRansPolarPromotions.$inferSelect,
): RansPolarPromotionOwner | null {
  if (
    promotion.ownerKind === "campaign" &&
    promotion.campaignId &&
    promotion.syncPromiseId === null
  ) {
    return { kind: "campaign", campaignId: promotion.campaignId };
  }
  if (
    promotion.ownerKind === "sync_promise" &&
    promotion.syncPromiseId &&
    promotion.campaignId === null
  ) {
    return {
      kind: "sync_promise",
      syncPromiseId: promotion.syncPromiseId,
    };
  }
  if (
    promotion.ownerKind === "background" &&
    promotion.campaignId === null &&
    promotion.syncPromiseId === null
  ) {
    return { kind: "background" };
  }
  return null;
}

function exactPromotionOwner(
  ownership: PrecalcObligationOwnership,
): RansPolarPromotionOwner | null {
  const campaignIds = [...new Set(ownership.campaignIds ?? [])].sort();
  const syncPromiseIds = [...new Set(ownership.syncPromiseIds ?? [])].sort();
  const modes =
    Number(campaignIds.length > 0) +
    Number(ownership.backgroundOwner === true) +
    Number(syncPromiseIds.length > 0);
  if (modes !== 1 || campaignIds.length > 1 || syncPromiseIds.length > 1) {
    return null;
  }
  if (campaignIds[0]) return { kind: "campaign", campaignId: campaignIds[0] };
  if (syncPromiseIds[0]) {
    return { kind: "sync_promise", syncPromiseId: syncPromiseIds[0] };
  }
  return { kind: "background" };
}

async function lockAndValidatePromotionParent(
  tx: DB,
  input: RecordRansPolarPromotionInput,
  owner: RansPolarPromotionOwner,
): Promise<void> {
  const [parent] = await tx
    .select({
      id: simJobs.id,
      status: simJobs.status,
      token: simJobs.ingestLeaseToken,
      airfoilId: simJobs.airfoilId,
      campaignId: simJobs.campaignId,
      requestPayload: simJobs.requestPayload,
    })
    .from(simJobs)
    .where(eq(simJobs.id, input.parentJobId))
    .for("update")
    .limit(1);
  if (
    !parent ||
    parent.status !== "ingesting" ||
    parent.token !== input.ingestLeaseToken ||
    parent.airfoilId !== input.airfoilId
  ) {
    throw new PromotionPreconditionError(
      "whole-polar promotion lost its ingest lease or parent identity",
    );
  }
  const parentSyncPromiseId =
    parent.requestPayload && typeof parent.requestPayload === "object"
      ? (parent.requestPayload as { syncPromiseId?: unknown }).syncPromiseId
      : undefined;
  const parentOwnsEvent =
    owner.kind === "campaign"
      ? parent.campaignId === owner.campaignId
      : owner.kind === "sync_promise"
        ? parent.campaignId === null &&
          parentSyncPromiseId === owner.syncPromiseId
        : parent.campaignId === null && typeof parentSyncPromiseId !== "string";
  if (!parentOwnsEvent) {
    throw new PromotionPreconditionError(
      "whole-polar promotion owner does not match the exact parent request",
    );
  }
}

/** Read one committed promotion from its normalized immutable provenance.
 * Callers may narrow by revision and/or condition. An explicit null condition
 * matches only conditionless events; undefined leaves that dimension open.
 *
 * When an ingest token is supplied, the parent row is locked and checked only
 * for the live ingestion facts which authorize replay: exact parent id,
 * event-owned airfoil, ingesting status and token. Campaign ownership and
 * request JSON are deliberately excluded because they are mutable scheduling
 * context, not part of the committed replay contract. */
export async function inspectRansPolarPromotion(
  db: DB,
  input: InspectRansPolarPromotionInput,
): Promise<RecordedRansPolarPromotion | null> {
  const promotions = await db
    .select()
    .from(simRansPolarPromotions)
    .where(
      and(
        eq(simRansPolarPromotions.parentJobId, input.parentJobId),
        input.revisionId === undefined
          ? undefined
          : eq(simRansPolarPromotions.revisionId, input.revisionId),
        input.conditionId === undefined
          ? undefined
          : input.conditionId === null
            ? isNull(simRansPolarPromotions.conditionId)
            : eq(simRansPolarPromotions.conditionId, input.conditionId),
      ),
    )
    .limit(2);
  if (promotions.length === 0) return null;
  if (promotions.length !== 1) {
    throw new Error(
      "ambiguous conditional whole-polar promotion; provide its exact revision and condition",
    );
  }
  const promotion = promotions[0]!;
  const owner = ownerFromPromotion(promotion);
  if (
    !owner ||
    promotion.failureDisposition !== "hard_solver" ||
    promotion.requestOrigin !== "continuous-polar"
  ) {
    throw new Error(
      "conditional whole-polar promotion has invalid immutable provenance",
    );
  }

  if (input.ingestLeaseToken !== undefined) {
    const [parent] = await db
      .select({
        id: simJobs.id,
        airfoilId: simJobs.airfoilId,
        status: simJobs.status,
        token: simJobs.ingestLeaseToken,
      })
      .from(simJobs)
      .where(eq(simJobs.id, promotion.parentJobId))
      .for("update")
      .limit(1);
    if (
      !parent ||
      parent.id !== input.parentJobId ||
      parent.airfoilId !== promotion.airfoilId ||
      parent.status !== "ingesting" ||
      parent.token !== input.ingestLeaseToken
    ) {
      throw new PromotionPreconditionError(
        "whole-polar promotion lost its ingest lease or parent identity",
      );
    }
  }

  const points = await db
    .select({
      aoaDeg: simRansPolarPromotionPoints.aoaDeg,
      obligationId: simRansPolarPromotionPoints.obligationId,
      intentionallyOmittedByRans:
        simRansPolarPromotionPoints.intentionallyOmittedByRans,
      obligationAirfoilId: simPrecalcObligations.airfoilId,
      obligationRevisionId: simPrecalcObligations.revisionId,
      obligationAoaDeg: simPrecalcObligations.aoaDeg,
    })
    .from(simRansPolarPromotionPoints)
    .innerJoin(
      simPrecalcObligations,
      eq(simPrecalcObligations.id, simRansPolarPromotionPoints.obligationId),
    )
    .where(eq(simRansPolarPromotionPoints.promotionId, promotion.id));
  const requestedAoas = uniqueSorted(points.map((point) => point.aoaDeg));
  const pointsByAoa = new Map(points.map((point) => [point.aoaDeg, point]));
  const validCoverage =
    points.length > 1 &&
    requestedAoas.length === points.length &&
    points.every(
      (point) =>
        point.obligationAirfoilId === promotion.airfoilId &&
        point.obligationRevisionId === promotion.revisionId &&
        point.obligationAoaDeg === point.aoaDeg,
    );
  if (!validCoverage) {
    throw new Error(
      "conditional whole-polar promotion has invalid immutable obligation coverage",
    );
  }

  return {
    promotionId: promotion.id,
    parentJobId: promotion.parentJobId,
    airfoilId: promotion.airfoilId,
    revisionId: promotion.revisionId,
    conditionId: promotion.conditionId,
    triggerResultAttemptId: promotion.triggerResultAttemptId,
    triggerAoaDeg: promotion.triggerAoaDeg,
    failureDisposition: "hard_solver",
    requestOrigin: "continuous-polar",
    obligationIds: requestedAoas.map(
      (aoaDeg) => pointsByAoa.get(aoaDeg)!.obligationId,
    ),
    requestedAoas,
    intentionallyOmittedAoas: requestedAoas.filter(
      (aoaDeg) => pointsByAoa.get(aoaDeg)!.intentionallyOmittedByRans,
    ),
    owner,
  };
}

/** Discover every immutable promotion owned by one parent before callers
 * interpret mutable transport fields such as conditionMap or ransRetryScope.
 * Identities come from the normalized event table first; each event is then
 * validated through the same point/obligation and optional ingest-lease gate
 * as exact single-event replay. A disappearing/corrupt event fails closed
 * rather than allowing generic retry planning to adopt its physical cells. */
export async function inspectParentRansPolarPromotions(
  db: DB,
  input: InspectParentRansPolarPromotionsInput,
): Promise<RecordedRansPolarPromotion[]> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const identities = await tx
      .select({
        promotionId: simRansPolarPromotions.id,
        revisionId: simRansPolarPromotions.revisionId,
        conditionId: simRansPolarPromotions.conditionId,
      })
      .from(simRansPolarPromotions)
      .where(eq(simRansPolarPromotions.parentJobId, input.parentJobId))
      .orderBy(simRansPolarPromotions.createdAt, simRansPolarPromotions.id);
    const recorded: RecordedRansPolarPromotion[] = [];
    for (const identity of identities) {
      const event = await inspectRansPolarPromotion(tx, {
        parentJobId: input.parentJobId,
        revisionId: identity.revisionId,
        conditionId: identity.conditionId,
        ...(input.ingestLeaseToken
          ? { ingestLeaseToken: input.ingestLeaseToken }
          : {}),
      });
      if (!event || event.promotionId !== identity.promotionId) {
        throw new Error(
          `conditional whole-polar promotion ${identity.promotionId} disappeared during parent discovery`,
        );
      }
      recorded.push(event);
    }
    return recorded;
  });
}

interface LockedRemotePromisePoint {
  promise_id: string;
  promise_status: string;
  remote_solver: boolean;
  expires_at: Date | string;
  aoa_count: number;
  airfoil_id: string;
  revision_id: string;
  point_id: string;
  aoa_deg: number;
  point_status: string;
}

/** A remote solver may already have pushed early RANS siblings before the
 * marched job reaches its typed low-angle hard failure. Whole-polar
 * replacement has to put those fulfilled points back under the same live
 * promise lease before creating obligations; otherwise the promoted child
 * silently covers only the still-active tail. Owner validation, point reopen,
 * and promotion provenance therefore share one transaction.
 *
 * A terminal promise or point is never resurrected. The exact mirrored
 * promise must still be active and unexpired, every original point must still
 * belong to it, and each point must be either active or fulfilled. */
async function reopenRemotePromotionScope(
  tx: DB,
  input: RecordRansPolarPromotionInput,
  requestedAoas: number[],
  owner: RansPolarPromotionOwner,
): Promise<void> {
  if (owner.kind !== "sync_promise") return;
  const promiseId = owner.syncPromiseId;
  // Lock the target promise and every active point which could conflict with
  // its requested natural cells in one globally ordered owner-row pass.
  // Taking only the target here and a competitor after the advisory cell lock
  // creates target-owner -> cell -> competitor-owner inversion between two
  // concurrent promotions.
  const ownerRows = (await tx.execute(sql`
    SELECT promise.id AS promise_id,
           promise.status AS promise_status,
           (promise.request_payload ->> 'remoteSolver' = 'true') AS remote_solver,
           promise."expiresAt" AS expires_at,
           promise.aoa_count::int AS aoa_count,
           promise.airfoil_id,
           promise.simulation_preset_revision_id AS revision_id,
           promise_point.id AS point_id,
           promise_point.aoa_deg::float8 AS aoa_deg,
           promise_point.status AS point_status
    FROM sync_sweep_promises promise
    JOIN sync_sweep_promise_points promise_point
      ON promise_point.promise_id = promise.id
    WHERE promise_point.airfoil_id = ${input.airfoilId}
      AND promise_point.simulation_preset_revision_id = ${input.revisionId}
      AND promise_point.aoa_deg = ANY(${sql`ARRAY[${sql.join(
        requestedAoas.map((aoa) => sql`${aoa}::float8`),
        sql`, `,
      )}]`})
      AND (promise.id = ${promiseId} OR promise_point.status = 'active')
    ORDER BY promise.id, promise_point.id
    FOR UPDATE OF promise, promise_point
  `)) as unknown as LockedRemotePromisePoint[];
  const locked = ownerRows.filter((row) => row.promise_id === promiseId);
  const promise = locked[0];
  const exactAoas = uniqueSorted(locked.map((row) => Number(row.aoa_deg)));
  if (
    !promise ||
    promise.promise_status !== "active" ||
    !promise.remote_solver ||
    new Date(promise.expires_at).getTime() <= Date.now() ||
    promise.airfoil_id !== input.airfoilId ||
    promise.revision_id !== input.revisionId ||
    promise.aoa_count !== requestedAoas.length ||
    locked.length !== requestedAoas.length ||
    exactAoas.join(",") !== requestedAoas.join(",") ||
    locked.some(
      (row) =>
        row.point_status !== "active" && row.point_status !== "fulfilled",
    )
  ) {
    throw new PromotionPreconditionError(
      "whole-polar remote promotion lost its exact active promise scope",
    );
  }
  if (ownerRows.some((row) => row.promise_id !== promiseId)) {
    throw new PromotionPreconditionError(
      "whole-polar remote promotion conflicts with another active promise",
    );
  }

  // Match the global owner→natural-cell lock order before making a fulfilled
  // point active again. The unique active-cell index remains the final race
  // guard against another promise taking the same physical point.
  await lockPrecalcCells(
    tx,
    requestedAoas.map((aoaDeg) => ({
      airfoilId: input.airfoilId,
      revisionId: input.revisionId,
      aoaDeg,
    })),
  );
  await tx
    .update(syncSweepPromisePoints)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(syncSweepPromisePoints.promiseId, promiseId),
        eq(syncSweepPromisePoints.status, "fulfilled"),
      ),
    );
}

/** Persist the exact trigger, full physical coverage and parent-claim transfer
 * in one transaction. A crash after this commit cannot lose accepted siblings:
 * recovery reads the normalized promotion→obligation links and composes the
 * same physical work idempotently. */
export async function recordRansPolarPromotion(
  db: DB,
  input: RecordRansPolarPromotionInput,
): Promise<RecordedRansPolarPromotion | null> {
  try {
    return await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const recordedEvent = await inspectRansPolarPromotion(tx, {
        parentJobId: input.parentJobId,
        revisionId: input.revisionId,
        conditionId: input.conditionId ?? null,
        ingestLeaseToken: input.ingestLeaseToken,
      });
      if (recordedEvent) return recordedEvent;

      // Only a genuinely new event depends on caller-supplied scope, trigger
      // and scheduling ownership. A committed event above is authoritative on
      // replay even if those mutable inputs have since drifted.
      const requestedAoas = uniqueSorted(input.requestedAoas);
      const owner = exactPromotionOwner(input.ownership);
      const intentionallyOmittedAoas = uniqueSorted(
        input.intentionallyOmittedAoas ?? [],
      ).filter((aoa) => requestedAoas.includes(aoa));
      if (
        requestedAoas.length <= 1 ||
        input.triggerAoaDeg < 0 ||
        input.triggerAoaDeg > 5 ||
        !requestedAoas.includes(input.triggerAoaDeg) ||
        !owner
      ) {
        return null;
      }

      // The obligation helper owns the global owner→natural-cell lock order.
      // transferFromJobId permits only this parent job's still-claimed omitted
      // shells; any competing owner makes the whole transaction fail closed.
      const trigger = await tx
        .select({
          id: resultAttempts.id,
          resultId: resultAttempts.resultId,
          simJobId: resultAttempts.simJobId,
          airfoilId: resultAttempts.airfoilId,
          revisionId: resultAttempts.simulationPresetRevisionId,
          aoaDeg: resultAttempts.aoaDeg,
          regime: resultAttempts.regime,
          error: resultAttempts.error,
          disposition: sql<
            string | null
          >`${resultAttempts.evidencePayload} ->> 'failure_disposition'`,
          classification: resultClassifications.state,
        })
        .from(resultAttempts)
        .leftJoin(
          resultClassifications,
          eq(resultClassifications.resultAttemptId, resultAttempts.id),
        )
        .where(eq(resultAttempts.id, input.triggerResultAttemptId))
        .limit(1);
      const triggerRow = trigger[0];
      if (
        !triggerRow ||
        triggerRow.simJobId !== input.parentJobId ||
        triggerRow.airfoilId !== input.airfoilId ||
        triggerRow.revisionId !== input.revisionId ||
        triggerRow.aoaDeg !== input.triggerAoaDeg ||
        triggerRow.regime !== "rans" ||
        triggerRow.disposition !== "hard_solver" ||
        triggerRow.classification !== "rejected"
      ) {
        return null;
      }

      await reopenRemotePromotionScope(tx, input, requestedAoas, owner);

      const obligations = await ensurePrecalcObligationsInTransaction(
        tx,
        requestedAoas.map((aoaDeg) => ({
          airfoilId: input.airfoilId,
          revisionId: input.revisionId,
          aoaDeg,
          ...(aoaDeg === input.triggerAoaDeg && triggerRow.resultId
            ? {
                sourceResultId: triggerRow.resultId,
                sourceResultAttemptId: triggerRow.id,
              }
            : {}),
        })),
        input.ownership,
        { transferFromJobId: input.parentJobId },
      );
      const obligationByAoa = new Map(
        obligations.map((obligation) => [obligation.aoaDeg, obligation]),
      );
      if (requestedAoas.some((aoa) => !obligationByAoa.has(aoa))) {
        throw new PromotionPreconditionError(
          "whole-polar promotion lost one or more owner-authorized obligations",
        );
      }

      // Parent lock comes after owner/cell locks, matching the child composer.
      await lockAndValidatePromotionParent(tx, input, owner);
      const concurrentEvent = await inspectRansPolarPromotion(tx, {
        parentJobId: input.parentJobId,
        revisionId: input.revisionId,
        conditionId: input.conditionId ?? null,
        ingestLeaseToken: input.ingestLeaseToken,
      });
      if (concurrentEvent) return concurrentEvent;

      const [promotion] = await tx
        .insert(simRansPolarPromotions)
        .values({
          parentJobId: input.parentJobId,
          airfoilId: input.airfoilId,
          revisionId: input.revisionId,
          conditionId: input.conditionId ?? null,
          ownerKind: owner.kind,
          campaignId: owner.kind === "campaign" ? owner.campaignId : null,
          syncPromiseId:
            owner.kind === "sync_promise" ? owner.syncPromiseId : null,
          triggerResultAttemptId: input.triggerResultAttemptId,
          triggerAoaDeg: input.triggerAoaDeg,
          failureDisposition: "hard_solver",
          requestOrigin: "continuous-polar",
        })
        .returning();
      if (!promotion) {
        throw new PromotionPreconditionError(
          "whole-polar promotion insert returned no row",
        );
      }

      await tx.insert(simRansPolarPromotionPoints).values(
        requestedAoas.map((aoaDeg) => ({
          promotionId: promotion.id,
          aoaDeg,
          obligationId: obligationByAoa.get(aoaDeg)!.id,
          intentionallyOmittedByRans: intentionallyOmittedAoas.includes(aoaDeg),
        })),
      );

      if (owner.kind === "sync_promise") {
        // A delivery claim may have been queued or may already be streaming
        // while ingestion records this promotion. Invalidate that exact
        // parent/promise generation in the same transaction that reopens the
        // promise points, so a late RANS response cannot reclaim ownership.
        await tx
          .update(syncRemoteResultDeliveries)
          .set({
            state: "superseded",
            nextAttemptAt: new Date(),
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            lastHttpStatus: null,
            lastError:
              "superseded by conditional whole-polar preliminary URANS promotion",
            remoteConflictIds: [],
            deliveredAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(syncRemoteResultDeliveries.promiseId, owner.syncPromiseId),
              eq(syncRemoteResultDeliveries.simJobId, input.parentJobId),
              inArray(syncRemoteResultDeliveries.state, [
                "pending",
                "pushing",
                "retry_wait",
              ]),
            ),
          );
      }

      if (intentionallyOmittedAoas.length) {
        // These cells were deliberately not run after the engine's typed abort.
        // Route them to the durable preliminary ledger without inventing a failed
        // result or attempt. The obligation excludes them from ordinary RANS gaps.
        await tx
          .update(results)
          .set({
            status: "queued",
            source: "queued",
            simJobId: null,
            engineJobId: null,
            engineCaseSlug: null,
            error: null,
          })
          .where(
            and(
              eq(results.airfoilId, input.airfoilId),
              eq(results.simulationPresetRevisionId, input.revisionId),
              eq(results.simJobId, input.parentJobId),
              inArray(results.aoaDeg, intentionallyOmittedAoas),
              inArray(results.status, [
                "pending",
                "queued",
                "running",
                "stale",
              ]),
              sql`${results.currentResultAttemptId} IS NULL`,
            ),
          );
      }

      return {
        promotionId: promotion.id,
        parentJobId: promotion.parentJobId,
        airfoilId: promotion.airfoilId,
        revisionId: promotion.revisionId,
        conditionId: promotion.conditionId,
        triggerResultAttemptId: promotion.triggerResultAttemptId,
        triggerAoaDeg: promotion.triggerAoaDeg,
        failureDisposition: "hard_solver",
        requestOrigin: "continuous-polar",
        obligationIds: requestedAoas.map((aoa) => obligationByAoa.get(aoa)!.id),
        requestedAoas,
        intentionallyOmittedAoas,
        owner,
      };
    });
  } catch (error) {
    if (error instanceof PromotionPreconditionError) return null;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === "sync_sweep_promise_points_active_uq"
    ) {
      return null;
    }
    throw error;
  }
}
