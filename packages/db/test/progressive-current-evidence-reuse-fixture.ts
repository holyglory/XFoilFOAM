import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { reconcileCurrentPreciseEvidenceReuse, type CurrentPreciseReuseCursor } from "../src/progressive-current-evidence-reuse";
import { reconcileAcceptedProgressiveCfdEvidence } from "../src/progressive-cfd-reuse";
import { archiveReportFixture } from "../test-support/progressive-report-archive-fixture";
import { installProgressiveReportArchiveReader } from "../src/progressive-report-reader";
import { withPreparedProgressiveRemoteRetention, readProgressiveRemoteRetention } from "../src/progressive-remote-retention";
import { claimProgressiveCfdUnit } from "../src/progressive-cfd";
import { acknowledgeProgressiveCfdExecutionStop } from "../src/progressive-cfd-settlement";
import { sealProgressiveRemoteExecution, type ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { simJobs, syncSweepPromises } from "../src/schema";

async function rollback(db: DB, label: string, run: (connection: DB) => Promise<void>) {
  const sentinel = new Error(label);
  try {
    await db.transaction(async (transaction) => { await run(transaction as unknown as DB); throw sentinel; });
  } catch (error) { if (error !== sentinel) throw error; return; }
  throw new Error(`Rollback not reached: ${label}`);
}

async function shadow(db: DB, table: string) {
  await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} ON COMMIT DROP AS SELECT * FROM public.${sql.identifier(table)}`);
}

// Observe the actual integration statements; no query or lock is mocked. This
// complements the existing epoch-reset concurrency regression in the campaign
// suite while this fixture's source rows remain inside their rollback scope.
function observeLockOrder(db: DB, order: string[]): DB {
  return new Proxy(db, { get(target, property) {
    if (property === "execute") return (query: Parameters<DB["execute"]>[0]) => {
      const compiled = typeof query === "string" ? { sql: query, params: [] } : new PgDialect().sqlToQuery(query.getSQL());
      const statement = compiled.sql.replace(/\s+/g, " ").toLowerCase();
      if (statement.includes("from calculation_epochs where current for share")) order.push("epoch");
      if (statement.includes("pg_try_advisory_xact_lock") && statement.includes("progressive-cfd-admission")) order.push("admission");
      if (statement.includes("from sim_campaigns") && statement.includes("for update")) order.push("campaign");
      if (statement.includes("for update of generation,work,unit,source")) order.push("unit");
      if (statement.includes("from sim_jobs") && statement.includes("for update")) order.push("job");
      if (compiled.params.some((param) => typeof param === "string" && param.startsWith("precalc-cell:"))) order.push("cell reservation");
      if (compiled.params.some((param) => typeof param === "string" && param.startsWith("result-evidence:"))) order.push("evidence");
      if (compiled.params.some((param) => typeof param === "string" && param.startsWith("result-review-verdict:"))) order.push("review");
      if (compiled.params.some((param) => typeof param === "string" && param.startsWith("polar-compatibility:"))) order.push("compatibility");
      if (compiled.params.some((param) => typeof param === "string" && param.startsWith("polar-revision:"))) order.push("revision");
      if (statement.includes("for update of cell for share of classification")) order.push("canonical");
      return target.execute(query);
    };
    if (property === "transaction") return (run: (transaction: DB) => Promise<unknown>, config?: Parameters<DB["transaction"]>[1]) =>
      target.transaction((transaction) => run(observeLockOrder(transaction as unknown as DB, order)), config);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// A real validated cancellation envelope/receipt, with no engine submission or
// raw result, models the two never-started successors in the production history.
async function stoppedSuccessor(db: DB, original: ProgressiveRemoteExecutionEnvelope, neverStarted = true) {
  const [parent] = await db.select().from(simJobs).where(eq(simJobs.id, original.scope.executionId));
  const jobId = randomUUID();
  const promiseId = randomUUID();
  const units = original.scope.units.map((unit) => ({ ...unit, token: randomUUID() }));
  const scope = { ...original.scope, executionId: jobId, units, tokens: units.map((unit) => unit.token) };
  const request = { ...structuredClone(original.request), execution_id: jobId };
  const envelope = sealProgressiveRemoteExecution({ solverId: original.solverId, promiseId, scope, request });
  await db.insert(simJobs).values({ ...parent, id: jobId, engineJobId: jobId, status: "cancelled", engineState: "cancelled",
    completedCases: 0, ingestedAt: new Date(), finishedAt: new Date(), ingestLeaseToken: null, ingestLeaseExpiresAt: null,
    requestPayload: { ...(parent.requestPayload as object), progressive: scope, engineRequest: request } });
  await db.insert(syncSweepPromises).values({ id: promiseId, registeredSolverId: original.solverId,
    airfoilId: parent.airfoilId, simulationPresetRevisionId: parent.simulationPresetRevisionId!, aoaCount: units.length,
    expiresAt: new Date(), status: "cancelled", requestPayload: { solverId: original.solverId, executionContract: "progressive-cfd-v1" } });
  await db.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
    SELECT ${jobId}::uuid,${promiseId}::uuid,solver_id,cpu_slots,${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb
    FROM progressive_remote_dispatches WHERE sim_job_id=${original.scope.executionId}::uuid`);
  for (const unit of units) await db.execute(sql`INSERT INTO progressive_cfd_attempts
    (token,unit_id,sim_job_id,owner,execution_recipe_id,outcome,started_at,finished_at,lease_until,active_seconds)
    VALUES(${unit.token}::uuid,${unit.unitId}::uuid,${jobId}::uuid,'authenticated stopped successor',${scope.recipeId},
      'cancelled',clock_timestamp(),clock_timestamp(),clock_timestamp(),0)`);
  const report: ProgressiveRemoteReport = { version: 1, solverId: original.solverId, promiseId, executionId: jobId,
    assignmentSignature: envelope.contentSignature, sequence: 1,
    status: { job_id: jobId, state: "cancelled", total_cases: units.length, completed_cases: 0 }, result: null,
    stopProof: { version: 1, job_id: jobId, execution_stopped: true, producer_stopped: true, namespace_verified: true,
      remaining: [], observed_at: new Date().toISOString(), error: null, fence: "cancel_marker", ownership_basis: neverStarted ? "never_started_cancellation_fence" : "recorded_execution_namespace" } };
  await storeProgressiveRemoteReport(db, { executionId: jobId, solverId: original.solverId, promiseId, report });
  await acknowledgeProgressiveCfdExecutionStop(db, { simJobId: jobId, proof: report.stopProof! });
  return { jobId, promiseId, token: units[0].token };
}

