import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { deriveGeometry, parseCoordinates } from "@aerodb/core";
import {
  airfoils,
  boundaryProfiles,
  categories,
  createClient,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  progressiveCfdAttempts,
  progressiveCfdUnits,
  progressivePolarModelEvidence,
  publicProgressivePolars,
  simCampaigns,
  simJobs,
  solverExecutionPools,
  solverImplementations,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  EngineClient,
  engineIdentityKey,
  type EngineIdentity,
} from "@aerodb/engine-client";
import { and, eq, sql } from "drizzle-orm";
import {
  SEEDED_RUNTIME_PROFILE_SLUGS,
  seedRuntimeProfiles,
} from "../../../packages/db/seed/runtime-profiles";
import { assertSeedCoordinateIntegrity } from "../../../packages/db/seed/coordinate-integrity";
import { sourceAirModel } from "../../../packages/core/test/fixtures/source-air-model";
import {
  progressiveRefinementProof,
  progressiveUransHistoryProof,
} from "./progressive-refinement-proof";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const engineDeployment =
  process.env.PROGRESSIVE_LIVE_ENGINE_DEPLOYMENT ?? "progressive-test-engine";
assert(
  ["progressive-engine", "progressive-test-engine"].includes(engineDeployment),
  "Expected an explicitly owned local validation engine",
);
const requestedSpeedMps = Number(
  process.env.PROGRESSIVE_LIVE_SPEED_MPS ?? "30",
);
const requestedMomentumScheme =
  process.env.PROGRESSIVE_LIVE_MOMENTUM_SCHEME ?? "linearUpwind";
const requestedTargetYPlus =
  process.env.PROGRESSIVE_LIVE_TARGET_Y_PLUS === undefined
    ? null
    : Number(process.env.PROGRESSIVE_LIVE_TARGET_Y_PLUS);
assert(
  requestedTargetYPlus === null || requestedTargetYPlus === 40,
  "Only the explicit yPlus40 mesh comparison is supported",
);
const requireRansHold = process.env.PROGRESSIVE_REQUIRE_RANS_HOLD === "1";
const requireUransHistories =
  process.env.PROGRESSIVE_REQUIRE_URANS_HISTORIES === "1";
