import { type DB, simJobs, simPrecalcObligations } from "@aerodb/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface PhysicalPrecalcComposition {
  obligationIds: string[];
  job: typeof simJobs.$inferInsert;
  /** Direct campaign children retain their parent/condition identity for
   * sequential drain. Request-backed physical jobs omit this block. */
  directParent?: {
    parentJobId: string;
    revisionId: string;
    conditionId?: string;
  };
}

/** Claim physical preliminary work and compose its pending sim_job in one
 * transaction. latest_sim_job_id is the pre-submit lease; it consumes no
 * solver attempt until the engine accepts. Every obligation is locked and
 * must still be due, owner-authorized, and free of another live composition.
 */
export async function composePhysicalPrecalcJob(
  db: DB,
  spec: PhysicalPrecalcComposition,
): Promise<{ id: string } | null> {
  if (!spec.obligationIds.length) return null;
  const ids = [...new Set(spec.obligationIds)].sort();
  if (ids.length !== spec.obligationIds.length) return null;
  if (spec.job.campaignId != null) {
    throw new Error("physical precalc jobs must not carry scalar campaign_id");
  }
  const payloadIds = Array.isArray(
    (spec.job.requestPayload as { precalcObligationIds?: unknown } | null)
      ?.precalcObligationIds,
  )
    ? (
        spec.job.requestPayload as { precalcObligationIds: unknown[] }
      ).precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (
    payloadIds.length !== ids.length ||
    [...payloadIds].sort().some((id, index) => id !== ids[index])
  ) {
    throw new Error(
      "physical precalc job payload must carry the exact claimed obligation ids",
    );
  }
  const payload = (spec.job.requestPayload ?? {}) as {
    syncPromiseId?: unknown;
    remoteSolver?: unknown;
    upstreamBaseUrl?: unknown;
  };
  const remoteProvenance =
    typeof payload.syncPromiseId === "string" &&
    payload.remoteSolver === true &&
    typeof payload.upstreamBaseUrl === "string" &&
    payload.upstreamBaseUrl.length > 0
      ? {
          promiseId: payload.syncPromiseId,
          upstreamBaseUrl: payload.upstreamBaseUrl,
        }
      : null;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;

    // Campaign lifecycle transitions acquire UPDATE locks on these same rows
    // before touching obligation ownership. Keep the same lock order.
    const ownerRows = (await tx.execute(sql`
      SELECT ownership.obligation_id, campaign.id AS campaign_id
      FROM sim_precalc_obligation_campaigns ownership
      JOIN sim_campaigns campaign
        ON campaign.id = ownership.campaign_id
       AND campaign.status IN ('active', 'attention')
      WHERE ownership.obligation_id = ANY(${sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
        AND ownership.state = 'active'
      ORDER BY campaign.id, ownership.obligation_id
      FOR SHARE OF campaign
    `)) as unknown as Array<{
      obligation_id: string;
      campaign_id: string;
    }>;
    const remoteOwnerRows = remoteProvenance
      ? ((await tx.execute(sql`
          SELECT obligation.id AS obligation_id
          FROM sync_sweep_promises remote_promise
          JOIN sync_sweep_promise_points promise_point
            ON promise_point.promise_id = remote_promise.id
           AND promise_point.status = 'active'
          JOIN sim_precalc_obligations obligation
            ON obligation.airfoil_id = promise_point.airfoil_id
           AND obligation.revision_id = promise_point.simulation_preset_revision_id
           AND obligation.aoa_deg = promise_point.aoa_deg
          WHERE remote_promise.id = ${remoteProvenance.promiseId}
            AND remote_promise.status = 'active'
            AND remote_promise."expiresAt" > now()
            AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
            AND remote_promise.source_base_url = ${remoteProvenance.upstreamBaseUrl}
            AND obligation.id = ANY(${sql`ARRAY[${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})
          ORDER BY obligation.id
          FOR SHARE OF remote_promise
        `)) as unknown as Array<{ obligation_id: string }>)
      : [];
    const requestOwnerRows = (await tx.execute(sql`
      SELECT coverage.obligation_id, request.id AS request_id
      FROM sim_precalc_obligation_requests coverage
      JOIN sim_urans_requests request
        ON request.id = coverage.request_id
       AND request.background_owner
       AND request.state IN ('pending', 'running')
      WHERE coverage.obligation_id = ANY(${sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
      ORDER BY request.id, coverage.obligation_id
      FOR SHARE OF request
    `)) as unknown as Array<{
      obligation_id: string;
      request_id: string;
    }>;
    const runnableOwnerIds = new Set([
      ...ownerRows.map((row) => row.obligation_id),
      ...remoteOwnerRows.map((row) => row.obligation_id),
      ...requestOwnerRows.map((row) => row.obligation_id),
    ]);

    const obligations = await tx
      .select()
      .from(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, ids))
      .orderBy(simPrecalcObligations.id)
      .for("update");
    if (obligations.length !== ids.length) return null;

    const latestIds = obligations
      .map((obligation) => obligation.latestSimJobId)
      .filter((id): id is string => Boolean(id));
    const latestJobs = latestIds.length
      ? await tx
          .select({ id: simJobs.id, status: simJobs.status })
          .from(simJobs)
          .where(inArray(simJobs.id, latestIds))
      : [];
    const latestStatus = new Map(latestJobs.map((job) => [job.id, job.status]));
    const now = Date.now();
    for (const obligation of obligations) {
      const latest = obligation.latestSimJobId
        ? latestStatus.get(obligation.latestSimJobId)
        : null;
      if (
        obligation.state !== "pending" ||
        obligation.attemptCount >= obligation.maxAttempts ||
        (obligation.nextSubmitAt &&
          new Date(obligation.nextSubmitAt).getTime() > now) ||
        (!obligation.backgroundOwner && !runnableOwnerIds.has(obligation.id)) ||
        (latest != null &&
          ["pending", "submitted", "running", "ingesting"].includes(latest))
      ) {
        return null;
      }
    }

    if (spec.directParent) {
      // Parent locking comes after campaign + physical obligation locks and
      // before insertion, matching lifecycle order and preventing two
      // sweepers from composing the same condition child.
      const [parent] = (await tx.execute(sql`
        SELECT id FROM sim_jobs
        WHERE id = ${spec.directParent.parentJobId}
        FOR UPDATE
      `)) as unknown as Array<{ id: string }>;
      if (!parent) return null;
      const conditionSql = spec.directParent.conditionId
        ? sql`request_payload ->> 'conditionId' = ${spec.directParent.conditionId}`
        : sql`request_payload ->> 'conditionId' IS NULL`;
      const [liveChild] = await tx
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(
            eq(simJobs.parentJobId, spec.directParent.parentJobId),
            eq(simJobs.wave, 2),
            eq(
              simJobs.simulationPresetRevisionId,
              spec.directParent.revisionId,
            ),
            conditionSql,
            inArray(simJobs.status, [
              "pending",
              "submitted",
              "running",
              "ingesting",
            ]),
          ),
        )
        .limit(1);
      if (liveChild) return null;
    }

    const [job] = await tx.insert(simJobs).values(spec.job).returning({
      id: simJobs.id,
    });
    await tx
      .update(simPrecalcObligations)
      .set({
        latestSimJobId: job.id,
        lastOutcome: "composed",
        completedAt: null,
      })
      .where(inArray(simPrecalcObligations.id, ids));
    return job;
  });
}