/** Called only after the original normal-publication/unit-unchanged/API assertions. */
export async function verifyCurrentPreciseEvidenceReuse(
  db: DB, envelope: ProgressiveRemoteExecutionEnvelope, acceptedAttemptId: string,
) {
  const unitId = envelope.scope.units[0].unitId;
  const [source] = await db.execute(sql`SELECT raw.result_id,evidence.evidence_signature,job.campaign_id
    FROM result_attempts raw JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id=raw.id
    JOIN sim_jobs job ON job.id=raw.sim_job_id WHERE raw.id=${acceptedAttemptId}::uuid`);
  const input = { campaignId: String(source.campaign_id), unitIds: [unitId] };
  let legitimateCompletions = 0;
  for (const scenario of ["latest cancelled", "two never-started successors"] as const) {
    await rollback(db, `Current precise reuse: ${scenario}`, async (connection) => {
      const successors: Array<Awaited<ReturnType<typeof stoppedSuccessor>>> = [];
      if (scenario === "two never-started successors") {
        successors.push(await stoppedSuccessor(connection, envelope));
        successors.push(await stoppedSuccessor(connection, envelope));
        await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',attempts=attempts+2 WHERE id=${unitId}::uuid`);
      }
      const preserve = async (scoped: DB) => {
        const [unit] = await scoped.execute(sql`SELECT to_jsonb(unit)-'state'-'error' AS budget FROM progressive_cfd_units unit WHERE id=${unitId}::uuid`);
        const history = await scoped.execute(sql`SELECT to_jsonb(attempt) AS history FROM progressive_cfd_attempts attempt WHERE unit_id=${unitId}::uuid ORDER BY token`);
        const [jobs] = await scoped.execute(sql`SELECT count(*)::int AS count FROM sim_jobs WHERE campaign_id=${source.campaign_id}::uuid`);
        const evidence = await scoped.execute(sql`SELECT to_jsonb(raw) AS raw,to_jsonb(receipt) AS receipt,to_jsonb(cell) AS canonical
          FROM result_attempts raw JOIN progressive_cfd_evidence receipt ON receipt.result_attempt_id=raw.id
          JOIN results cell ON cell.id=raw.result_id WHERE raw.sim_job_id=${envelope.scope.executionId}::uuid ORDER BY raw.id`);
        const proofs = await scoped.execute(sql`SELECT to_jsonb(receipt) AS receipt FROM progressive_remote_evidence_receipts receipt
          WHERE sim_job_id=${envelope.scope.executionId}::uuid ORDER BY point_content_signature`);
        return { budget: unit.budget, history, jobs: jobs.count, evidence, proofs };
      };
      const initial = await preserve(connection);
      const guards: Array<[string, (target: DB) => Promise<unknown>]> = [
        ["obsolete epoch", (target) => target.execute(sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`)],
        ["obsolete plan", (target) => target.execute(sql`UPDATE sim_campaigns SET current_plan_revision_id=NULL WHERE id=${source.campaign_id}::uuid`)],
        ["changed canonical pointer", (target) => target.execute(sql`UPDATE results SET current_result_attempt_id=NULL WHERE id=${source.result_id}::uuid`)],
        ["live result owner", (target) => target.execute(sql`UPDATE sim_jobs SET status='running' WHERE id=${envelope.scope.executionId}::uuid`)],
        ["live ingest lease", (target) => target.execute(sql`UPDATE sim_jobs SET ingest_lease_token=${randomUUID()},ingest_lease_expires_at=clock_timestamp()+interval '1 hour'
          WHERE id=${envelope.scope.executionId}::uuid`)],
        ["active promise", (target) => target.execute(sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${envelope.promiseId}::uuid`)],
        ["revoked sender", (target) => target.execute(sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${envelope.solverId}::uuid`)],
        ["rejected source", (target) => target.execute(sql`UPDATE result_classifications SET state='rejected' WHERE result_attempt_id=${acceptedAttemptId}::uuid`)],
        ["review exclusion", (target) => target.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
          VALUES(${source.result_id}::uuid,'exclude','current reuse refusal fixture')`)],
        ["review deferral", (target) => target.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
          VALUES(${source.result_id}::uuid,'defer','current reuse refusal fixture')`)],
        ["live unit", (target) => target.execute(sql`UPDATE progressive_cfd_units SET state='leased',lease_token=${randomUUID()}::uuid,
          lease_owner='competing owner',lease_until=clock_timestamp()+interval '1 hour' WHERE id=${unitId}::uuid`)],
        ["changed recipe", async (target) => { await shadow(target, "progressive_cfd_units"); return target.execute(sql`UPDATE progressive_cfd_units
          SET recipe=recipe||'{"differentNumerics":true}'::jsonb WHERE id=${unitId}::uuid`); }],
        ["foreign geometry", async (target) => { await shadow(target, "polar_analysis_targets"); return target.execute(sql`UPDATE polar_analysis_targets
          SET physical=jsonb_set(physical,'{geometry}','[[0,0],[1,1],[0,2]]'::jsonb) WHERE id=${envelope.scope.targetId}`); }],
        ["missing archive", async (target) => { await shadow(target, "solver_evidence_archives"); return target.execute(sql`DELETE FROM solver_evidence_archives WHERE result_attempt_id=${acceptedAttemptId}::uuid`); }],
        ["missing manifest", async (target) => { await shadow(target, "solver_evidence_artifacts"); return target.execute(sql`DELETE FROM solver_evidence_artifacts WHERE result_attempt_id=${acceptedAttemptId}::uuid AND kind='manifest'`); }],
        ["changed report", async (target) => { await shadow(target, "progressive_remote_reports"); return target.execute(sql`UPDATE progressive_remote_reports
          SET content_signature=${"0".repeat(64)} WHERE sim_job_id=${envelope.scope.executionId}::uuid`); }],
        ["changed raw coefficients", async (target) => { await shadow(target, "result_attempts"); return target.execute(sql`UPDATE result_attempts SET cl=cl+1 WHERE id=${acceptedAttemptId}::uuid`); }],
        ["changed evidence hash", async (target) => { await shadow(target, "progressive_cfd_evidence"); return target.execute(sql`UPDATE progressive_cfd_evidence
          SET evidence_signature=${"0".repeat(64)} WHERE result_attempt_id=${acceptedAttemptId}::uuid`); }],
        ["preliminary source", async (target) => { await shadow(target, "result_attempts"); return target.execute(sql`UPDATE result_attempts
          SET evidence_payload=jsonb_set(evidence_payload,'{fidelity}','"urans_precalc"'::jsonb) WHERE id=${acceptedAttemptId}::uuid`); }],
        ["missing physical stop", async (target) => { await shadow(target, "progressive_cfd_execution_stops"); return target.execute(sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${envelope.scope.executionId}::uuid`); }],
        ["recovery obligation", async (target) => { await shadow(target, "progressive_cfd_recovery_plans"); return target.execute(sql`INSERT INTO progressive_cfd_recovery_plans(unit_id) VALUES(${unitId}::uuid)`); }],
        ["conflicting reuse", (target) => target.execute(sql`INSERT INTO progressive_cfd_evidence_reuses
          (successor_unit_id,source_attempt_token,source_result_attempt_id,source_evidence_signature,source_generation_id,source_execution_recipe_id)
          VALUES(${unitId}::uuid,${envelope.scope.units[0].token}::uuid,${acceptedAttemptId}::uuid,${"0".repeat(64)},
            ${envelope.scope.generationId}::uuid,${envelope.scope.recipeId})`)],
      ];
      if (successors.length) {
        guards.push(["later real work", (target) => target.execute(sql`UPDATE progressive_cfd_attempts SET active_seconds=1 WHERE token=${successors[0].token}::uuid`)]);
        guards.push(["unfenced successor", async (target) => { await shadow(target, "progressive_cfd_execution_stops"); return target.execute(sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${successors[0].jobId}::uuid`); }]);
        guards.push(["tampered successor cancellation", async (target) => { await shadow(target, "progressive_remote_reports"); return target.execute(sql`UPDATE progressive_remote_reports SET content_signature=${"0".repeat(64)} WHERE sim_job_id=${successors[0].jobId}::uuid`); }]);
      }
      for (const [label, mutate] of guards) await rollback(connection, `${scenario}: ${label}`, async (target) => {
        await mutate(target);
        const before = await preserve(target);
        const links = await target.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${unitId}::uuid`);
        try {
          const outcome = await reconcileCurrentPreciseEvidenceReuse(target, input);
          expect(outcome.reusedUnitIds, label).toEqual([]);
          expect(outcome.replayedUnitIds, label).toEqual([]);
          expect(outcome.refused, label).toHaveLength(1);
        } catch (error) {
          // Authentication failures remain hard errors. Never swallow an
          // assertion or SQL/setup failure as an acceptable refusal.
          expect(error, label).toBeInstanceOf(Error);
          expect((error as Error).message, label).toMatch(/report|source|evidence|physical|signature|manifest|custody/i);
          if ((error as { code?: unknown }).code || (error as Error).name === "AssertionError") throw error;
        }
        expect(analysisContentHash(await preserve(target)), label).toBe(analysisContentHash(before));
        expect(await target.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${unitId}::uuid`), label).toEqual(links);
        expect(await target.execute(sql`SELECT state FROM progressive_cfd_units WHERE id=${unitId}::uuid`), label)
          .not.toEqual([{ state: "complete" }]);
      });

      if (scenario === "latest cancelled") for (const cheapRefusal of [false, true])
        await rollback(connection, `Maintenance must pass a refused prefix (${cheapRefusal})`, async (target) => {
          const [blocked] = await target.execute(sql`SELECT raw.id,raw.result_id,attempt.unit_id FROM result_attempts raw
            JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id=raw.id
            JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
            WHERE raw.sim_job_id=${envelope.scope.executionId}::uuid AND attempt.unit_id=${envelope.scope.units[1].unitId}::uuid`);
          expect(blocked).toBeTruthy();
          // Corrupt only the isolated read model for the rejected sibling. Its
          // authentic failed report/payload still makes the deep proof refuse.
          for (const table of ["result_attempts", "results", "result_classifications"]) await shadow(target, table);
          await target.execute(sql`UPDATE result_attempts SET status='done',source='solved',valid_for_polar=true,cl=0.4,cd=0.03,cm=0
            WHERE id=${blocked.id}::uuid`);
          await target.execute(sql`UPDATE results SET status='done',sim_job_id=${envelope.scope.executionId}::uuid,
            current_result_attempt_id=${blocked.id}::uuid WHERE id=${blocked.result_id}::uuid`);
          await target.execute(sql`UPDATE result_classifications SET state='accepted' WHERE result_attempt_id=${blocked.id}::uuid`);
          if (cheapRefusal) {
            await shadow(target, "progressive_cfd_recovery_plans");
            await target.execute(sql`INSERT INTO progressive_cfd_recovery_plans(unit_id) VALUES(${blocked.unit_id}::uuid)`);
          }
          const cursor: CurrentPreciseReuseCursor = !cheapRefusal && String(blocked.unit_id) > unitId
            ? { after: { unitId, resultAttemptId: acceptedAttemptId } } : {};
          const scan = { campaignId: input.campaignId, cursor, limit: 1 };
          const first = await reconcileCurrentPreciseEvidenceReuse(target, scan);
          if (cheapRefusal) expect(first.reusedUnitIds).toEqual([unitId]);
          else {
            expect(first.reusedUnitIds).toEqual([]);
            expect(first.refused).toEqual([{ unitId: blocked.unit_id, reason: "source is not an archived final physical point" }]);
            const reused: string[] = [];
            for (let pass = 0; pass < 3 && !reused.length; pass++)
              reused.push(...(await reconcileCurrentPreciseEvidenceReuse(target, scan)).reusedUnitIds);
            expect(reused, "unchanged refused head must not pin maintenance's bounded scan").toEqual([unitId]);
          }
          expect(await target.execute(sql`SELECT successor_unit_id FROM progressive_cfd_evidence_reuses
            WHERE successor_unit_id=${blocked.unit_id}::uuid`)).toEqual([]);
        });

      const order: string[] = [];
      const credited = await reconcileCurrentPreciseEvidenceReuse(observeLockOrder(connection, order), input);
      expect(credited, scenario).toEqual({ reusedUnitIds: [unitId], replayedUnitIds: [], refused: [] });
      expect(order, "epoch must precede admission; classification/revision rows must not precede cache locks")
        .toEqual(["epoch", "admission", "campaign", "unit", "job", "cell reservation", "compatibility", "revision", "evidence", "review", "canonical"]);
      legitimateCompletions += credited.reusedUnitIds.length;
      expect(await connection.execute(sql`SELECT state FROM progressive_cfd_units WHERE id=${unitId}::uuid`)).toEqual([{ state: "complete" }]);
      const [link] = await connection.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${unitId}::uuid`);
      expect(link).toMatchObject({ source_attempt_token: envelope.scope.units[0].token, source_result_attempt_id: acceptedAttemptId,
        source_evidence_signature: source.evidence_signature, source_generation_id: envelope.scope.generationId,
        source_execution_recipe_id: envelope.scope.recipeId });
      expect(await preserve(connection)).toEqual(initial);
      expect(await reconcileCurrentPreciseEvidenceReuse(connection, input)).toEqual({ reusedUnitIds: [], replayedUnitIds: [unitId], refused: [] });
      expect(await connection.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${unitId}::uuid`)).toEqual([link]);
      expect(await reconcileAcceptedProgressiveCfdEvidence(connection, input.campaignId)).toBe(0);
      expect(await preserve(connection)).toEqual(initial);
      await rollback(connection, "Next claim cannot repeat reused work", async (target) => {
        const [unit] = await target.execute(sql`SELECT recipe,active_budget_seconds-active_seconds AS remaining FROM progressive_cfd_units WHERE id=${unitId}::uuid`);
        const lease = await claimProgressiveCfdUnit(target, { owner: "reuse next claim fixture", leaseSeconds: 120,
          solverBudgetVersion: 2, localTimeStepVersion: 1, allowPhysicalTime: true,
          sameTarget: { generationId: envelope.scope.generationId, targetId: envelope.scope.targetId,
            recipe: unit.recipe as Record<string, unknown>, remainingActiveSeconds: Number(unit.remaining), recoveryParentJobId: null } });
        expect(lease?.id).not.toBe(unitId);
      });
      expect(await preserve(connection)).toEqual(initial);
    });
  }
  expect(legitimateCompletions).toBe(2);
}

// This fixture starts after normal publication and cache refresh. Five final
// points have archives and canonical pointers; two other physical sources are
// missing and the eighth angle is diagnostic-only.
export async function verifySelectedIncompleteUnitReuse(
  db: DB, envelope: ProgressiveRemoteExecutionEnvelope, rawIds: string[], eligibleOriginalRequest: boolean,
) {
  const job = envelope.scope.executionId;
  const units = envelope.scope.units.slice(0, 5);
  const ids = units.map(unit => unit.unitId);
  const missing = envelope.scope.units.slice(5).map(unit => unit.unitId);
  const [parent] = await db.execute(sql`SELECT campaign_id FROM sim_jobs WHERE id=${job}::uuid`);
  const exact = { campaignId: String(parent.campaign_id), unitIds: ids };
  const states = (c: DB) => c.execute(sql`SELECT u.id,u.state,reuse.source_result_attempt_id AS credited
    FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id
    LEFT JOIN progressive_cfd_evidence_reuses reuse ON reuse.successor_unit_id=u.id
    WHERE a.sim_job_id=${job}::uuid ORDER BY u.aoa_deg`);
  const immutable = async (c: DB) => analysisContentHash(await c.execute(sql`SELECT
    to_jsonb(a) AS original,to_jsonb(u)-'state'-'error' AS unit_budget,to_jsonb(e) AS receipt,to_jsonb(raw) AS raw,
    to_jsonb(cell) AS canonical,to_jsonb(proof) AS stop,to_jsonb(j) AS job,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM polar_fit_sets f WHERE f.is_current
      AND f.airfoil_id=j.airfoil_id AND f.simulation_preset_revision_id=j.simulation_preset_revision_id) AS fit,
    (SELECT count(*) FROM sim_jobs j2 WHERE j2.campaign_id=j.campaign_id) AS jobs,
    (SELECT count(*) FROM progressive_cfd_attempts h WHERE h.unit_id=u.id) AS attempts
    FROM sim_jobs j JOIN progressive_cfd_execution_stops proof ON proof.sim_job_id=j.id
    JOIN progressive_cfd_attempts a ON a.sim_job_id=j.id JOIN progressive_cfd_units u ON u.id=a.unit_id
    LEFT JOIN progressive_cfd_evidence e ON e.attempt_token=a.token LEFT JOIN result_attempts raw ON raw.id=e.result_attempt_id
    LEFT JOIN results cell ON cell.id=raw.result_id WHERE j.id=${job}::uuid ORDER BY a.token,raw.id`));
  expect(await states(db)).toEqual(envelope.scope.units.map(u => ({id:u.unitId,state:"pending",credited:null})));
  const before = await immutable(db);
  if (!eligibleOriginalRequest) {
    // A signed transient execution can carry a RANS-labelled point. The
    // canonical record alone cannot establish original steady-solve authority.
    const outcome = await reconcileCurrentPreciseEvidenceReuse(db, exact);
    expect(outcome.reusedUnitIds).toEqual([]);
    expect(outcome.refused).toHaveLength(5);
    expect(await immutable(db)).toBe(before);
    return;
  }

  await rollback(db, "withdraw selected points after discovery", async c => {
    let discovered = false;
    const input = new Proxy(c, { get(target, prop) {
      if (prop === "execute") return async (query: Parameters<DB["execute"]>[0]) => {
        const rows = await target.execute(query);
        if (!discovered) {
          // This is the actual exact-ID discovery SELECT. Change authority
          // after its snapshot; the per-unit locked recheck decides each row.
          expect(rows.map(r => String(r.unit_id)).sort()).toEqual([...ids].sort());
          discovered = true;
          await c.execute(sql`UPDATE results SET current_result_attempt_id=NULL WHERE current_result_attempt_id=${rawIds[0]}::uuid`);
          await c.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
            SELECT result_id,'defer','selected-point-withdrawal' FROM result_attempts WHERE id=${rawIds[1]}::uuid`);
          const promise = randomUUID();
          await c.execute(sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,airfoil_id,simulation_preset_revision_id,aoa_count,"expiresAt")
            SELECT ${promise}::uuid,${envelope.solverId}::uuid,airfoil_id,simulation_preset_revision_id,1,clock_timestamp()+interval '1 hour'
            FROM result_attempts WHERE id=${rawIds[2]}::uuid`);
          await c.execute(sql`INSERT INTO sync_sweep_promise_points(promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg)
            SELECT ${promise}::uuid,airfoil_id,simulation_preset_revision_id,aoa_deg FROM result_attempts WHERE id=${rawIds[2]}::uuid`);
        }
        return rows;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const outcome = await reconcileCurrentPreciseEvidenceReuse(input, exact);
    expect(discovered).toBe(true);
    expect(outcome.reusedUnitIds.sort()).toEqual(ids.slice(3).sort());
    expect(outcome.refused.map(row => row.unitId).sort()).toEqual(ids.slice(0,3).sort());
    expect((await states(c)).filter(row => row.credited).map(row => row.id)).toEqual(ids.slice(3));
  });
  await rollback(db, "later physically stopped execution still owns the unit", async c => {
    await stoppedSuccessor(c, envelope, false);
    const outcome = await reconcileCurrentPreciseEvidenceReuse(c, exact);
    expect(outcome.reusedUnitIds).toEqual([]);
    expect(outcome.refused).toHaveLength(ids.length);
    expect((await states(c)).every(r => !r.credited)).toBe(true);
  });
  await rollback(db, "storage-only source is never unit credit", async c => {
    await shadow(c,"progressive_remote_evidence_receipts");
    await c.execute(sql`UPDATE progressive_remote_evidence_receipts SET storage_only=true WHERE result_attempt_id=${rawIds[0]}::uuid`);
    const outcome = await reconcileCurrentPreciseEvidenceReuse(c,{...exact,unitIds:[ids[0]]});
    expect(outcome.reusedUnitIds).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
  });

  // Verify the compact final report against its original archive member before
  // crediting selected evidence under the unit and canonical locks.
  await shadow(db, "progressive_remote_reports");
  const anchor = await archiveReportFixture(db, "remote", job, 1);
  const final = await archiveReportFixture(db, "remote", job, 2);
  const inlineAttempts = { read: async () => { throw new Error("Raw fixture attempts are inline"); } };
  let reads = 0;
  installProgressiveReportArchiveReader({ read: async ({sequence}) => {
    reads++;
    if (sequence === 1) return anchor.text;
    if (sequence === 2) return final.text;
    throw new Error("Unexpected report sequence");
  } });
  try {
    await rollback(db, "one withheld archive source does not block its siblings", async c => {
      await shadow(c, "progressive_remote_evidence_receipts");
      await c.execute(sql`UPDATE progressive_remote_evidence_receipts SET point_content_signature=${"0".repeat(64)}
        WHERE result_attempt_id=${rawIds[0]}::uuid`);
      const outcome = await withPreparedProgressiveRemoteRetention(c, job, inlineAttempts,
        () => reconcileCurrentPreciseEvidenceReuse(c, exact), rawIds);
      expect(outcome.reusedUnitIds.sort()).toEqual(ids.slice(1).sort());
      expect(outcome.refused.map(row => row.unitId)).toEqual([ids[0]]);
    });
    await withPreparedProgressiveRemoteRetention(db, job, inlineAttempts, async () => {
      const preparedReads = reads;
      expect(preparedReads).toBeGreaterThan(0);
      expect(await reconcileAcceptedProgressiveCfdEvidence(db, exact.campaignId)).toBe(5);
      const links = await db.execute(sql`SELECT reuse.* FROM progressive_cfd_evidence_reuses reuse JOIN progressive_cfd_units u ON u.id=reuse.successor_unit_id
        WHERE u.work_id=(SELECT work_id FROM progressive_cfd_units WHERE id=${ids[0]}::uuid) ORDER BY u.aoa_deg`);
      expect(links).toHaveLength(5);
      for (const [i,link] of links.entries()) {
        const [receipt] = await db.execute(sql`SELECT evidence_signature FROM progressive_cfd_evidence WHERE result_attempt_id=${rawIds[i]}::uuid`);
        expect(link).toMatchObject({successor_unit_id:ids[i],source_attempt_token:units[i].token,source_result_attempt_id:rawIds[i],
          source_evidence_signature:receipt.evidence_signature,source_generation_id:envelope.scope.generationId,source_execution_recipe_id:envelope.scope.recipeId});
      }
      const replay = await reconcileCurrentPreciseEvidenceReuse(db,{...exact,unitIds:[...ids,...missing]});
      expect(replay.reusedUnitIds).toEqual([]);
      expect(replay.replayedUnitIds.sort()).toEqual([...ids].sort());
      expect(replay.refused.map(r => r.unitId).sort()).toEqual([...missing].sort());
      expect(await reconcileAcceptedProgressiveCfdEvidence(db,exact.campaignId)).toBe(0);
      expect(await states(db)).toEqual(envelope.scope.units.map((u,i) => ({id:u.unitId,state:i<5?"complete":"pending",credited:rawIds[i]??null})));
      await expect(readProgressiveRemoteRetention(db,job)).rejects.toThrow("whole-job retention");
      await rollback(db, "withdrawal after credit refuses replay without rewriting its receipt", async c => {
        await c.execute(sql`UPDATE results SET current_result_attempt_id=NULL WHERE current_result_attempt_id=${rawIds[0]}::uuid`);
        const withdrawn = await reconcileCurrentPreciseEvidenceReuse(c, { ...exact, unitIds: [ids[0]] });
        expect(withdrawn.replayedUnitIds).toEqual([]);
        expect(withdrawn.reusedUnitIds).toEqual([]);
        expect(withdrawn.refused).toHaveLength(1);
        expect(await c.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${ids[0]}::uuid`)).toEqual([links[0]]);
      });
      expect(await db.execute(sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${job}::uuid`)).toEqual([{status:"cancelled",ingestedAt:null}]);
      expect(await immutable(db)).toBe(before);
      expect(reads).toBe(preparedReads);
    }, rawIds);
    const entire = await withPreparedProgressiveRemoteRetention(db, job, inlineAttempts, () => readProgressiveRemoteRetention(db, job));
    expect(entire).toMatchObject({kind:"waiting",reason:"raw_evidence",pendingCount:2});
  } finally {installProgressiveReportArchiveReader(null);}

  // Drive the ordinary claimant. Only the three still-unresolved siblings can
  // be issued, and the rollback leaves their original attempt histories intact.
  await rollback(db,"do not re-execute completed selected angles",async c => {
    const [unit] = await c.execute(sql`SELECT recipe,active_budget_seconds-active_seconds AS remaining FROM progressive_cfd_units WHERE id=${ids[0]}::uuid`);
    const offered: string[] = [];
    for (let n=0;n<=envelope.scope.units.length;n++) {
      const lease=await claimProgressiveCfdUnit(c,{owner:"selected-precise-reuse",leaseSeconds:120,solverBudgetVersion:2,
        localTimeStepVersion:1,sameTarget:{generationId:envelope.scope.generationId,targetId:envelope.scope.targetId,
          recipe:unit.recipe as Record<string,unknown>,remainingActiveSeconds:Number(unit.remaining),recoveryParentJobId:null}});
      if(!lease) break;
      offered.push(lease.id);
    }
    expect(offered.sort()).toEqual([...missing].sort());
  });
  expect(await immutable(db)).toBe(before);
}
