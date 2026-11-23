import { progressiveAdmissionReportPressureSql } from "../../../apps/sweeper/src/progressive-progress-selection";
import { expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DB, Sql } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { resolveEngineRuntimeBuild } from "../../../apps/sweeper/src/engine-provenance";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import {
  applyProgressiveRemoteProgress,
  reconcileProgressiveRemoteProgress,
} from "../../../apps/sweeper/src/progressive-remote-progress";
import { pinsMatch, prepareProgressPage } from "../../../apps/sweeper/src/progressive-repeated-progress";

// Same assigned physical units and v1 writer for the sequential and paged paths.
// Each run is rolled back to the same original job, observations and receipts.
export async function verifyRepeatedProgress(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  running: ProgressiveRemoteReport,
  driver: Sql,
) {
  const job = envelope.scope.executionId;
  const baseline = new Error("restore independent repeated-progress fixture");
  const compare = async (shared: DB, paged: boolean) => {
    let snapshot: unknown;
    await expect(
      shared.transaction(async (tx) => {
        const connection = tx as unknown as DB;
        await connection.execute(
          sql`UPDATE progressive_report_storage_policy SET normalization_enabled=true WHERE id=1`,
        );
        await expect(applyProgressiveRemoteProgress(connection, job)).resolves.toMatchObject({ sequence: 1 });
        const signatures = [];
        for (let n = 2; n <= 17; n++) {
          const r = structuredClone(running);
          r.sequence = n;
          const budget = r.status.solver_budget_progress!;
          budget.observed_at = new Date(
            Date.parse(running.status.solver_budget_progress!.observed_at) + n * 1000,
          ).toISOString();
          budget.cases[0]!.solver_active_seconds = n;
          if (n === 5) {
            budget.observed_at = new Date(
              Date.parse(running.status.solver_budget_progress!.observed_at) + 2500,
            ).toISOString();
            budget.cases[0]!.solver_active_seconds = 2.5;
          }
          if (n >= 10 && n <= 13) r.result = null;
          if (n >= 14) r.result!.polars[0]!.attempts![0]!.force_history!.cl[1] = 0.61;
          signatures.push(
            (
              await storeProgressiveRemoteReport(connection, {
                executionId: job,
                solverId: envelope.solverId,
                promiseId: envelope.promiseId,
                report: r,
              })
            ).contentSignature,
          );
        }
        // All reports were indexed on delivery, but their unapplied progress
        // must keep the original threshold intact until it has actually drained.
        const pressure = async (limit: number) =>
          (await connection.execute(progressiveAdmissionReportPressureSql(limit)))[0].throttled;
        const otherPending = Number(
          (
            await connection.execute(sql`SELECT count(*) AS n FROM progressive_remote_reports r
        WHERE r.sim_job_id<>${job}::uuid AND (NOT EXISTS(SELECT FROM progressive_remote_progress_receipts p WHERE p.sim_job_id=r.sim_job_id AND p.sequence=r.sequence)
          OR NOT EXISTS(SELECT FROM progressive_remote_report_inventories i WHERE i.sim_job_id=r.sim_job_id AND i.sequence=r.sequence))`)
          )[0].n,
        );
        expect(await pressure(otherPending + 16)).toBe(true);
        expect(await pressure(otherPending + 17)).toBe(false);
        const page = await prepareProgressPage(connection, job, 8);
        expect(page?.heads.map((h) => h.signature)).toEqual(signatures.slice(0, 8));
        expect(await pinsMatch(connection, job, page!, envelope)).toBe(true);
        const corrupt = Object.create(connection) as DB;
        const dialect = new PgDialect();
        const corruptRead = async (statement: Parameters<DB["execute"]>[0]) => {
          const rows = await connection.execute(statement);
          if (
            dialect.sqlToQuery(statement as ReturnType<typeof sql>).sql.includes("AS header") &&
            rows.length >= 2
          )
            rows[1] = { ...rows[1], content_signature: "0".repeat(64) };
          return rows;
        };
        corrupt.execute = corruptRead as DB["execute"];
        await expect(prepareProgressPage(corrupt, job, 8)).rejects.toThrow("immutable receipt");
        const runtimeWrites: string[] = [];
        const originalDebug = driver.options.debug;
        let originalReads = 0,
          ordinaryReads = 0;
        driver.options.debug = (id, query, params, types) => {
          if (typeof originalDebug === "function") originalDebug(id, query, params, types);
          if (query.includes("INSERT INTO progressive_cfd_runtime_progress("))
            runtimeWrites.push(analysisContentHash(params));
          if (query.includes("resolve_progressive_report(r.report,r.result_payload_hash) AS original"))
            originalReads++;
          if (query.includes("resolve_progressive_report(to_jsonb(report.*)) AS report")) ordinaryReads++;
        };
        try {
          if (paged) {
            const receipt = await reconcileProgressiveRemoteProgress(connection, { jobIds: [job] });
            expect(receipt).toMatchObject({ applied: 16, stopped: 0, errors: [] });
          } else {
            for (let n = 2; n <= 17; n++)
              expect(await applyProgressiveRemoteProgress(connection, job)).toMatchObject({
                kind: "applied",
                sequence: n,
              });
          }
        } finally {
          driver.options.debug = originalDebug;
        }
        expect(runtimeWrites.length).toBeGreaterThan(1);
        if (paged) {
          expect(originalReads).toBe(1);
          expect(ordinaryReads).toBeLessThan(16);
        } else {
          expect(originalReads).toBe(0);
          expect(ordinaryReads).toBeGreaterThanOrEqual(16);
        }
        expect(await pinsMatch(connection, job, page!, envelope)).toBe(false);
        expect(await pressure(otherPending + 1)).toBe(false);
        // The two oldest rows fall outside the four-threshold recent prefix.
        // One is missing both markers and the other only its inventory.
        const holes = new Error("restore old receipt and inventory holes");
        await expect(
          connection.transaction(async (inner) => {
            await inner.execute(
              sql`DELETE FROM progressive_remote_progress_receipts WHERE sim_job_id=${job}::uuid AND sequence=1`,
            );
            await inner.execute(
              sql`DELETE FROM progressive_remote_report_inventories WHERE sim_job_id=${job}::uuid AND sequence IN(1,2)`,
            );
            expect(
              (await inner.execute(progressiveAdmissionReportPressureSql(otherPending + 2)))[0].throttled,
            ).toBe(true);
            expect(
              (await inner.execute(progressiveAdmissionReportPressureSql(otherPending + 3)))[0].throttled,
            ).toBe(false);
            throw holes;
          }),
        ).rejects.toBe(holes);
        const [result] = await connection.execute(sql`SELECT jsonb_build_object(
        'job',jsonb_build_array(j.status,j.engine_state,j.completed_cases,j.engine_job_id,j.solver_runtime_build_id),
        'receipts',(SELECT jsonb_agg(p.content_signature ORDER BY p.sequence) FROM progressive_remote_progress_receipts p
          WHERE p.sim_job_id=j.id AND p.sequence>=2),
        'inventory',(SELECT jsonb_agg(jsonb_build_array(i.inventory_signature,i.source_count) ORDER BY i.sequence)
          FROM progressive_remote_report_inventories i WHERE i.sim_job_id=j.id),
        'units',(SELECT jsonb_agg(jsonb_build_array(a.token,a.outcome,a.active_seconds,u.state,u.active_seconds,
          b.observation_signature,b.active_seconds,b.solver_running) ORDER BY a.token)
          FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id
          LEFT JOIN progressive_cfd_runtime_progress b ON b.attempt_token=a.token WHERE a.sim_job_id=j.id),
        'physical',(SELECT count(*) FROM result_attempts raw WHERE raw.sim_job_id=j.id)) AS state
        FROM sim_jobs j WHERE j.id=${job}::uuid`);
        snapshot = { state: result.state, runtimeWrites };
        expect(result.state).toMatchObject({ receipts: signatures });
        throw baseline;
      }),
    ).rejects.toBe(baseline);
    return snapshot;
  };
  await expect(
    db.transaction(async (tx) => {
      const shared = tx as unknown as DB;
      // Allocate the actual runtime provenance once, so rolling back one
      // comparison cannot produce a different surrogate UUID in its sibling.
      await resolveEngineRuntimeBuild(shared, running.status.engine ?? running.result?.engine);
      expect(await compare(shared, true)).toEqual(await compare(shared, false));
      throw baseline;
    }),
  ).rejects.toBe(baseline);
}
