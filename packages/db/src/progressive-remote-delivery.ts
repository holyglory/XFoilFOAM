import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";

export async function listProgressiveRemoteAssignments(
  db: DB,
  input: {
    solverId: string;
    beforeCreatedAt?: string;
    afterCreatedAt?: string;
    after?: string;
    limit?: number;
  },
) {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Remote assignment page size must be between 1 and 50");
  if (Boolean(input.afterCreatedAt) !== Boolean(input.after))
    throw new Error("Remote assignment cursor requires created time and id");
  const cycleStartedAt = input.beforeCreatedAt ?? new Date().toISOString();
  const rows = await db.execute(sql`
    SELECT dispatch.sim_job_id AS "executionId", dispatch.promise_id AS "promiseId",
      dispatch.content_signature AS "contentSignature", dispatch.cpu_slots AS "cpuSlots",
      date_trunc('milliseconds', dispatch.created_at) AS "createdAt"
    FROM progressive_remote_dispatches dispatch
    JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id AND solver.revoked_at IS NULL
    JOIN sync_sweep_promises promise
      ON promise.id = dispatch.promise_id
      AND promise.status = 'active'
      AND promise."expiresAt" > clock_timestamp()
    WHERE dispatch.solver_id = ${input.solverId}::uuid
      AND date_trunc('milliseconds', dispatch.created_at) <= ${cycleStartedAt}::timestamptz
      ${
        input.after && input.afterCreatedAt
          ? sql`AND (date_trunc('milliseconds', dispatch.created_at), dispatch.sim_job_id) > (${input.afterCreatedAt}::timestamptz, ${input.after}::uuid)`
          : sql``
      }
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
        WHERE stopped.sim_job_id = dispatch.sim_job_id AND stopped.engine_job_id = dispatch.sim_job_id::text)
    ORDER BY date_trunc('milliseconds', dispatch.created_at) ASC, dispatch.sim_job_id ASC LIMIT ${limit + 1}
  `);
  const items = rows.slice(0, limit).map((row) => ({
    executionId: String(row.executionId),
    promiseId: String(row.promiseId),
    contentSignature: String(row.contentSignature),
    cpuSlots: Number(row.cpuSlots),
    createdAt: new Date(row.createdAt as string | Date).toISOString(),
  }));
  return {
    items,
    cycleStartedAt,
    nextCursor: rows.length > limit ? items.at(-1)!.executionId : null,
    nextCreatedAt: rows.length > limit ? items.at(-1)!.createdAt : null,
  };
}

export async function readProgressiveRemoteAssignment(
  db: DB,
  input: { solverId: string; executionId: string },
) {
  const [row] = await db.execute(sql`
    SELECT dispatch.promise_id, dispatch.content_signature, dispatch.envelope, dispatch.cpu_slots,
      promise.status AS promise_status, promise."expiresAt" AS expires_at,
      promise."expiresAt" <= clock_timestamp() AS expired,
      job.status AS job_status, job.engine_state,
      airfoil.id AS airfoil_id, airfoil.slug, airfoil.name, airfoil.source, airfoil.point_format, airfoil.points,
      revision.id AS revision_id, revision.signature_hash, revision.snapshot,
      EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
        WHERE stopped.sim_job_id = dispatch.sim_job_id AND stopped.engine_job_id = dispatch.sim_job_id::text) AS stopped,
      (SELECT max(sequence) FROM progressive_remote_reports report
        WHERE report.sim_job_id = dispatch.sim_job_id) AS received_sequence
    FROM progressive_remote_dispatches dispatch
    JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id AND solver.revoked_at IS NULL
    JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
    JOIN sim_jobs job ON job.id = dispatch.sim_job_id
    JOIN airfoils airfoil ON airfoil.id = job.airfoil_id
    JOIN simulation_preset_revisions revision ON revision.id = job.simulation_preset_revision_id
    WHERE dispatch.solver_id = ${input.solverId}::uuid AND dispatch.sim_job_id = ${input.executionId}::uuid
  `);
  if (!row) return null;
  const envelope = verifyProgressiveRemoteExecution(row.envelope, {
    solverId: input.solverId,
    promiseId: String(row.promise_id),
    executionId: input.executionId,
    contentSignature: String(row.content_signature),
  });
  return {
    envelope,
    cpuSlots: Number(row.cpu_slots),
    executionStopped: Boolean(row.stopped),
    receivedSequence: Number(row.received_sequence ?? 0),
    job: { status: String(row.job_status), engineState: row.engine_state },
    promise: {
      id: String(row.promise_id),
      status: String(row.promise_status),
      expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      expired: Boolean(row.expired),
      airfoil: {
        id: String(row.airfoil_id),
        slug: String(row.slug),
        name: String(row.name),
        source: row.source,
        pointFormat: String(row.point_format),
        points: row.points,
      },
      setupRevision: {
        id: String(row.revision_id),
        signatureHash: String(row.signature_hash),
        snapshot: row.snapshot,
      },
      aoas: envelope.scope.units.map((unit) => unit.alpha),
    },
  };
}