assert(
  !(requireRansHold && requireUransHistories),
  "Choose one explicit native evidence proof",
);
assert(
  ["linearUpwind", "upwind"].includes(requestedMomentumScheme),
  "Unsupported numerical comparison recipe",
);
assert(
  [30, 166, 1020].includes(requestedSpeedMps),
  "Use an explicit campaign speed supported by this verification",
);
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
assert(
  process.env.DEVCOORDINATOR_CHECK_SCRATCH &&
    process.env.PGPORT &&
    process.env.PGDATABASE,
  "Real solver verification requires a governed ephemeral PostgreSQL check",
);
assert(
  ["127.0.0.1", "localhost"].includes(databaseUrl.hostname) &&
    databaseUrl.port === process.env.PGPORT &&
    databaseUrl.pathname === `/${process.env.PGDATABASE}` &&
    !process.env.DC2_COMPONENT,
  "Refusing a database outside the governed ephemeral check",
);
const deployment = JSON.parse(
  execFileSync(
    "/usr/local/bin/devcoordinator2",
    [
      "deployment",
      "status",
      root,
      "--name",
      engineDeployment,
      "--client",
      "codex",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
  ),
);
assert(
  deployment.ok &&
    deployment.data.name === engineDeployment &&
    deployment.data.state === "running" &&
    deployment.data.public === false &&
    deployment.data.readiness.blockers.length === 0 &&
    deployment.data.readiness.missing_components.length === 0,
  "The isolated engine is not ready",
);
const components = deployment.data.components.filter(
  (entry: { name: string }) => entry.name === "engine",
);
assert(
  components.length === 1 &&
    components[0].owned &&
    components[0].state === "running" &&
    components[0].health === "healthy",
);
const port = components[0].port;
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const engineUrl = `http://127.0.0.1:${port}`;
const credentialFile = readFileSync(
  resolve(root, ".codex-artifacts/progressive-engine.env"),
  "utf8",
);
const controlPlaneToken = /^ENGINE_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
  credentialFile,
)?.[1];
assert(
  controlPlaneToken &&
    /^AIRFOILFOAM_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
      credentialFile,
    )?.[1] === controlPlaneToken,
  "Matching private engine credentials are required before starting the controller",
);
const healthResponse = await fetch(`${engineUrl}/health`, {
  signal: AbortSignal.timeout(10_000),
});
assert(healthResponse.ok);
const health = (await healthResponse.json()) as {
  build_id: string;
  default_engine: EngineIdentity;
  mesh_recovery_version: number;
  solver_budget_version: number;
  evidence_storage: { backend: string };
};
assert.equal(health.build_id, "progressive-local-validation");
assert.equal(health.solver_budget_version, 2);
assert.equal(health.evidence_storage.backend, "volume");
const engine = new EngineClient(engineUrl, {
  expectedEngine: health.default_engine,
  controlPlaneToken,
});
const expectedSolverSource = execFileSync(
  resolve(root, ".venv/bin/python"),
  [
    "-c",
    "from pathlib import Path; from airfoilfoam.provenance import application_source_sha256; print(application_source_sha256(Path.cwd()))",
  ],
  { cwd: root, encoding: "utf8", timeout: 10_000 },
).trim();
assert.match(expectedSolverSource, /^[a-f0-9]{64}$/);
const queue = await engine.getQueue({ timeoutMs: 15_000 });
assert(!queue.worker_queues_error && !queue.worker_runtime_error);
assert.equal(
  queue.worker_queues?.length,
  1,
  "Expected the isolated engine's single real worker",
);
const worker = queue.worker_queues![0];
assert(worker.engine && worker.execution_pool);
assert.equal(
  engineIdentityKey(worker.engine),
  engineIdentityKey(health.default_engine),
);
assert.equal(
  worker.engine.application_source_sha256,
  expectedSolverSource,
  "The running solver adapter differs from the tested source; rebuild the engine",
);
assert.equal(worker.engine.build_id, health.build_id);
assert.equal(
  queue.active_count,
  0,
  "Refusing to share an engine already executing another check",
);
assert.equal(queue.reserved_count, 0);
assert.equal(queue.scheduled_count, 0);
assert.equal(queue.queue_depth, 0);
const { db, sql: connection } = createClient({ max: 4 });
const prefix = `pw-progressive-live-${randomUUID()}`;
const directory = resolve(
  root,
  `.codex-artifacts/progressive-live-${requestedSpeedMps}${requestedMomentumScheme === "upwind" ? "-upwind" : ""}${requireRansHold ? "-hold" : ""}${requireUransHistories ? "-urans" : ""}${requestedTargetYPlus === null ? "" : `-yplus${requestedTargetYPlus}`}`,
);
mkdirSync(directory, { recursive: true });
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => abort.abort());
let campaignId: string | undefined;
let airfoilId: string | undefined;
let categoryId: string | undefined;
let originalMedium: typeof mediums.$inferSelect | undefined;
let originalSolver: typeof solverProfiles.$inferSelect | undefined;
let originalMesh: typeof meshProfiles.$inferSelect | undefined;
let controller: ReturnType<typeof spawn> | undefined;
let controllerStopped: Promise<void> | undefined;
let controllerExit:
  | { code: number | null; signal: NodeJS.Signals | null }
  | undefined;
let controllerLog = "";
const timeline: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
  kind: "real-progressive-fast-journey",
  startedAt: new Date().toISOString(),
  physicalAerodynamicAccuracyValidated: false,
  productionDeployed: false,
  engineIdentity: health.default_engine,
  engineDeployment,
  buildId: health.build_id,
  requestedSpeedMps,
  requestedMomentumScheme,
  requestedTargetYPlus,
  requireUransHistories,
  experimentalNumericalRecipe:
    requestedMomentumScheme === "upwind" || requestedTargetYPlus !== null,
  workerRuntime: worker,
  expectedSolverSource,
  deploymentPendingApply: deployment.data.readiness.pending_apply,
};

