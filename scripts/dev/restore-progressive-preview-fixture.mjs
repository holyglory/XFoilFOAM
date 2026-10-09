import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  methodCompatibilityHashForSnapshot,
  simulationSetupSignature,
} from "../../packages/db/src/simulation-setup.ts";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

const root = new URL("../../", import.meta.url).pathname;
const deployment = (name) =>
  JSON.parse(
    execFileSync(
      "/usr/local/bin/devcoordinator2",
      ["--client", "codex", "deployment", "status", root, "--name", name],
      { encoding: "utf8", timeout: 30000 },
    ),
  );
const preview = deployment("progressive-preview");
const origin = originFromDeployment(preview);
const apiComponent = preview.data.components.find(
  (item) => item.name === "api",
);
assert(apiComponent?.owned && apiComponent.health === "healthy");
const api = `http://127.0.0.1:${apiComponent.port}`;
const engine = deployment("progressive-engine");
assert(
  engine.ok && engine.data.state === "running" && engine.data.public === false,
);
const engineComponent = engine.data.components.find(
  (item) => item.name === "engine",
);
assert(engineComponent?.owned && engineComponent.health === "healthy");
const engineOrigin = `http://127.0.0.1:${engineComponent.port}`;
const artifactRoot = new URL(
  "../../.codex-artifacts/preview-ag24-recovery-20261002-a6ce8ae2/",
  import.meta.url,
);
const nativeReportPath = process.env.PROGRESSIVE_PREVIEW_NATIVE_REPORT
  ? resolve(root, process.env.PROGRESSIVE_PREVIEW_NATIVE_REPORT)
  : null;
