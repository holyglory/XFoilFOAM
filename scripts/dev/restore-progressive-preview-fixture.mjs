import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
const report = JSON.parse(
  await readFile(new URL("native-report.json", artifactRoot), "utf8"),
);
const native = JSON.parse(
  await readFile(new URL("new-job-result.json", artifactRoot), "utf8"),
);
assert.equal(native.state, "completed");
assert.equal(native.job_id, "a6ce8ae2-cddb-490e-9e0a-b2deeee0b64f");
assert.equal(native.engine.numerics_revision, "2");
assert.equal(native.mesh_recovery_version, 3);
const originalCampaignId = "35c2dc35-7fbd-411f-a7f7-452c1e1d3b0f";
const snapshot = structuredClone(report.jobs[0].requestPayload.setupSnapshot);
const originalCompatibility = methodCompatibilityHashForSnapshot(snapshot);
snapshot.flowState.mediumSlug = "preview-retained-ag24-a6ce8ae2-air";
snapshot.flowState.mediumName = "Air — retained AG24 preview";
snapshot.preset.name = "Retained AG24 native evidence";
assert.equal(
  methodCompatibilityHashForSnapshot(snapshot),
  originalCompatibility,
);
const signatureHash = simulationSetupSignature(snapshot);
const source = {
  sourceInstanceId: engine.data.deployment_id,
  sourceInstanceName: `Private progressive engine; native run ${report.nativeRun ?? "t20261002T213447Z-aa1e9a"}`,
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
const multipart = new FormData();
const points = [];
for (const polar of native.polars) {
  for (const point of polar.points) {
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
    for (const artifact of point.evidence_artifacts) {
      const stored = await download(artifact.url, artifact);
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
      const stored = await download(path);
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
      (item) => contributor?.attemptId === item.result_attempt_id,
    );
    assert(contributor?.resultId && contributor.attemptId && receipt);
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
      stalled: false,
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
        native_run_id: "t20261002T213447Z-aa1e9a",
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
            id: report.jobs[0].simulationPresetRevisionId,
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
    idempotencyKey: "preview-retained-ag24-a6ce8ae2-v1",
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
let waitMs = 250;
while (Date.now() < deadline) {
  const response = await fetch(`${origin}/api/airfoils/ag24`, {
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok);
  const detail = await response.json();
  series = detail.progressivePolars?.find(
    (item) =>
      item.curves.some((curve) => curve.method === "composite") &&
      item.explanation?.contributors?.some(
        (item) => item.resultId && item.attemptId,
      ),
  );
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
  sourceRunId: "t20261002T213447Z-aa1e9a",
  sourceProviderId: source.sourceInstanceId,
  originalCampaign,
  originalCampaignPreserved: true,
  fixtureCampaignId,
  revisionId,
  sourceCompatibilityHash: originalCompatibility,
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
  new URL("recovery.json", destination),
  `${JSON.stringify(receipt)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify({ ...receipt, downloads: undefined }));
