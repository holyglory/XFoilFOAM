import {
  type DB,
  type MeshRecoveryRequeueScope,
  requeueDeterministicMeshObligationsForRecoveryVersion,
  requeueDeterministicRansMeshFailuresForRecoveryVersion,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";

import { engineMeshRecoveryVersion } from "./engine-capabilities";

/** Close only the incident occurrences proven to be the same immutable,
 * non-physical deterministic-mesh attempts which the newer strategy just
 * reopened. A different preliminary failure on the same obligation remains
 * open and therefore continues to fence NEW admission. */
async function resolveReopenedPrecalcMeshIncidents(
  db: DB,
  obligationIds: string[],
  meshRecoveryVersion: number,
): Promise<number> {
  if (!obligationIds.length) return 0;
  const resolved = (await db.execute(sql`
    UPDATE sim_solver_incidents incident
    SET status = 'resolved',
        resolved_at = now(),
        "updatedAt" = now()
    WHERE incident.precalc_obligation_id = ANY(${sql`ARRAY[${sql.join(
      obligationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND incident.stage = 'preliminary'
      AND incident.status = 'open'
      AND incident.occurrence_key =
        'preliminary:' || incident.precalc_obligation_id::text || ':' ||
        COALESCE(
          incident.result_attempt_id::text,
          incident.sim_job_id::text
        ) || ':deterministic_failure'
      AND incident.metadata ->> 'lastOutcome' = 'deterministic_failure'
      AND (
        (
          incident.reason = 'deterministic-mesh'
          AND incident.metadata ->> 'recovery' = 'deterministic-mesh'
          AND CASE
            WHEN incident.metadata ->> 'meshRecoveryVersion' ~ '^[0-9]+$'
            THEN (incident.metadata ->> 'meshRecoveryVersion')::int
            ELSE 0
          END < ${meshRecoveryVersion}
        )
        OR (
          incident.reason <> 'deterministic-mesh'
          AND (
            incident.metadata ->> 'failureDisposition' = 'deterministic_mesh'
            OR NOT (incident.metadata ? 'failureDisposition')
            OR incident.metadata -> 'failureDisposition' = 'null'::jsonb
          )
        )
      )
      AND EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_attempts immutable_attempt
        WHERE immutable_attempt.obligation_id = incident.precalc_obligation_id
          AND immutable_attempt.state = 'failed'
          AND immutable_attempt.outcome = 'deterministic_failure'
          AND NOT immutable_attempt.consumes_solver_attempt
          AND immutable_attempt.mesh_recovery_version < ${meshRecoveryVersion}
          AND (
            (
              incident.result_attempt_id IS NOT NULL
              AND immutable_attempt.result_attempt_id = incident.result_attempt_id
            )
            OR (
              incident.result_attempt_id IS NULL
              AND incident.sim_job_id IS NOT NULL
              AND immutable_attempt.sim_job_id = incident.sim_job_id
            )
          )
      )
    RETURNING incident.id
  `)) as unknown as Array<{ id: string }>;
  return resolved.length;
}

/** One bounded control-plane preparation pass before scheduler lane choice.
 * It learns the live engine capability, reopens only older structured
 * deterministic-mesh obligations with a remaining attempt, refreshes campaign
 * counters, and returns the exact version every resulting PRECALC job must
 * stamp into requestPayload. */
export async function prepareAutomaticMeshRecovery(
  db: DB,
  engine: EngineClient,
  scope: MeshRecoveryRequeueScope = {},
): Promise<number | null> {
  const meshRecoveryVersion = await engineMeshRecoveryVersion(engine);
  if (meshRecoveryVersion == null) {
    console.error(
      "[sweeper] PRECALC scheduling deferred: engine mesh-recovery capability is unavailable or malformed",
    );
    return null;
  }
  // Reopening the work and resolving its exact old-strategy incident are one
  // durable transition. A process crash cannot leave the obligation pending
  // while stale incident provenance continues to trip Resume forever.
  const { reopened, resolvedIncidentCount } = await db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const reopened =
        await requeueDeterministicMeshObligationsForRecoveryVersion(
          tx,
          meshRecoveryVersion,
          scope,
        );
      const resolvedIncidentCount = await resolveReopenedPrecalcMeshIncidents(
        tx,
        reopened.obligationIds,
        meshRecoveryVersion,
      );
      return { reopened, resolvedIncidentCount };
    },
  );
  if (reopened.obligationIds.length) {
    console.log(
      `[sweeper] reopened ${reopened.obligationIds.length} deterministic PRECALC mesh obligation(s) and resolved ${resolvedIncidentCount} matching old-strategy incident(s) for engine mesh recovery strategy v${meshRecoveryVersion}; original attempt evidence retained`,
    );
  }
  const ransScope =
    scope.campaignIds !== undefined
      ? { campaignIds: scope.campaignIds }
      : Object.keys(scope).length
        ? { resultIds: [] }
        : {};
  const reopenedRans =
    await requeueDeterministicRansMeshFailuresForRecoveryVersion(
      db,
      meshRecoveryVersion,
      ransScope,
    );
  if (reopenedRans.resultIds.length) {
    console.log(
      `[sweeper] reopened ${reopenedRans.resultIds.length} deterministic wave-1 RANS mesh result(s) for engine mesh recovery strategy v${meshRecoveryVersion}; original attempt evidence retained`,
    );
  }
  return meshRecoveryVersion;
}
