import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { DB } from "../src/client";
import type { EngineClient, PolarRequest } from "../../engine-client/src";
import { analysisContentHash } from "../src/analysis-target";
import { readProgressiveRemoteAssignment } from "../src/progressive-remote-delivery";
import { initializeProgressiveCfdWork } from "../src/progressive-cfd";
import {
  initializeProgressiveGenerationCohorts,
  SUBSONIC_THROUGH_PRECISE_POLICY,
} from "../src/progressive-execution-policy";
import {
  sealProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "../src/progressive-remote-execution";
import {
  validateProgressiveRemoteReport,
  progressiveReportedPointSources,
} from "../src/progressive-remote-report";
import { indexProgressiveRemoteReport } from "../src/progressive-remote-inventory";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import {
  admitRemoteSolverTick,
  receiveProgressiveCampaignAssignments,
  reconcileRemoteSolverTick,
} from "../../../apps/sweeper/src/remote-solver";
import { withRegisteredRoundDatabases } from "./registered-replacement-db-fixture";

export async function verifyRegisteredReplacementRound(
  source: DB,
  seed: ProgressiveRemoteExecutionEnvelope,
) {
  await withRegisteredRoundDatabases(
    source,
    async (hub, worker, base, requests) => {
      const { solverId } = seed,
        token = randomUUID() + randomUUID(),
        instance = randomUUID();
      const ds =
        await hub.sql`SELECT d.sim_job_id FROM progressive_remote_dispatches d JOIN sync_sweep_promises p ON p.id=d.promise_id
      WHERE d.solver_id=${solverId} AND p.status='active' ORDER BY date_trunc('milliseconds',d.created_at),d.sim_job_id`;
      // Both offers were prepared by the canonical fleet with actual leased
      // campaign units. The first listed cell will conflict on the worker only.
      expect(ds).toHaveLength(2);
      const documents = await Promise.all(
        ds.map((x) =>
          readProgressiveRemoteAssignment(hub.db, {
            solverId,
            executionId: x.sim_job_id,
          }),
        ),
      );
      const [replacement, other] = documents;
      if (!replacement || !other)
        throw Error("Two registered campaign assignments are required");
      // The same target can already have a precise grid when a leased FAST
      // group still belongs to its stage-2 cohort. Materialize the ordinary
      // precise recipe in the independent hub fixture.
      const scope = other.envelope.scope;
      expect(scope.stage).toBe(2);
      const [generation] =
        await hub.sql`SELECT campaign_id FROM progressive_generations WHERE id=${scope.generationId}`;
      await hub.sql`INSERT INTO campaign_progressive_execution_policies (campaign_id, policy)
        VALUES (${generation.campaign_id}, ${SUBSONIC_THROUGH_PRECISE_POLICY}) ON CONFLICT DO NOTHING`;
      await initializeProgressiveGenerationCohorts(hub.db, scope.generationId);
      const [member] =
        await hub.sql`SELECT cohort FROM progressive_generation_cohort_targets
        WHERE generation_id=${scope.generationId} AND target_id=${scope.targetId}`;
      expect(member.cohort).toBe("low");
      const setCohortStage = (
        stage: 2 | 3,
      ) => hub.sql`UPDATE progressive_generation_cohorts SET stage=${stage}
        WHERE generation_id=${scope.generationId} AND cohort=${member.cohort}`;
      await setCohortStage(3);
      await hub.sql`INSERT INTO progressive_work (generation_id,target_id,stage)
        VALUES (${scope.generationId},${scope.targetId},3) ON CONFLICT DO NOTHING`;
      await initializeProgressiveCfdWork(hub.db, generation.campaign_id);
      const preciseGrid =
        () => hub.sql`SELECT u.id,u.aoa_deg,u.recipe,u.active_budget_seconds,u.state
        FROM progressive_cfd_units u JOIN progressive_work w ON w.id=u.work_id
        WHERE w.generation_id=${scope.generationId} AND w.target_id=${scope.targetId} AND w.stage=3 ORDER BY u.ordinal`;
      const originalPrecise = await preciseGrid();
      expect(originalPrecise.length).toBeGreaterThan(0);
      await setCohortStage(2);
      const oldJob = randomUUID(),
        oldPromise = randomUUID();
      const oldUnits = replacement.envelope.scope.units.map((u) => ({
        ...u,
        token: randomUUID(),
      }));
      const prior = sealProgressiveRemoteExecution({
        solverId,
        promiseId: oldPromise,
        request: { ...replacement.envelope.request, execution_id: oldJob },
        scope: {
          ...replacement.envelope.scope,
          executionId: oldJob,
          units: oldUnits,
          tokens: oldUnits.map((u) => u.token),
        },
      });
      const expires = new Date(Date.now() + 3600_000).toISOString();
      const oldPoint = oldUnits[0]!;
      const runtime = {
        ...prior.request.expected_engine!,
        build_id: "registered-round-engine",
        application_source_sha256: analysisContentHash({ oldJob }),
      };
      const point = {
        aoa_deg: oldPoint.alpha,
        case_slug: "prior-case",
        cl: null,
        cd: null,
        cm: null,
        converged: false,
        unsteady: false,
        error: "retained infrastructure diagnostic",
        failure_disposition: "infrastructure",
        solver_active_seconds: 0,
        engine: runtime,
        execution_pool: prior.request.expected_execution_pool,
      };
      const proof = {
        version: 1,
        job_id: oldJob,
        execution_stopped: true,
        producer_stopped: true,
        namespace_verified: true,
        remaining: [],
        observed_at: new Date().toISOString(),
        error: null,
        fence: "cancel_marker",
        ownership_basis: "recorded_execution_namespace",
      };
      const { report, contentSignature } = validateProgressiveRemoteReport(
        {
          version: 1,
          solverId,
          promiseId: oldPromise,
          executionId: oldJob,
          assignmentSignature: prior.contentSignature,
          sequence: 1,
          status: {
            job_id: oldJob,
            state: "cancelled",
            total_cases: oldUnits.length,
            completed_cases: 1,
          },
          result: {
            job_id: oldJob,
            state: "cancelled",
            engine: runtime,
            execution_pool: prior.request.expected_execution_pool,
            polars: [
              {
                chord: prior.request.chord_lengths![0],
                speed: prior.request.speeds![0],
                reynolds: 123456,
                points: [],
                attempts: [point],
              },
            ],
          },
          stopProof: proof,
        },
        prior,
      );
      const reported = progressiveReportedPointSources(report.result!)[0]!;
      const sig = reported.contentSignature;
      const originalPayload = progressiveRemotePointProjection({
        ...reported,
        envelope: prior,
        report,
      }).evidencePayload;
      const hash = createHash("sha256").update(token).digest("hex");
      await hub.sql`UPDATE registered_remote_solvers SET instance_id=${instance},auth_token_hash=${hash},last_heartbeat_at=clock_timestamp(),revoked_at=NULL WHERE id=${solverId}`;
      await hub.sql`UPDATE sync_sweep_promises SET source_instance_id=${instance} WHERE registered_solver_id=${solverId}`;
      await hub.sql`UPDATE sync_api_settings SET enabled=true,remote_solver_enabled=false WHERE id=1`;
      await hub.sql`UPDATE sweeper_state SET enabled=true,admission_fence_active=false,disk_admission_blocked=false WHERE id=1`;
      await hub.sql`INSERT INTO sync_api_permissions(data_type,can_fetch,can_push) VALUES('sweeps',true,false),('polars',false,true)
      ON CONFLICT(data_type) DO UPDATE SET can_fetch=excluded.can_fetch,can_push=excluded.can_push`;
      await worker.sql`INSERT INTO sync_api_settings(id) VALUES(1) ON CONFLICT DO NOTHING`;
      await worker.sql`UPDATE sync_api_settings SET instance_id=${instance},enabled=true,remote_solver_enabled=true,remote_solver_transfer_paused=false,
      upstream_base_url=${base},remote_solver_registered_id=${solverId},remote_solver_auth_token=${token},remote_solver_cpu_budget=96,
      remote_solver_heartbeat_interval_seconds=10 WHERE id=1`;
      await worker.sql`UPDATE sweeper_state SET enabled=true,admission_fence_active=false,disk_admission_blocked=false,cpu_slots=96 WHERE id=1`;
      const future = [replacement.envelope.promiseId, other.envelope.promiseId];
      // Seed the previous generation chronologically through the real registered
      // intake, including its value-based worker-local revision and BC identities.
      await hub.sql`UPDATE sync_sweep_promise_points SET status='expired' WHERE promise_id IN ${hub.sql(future)}`;
      await hub.sql`UPDATE sync_sweep_promises SET status='expired' WHERE id IN ${hub.sql(future)}`;
      await hub.sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,airfoil_id,simulation_preset_revision_id,aoa_count,status,"expiresAt",request_payload)
      SELECT ${oldPromise},registered_solver_id,airfoil_id,simulation_preset_revision_id,aoa_count,'active',${expires},request_payload||jsonb_build_object('progressiveExecutionId',${oldJob}::text)
      FROM sync_sweep_promises WHERE id=${replacement.envelope.promiseId}`;
      await hub.sql`INSERT INTO sim_jobs(id,campaign_id,airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,status,engine_state,engine_job_id,request_payload)
      SELECT ${oldJob},campaign_id,airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,'pending',NULL,NULL,jsonb_build_object('progressive',${JSON.stringify(prior.scope)}::jsonb,'engineRequest',${JSON.stringify(prior.request)}::jsonb) FROM sim_jobs WHERE id=${replacement.envelope.scope.executionId}`;
      await hub.sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES(${oldJob},${oldPromise},${solverId},1,${prior.contentSignature},${JSON.stringify(prior)}::jsonb)`;
      await hub.sql`INSERT INTO sync_sweep_promise_points(promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg,status)
      SELECT ${oldPromise},airfoil_id,simulation_preset_revision_id,aoa_deg,'active' FROM sync_sweep_promise_points WHERE promise_id=${replacement.envelope.promiseId}`;
      const calls: PolarRequest[] = [];
      const engine = {
        submitPolar: async (req: PolarRequest) => {
          calls.push(req);
          return {
            job_id: req.execution_id,
            state: "pending",
            completed_cases: 0,
            total_cases: other.envelope.scope.units.length,
            engine: runtime,
          };
        },
      } as unknown as EngineClient;
      const oldIntake = await receiveProgressiveCampaignAssignments(
        worker.db,
        engine,
      );
      expect(oldIntake).toMatchObject({ mirrored: 1, errors: [] });
      await hub.sql`UPDATE sync_sweep_promise_points SET status='cancelled' WHERE promise_id=${oldPromise}`;
      await hub.sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${oldPromise}`;
      await hub.sql`UPDATE sim_jobs SET status='cancelled',engine_state='cancelled',engine_job_id=id::text WHERE id=${oldJob}`;
      await hub.sql`UPDATE sync_sweep_promises SET status='active' WHERE id IN ${hub.sql(future)}`;
      await hub.sql`UPDATE sync_sweep_promise_points SET status='active' WHERE promise_id IN ${hub.sql(future)}`;
      await worker.sql`UPDATE sim_jobs SET status='cancelled',engine_state='cancelled',engine_job_id=${oldJob},"finishedAt"=now() WHERE id=${oldJob}`;
      await worker.sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization") VALUES(${oldJob},gen_random_uuid(),${prior.contentSignature},
      jsonb_build_object('kind','authorized','executionId',${oldJob}::text,'contentSignature',${prior.contentSignature}::text))`;
      await worker.sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
      VALUES(${oldJob},1,${contentSignature},${JSON.stringify(report)}::jsonb,clock_timestamp())`;
      // An acknowledged report is independent of its outstanding attempt delivery.
      const [own] =
        await worker.sql`INSERT INTO results(airfoil_id,bc_id,simulation_preset_revision_id,aoa_deg,sim_job_id,engine_job_id,engine_case_slug,status,source,regime,converged)
      SELECT airfoil_id,(bc_ids->>0)::uuid,simulation_preset_revision_id,${point.aoa_deg},id,id::text,${point.case_slug},'failed','queued','rans',false FROM sim_jobs WHERE id=${oldJob} RETURNING id`;
      const [attempt] =
        await worker.sql`INSERT INTO result_attempts(result_id,airfoil_id,bc_id,simulation_preset_revision_id,aoa_deg,sim_job_id,engine_job_id,engine_case_slug,status,source,regime,converged,valid_for_polar,error,evidence_payload)
      SELECT id,airfoil_id,bc_id,simulation_preset_revision_id,aoa_deg,sim_job_id,engine_job_id,engine_case_slug,'failed','queued','rans',false,false,${point.error},${JSON.stringify(originalPayload)}::jsonb FROM results WHERE id=${own.id} RETURNING id`;
      await worker.sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature) VALUES(${oldJob},1,${contentSignature})`;
      await worker.sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature) VALUES(${oldJob},1,${attempt.id},${sig})`;
      const deliveryId = randomUUID(),
        claimToken = randomUUID();
      await worker.sql`INSERT INTO progressive_worker_evidence_delivery_claims(sim_job_id,sequence,result_attempt_id,point_content_signature,claim_token,claim_expires_at)
      VALUES(${oldJob},1,${attempt.id},${sig},${claimToken},clock_timestamp()+interval '10 minutes')`;
      await worker.sql`INSERT INTO sync_remote_result_deliveries(id,promise_id,sim_job_id,result_id,result_attempt_id,aoa_deg,generation_key,state,claim_token,claimed_at,claim_expires_at)
      VALUES(${deliveryId},${oldPromise},${oldJob},${own.id},${attempt.id},${oldPoint.alpha}, ${attempt.id},'pushing',${claimToken},clock_timestamp(),now()+interval '10 minutes')`;

      await hub.sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
      VALUES(${oldJob},1,${contentSignature},${JSON.stringify(report)}::jsonb)`;
      await indexProgressiveRemoteReport(hub.db, {
        report,
        reportContentSignature: contentSignature,
      });
      await hub.sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
      VALUES(${oldJob},${oldJob},${prior.scope.epochId},${JSON.stringify(proof)}::jsonb,${analysisContentHash(proof)},${proof.observed_at})`;
      const readOldAuthority = async () => {
        const reply = await fetch(base + "/progressive-executions/" + oldJob, {
          headers: { "x-xfoilfoam-solver-token": token },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        expect(reply.status).toBe(200);
        const body = (await reply.json()).assignment;
        expect(body).toMatchObject({
          envelope: { contentSignature: prior.contentSignature },
          promise: { id: oldPromise, status: "cancelled" },
          executionStopped: true,
          receivedSequence: 1,
          terminalReceipt: {
            reportSignature: contentSignature,
            stopProofSignature: analysisContentHash(proof),
          },
        });
        return body.terminalReceipt;
      };
      const canonicalOld = await readOldAuthority();
      const renewing = [randomUUID(), randomUUID()];
      for (const id of renewing) {
        await hub.sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,source_instance_id,airfoil_id,simulation_preset_revision_id,aoa_count,status,"expiresAt")
        SELECT ${id},registered_solver_id,${instance},airfoil_id,simulation_preset_revision_id,0,'active',clock_timestamp()+interval '2 minutes' FROM sync_sweep_promises WHERE id=${oldPromise}`;
        await worker.sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,airfoil_id,simulation_preset_revision_id,aoa_count,status,"expiresAt",source_base_url,request_payload)
        SELECT ${id},registered_solver_id,airfoil_id,simulation_preset_revision_id,0,'active',clock_timestamp()+interval '2 minutes',${base},'{"remoteSolver":true}'::jsonb FROM sync_sweep_promises WHERE id=${oldPromise}`;
      }
      const leased = () =>
        worker.sql`SELECT id,"expiresAt"::text AS expiry,"lastHeartbeatAt" beat FROM sync_sweep_promises WHERE id IN ${worker.sql(renewing)} ORDER BY id`;
      const oldSource =
        () => worker.sql`SELECT w.content_signature,resolve_progressive_report(w.report,w.result_payload_hash)::text AS source,s.point_content_signature,a.id,a.status,a.valid_for_polar,a.evidence_payload,
      held.claim_token AS point_claim,held.claim_expires_at AS point_claim_expires,
      d.id AS delivery,d.state,d.claim_token,d.claim_expires_at,p.status lease,pp.aoa_deg,pp.status AS point_lease
      FROM progressive_worker_reports w JOIN progressive_worker_evidence_attempts s USING(sim_job_id,sequence) JOIN result_attempts a ON a.id=s.result_attempt_id
      JOIN progressive_worker_evidence_delivery_claims held ON (held.sim_job_id,held.point_content_signature,held.result_attempt_id)=(s.sim_job_id,s.point_content_signature,a.id)
      JOIN sync_remote_result_deliveries d ON d.result_attempt_id=a.id JOIN sync_sweep_promises p ON p.id=d.promise_id JOIN sync_sweep_promise_points pp ON pp.promise_id=p.id
      WHERE w.sim_job_id=${oldJob} ORDER BY pp.aoa_deg`;
      const newSource =
        () => hub.sql`SELECT d.content_signature,d.envelope::text,j.status,j.engine_job_id,j.request_payload::text,p.status AS lease,pp.aoa_deg,pp.status AS point_lease,
      (SELECT jsonb_agg(jsonb_build_array(a.token,a.unit_id,a.outcome,u.lease_token,u.lease_until)ORDER BY a.token)
        FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id WHERE a.sim_job_id=d.sim_job_id) unit_owners,
      (SELECT count(*) FROM progressive_remote_reports observed WHERE observed.sim_job_id=d.sim_job_id) received_reports
      FROM progressive_remote_dispatches d JOIN sim_jobs j ON j.id=d.sim_job_id JOIN sync_sweep_promises p ON p.id=d.promise_id JOIN sync_sweep_promise_points pp ON pp.promise_id=p.id
      WHERE d.sim_job_id=${replacement.envelope.scope.executionId} ORDER BY pp.aoa_deg`;
      const [priorOwner, newOwner, priorLease] = await Promise.all([
        oldSource(),
        newSource(),
        leased(),
      ]);
      expect(priorOwner.length).toBeGreaterThan(0);
      expect(priorOwner[0]).toMatchObject({
        id: attempt.id,
        evidence_payload: originalPayload,
        state: "pushing",
        claim_token: claimToken,
        point_claim: claimToken,
        lease: "active",
      });
      expect(newOwner.length).toBeGreaterThan(0);
      expect(newOwner[0].unit_owners).toHaveLength(
        replacement.envelope.scope.units.length,
      );
      const env = { ...process.env };
      let release!: () => void, locked!: () => void;
      const onLock = new Promise<void>((r) => {
          locked = r;
        }),
        onRelease = new Promise<void>((r) => {
          release = r;
        });
      const holder = worker.sql.begin(async (tx) => {
        await tx`SELECT id FROM sync_sweep_promises WHERE id=${oldPromise} FOR UPDATE`;
        locked();
        await onRelease;
      });
      await onLock;
      try {
        vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
        vi.stubEnv("ENGINE_CONTROL_PLANE_TOKEN", token);
        vi.stubEnv("SWEEPER_REMOTE_MAX_ADMISSIONS_PER_TICK", "1");
        vi.stubEnv("SWEEPER_PROGRESSIVE_ASSIGNMENT_INTAKE_CONCURRENCY", "1");
        // Keep the old promise locked throughout the whole HZ round. A blocking
        // overlap lookup would prevent both the later intake and renewal phases.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const round = (async () => {
          const ready = await reconcileRemoteSolverTick(worker.db, engine);
          if (!ready) {
            const [settings] =
              await worker.sql`SELECT remote_solver_last_status status,remote_solver_last_error reason,remote_solver_cpu_budget cap FROM sync_api_settings WHERE id=1`;
            throw Error(
              "HZ reconcile refused unrelated admission: " +
                JSON.stringify({ settings, requests }).replaceAll(
                  token,
                  "[fixture credential]",
                ),
            );
          }
          const admitted = await admitRemoteSolverTick(worker.db, engine, {
            kind: "allow",
            meshRecoveryVersion:
              other.envelope.request.expected_mesh_recovery_version!,
          });
          if (!admitted) {
            const [settings] =
              await worker.sql`SELECT remote_solver_last_status status,remote_solver_last_error reason FROM sync_api_settings WHERE id=1`;
            throw Error(
              "Unrelated registered start was refused: " +
                JSON.stringify({ settings, requests }).replaceAll(
                  token,
                  "[fixture credential]",
                ),
            );
          }
        })();
        try {
          await Promise.race([
            round,
            new Promise<never>((_, rej) => {
              timeout = setTimeout(
                () =>
                  rej(
                    Error(
                      "The overlapping promise blocked the registered HZ round",
                    ),
                  ),
                14000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
          release();
          await Promise.allSettled([round, holder]);
        }
        expect(calls).toEqual([other.envelope.request]);
        const get = (id: string) =>
          requests.some(
            (q) =>
              q.method === "GET" &&
              q.path.endsWith("/progressive-executions/" + id) &&
              q.status === 200,
          );
        expect(get(replacement.envelope.scope.executionId)).toBe(true);
        expect(get(other.envelope.scope.executionId)).toBe(true);
        expect(
          requests
            .filter((q) => q.path.endsWith("/start"))
            .map((q) => [q.path, q.status]),
        ).toEqual([
          [
            "/api/sync/v1/progressive-executions/" +
              other.envelope.scope.executionId +
              "/start",
            200,
          ],
        ]);
        expect(await oldSource()).toEqual(priorOwner);
        expect(await newSource()).toEqual(newOwner);
        expect(await readOldAuthority()).toEqual(canonicalOld);
        const [authority] =
          await hub.sql`SELECT request_payload->'remoteStartAuthorization' AS proof FROM sim_jobs WHERE id=${other.envelope.scope.executionId}`;
        expect(authority.proof).toMatchObject({
          kind: "authorized",
          executionId: other.envelope.scope.executionId,
          contentSignature: other.envelope.contentSignature,
        });
        const [intent] =
          await worker.sql`SELECT i."authorization",i.assignment_signature,j.engine_job_id,p.status AS lease
        FROM progressive_worker_submission_intents i JOIN sim_jobs j ON j.id=i.sim_job_id JOIN sync_sweep_promises p ON p.id=${other.envelope.promiseId} WHERE i.sim_job_id=${other.envelope.scope.executionId}`;
        expect(intent).toMatchObject({
          authorization: authority.proof,
          assignment_signature: other.envelope.contentSignature,
          engine_job_id: other.envelope.scope.executionId,
          lease: "active",
        });
        expect(
          await worker.sql`SELECT id FROM sim_jobs WHERE id=${replacement.envelope.scope.executionId}`,
        ).toHaveLength(0);
        const renewed = await leased();
        expect(renewed).toHaveLength(2);
        for (const [i, item] of renewed.entries()) {
          expect(
            requests.some(
              (q) =>
                q.path.endsWith("/sweeps/" + item.id + "/heartbeat") &&
                q.status === 200,
            ),
          ).toBe(true);
          expect(Date.parse(item.expiry)).toBeGreaterThan(
            Date.parse(priorLease[i].expiry),
          );
          expect(item.beat).not.toBeNull();
          const [canonical] =
            await hub.sql`SELECT "expiresAt" expiry FROM sync_sweep_promises WHERE id=${item.id}`;
          expect(new Date(item.expiry).toISOString()).toBe(
            new Date(canonical.expiry).toISOString(),
          );
        }
        const retryPage = await receiveProgressiveCampaignAssignments(
          worker.db,
          engine,
        );
        expect(retryPage.errors).toContainEqual({
          executionId: replacement.envelope.scope.executionId,
          error:
            "previous progressive promise requires registered terminal reconciliation",
          deferred: "unreconciled_promise",
          conflictingPromiseId: oldPromise,
        });
        expect(retryPage.existing).toBeGreaterThanOrEqual(1);
        expect(await oldSource()).toEqual(priorOwner);
        const url = `${base}/progressive-executions/${scope.executionId}`;
        const headers = { "x-xfoilfoam-solver-token": token };
        const continuation = async () => {
          const response = await fetch(`${url}/control`, { headers });
          expect(response.status).toBe(200);
          return response.json();
        };
        expect(await continuation()).toMatchObject({
          continuation: { kind: "continue" },
        });
        await setCohortStage(3);
        expect(await continuation()).toMatchObject({
          continuation: {
            kind: "stop",
            reason: expect.stringContaining("stage"),
          },
        });
        const staleStart = await fetch(`${url}/start`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            contentSignature: other.envelope.contentSignature,
          }),
        });
        expect(staleStart.status).toBe(409);
        expect(await staleStart.json()).toMatchObject({
          decision: { kind: "stop", reason: expect.stringContaining("stage") },
        });
        const [retained] =
          await hub.sql`SELECT request_payload->'remoteStartAuthorization' AS proof
          FROM sim_jobs WHERE id=${scope.executionId}`;
        expect(retained.proof).toEqual(authority.proof);
        expect(await preciseGrid()).toEqual(originalPrecise);
        console.log(
          JSON.stringify({
            registeredReplacementRound: true,
            oldDeliveryPreserved: true,
            offered: 2,
            unrelatedStarts: calls.length,
            independentlyRenewed: renewed.length,
          }),
        );
      } finally {
        release();
        await holder;
        for (const name of [
          "AIRFOILFOAM_DEPLOYMENT_ROLE",
          "ENGINE_CONTROL_PLANE_TOKEN",
          "SWEEPER_REMOTE_MAX_ADMISSIONS_PER_TICK",
          "SWEEPER_PROGRESSIVE_ASSIGNMENT_INTAKE_CONCURRENCY",
        ])
          if (env[name] === undefined) delete process.env[name];
          else process.env[name] = env[name];
      }
    },
  );
}