const report = JSON.parse(
  await readFile(
    nativeReportPath ?? new URL("native-report.json", artifactRoot),
    "utf8",
  ),
);
const retainedHandoff = nativeReportPath !== null;
const handoffRoot = nativeReportPath ? dirname(nativeReportPath) : null;
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assertSha256 = (value, label) => {
  assert.match(value, /^[0-9a-f]{64}$/, `${label} is not a SHA-256 digest`);
};
const assertEngineIdentity = (actual, expected, label) => {
  assert(actual && expected, `${label} is missing`);
  for (const field of [
    "family",
    "distribution",
    "version",
    "numerics_revision",
    "adapter_contract_version",
  ]) {
    assert.equal(actual[field], expected[field], `${label}.${field} changed`);
  }
};
const readRetainedFile = async (path, expected, label) => {
  assert(handoffRoot && typeof path === "string" && path.length > 0);
  assert(Number.isSafeInteger(expected.byteSize) && expected.byteSize >= 0);
  assertSha256(expected.sha256, label);
  assert(!path.split(/[\\/]/).includes(".."), `${label} path is invalid`);
  const absolute = resolve(handoffRoot, path);
  const withinRoot = relative(handoffRoot, absolute);
  assert(
    withinRoot && !withinRoot.startsWith("..") && !isAbsolute(withinRoot),
    `${label} escaped its retained handoff directory`,
  );
  const bytes = await readFile(absolute);
  assert.equal(bytes.length, expected.byteSize, `${label} byte size changed`);
  assert.equal(hashBytes(bytes), expected.sha256, `${label} bytes changed`);
  return { bytes, sha256: expected.sha256, byteSize: bytes.length };
};
let handoff;
let handoffJob;
let sourceJob;
let native;
if (retainedHandoff) {
  assert.equal(report.nativeEvidence?.kind, "native-engine-evidence-handoff");
  assert.equal(report.nativeEvidence?.version, 2);
  assert.equal(report.nativeEvidence?.retainedBeforeExecutionStops, true);
  assert(report.nativeEvidence?.manifestPath);
  const manifestPath = resolve(handoffRoot, "native-evidence-manifest.json");
  assert.equal(resolve(root, report.nativeEvidence.manifestPath), manifestPath);
  const manifestBytes = await readFile(manifestPath);
  assert.equal(
    manifestBytes.length,
    report.nativeEvidence.manifestByteSize,
    "Retained handoff manifest byte size changed",
  );
  assert.equal(
    hashBytes(manifestBytes),
    report.nativeEvidence.manifestSha256,
    "Retained handoff manifest bytes changed",
  );
  assertSha256(
    report.nativeEvidence.manifestSha256,
    "Retained handoff manifest",
  );
  handoff = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(handoff.kind, "native-engine-evidence-handoff");
  assert.equal(handoff.version, 2);
  assert.equal(handoff.sourceRunId, report.sourceRunId);
  assert.deepEqual(handoff.source.expectedEngine, report.engineIdentity);
  assert.equal(handoff.source.instanceId, report.engineDeploymentId);
  assert.equal(handoff.source.deployment, report.engineDeployment);
  assert.equal(
    handoff.source.expectedSolverSource,
    report.expectedSolverSource,
  );
  assert.equal(handoff.retainedBeforeExecutionStops, true);
  assert.equal(handoff.jobs.length, 1);
  [handoffJob] = handoff.jobs;
  assert.equal(handoffJob.resultPath, "native-result.json");
  assert(Array.isArray(handoff.artifacts));
  assertEngineIdentity(
    handoff.source.expectedEngine,
    report.engineIdentity,
    "Retained expected engine",
  );
  for (const artifact of handoff.artifacts) {
    assert.equal(artifact.jobId, handoffJob.jobId);
    assert(typeof artifact.originalPath === "string" && artifact.originalPath);
    assert(typeof artifact.retainedPath === "string" && artifact.retainedPath);
    assert(
      Array.isArray(artifact.references) && artifact.references.length > 0,
    );
    assertSha256(artifact.sha256, `Retained ${artifact.originalPath}`);
    for (const reference of artifact.references) {
      assert.equal(reference.simJobId, handoffJob.simJobId);
    }
  }
  sourceJob = report.jobs.find((job) => job.id === handoffJob.simJobId);
  assert(sourceJob, "Retained handoff lost its source database job");
  assert.equal(sourceJob.engineJobId, handoffJob.jobId);
  assert.equal(sourceJob.airfoilId, handoffJob.airfoilId);
  assert.equal(
    sourceJob.simulationPresetRevisionId,
    handoffJob.simulationPresetRevisionId,
  );
  assert.deepEqual(sourceJob.requestPayload, handoffJob.requestPayload);
  const requestBytes = Buffer.from(
    `${JSON.stringify(sourceJob.requestPayload ?? null)}\n`,
  );
  assert.equal(
    hashBytes(requestBytes),
    handoffJob.requestPayloadSha256,
    "Retained source request bytes changed",
  );
  const result = await readRetainedFile(
    handoffJob.resultPath,
    {
      byteSize: handoffJob.resultByteSize,
      sha256: handoffJob.resultSha256,
    },
    "Retained native result",
  );
  native = JSON.parse(result.bytes.toString("utf8"));
} else {
  native = JSON.parse(
    await readFile(new URL("new-job-result.json", artifactRoot), "utf8"),
  );
  sourceJob = report.jobs[0];
}
assert.equal(native.state, "completed");
assert.equal(native.job_id, sourceJob.engineJobId);
assert.equal(native.engine.numerics_revision, "2");
assert.equal(native.mesh_recovery_version, 3);
assert.equal(
  native.engine.application_source_sha256,
  report.expectedSolverSource,
);
if (retainedHandoff) {
  assertEngineIdentity(
    handoffJob.sourceEngine,
    handoff.source.expectedEngine,
    "Retained source engine",
  );
  assertEngineIdentity(
    native.engine,
    handoff.source.expectedEngine,
    "Retained result engine",
  );
  assert.deepEqual(native.engine, handoffJob.sourceEngine);
  assert.deepEqual(native.requested_engine, handoffJob.requestedEngine);
  assert.equal(
    native.requested_execution_pool,
    handoffJob.requestedExecutionPool,
  );
  assert.equal(native.execution_pool, handoffJob.executionPool);
  assert.equal(native.job_id, handoffJob.jobId);
  assert.equal(handoffJob.resultState, native.state);
}
const sourceRunId = retainedHandoff
  ? handoff.sourceRunId
  : "t20261002T213447Z-aa1e9a";