try {
  const [existing] = await db.execute(sql`SELECT
    (SELECT count(*)::int FROM sim_campaigns) AS campaigns,
    (SELECT count(*)::int FROM sim_jobs) AS jobs,
    (SELECT count(*)::int FROM airfoils) AS profiles`);
  report.initialDomain = existing;
  assert(
    existing && existing.campaigns === 0 && existing.jobs === 0,
    "Expected an unused campaign/job domain in the ephemeral test database",
  );
  await seedRuntimeProfiles(db);
  const identity = health.default_engine;
  const implementations = await db
    .select()
    .from(solverImplementations)
    .where(
      and(
        eq(solverImplementations.family, identity.family),
        eq(solverImplementations.distribution, identity.distribution),
        eq(solverImplementations.releaseVersion, identity.version),
        eq(solverImplementations.numericsRevision, identity.numerics_revision),
        eq(
          solverImplementations.adapterContractVersion,
          identity.adapter_contract_version,
        ),
      ),
    );
  assert.equal(implementations.length, 1);
  const pools = await db
    .select()
    .from(solverExecutionPools)
    .where(
      eq(solverExecutionPools.solverImplementationId, implementations[0].id),
    );
  assert.equal(pools.length, 1);
  await db
    .update(solverExecutionPools)
    .set({ enabled: true, capacityLimit: 1 })
    .where(eq(solverExecutionPools.id, pools[0].id));
  const source = readFileSync(
    resolve(root, "packages/db/seed/selig-database/ag24.dat"),
    "utf8",
  );
  assertSeedCoordinateIntegrity(source, "ag24.dat");
  const parsed = parseCoordinates(source);
  const geometry = deriveGeometry(parsed.points);
  const [category] = await db
    .insert(categories)
    .values({
      slug: prefix,
      name: "Real progressive verification",
      path: prefix,
      depth: 0,
    })
    .returning();
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${prefix}-ag24`,
      name: "AG24 real progressive verification",
      categoryId: category.id,
      points: geometry.contour,
      pointFormat: parsed.format,
      source: "selig-database",
      refMetricsSource: "queued",
      thicknessPct: geometry.thicknessPct,
      camberPct: geometry.camberPct,
    })
    .returning();
  airfoilId = airfoil.id;
  report.geometrySourceSha256 = createHash("sha256")
    .update(source)
    .digest("hex");
  writeFileSync(resolve(directory, "ag24.dat"), source);
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"));
  const [boundary] = await db
    .select()
    .from(boundaryProfiles)
    .where(eq(boundaryProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.boundary));
  const [mesh] = await db
    .select()
    .from(meshProfiles)
    .where(eq(meshProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.mesh));
  const [solver] = await db
    .select()
    .from(solverProfiles)
    .where(eq(solverProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.solver));
  const [output] = await db
    .select()
    .from(outputProfiles)
    .where(eq(outputProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.output));
  assert(medium && boundary && mesh && solver && output);
  originalMesh = mesh;
  if (requestedTargetYPlus !== null)
    await db
      .update(meshProfiles)
      .set({ targetYPlus: requestedTargetYPlus })
      .where(eq(meshProfiles.id, mesh.id));
  report.meshTargetYPlus = requestedTargetYPlus ?? mesh.targetYPlus;
  originalSolver = solver;
  if (solver.momentumScheme !== requestedMomentumScheme)
    await db
      .update(solverProfiles)
      .set({ momentumScheme: requestedMomentumScheme })
      .where(eq(solverProfiles.id, solver.id));
  originalMedium = medium;
  const gasModel = sourceAirModel();
  await db
    .update(mediums)
    .set({ gasThermodynamics: gasModel })
    .where(eq(mediums.id, medium.id));
  report.selectedMaterialModel = gasModel;
  const launched = await materializeCampaignLaunch(db, {
    name: prefix,
    priority: 5,
    idempotencyKey: prefix,
    airfoilIds: [airfoil.id],
    plan: {
      mediumId: medium.id,
      ambients: [[288.15, 101325]],
      speedsMps: [requestedSpeedMps],
      chordsM: [1.123457],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: requireUransHistories ? [18, 20, 22, 24] : [-2, 0, 2, 4],
      },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
        clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
      },
      numerics: {
        boundaryProfileId: boundary.id,
        meshProfileId: mesh.id,
        solverProfileId: solver.id,
        outputProfileId: output.id,
      },
    },
  });
  campaignId = launched.campaign.id;
  const [scope] =
    await db.execute(sql`SELECT count(DISTINCT airfoil_id)::int AS profiles
    FROM sim_campaign_points WHERE campaign_id = ${campaignId}`);
  assert.equal(
    scope.profiles,
    1,
    "The live campaign must remain scoped to its one owned profile",
  );
  report.campaignId = campaignId;
  report.airfoilId = airfoil.id;
  await db
    .update(sweeperState)
    .set({ enabled: true, cpuSlots: 1, maxConcurrentJobs: 1 })
    .where(eq(sweeperState.id, 1));
  controller = spawn(
    process.execPath,
    ["--import", "tsx", "apps/sweeper/src/index.ts"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ENGINE_URL: engineUrl,
        ENGINE_DISTRIBUTION: identity.distribution,
        ENGINE_VERSION: identity.version,
        ENGINE_NUMERICS_REVISION: identity.numerics_revision,
        ENGINE_ADAPTER_CONTRACT_VERSION: String(
          identity.adapter_contract_version,
        ),
        ENGINE_CONTROL_PLANE_TOKEN: controlPlaneToken,
        AIRFOILFOAM_EVIDENCE_BUCKET: "",
        AIRFOILFOAM_EVIDENCE_REMOTE_ONLY: "false",
        AIRFOILFOAM_BUILD_ID: health.build_id,
      },
    },
  );
  controllerStopped = new Promise((resolveStopped, reject) => {
    controller!.once("error", reject);
    controller!.once("exit", (code, signal) => {
      controllerExit = { code, signal };
      resolveStopped();
    });
  });
  controllerStopped.catch(() => undefined);
  for (const stream of [controller.stdout, controller.stderr])
    stream?.on("data", (chunk: Buffer) => {
      controllerLog = (controllerLog + chunk.toString()).slice(-2_000_000);
      process.stdout.write(chunk);
    });
  const deadline =
    Date.now() +
    (requireUransHistories
      ? 3_600_000
      : requestedSpeedMps === 1020
        ? 2_400_000
        : 1_800_000);
  let lastSignature = "";
  let baselineObserved = false;
  let refined = false;
  while (Date.now() < deadline && !abort.signal.aborted) {
    if (controllerExit)
      throw new Error(
        `Controller exited before refinement: ${JSON.stringify(controllerExit)}`,
      );
    const [snapshot] = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM neuralfoil_predictions) AS predictions,
      (SELECT count(*)::int FROM progressive_cfd_evidence) AS receipts,
      (SELECT count(*)::int FROM progressive_polar_model_evidence) AS model_evidence,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'engineJobId', engine_job_id,
        'stage', request_payload->'progressive'->'stage') ORDER BY id), '[]'::jsonb) FROM sim_jobs) AS jobs,
      (SELECT count(*)::int FROM progressive_work WHERE state IN ('pending', 'leased')) AS open_work,
      (SELECT count(DISTINCT stage)::int FROM progressive_work) AS observed_stages,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'state', state, 'error', error) ORDER BY stage), '[]'::jsonb)
        FROM progressive_work) AS work`);
    const signature = JSON.stringify(snapshot);
    if (signature !== lastSignature) {
      lastSignature = signature;
      timeline.push({ at: new Date().toISOString(), ...snapshot });
      console.log(
        JSON.stringify({
          kind: "real-progressive-checkpoint",
          ...timeline.at(-1),
        }),
      );
      if (Number(snapshot.predictions) > 0) {
        const curves = await publicProgressivePolars(db, airfoil.id);
        assert.equal(curves.length, 1);
        assert(curves[0].curves.some((curve) => curve.method === "neuralfoil"));
        if (!baselineObserved) {
          baselineObserved = true;
          report.baselineObservedAt = new Date().toISOString();
          report.baseline = curves;
        }
        if (
          Number(snapshot.model_evidence) > 0 &&
          curves[0].curves.some((curve) => curve.method === "composite")
        ) {
          const modelId = curves[0].modelId;
          assert(modelId);
          const evidence = await db
            .select({
              attemptId: progressivePolarModelEvidence.resultAttemptId,
              angle: progressiveCfdUnits.aoaDeg,
            })
            .from(progressivePolarModelEvidence)
            .innerJoin(
              progressiveCfdAttempts,
              eq(
                progressiveCfdAttempts.token,
                progressivePolarModelEvidence.attemptToken,
              ),
            )
            .innerJoin(
              progressiveCfdUnits,
              eq(progressiveCfdUnits.id, progressiveCfdAttempts.unitId),
            )
            .where(eq(progressivePolarModelEvidence.modelId, modelId));
          const proof = progressiveRefinementProof(
            curves[0],
            new Map(evidence.map((row) => [row.attemptId, row.angle])),
          );
          report.refinementProof = proof;
          report.latestCurves = curves;
          if (proof.distinctCfdAngles > 0 && proof.changedCoefficients) {
            report.firstRefinementObservedAt ??= new Date().toISOString();
            report.firstRefinement ??= curves;
          }
          if (proof.refined) {
            let historiesReady = true;
            if (requireUransHistories) {
              const stored = await db.execute(sql`
                SELECT id, aoa_deg, regime, converged, evidence_payload FROM result_attempts WHERE id IN (
                  ${sql.join(
                    proof.contributorAttemptIds.map((id) => sql`${id}::uuid`),
                    sql`, `,
                  )}
                )
              `);
              const [model] = await db.execute(
                sql`SELECT request FROM progressive_polar_models WHERE id = ${modelId}`,
              );
              const manifest = model?.request as
                | {
                    histories?: unknown;
                    history_policy?: { minimum_samples?: number };
                  }
                | undefined;
              const historyProof = progressiveUransHistoryProof(
                proof.contributorAttemptIds,
                manifest?.histories,
                new Map(
                  stored.map((row) => [
                    String(row.id),
                    {
                      alpha: Number(row.aoa_deg),
                      regime: String(row.regime),
                      converged:
                        row.converged === true
                          ? true
                          : row.converged === false
                            ? false
                            : null,
                    },
                  ]),
                ),
                Number(manifest?.history_policy?.minimum_samples),
              );
              const origins = historyProof.sources.map((source) => {
                const payload = stored.find(
                  (row) => row.id === source.attemptId,
                )?.evidence_payload as
                  | {
                      force_history?: {
                        source_start_time?: unknown;
                        t?: unknown;
                      };
                    }
                  | undefined;
                const history = payload?.force_history;
                const origin = history?.source_start_time;
                const first = Array.isArray(history?.t) ? history.t[0] : null;
                return {
                  attemptId: source.attemptId,
                  sourceStartTime: origin,
                  firstRetainedTime: first,
                  recorded:
                    typeof origin === "number" &&
                    Number.isFinite(origin) &&
                    typeof first === "number" &&
                    Number.isFinite(first) &&
                    origin <= first,
                };
              });
              report.uransHistoryProof = { ...historyProof, origins };
              historiesReady =
                historyProof.joint &&
                historyProof.unconvergedHistories > 0 &&
                origins.every((origin) => origin.recorded);
            }
            if (requireRansHold) {
              const attemptIds = [
                ...new Set(
                  (curves[0].explanation.contributors ?? []).map(
                    (entry) => entry.attemptId,
                  ),
                ),
              ];
              const held = await db.execute(sql`
                SELECT attempt.id, attempt.aoa_deg, attempt.regime, attempt.converged,
                  classification.state, attempt.evidence_payload->'rans_hold_certificate' AS certificate
                FROM result_attempts attempt JOIN result_classifications classification ON classification.result_attempt_id = attempt.id
                WHERE attempt.id IN (${sql.join(
                  attemptIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
              `);
              report.ransHoldProof = held;
              const accepted = held.filter(
                (row) =>
                  row.regime === "rans" &&
                  row.converged === true &&
                  row.state === "accepted" &&
                  (row.certificate as { certified?: boolean } | null)
                    ?.certified === true,
              );
              assert(
                new Set(accepted.map((row) => Number(row.aoa_deg))).size >= 2,
                "Two actual accepted RANS angles with exact hold certificates are required",
              );
            }
            if (historiesReady) {
              report.distinctCfdAngles = proof.distinctCfdAngles;
              refined = true;
              report.refinedObservedAt = new Date().toISOString();
              report.refined = curves;
              break;
            }
          }
        }
      }
    }
    assert(
      Number(snapshot.observed_stages) < 3 || Number(snapshot.open_work) > 0,
      requireUransHistories
        ? "All campaign stages closed without joint multi-angle URANS histories; inspect retained evidence"
        : "All campaign stages closed without two usable CFD angles; inspect retained work and evidence",
    );
    await delay(100, undefined, { signal: abort.signal });
  }
  assert(
    baselineObserved,
    "The real NeuralFoil baseline never became publicly readable",
  );
  assert(
    refined,
    "No publicly readable composite incorporated real CFD evidence within the finite check",
  );
  const [order] =
    await db.execute(sql`SELECT count(*)::int AS violations FROM sim_jobs job
    WHERE job.campaign_id = ${campaignId} AND (job.request_payload->'progressive'->>'stage')::int = 2
      AND NOT EXISTS (SELECT 1 FROM neuralfoil_predictions prediction
        WHERE prediction.target_id = job.request_payload->'progressive'->>'targetId'
          AND prediction.created_at <= job."createdAt")`);
  assert.equal(
    order.violations,
    0,
    "CFD was dispatched without its real NeuralFoil baseline",
  );
  report.stageOrderVerified = true;
  report.engineRoutingKey = engineIdentityKey(identity);
  report.outcome = "passed";
} catch (error) {
  report.outcome = "failed";
  report.error = String(error);
  throw error;
} finally {
  try {
    if (campaignId)
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
    if (controller && !controllerExit) {
      controller.kill("SIGTERM");
      await Promise.race([
        controllerStopped,
        delay(30_000, undefined, { ref: false }),
      ]);
      if (!controllerExit) {
        controller.kill("SIGKILL");
        await controllerStopped;
      }
    }
    if (airfoilId) {
      const jobs = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.airfoilId, airfoilId));
      report.jobs = jobs;
      report.submittedMeshTargets = await db.execute(sql`
        SELECT id, request_payload#>'{engineRequest,mesh}' AS mesh
        FROM sim_jobs WHERE airfoil_id = ${airfoilId}::uuid ORDER BY id
      `);
      report.sourceReceipts =
        await db.execute(sql`SELECT receipt.*, attempt.sim_job_id
        FROM progressive_cfd_evidence receipt
        JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token`);
      const stops = [];
      for (const job of jobs) {
        if (!job.engineJobId) continue;
        assert.equal(
          job.engineJobId,
          job.id,
          "Refusing cleanup without exact progressive execution identity",
        );
        const cancellation = await engine.cancelJob(job.engineJobId, {
          timeoutMs: 15_000,
        });
        assert.equal(cancellation.job_id, job.engineJobId);
        const stopDeadline = Date.now() + 120_000;
        let proof = await engine.getExecutionStopProof(job.engineJobId, {
          timeoutMs: 10_000,
        });
        while (!proof.execution_stopped && Date.now() < stopDeadline) {
          await delay(100);
          proof = await engine.getExecutionStopProof(job.engineJobId, {
            timeoutMs: 10_000,
          });
        }
        assert.equal(proof.job_id, job.engineJobId);
        assert(
          proof.execution_stopped,
          "The isolated solver execution did not stop; preserve its database ownership",
        );
        stops.push(proof);
      }
      report.executionStops = stops;
    }
    if (campaignId)
      await cleanupCampaignFixtures(db, {
        campaignIds: [campaignId],
        presetSlugPrefix: `campaign-${prefix}`,
      });
    if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
    if (categoryId)
      await db.delete(categories).where(eq(categories.id, categoryId));
    if (originalMedium)
      await db
        .update(mediums)
        .set({ gasThermodynamics: originalMedium.gasThermodynamics })
        .where(eq(mediums.id, originalMedium.id));
    if (originalSolver)
      await db
        .update(solverProfiles)
        .set({ momentumScheme: originalSolver.momentumScheme })
        .where(eq(solverProfiles.id, originalSolver.id));
    if (originalMesh)
      await db
        .update(meshProfiles)
        .set({ targetYPlus: originalMesh.targetYPlus })
        .where(eq(meshProfiles.id, originalMesh.id));
    report.databaseFixturesRemoved = true;
  } catch (error) {
    report.outcome = "failed";
    report.cleanupError = String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.timeline = timeline;
    writeFileSync(
      resolve(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(resolve(directory, "controller.log"), controllerLog);
    console.log(
      JSON.stringify({
        kind: "real-progressive-journey-result",
        outcome: report.outcome,
        reportPath: resolve(directory, "report.json"),
        databaseFixturesRemoved: report.databaseFixturesRemoved ?? false,
      }),
    );
    await connection.end({ timeout: 5 });
  }
}
