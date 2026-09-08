import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import {
  sealProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "../src/progressive-remote-execution";
import { receiveProgressiveAssignmentPage } from "../../../apps/sweeper/src/progressive-remote-intake";
import { mirrorProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-jobs";
import { receiveProgressiveCampaignAssignments } from "../../../apps/sweeper/src/remote-solver";
import type { EngineClient } from "../../engine-client/src";

export async function verifyProgressiveAssignmentIntake(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  const executionId = envelope.scope.executionId;
  const [settings] = await db.execute(
    sql`SELECT remote_solver_enabled, remote_solver_transfer_paused FROM sync_api_settings WHERE id = 1`,
  );
  const [originalCursor] = await db.execute(
    sql`SELECT * FROM progressive_worker_assignment_cursors WHERE settings_id = 1`,
  );
  const assignments = [
    envelope,
    ...Array.from({ length: 51 }, () => {
      const assignedId = randomUUID();
      return sealProgressiveRemoteExecution({
        solverId: envelope.solverId,
        promiseId: randomUUID(),
        scope: { ...envelope.scope, executionId: assignedId },
        request: { ...envelope.request, execution_id: assignedId },
      });
    }),
  ].sort((left, right) =>
    left.scope.executionId < right.scope.executionId ? -1 : 1,
  );
  const fullReads: string[] = [];
  const importedExecutionId = randomUUID();
  const importedPromiseId = randomUUID();
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toHaveProperty("x-xfoilfoam-solver-token");
    if (url.pathname.endsWith("/progressive-executions")) {
      const after = url.searchParams.get("after");
      const remaining = assignments.filter(
        (item) => after === null || item.scope.executionId > after,
      );
      const page = remaining.slice(0, 25);
      return Response.json({
        items: page.map((item) => ({
          executionId: item.scope.executionId,
          promiseId: item.promiseId,
          contentSignature: item.contentSignature,
          cpuSlots: item.request.resources?.solver_processes ?? 1,
        })),
        nextCursor:
          remaining.length > 25 ? page.at(-1)!.scope.executionId : null,
      });
    }
    const assignedId = url.pathname.split("/").at(-1)!;
    fullReads.push(assignedId);
    const assigned = assignments.find(
      (item) => item.scope.executionId === assignedId,
    );
    if (!assigned) throw new Error("Unexpected isolated assignment URL");
    return Response.json({
      assignment: {
        envelope: assigned,
        promise: { id: assigned.promiseId },
        executionStopped: assignedId !== executionId,
      },
    });
  };
  const receive = vi.fn(
    async (document: { envelope: ProgressiveRemoteExecutionEnvelope }) => {
      await mirrorProgressiveRemoteJob(db, {
        envelope: document.envelope,
        assignment: {
          solverId: envelope.solverId,
          promiseId: envelope.promiseId,
          executionId,
          contentSignature: envelope.contentSignature,
        },
      });
    },
  );
  try {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = true, remote_solver_transfer_paused = false WHERE id = 1`,
    );
    await db.execute(
      sql`DELETE FROM progressive_worker_assignment_cursors WHERE settings_id = 1`,
    );
    const removed =
      await db.execute(sql`DELETE FROM sim_jobs WHERE id = ${executionId}::uuid
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_submission_intents WHERE sim_job_id = ${executionId}::uuid) RETURNING id`);
    expect(removed).toHaveLength(1);
    for (const expectedSeen of [25, 25, 2]) {
      const receipt = await receiveProgressiveAssignmentPage(
        db,
        receive,
        fetcher,
      );
      expect(receipt).toMatchObject({
        seen: expectedSeen,
        cursorAdvanced: true,
        errors: [],
      });
    }
    expect(receive).toHaveBeenCalledTimes(1);
    expect(fullReads).toHaveLength(52);
    const [wrapped] = await db.execute(
      sql`SELECT after_execution_id FROM progressive_worker_assignment_cursors WHERE settings_id = 1`,
    );
    expect(wrapped.after_execution_id).toBeNull();
    const repeated = [];
    for (const expectedSeen of [25, 25, 2]) {
      const receipt = await receiveProgressiveAssignmentPage(
        db,
        receive,
        fetcher,
      );
      expect(receipt.seen).toBe(expectedSeen);
      repeated.push(receipt);
    }
    expect(repeated.reduce((total, item) => total + item.existing, 0)).toBe(1);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(fullReads.filter((id) => id === executionId)).toHaveLength(1);
    const [source] =
      await db.execute(sql`SELECT airfoil.slug, airfoil.name, airfoil.source, airfoil.point_format, airfoil.points,
      revision.signature_hash, revision.snapshot FROM sim_jobs job JOIN airfoils airfoil ON airfoil.id = job.airfoil_id
      JOIN simulation_preset_revisions revision ON revision.id = job.simulation_preset_revision_id WHERE job.id = ${executionId}::uuid`);
    const importedEnvelope = sealProgressiveRemoteExecution({
      solverId: envelope.solverId,
      promiseId: importedPromiseId,
      scope: { ...envelope.scope, executionId: importedExecutionId },
      request: { ...envelope.request, execution_id: importedExecutionId },
    });
    const proof = {
      version: 1,
      job_id: importedExecutionId,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: new Date().toISOString(),
      error: null,
      fence: "cancel_marker",
      ownership_basis: "never_started_cancellation_fence",
    };
    const engine = {
      getExecutionStopProof: vi.fn(async () => proof),
      getJob: vi.fn(async () => ({
        job_id: importedExecutionId,
        state: "cancelled",
        completed_cases: 0,
        total_cases: 0,
      })),
    } as unknown as EngineClient;
    const imported = await receiveProgressiveCampaignAssignments(
      db,
      engine,
      async (url) => {
        if (String(url).includes("?limit="))
          return Response.json({
            items: [
              {
                executionId: importedExecutionId,
                promiseId: importedPromiseId,
                contentSignature: importedEnvelope.contentSignature,
              },
            ],
            nextCursor: null,
          });
        return Response.json({
          assignment: {
            envelope: importedEnvelope,
            executionStopped: false,
            promise: {
              id: importedPromiseId,
              status: "expired",
              expired: true,
              expiresAt: new Date(Date.now() - 1000).toISOString(),
              airfoil: {
                slug: source.slug,
                name: source.name,
                source: source.source,
                pointFormat: source.point_format,
                points: source.points,
              },
              setupRevision: {
                signatureHash: source.signature_hash,
                snapshot: source.snapshot,
              },
              aoas: envelope.scope.units.map((unit) => unit.alpha),
            },
          },
        });
      },
    );
    expect(imported).toMatchObject({ seen: 1, mirrored: 1, errors: [] });
    const [importedJob] =
      await db.execute(sql`SELECT job.request_payload, promise.status FROM sim_jobs job
      JOIN sync_sweep_promises promise ON promise.id = ${importedPromiseId}::uuid WHERE job.id = ${importedExecutionId}::uuid`);
    expect(importedJob.status).toBe("expired");
    expect(
      (importedJob.request_payload as Record<string, unknown>).engineRequest,
    ).toEqual(importedEnvelope.request);
    const [noExecution] = await db.execute(sql`SELECT
      (SELECT count(*)::integer FROM results WHERE sim_job_id = ${importedExecutionId}::uuid) AS points,
      (SELECT count(*)::integer FROM progressive_worker_submission_intents WHERE sim_job_id = ${importedExecutionId}::uuid) AS intents,
      (SELECT count(*)::integer FROM progressive_worker_reports WHERE sim_job_id = ${importedExecutionId}::uuid) AS reports`);
    expect(noExecution).toEqual({ points: 0, intents: 0, reports: 1 });
    await expect(
      receiveProgressiveAssignmentPage(db, receive, async () =>
        Response.json({ items: [], nextCursor: randomUUID() }),
      ),
    ).rejects.toThrow("cursor would skip");
    const futureCursor = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const changed = await receiveProgressiveAssignmentPage(
      db,
      receive,
      async () => {
        await db.execute(
          sql`UPDATE progressive_worker_assignment_cursors SET after_execution_id = ${futureCursor}::uuid WHERE settings_id = 1`,
        );
        return Response.json({ items: [], nextCursor: null });
      },
    );
    expect(changed.cursorAdvanced).toBe(false);
    const [kept] = await db.execute(
      sql`SELECT after_execution_id FROM progressive_worker_assignment_cursors WHERE settings_id = 1`,
    );
    expect(kept.after_execution_id).toBe(futureCursor);
  } finally {
    await db.execute(
      sql`DELETE FROM progressive_worker_reports WHERE sim_job_id = ${importedExecutionId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM sim_jobs WHERE id = ${importedExecutionId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM sync_sweep_promises WHERE id = ${importedPromiseId}::uuid`,
    );
    await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled = ${settings.remote_solver_enabled},
      remote_solver_transfer_paused = ${settings.remote_solver_transfer_paused} WHERE id = 1`);
    await db.execute(
      sql`DELETE FROM progressive_worker_assignment_cursors WHERE settings_id = 1`,
    );
    if (originalCursor)
      await db.execute(sql`INSERT INTO progressive_worker_assignment_cursors
      (settings_id, solver_id, upstream_base_url, after_execution_id, updated_at) VALUES
      (1, ${originalCursor.solver_id}::uuid, ${originalCursor.upstream_base_url}, ${originalCursor.after_execution_id}::uuid, ${originalCursor.updated_at}::timestamptz)`);
  }
}