const originalCampaignId = "35c2dc35-7fbd-411f-a7f7-452c1e1d3b0f";
assert(sourceJob?.requestPayload?.setupSnapshot);
const snapshot = structuredClone(sourceJob.requestPayload.setupSnapshot);
const originalCompatibility = methodCompatibilityHashForSnapshot(snapshot);
snapshot.flowState.mediumSlug = `preview-retained-ag24-${native.job_id.slice(0, 8)}-air`;
snapshot.flowState.mediumName = "Air — retained AG24 preview";
snapshot.preset.name = "Retained AG24 native evidence";
assert.equal(
  methodCompatibilityHashForSnapshot(snapshot),
  originalCompatibility,
);
const signatureHash = simulationSetupSignature(snapshot);
const source = {
  sourceInstanceId: retainedHandoff
    ? handoff.source.instanceId
    : engine.data.deployment_id,
  sourceInstanceName: `Private progressive engine; native job ${native.job_id}`,
};
const secret = randomBytes(32).toString("hex");
let syncEnabled = false;
let savedSync;
const request = async (path, method = "GET", data, sync = false) => {
  const headers = {};
  let body;
  if (sync) headers["x-xfoilfoam-sync-secret"] = secret;
  if (data instanceof FormData) body = data;
  else if (data !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(data);
  }
  const response = await fetch(new URL(path, api), {
    method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  assert(response.ok, `${method} ${path} returned ${response.status}`);
  return response.json();
};
const permissionValues = (payload) =>
  payload.permissions
    .map((item) => ({
      dataType: item.dataType,
      canFetch: item.canFetch,
      canPush: item.canPush,
    }))
    .sort((left, right) => left.dataType.localeCompare(right.dataType));
const destination = new URL(
  "../../.codex-artifacts/preview-fixture-recovery/",
  import.meta.url,
);
const restoreAccess = async (saved) => {
  await request("/api/admin/sync", "PATCH", {
    enabled: saved.enabled,
    secret: "",
    permissions: saved.permissions,
  });
  const restored = await request("/api/admin/sync");
  assert.equal(restored.settings.enabled, saved.enabled);
  assert.equal(restored.settings.secretConfigured, false);
  assert.deepEqual(permissionValues(restored), saved.permissions);
};
if (process.argv.includes("--restore-access-only")) {
  try {
    const saved = JSON.parse(
      await readFile(new URL("sync-restore.json", destination), "utf8"),
    );
    await restoreAccess(saved);
    console.log(
      JSON.stringify({ kind: "preview-sync-restoration", restored: true }),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(
      JSON.stringify({
        kind: "preview-sync-restoration",
        restored: true,
        changesRequired: false,
      }),
    );
  }
  process.exit(0);
}
const campaignIdentity = (payload) => {
  const campaign = payload.campaign ?? payload;
  assert.equal(campaign.id, originalCampaignId);
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    planRevisionNumber: campaign.planRevisionNumber,
    plan: campaign.plan,
  };
};
const originalCampaign = campaignIdentity(
  await request(`/api/admin/campaigns/${originalCampaignId}`),
);
const downloads = [];
const download = async (path, expected = null) => {
  assert(
    !retainedHandoff,
    "Fresh native imports must use retained local files",
  );
  const url = new URL(path, engineOrigin);
  assert.equal(url.origin, engineOrigin);
  assert(url.pathname.startsWith(`/jobs/${native.job_id}/files/`));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  assert(response.ok, `Native artifact download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected) {
    assert.equal(bytes.length, expected.byte_size);
    assert.equal(sha256, expected.sha256);
  }
  return { bytes, sha256, byteSize: bytes.length };
};
const canonicalArtifactPath = (jobId, value) => {
  const raw = String(value);
  assert(!raw.includes("://"), "Native artifact path must be local to the job");
  const text = raw.replace(/^\/+/, "");
  const prefix = `jobs/${jobId}/files/`;
  if (text.startsWith("jobs/")) {
    assert(
      text.startsWith(prefix),
      "Native artifact path belongs to another job",
    );
    return text.slice(prefix.length);
  }
  assert(!text.split("/").includes(".."));
  return text;
};
const samePoint = (left, right) =>
  left.simJobId === right.simJobId &&
  left.polarIndex === right.polarIndex &&
  left.pointIndex === right.pointIndex &&
  left.pointCollection === right.pointCollection &&
  left.aoaDeg === right.aoaDeg &&
  left.caseSlug === right.caseSlug &&
  left.resultId === right.resultId &&
  left.attemptId === right.attemptId;
const retainedPointReference = (polarIndex, pointIndex, point) => {
  assert(retainedHandoff);
  const caseSlug = point.case_slug ?? null;
  const references = handoff.artifacts.flatMap(
    (entry) => entry.references ?? [],
  );
  const matches = references.filter(
    (reference) =>
      reference.simJobId === handoffJob.simJobId &&
      reference.polarIndex === polarIndex &&
      reference.pointIndex === pointIndex &&
      reference.pointCollection === "points" &&
      reference.aoaDeg === point.aoa_deg &&
      reference.caseSlug === caseSlug,
  );
  assert(matches.length > 0, "Retained native point identity is missing");
  const reference = matches[0];
  assert(
    matches.every((candidate) => samePoint(candidate, reference)),
    "Retained native point identity is inconsistent",
  );
  assert(reference.resultId && reference.attemptId);
  assert.equal(reference.caseSlug, caseSlug);
  assert.deepEqual(reference.coefficients, {
    cl: point.cl ?? null,
    cd: point.cd ?? null,
    cm: point.cm ?? null,
    clCd: point.cl_cd ?? null,
  });
  return reference;
};
const readRetainedArtifact = async (
  pointReference,
  sourceType,
  originalPath,
  descriptor,
) => {
  assert(retainedHandoff);
  const matches = handoff.artifacts.filter(
    (entry) =>
      entry.jobId === handoffJob.jobId &&
      entry.sourceType === sourceType &&
      entry.originalPath === originalPath &&
      (entry.references ?? []).some((reference) =>
        samePoint(reference, pointReference),
      ),
  );
  assert.equal(
    matches.length,
    1,
    "Retained native artifact identity is ambiguous",
  );
  const entry = matches[0];
  if (descriptor) {
    assert.equal(entry.kind, descriptor.kind);
    assert.equal(entry.field, descriptor.field ?? null);
    assert.equal(entry.role, descriptor.role ?? null);
    assert.equal(entry.mimeType, descriptor.mime_type);
    assert.equal(entry.byteSize, descriptor.byte_size);
    assert.equal(entry.sha256, descriptor.sha256);
  }
  const stored = await readRetainedFile(
    entry.retainedPath,
    { byteSize: entry.byteSize, sha256: entry.sha256 },
    `Retained ${sourceType} ${originalPath}`,
  );
  return { ...stored, entry };
};
const multipart = new FormData();
const points = [];
for (const [polarIndex, polar] of native.polars.entries()) {
  for (const [pointIndex, point] of polar.points.entries()) {
    assert(point.converged && !point.error && point.fidelity === "rans");
    const manifest = point.evidence_artifacts.find(
      (item) => item.kind === "manifest",
    );
    assert(
      manifest &&
        point.evidence_artifacts.some((item) => item.kind === "engine_bundle"),
    );
    const evidenceArtifacts = [];
    const media = [];
    const pointReference = retainedHandoff
      ? retainedPointReference(polarIndex, pointIndex, point)
      : null;
    for (const artifact of point.evidence_artifacts) {
      const originalPath = canonicalArtifactPath(native.job_id, artifact.path);
      const stored = retainedHandoff
        ? await readRetainedArtifact(
            pointReference,
            "evidence_artifact",
            originalPath,
            artifact,
          )
        : await download(artifact.url, artifact);
      const uploadField = `artifact-${downloads.length}`;
      multipart.append(
        uploadField,
        new Blob([stored.bytes], { type: artifact.mime_type }),
        artifact.path.split("/").at(-1),
      );
      evidenceArtifacts.push({
        kind: artifact.kind,
        field: artifact.field,
        role: artifact.role,
        mimeType: artifact.mime_type,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        metadata: artifact.metadata,
        uploadField,
      });
      downloads.push({
        aoaDeg: point.aoa_deg,
        kind: artifact.kind,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
      });
    }
    for (const [field, path] of Object.entries(point.images ?? {})) {
      const originalPath = canonicalArtifactPath(native.job_id, path);
      const retained = retainedHandoff
        ? await readRetainedArtifact(
            pointReference,
            "image",
            originalPath,
            null,
          )
        : null;
      if (retained) {
        assert.equal(retained.entry.kind, "image");
        assert.equal(retained.entry.field, field);
        assert.equal(retained.entry.role, "instantaneous");
        assert.equal(retained.entry.mimeType, "image/png");
      }
      const stored = retained ?? (await download(path));
      assert.equal(stored.bytes.subarray(1, 4).toString(), "PNG");
      const uploadField = `media-${downloads.length}`;
      multipart.append(
        uploadField,
        new Blob([stored.bytes], { type: "image/png" }),
        `${field}.png`,
      );
      media.push({
        kind: "image",
        field,
        role: "instantaneous",
        mimeType: "image/png",
        width: stored.bytes.readUInt32BE(16),
        height: stored.bytes.readUInt32BE(20),
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        evidenceSha256: manifest.sha256,
        renderProfileKey: "default:v1:zoom2",
        uploadField,
      });
      downloads.push({
        aoaDeg: point.aoa_deg,
        kind: "stored_image",
        field,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
      });
    }
    const contributor = report.refined[0].explanation.contributors.find(
      (item) => item.alpha === point.aoa_deg || item.aoa === point.aoa_deg,
    );
    const receipt = report.sourceReceipts.find(
      (item) =>
        contributor?.attemptId === item.result_attempt_id &&
        item.sim_job_id === sourceJob.id,
    );
    assert(contributor?.resultId && contributor.attemptId && receipt);
    assert.equal(receipt.sim_job_id, sourceJob.id);
    assert.equal(native.job_id, sourceJob.engineJobId);
    if (retainedHandoff) {
      assert.equal(pointReference.resultId, contributor.resultId);
      assert.equal(pointReference.attemptId, contributor.attemptId);
      assert.equal(pointReference.caseSlug, point.case_slug ?? null);
    }
    points.push({
      aoaDeg: point.aoa_deg,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: point.fidelity,
      reynolds: polar.reynolds,
      speed: polar.speed,
      chord: polar.chord,
      mach: snapshot.derived.mach,
      cl: point.cl,
      cd: point.cd,
      cm: point.cm,
      clCd: point.cl_cd,
      clStd: point.cl_std,
      cdStd: point.cd_std,
      cmStd: point.cm_std,
      ...(typeof point.stalled === "boolean" ? { stalled: point.stalled } : {}),
      unsteady: point.unsteady,
      converged: point.converged,
      finalResidual: point.final_residual,
      iterations: point.iterations,
      yPlusAvg: point.y_plus_avg,
      yPlusMax: point.y_plus_max,
      nCells: point.n_cells,
      firstOrderFallback: point.first_order_fallback,
      strouhal: point.strouhal,
      error: point.error,
      qualityWarnings: point.quality_warnings,
      frameTrack: point.frame_track,
      steadyHistory: point.steady_history,
      methodKey: point.method_key,
      engine: point.engine ?? native.engine,
      engineJobId: native.job_id,
      engineCaseSlug: point.case_slug,
      remoteResultId: contributor.resultId,
      remoteResultAttemptId: contributor.attemptId,
      evidencePayload: {
        ...point,
        mesh_recovery_version: native.mesh_recovery_version,
        native_source_receipt: receipt ?? null,
        native_run_id: sourceRunId,
        native_source_job_id: sourceJob.id,
        native_job_id: native.job_id,
        native_request_payload_sha256: retainedHandoff
          ? handoffJob.requestPayloadSha256
          : null,
        native_engine_identity: native.engine,
        native_requested_engine: native.requested_engine ?? null,
        native_coefficients: {
          cl: point.cl ?? null,
          cd: point.cd ?? null,
          cm: point.cm ?? null,
          clCd: point.cl_cd ?? null,
        },
        native_result_id: contributor.resultId,
        native_result_attempt_id: contributor.attemptId,
        native_original_point: point,
        source_field_availability: {
          stalled:
            typeof point.stalled === "boolean" ? "reported" : "not_reported",
        },
      },
      fieldExtents: [],
      evidenceArtifacts,
      media,
    });
  }
}
assert.equal(points.length, 2);
let imported;
let fixtureCampaignId;
let revisionId;
try {
  savedSync = await request("/api/admin/sync");
  assert(
    savedSync.settings.enabled === false &&
      savedSync.settings.secretConfigured === false,
  );
  await mkdir(destination, { recursive: true });
  await writeFile(
    new URL("sync-restore.json", destination),
    `${JSON.stringify({ enabled: savedSync.settings.enabled, permissions: permissionValues(savedSync) })}\n`,
    { mode: 0o600 },
  );
  const types = new Set([
    "mediums",
    "simulation_setup",
    "polars",
    "evidence_artifacts",
    "result_media",
  ]);
  syncEnabled = true;
  await request("/api/admin/sync", "PATCH", {
    enabled: true,
    secret,
    permissions: permissionValues(savedSync).map((item) => ({
      ...item,
      canPush: types.has(item.dataType) || item.canPush,
    })),
  });
  const viscosity = snapshot.material.viscosity;
  const medium = {
    slug: snapshot.flowState.mediumSlug,
    name: snapshot.flowState.mediumName,
    phase: snapshot.material.phase,
    density: snapshot.material.density,
    refTemperatureK: snapshot.material.refTemperatureK,
    refPressurePa: snapshot.material.refPressurePa,
    speedOfSound: snapshot.material.speedOfSound,
    gasThermodynamics: snapshot.material.gasThermodynamics,
    ...viscosity,
    viscosityModel: viscosity.model,
    viscosityTable:
      viscosity.model === "table"
        ? viscosity.tempsK.map((temperatureK, index) => ({
            temperatureK,
            dynamicViscosity: viscosity.mu[index],
            sortOrder: index,
          }))
        : undefined,
  };
  const setupImport = await request(
    "/api/sync/v1/import",
    "POST",
    {
      ...source,
      items: [
        { type: "mediums", data: medium },
        {
          type: "simulation_setup",
          data: {
            kind: "simulation_preset_revision",
            id: sourceJob.simulationPresetRevisionId,
            snapshot,
            signatureHash,
          },
        },
      ],
    },
    true,
  );
  assert.deepEqual(setupImport.conflicts, []);
  const setup = await request("/api/admin/simulation-setup");
  const preset = setup.simulationPresets.find(
    (item) => item.signatureHash === signatureHash,
  );
  assert(preset?.currentRevisionId);
  revisionId = preset.currentRevisionId;
  const baseSolver = setup.solverProfiles.find(
    (item) => item.name === "Standard k-omega SST",
  );
  const baseMesh = setup.meshProfiles.find(
    (item) => item.name === "Standard airfoil C-grid",
  );
  const airfoil = setup.airfoilOptions.find((item) => item.slug === "ag24");
  const flow = setup.flowConditions.find(
    (item) => item.id === preset.flowConditionId,
  );
  assert(baseSolver && baseMesh && airfoil && flow);
  const solverSlug = "preview-retained-ag24-numerics2-baseline";
  const solver =
    setup.solverProfiles.find((item) => item.slug === solverSlug) ??
    (await request("/api/admin/solver-profiles", "POST", {
      ...baseSolver,
      id: undefined,
      slug: solverSlug,
      name: "Retained AG24 numerical revision 2",
      solverImplementationId: snapshot.engine.implementationId,
    }));
  const launched = await request("/api/admin/campaigns", "POST", {
    name: "Retained AG24 native evidence preview",
    notes: `Derived preview of real native job ${native.job_id}; original campaign ${originalCampaignId} remains preserved.`,
    priority: 0,
    idempotencyKey: `preview-retained-ag24-${native.job_id}-v1`,
    airfoilIds: [airfoil.id],
    plan: {
      mediumId: flow.mediumId,
      ambients: [
        [snapshot.flowState.temperatureK, snapshot.flowState.pressurePa],
      ],
      speedsMps: [snapshot.flowState.speedMps],
      chordsM: [snapshot.referenceGeometry.referenceLengthM],
      spanM: snapshot.referenceGeometry.spanM,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: { fromDeg: -5, toDeg: 20, stepDeg: 1 },
      objectives: {
        ldMax: { enabled: false },
        clZero: { enabled: false },
        clMax: { enabled: false },
      },
      numerics: {
        boundaryProfileId: preset.boundaryProfileId,
        meshProfileId: baseMesh.id,
        solverProfileId: solver.id,
        outputProfileId: preset.outputProfileId,
      },
    },
  });
  fixtureCampaignId = launched.campaign.id;
  const manifest = new FormData();
  manifest.append(
    "manifest",
    JSON.stringify({
      ...source,
      airfoilSlug: "ag24",
      simulationPresetRevisionId: revisionId,
      results: points,
    }),
  );
  for (const [key, value] of multipart.entries()) manifest.append(key, value);
  imported = await request("/api/sync/v1/polars", "POST", manifest, true);
  assert.deepEqual(imported.conflictIds, []);
  assert.equal(imported.imported, 2);
} finally {
  if (syncEnabled) {
    await restoreAccess({
      enabled: savedSync.settings.enabled,
      permissions: permissionValues(savedSync),
    });
  }
}
assert.deepEqual(
  campaignIdentity(await request(`/api/admin/campaigns/${originalCampaignId}`)),
  originalCampaign,
);
const deadline = Date.now() + 120000;
let series;
let bindings = [];
let waitMs = 250;
while (Date.now() < deadline) {
  const response = await fetch(`${origin}/api/airfoils/ag24`, {
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok);
  const detail = await response.json();
  const candidates =
    detail.progressivePolars?.filter(
      (item) =>
        item.curves.some((curve) => curve.method === "composite") &&
        item.explanation?.contributors?.some(
          (item) => item.resultId && item.attemptId,
        ),
    ) ?? [];
  for (const candidate of candidates) {
    const candidateBindings = [];
    for (const contributor of candidate.explanation.contributors) {
      if (!contributor.resultId || !contributor.attemptId) continue;
      const query = new URLSearchParams({
        resultId: contributor.resultId,
        resultAttemptId: contributor.attemptId,
      });
      const response = await fetch(`${origin}/api/airfoils/ag24/sim?${query}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const stored = await response.json();
      const manifest = stored.evidenceArtifacts?.find(
        (item) => item.kind === "manifest",
      );
      const sourcePoint = native.polars[0].points.find((point) =>
        point.evidence_artifacts.some(
          (item) =>
            item.kind === "manifest" && item.sha256 === manifest?.sha256,
        ),
      );
      if (!sourcePoint) continue;
      assert.equal(stored.resultId, contributor.resultId);
      assert.equal(stored.resultAttemptId, contributor.attemptId);
      assert.equal(stored.cl, sourcePoint.cl);
      assert.equal(stored.cd, sourcePoint.cd);
      assert.equal(stored.cm, sourcePoint.cm);
      const sourceContributor = report.refined[0].explanation.contributors.find(
        (item) => item.alpha === sourcePoint.aoa_deg,
      );
      candidateBindings.push({
        resultId: contributor.resultId,
        attemptId: contributor.attemptId,
        sourceResultId: sourceContributor.resultId,
        sourceAttemptId: sourceContributor.attemptId,
        manifestSha256: manifest.sha256,
      });
    }
    if (
      new Set(candidateBindings.map((item) => item.manifestSha256)).size ===
      native.polars[0].points.length
    ) {
      series = candidate;
      bindings = candidateBindings;
      break;
    }
  }
  if (series) break;
  await delay(Math.min(waitMs, deadline - Date.now()));
  waitMs = Math.min(waitMs * 2, 5000);
}
assert(
  series,
  "The imported native evidence has not reached a real composite polar",
);
const receipt = {
  kind: "retained-native-preview-recovery",
  sourceJobId: native.job_id,
  sourceRunId,
  sourceProviderId: source.sourceInstanceId,
  originalCampaign,
  originalCampaignPreserved: true,
  fixtureCampaignId,
  revisionId,
  retainedRequestCompatibilityHash: originalCompatibility,
  currentDefaultNumericalIdentityClaimed: false,
  bindings,
  sourceTransforms: {
    labelChanges: [
      "flowState.mediumSlug",
      "flowState.mediumName",
      "preset.name",
    ],
    stateMapping: { nativeResultState: native.state, transportStatus: "done" },
    coefficientsChanged: false,
    stalled: native.polars[0].points.map((point) => ({
      aoaDeg: point.aoa_deg,
      sourceReported: typeof point.stalled === "boolean",
      sourceValue: point.stalled ?? null,
    })),
  },
  targetId: series.targetId,
  imported: imported.imported,
  attempts: imported.attempts,
  artifacts: imported.artifacts,
  media: imported.media,
  syncSettingsRestored: true,
  downloadCount: downloads.length,
  downloads,
  checkedAt: new Date().toISOString(),
};
await mkdir(destination, { recursive: true });
await writeFile(
  new URL("native-result.json", destination),
  `${JSON.stringify(native)}\n`,
  { mode: 0o600 },
);
await writeFile(
  new URL("native-report.json", destination),
  `${JSON.stringify(report)}\n`,
  { mode: 0o600 },
);
await writeFile(
  new URL("recovery.json", destination),
  `${JSON.stringify(receipt)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify({ ...receipt, downloads: undefined }));
