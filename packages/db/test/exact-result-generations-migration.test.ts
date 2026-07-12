import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const runId = `${process.pid}_${Date.now()}`;
const validDbName = `aerodb_exact0053_${runId}`;
const divergentDbName = `aerodb_exact0053_bad_${runId}`;
const halfOwnedMismatchDbName = `aerodb_exact0053_half_${runId}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const validUrl = new URL(baseUrl);
validUrl.pathname = `/${validDbName}`;
const divergentUrl = new URL(baseUrl);
divergentUrl.pathname = `/${divergentDbName}`;
const halfOwnedMismatchUrl = new URL(baseUrl);
halfOwnedMismatchUrl.pathname = `/${halfOwnedMismatchDbName}`;

function id(value: number): string {
  return `53000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
}

function sha(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function text(value: string | null): string {
  return value == null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function json(value: unknown): string {
  return `${text(JSON.stringify(value))}::jsonb`;
}

const ID = {
  category: id(1),
  airfoil: id(2),
  medium: id(3),
  flow: id(4),
  geometry: id(5),
  boundary: id(6),
  mesh: id(7),
  solver: id(8),
  scheduling: id(9),
  output: id(10),
  sweep: id(11),
  bc: id(12),
  preset: id(13),
  revision: id(14),
  otherRevision: id(15),

  snakeResult: id(101),
  normalizedResult: id(102),
  forceMismatchResult: id(103),
  priorityResult: id(104),
  tiedResult: id(105),
  missingManifestResult: id(106),
  duplicateManifestResult: id(107),
  invalidManifestResult: id(108),
  legacyUransResult: id(109),
  legacyRansResult: id(110),
  repairTargetResult: id(111),
  repairOtherResult: id(112),
  deletionResult: id(113),
  repointTargetResult: id(114),
  repointOtherResult: id(115),
  detachTargetResult: id(116),
  detachOtherResult: id(117),

  snakeAttempt: id(201),
  normalizedAttempt: id(202),
  forceMismatchAttempt: id(203),
  priorityProvisionalAttempt: id(204),
  priorityAcceptedAttempt: id(205),
  tiedAttemptA: id(206),
  tiedAttemptB: id(207),
  missingManifestAttempt: id(208),
  duplicateManifestAttempt: id(209),
  invalidManifestAttempt: id(210),
  legacyUransAttempt: id(211),
  legacyRansAttempt: id(212),
  repairOtherAttempt: id(213),
  deletionAttempt: id(214),
  repointCorrectAttempt: id(215),
  repointWrongAttempt: id(216),
  detachWrongAttempt: id(217),
  sharedJob: id(218),
  sharedJobTargetAttempt: id(219),
  sharedJobOtherAttempt: id(220),
  sharedJobDuplicateAttempt: id(221),

  exactMedia: id(701),
  mismatchedMedia: id(702),
  duplicateNullMediaA: id(703),
  duplicateNullMediaB: id(704),
  deletionMedia: id(705),
  snakeVideo: id(706),
  normalizedVideo: id(707),
  forceMismatchVideo: id(708),
  priorityVideo: id(709),
  legacyUransVideo: id(710),
  exactExtent: id(801),
  mismatchedExtent: id(802),
  repairedLegacyArtifact: id(901),
  repairedInvalidArtifact: id(902),
  repointedArtifact: id(903),
  detachedArtifact: id(904),
  halfOwnedArtifact: id(905),
} as const;

type ClassificationState = "accepted" | "needs_urans";

interface ManifestFixture {
  id: string;
  sha256: string;
}

interface AttemptFixture {
  id: string;
  classificationId?: string;
  classificationState?: ClassificationState;
  evidencePayload: Record<string, unknown>;
  manifests?: ManifestFixture[];
}

interface GenerationFixture {
  resultId: string;
  aoa: number;
  regime: "rans" | "urans";
  fidelity: "rans" | "urans_precalc" | "urans_full";
  engineJobId: string;
  engineCaseSlug: string;
  cl: number;
  cd: number;
  cm: number;
  clCd: number;
  clStd: number | null;
  cdStd: number | null;
  strouhal: number | null;
  unsteady: boolean;
  attempts: AttemptFixture[];
}

const snakeForce = {
  t: [0, 1],
  cl: [0.4, 0.6],
  cd: [0.02, 0.03],
  cm: [-0.01, -0.02],
  shedding_freq_hz: 2.4,
  samples: 2,
};
const normalizedForce = {
  t: [0, 1],
  cl: [0.68, 0.72],
  cd: [0.03, 0.04],
  cm: [-0.02, -0.03],
  clMean: 0.7,
  clRms: 0.02,
  cdMean: 0.035,
  cdRms: 0.005,
  strouhal: 0.19,
  sheddingFreqHz: 3.1,
  sampleCount: 2,
};
const mismatchedForce = {
  t: [0, 1],
  cl: [0.78, 0.82],
  cd: [0.04, 0.05],
  cm: [-0.03, -0.04],
  cl_mean: 0.8,
  cl_rms: 0.02,
  cd_mean: 0.045,
  cd_rms: 0.005,
  strouhal: 0.21,
  shedding_freq_hz: 3.5,
  sample_count: 2,
};

const fixtures: GenerationFixture[] = [
  {
    resultId: ID.snakeResult,
    aoa: -10,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-snake",
    engineCaseSlug: "aoa--10",
    cl: 0.5,
    cd: 0.025,
    cm: -0.015,
    clCd: 20,
    clStd: 0.1,
    cdStd: 0.005,
    strouhal: 0.17,
    unsteady: true,
    attempts: [
      {
        id: ID.snakeAttempt,
        classificationId: id(301),
        classificationState: "accepted",
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: snakeForce,
        },
        manifests: [{ id: id(501), sha256: sha(1) }],
      },
    ],
  },
  {
    resultId: ID.normalizedResult,
    aoa: -8,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-normalized",
    engineCaseSlug: "aoa--8",
    cl: 0.7,
    cd: 0.035,
    cm: -0.025,
    clCd: 20,
    clStd: 0.02,
    cdStd: 0.005,
    strouhal: 0.19,
    unsteady: true,
    attempts: [
      {
        id: ID.normalizedAttempt,
        classificationId: id(302),
        classificationState: "accepted",
        evidencePayload: {
          fidelity: "urans_precalc",
          forceHistory: normalizedForce,
        },
        manifests: [{ id: id(502), sha256: sha(2) }],
      },
    ],
  },
  {
    resultId: ID.forceMismatchResult,
    aoa: -6,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-force-mismatch",
    engineCaseSlug: "aoa--6",
    cl: 0.8,
    cd: 0.045,
    cm: -0.035,
    clCd: 17.77777777777778,
    clStd: 0.02,
    cdStd: 0.005,
    strouhal: 0.21,
    unsteady: true,
    attempts: [
      {
        id: ID.forceMismatchAttempt,
        classificationId: id(303),
        classificationState: "accepted",
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: mismatchedForce,
        },
        manifests: [{ id: id(503), sha256: sha(3) }],
      },
    ],
  },
  {
    resultId: ID.priorityResult,
    aoa: -4,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-priority",
    engineCaseSlug: "aoa--4",
    cl: 0.9,
    cd: 0.04,
    cm: -0.04,
    clCd: 22.5,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.22,
    unsteady: true,
    attempts: [
      {
        id: ID.priorityProvisionalAttempt,
        classificationId: id(304),
        classificationState: "needs_urans",
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: snakeForce,
        },
        manifests: [{ id: id(504), sha256: sha(4) }],
      },
      {
        id: ID.priorityAcceptedAttempt,
        classificationId: id(305),
        classificationState: "accepted",
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: snakeForce,
        },
        manifests: [{ id: id(505), sha256: sha(5) }],
      },
    ],
  },
  {
    resultId: ID.tiedResult,
    aoa: -2,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-tied",
    engineCaseSlug: "aoa--2",
    cl: 1,
    cd: 0.05,
    cm: -0.05,
    clCd: 20,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.23,
    unsteady: true,
    attempts: [
      {
        id: ID.tiedAttemptA,
        classificationId: id(306),
        classificationState: "accepted",
        evidencePayload: { fidelity: "urans_precalc" },
        manifests: [{ id: id(506), sha256: sha(6) }],
      },
      {
        id: ID.tiedAttemptB,
        classificationId: id(307),
        classificationState: "accepted",
        evidencePayload: { fidelity: "urans_precalc" },
        manifests: [{ id: id(507), sha256: sha(7) }],
      },
    ],
  },
  {
    resultId: ID.missingManifestResult,
    aoa: 0,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-missing",
    engineCaseSlug: "aoa-0",
    cl: 0.1,
    cd: 0.01,
    cm: -0.01,
    clCd: 10,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.1,
    unsteady: true,
    attempts: [
      {
        id: ID.missingManifestAttempt,
        classificationId: id(308),
        classificationState: "accepted",
        evidencePayload: { fidelity: "urans_precalc" },
      },
    ],
  },
  {
    resultId: ID.duplicateManifestResult,
    aoa: 2,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-duplicate",
    engineCaseSlug: "aoa-2",
    cl: 0.2,
    cd: 0.012,
    cm: -0.012,
    clCd: 16.666666666666668,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.11,
    unsteady: true,
    attempts: [
      {
        id: ID.duplicateManifestAttempt,
        classificationId: id(309),
        classificationState: "accepted",
        evidencePayload: { fidelity: "urans_precalc" },
        manifests: [
          { id: id(508), sha256: sha(8) },
          { id: id(509), sha256: sha(9) },
        ],
      },
    ],
  },
  {
    resultId: ID.invalidManifestResult,
    aoa: 4,
    regime: "urans",
    fidelity: "urans_precalc",
    engineJobId: "exact-0053-invalid",
    engineCaseSlug: "aoa-4",
    cl: 0.3,
    cd: 0.014,
    cm: -0.014,
    clCd: 21.428571428571427,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.12,
    unsteady: true,
    attempts: [
      {
        id: ID.invalidManifestAttempt,
        classificationId: id(310),
        classificationState: "accepted",
        evidencePayload: { fidelity: "urans_precalc" },
        manifests: [{ id: id(510), sha256: "not-a-valid-sha256" }],
      },
    ],
  },
  {
    resultId: ID.legacyUransResult,
    aoa: 6,
    regime: "urans",
    fidelity: "urans_full",
    engineJobId: "exact-0053-legacy-urans",
    engineCaseSlug: "aoa-6",
    cl: 0.4,
    cd: 0.016,
    cm: -0.016,
    clCd: 25,
    clStd: 0.01,
    cdStd: 0.001,
    strouhal: 0.13,
    unsteady: true,
    attempts: [
      {
        id: ID.legacyUransAttempt,
        classificationId: id(311),
        classificationState: "accepted",
        evidencePayload: { force_history: snakeForce },
        manifests: [{ id: id(511), sha256: sha(11) }],
      },
    ],
  },
  {
    resultId: ID.legacyRansResult,
    aoa: 8,
    regime: "rans",
    fidelity: "rans",
    engineJobId: "exact-0053-legacy-rans",
    engineCaseSlug: "aoa-8",
    cl: 0.5,
    cd: 0.018,
    cm: -0.018,
    clCd: 27.77777777777778,
    clStd: null,
    cdStd: null,
    strouhal: null,
    unsteady: false,
    attempts: [
      {
        id: ID.legacyRansAttempt,
        classificationId: id(312),
        classificationState: "accepted",
        evidencePayload: {},
        manifests: [{ id: id(512), sha256: sha(12) }],
      },
    ],
  },
  {
    resultId: ID.repairTargetResult,
    aoa: 10,
    regime: "rans",
    fidelity: "rans",
    engineJobId: "exact-0053-repair-target",
    engineCaseSlug: "aoa-10",
    cl: 0.6,
    cd: 0.02,
    cm: -0.02,
    clCd: 30,
    clStd: null,
    cdStd: null,
    strouhal: null,
    unsteady: false,
    attempts: [],
  },
  {
    resultId: ID.repairOtherResult,
    aoa: 12,
    regime: "rans",
    fidelity: "rans",
    engineJobId: "exact-0053-repair-other",
    engineCaseSlug: "aoa-12",
    cl: 0.7,
    cd: 0.022,
    cm: -0.022,
    clCd: 31.818181818181817,
    clStd: null,
    cdStd: null,
    strouhal: null,
    unsteady: false,
    attempts: [
      {
        id: ID.repairOtherAttempt,
        evidencePayload: { fidelity: "rans" },
      },
    ],
  },
];

function baseDomainSql(prefix: string): string {
  return `
INSERT INTO categories (id, slug, name, path) VALUES
  ('${ID.category}', '${prefix}-category', '${prefix} category', '${prefix}-category');
INSERT INTO airfoils (id, slug, name, category_id, points, is_symmetric) VALUES
  ('${ID.airfoil}', '${prefix}-foil', '${prefix} foil', '${ID.category}',
   '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb, false);
INSERT INTO mediums
  (id, slug, name, phase, density, viscosity_model,
   constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity, speed_of_sound)
VALUES ('${ID.medium}', '${prefix}-air', '${prefix} air', 'gas', 1.225, 'constant',
        0.00001789, 0.00001789, 0.000014604, 340.3);
INSERT INTO flow_conditions
  (id, slug, name, medium_id, speed_mps, density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.flow}', '${prefix}-flow', '${prefix} flow', '${ID.medium}', 20,
        1.225, 0.00001789, 0.000014604);
INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
VALUES ('${ID.geometry}', '${prefix}-geo', '${prefix} geo', 1);
INSERT INTO boundary_profiles (id, slug, name) VALUES
  ('${ID.boundary}', '${prefix}-boundary', '${prefix} boundary');
INSERT INTO mesh_profiles (id, slug, name) VALUES
  ('${ID.mesh}', '${prefix}-mesh', '${prefix} mesh');
INSERT INTO solver_profiles (id, slug, name) VALUES
  ('${ID.solver}', '${prefix}-solver', '${prefix} solver');
INSERT INTO scheduling_profiles (id, slug, name) VALUES
  ('${ID.scheduling}', '${prefix}-scheduling', '${prefix} scheduling');
INSERT INTO output_profiles (id, slug, name) VALUES
  ('${ID.output}', '${prefix}-output', '${prefix} output');
INSERT INTO sweep_definitions (id, slug, name, aoa_list) VALUES
  ('${ID.sweep}', '${prefix}-sweep', '${prefix} sweep', '[-10,12]'::jsonb);
INSERT INTO boundary_conditions
  (id, slug, name, medium_id, reynolds, reference_chord_m, speed_mps,
   density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.bc}', '${prefix}-bc', '${prefix} bc', '${ID.medium}', 1369491,
        1, 20, 1.225, 0.00001789, 0.000014604);
INSERT INTO simulation_presets
  (id, slug, name, flow_condition_id, reference_geometry_profile_id,
   boundary_profile_id, mesh_profile_id, solver_profile_id,
   scheduling_profile_id, output_profile_id, sweep_definition_id,
   legacy_boundary_condition_id)
VALUES ('${ID.preset}', '${prefix}-preset', '${prefix} preset', '${ID.flow}',
        '${ID.geometry}', '${ID.boundary}', '${ID.mesh}', '${ID.solver}',
        '${ID.scheduling}', '${ID.output}', '${ID.sweep}', '${ID.bc}');
INSERT INTO simulation_preset_revisions
  (id, preset_id, revision_number, signature_hash, reynolds,
   reference_length_m, snapshot)
VALUES
  ('${ID.revision}', '${ID.preset}', 1, '${prefix}-signature', 1369491, 1,
   '{}'::jsonb),
  ('${ID.otherRevision}', '${ID.preset}', 2, '${prefix}-other-signature',
   1369491, 1, '{}'::jsonb);
`;
}

function resultRow(fixture: GenerationFixture): string {
  return `(${text(fixture.resultId)}, '${ID.airfoil}', '${ID.bc}', '${ID.revision}',
    ${fixture.aoa}, 'done', 'solved', '${fixture.regime}', '${fixture.fidelity}',
    NULL, ${text(fixture.engineJobId)}, ${text(fixture.engineCaseSlug)},
    ${fixture.cl}, ${fixture.cd}, ${fixture.cm}, ${fixture.clCd},
    ${fixture.clStd ?? "NULL"}, ${fixture.cdStd ?? "NULL"},
    ${fixture.strouhal ?? "NULL"}, false, ${fixture.unsteady}, true, false)`;
}

function attemptRow(
  fixture: GenerationFixture,
  attempt: AttemptFixture,
): string {
  return `(${text(attempt.id)}, ${text(fixture.resultId)}, '${ID.airfoil}', '${ID.bc}',
    '${ID.revision}', ${fixture.aoa}, NULL, ${text(fixture.engineJobId)},
    ${text(fixture.engineCaseSlug)}, 'done', 'solved', '${fixture.regime}', true,
    ${fixture.cl}, ${fixture.cd}, ${fixture.cm}, ${fixture.clCd},
    ${fixture.clStd ?? "NULL"}, ${fixture.cdStd ?? "NULL"},
    ${fixture.strouhal ?? "NULL"}, false, ${fixture.unsteady}, true, false,
    ${json(attempt.evidencePayload)})`;
}

function validSetupSql(): string {
  const attempts = fixtures.flatMap((fixture) =>
    fixture.attempts.map((attempt) => ({ fixture, attempt })),
  );
  const classifications = fixtures.flatMap((fixture) => {
    const classified = fixture.attempts.filter(
      (attempt) => attempt.classificationId && attempt.classificationState,
    );
    return classified.map((attempt, index) => ({
      fixture,
      attempt,
      resultId: index === 0 ? fixture.resultId : null,
    }));
  });
  const manifests = attempts.flatMap(({ fixture, attempt }) =>
    (attempt.manifests ?? []).map((manifest) => ({
      fixture,
      attempt,
      manifest,
    })),
  );

  return `
${baseDomainSql("exact-0053")}
INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, sim_job_id, engine_job_id, engine_case_slug,
   cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled, unsteady,
   converged, first_order_fallback)
VALUES
  ${fixtures.map(resultRow).join(",\n  ")};

INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled,
   unsteady, converged, first_order_fallback, evidence_payload)
VALUES
  ${attempts
    .map(({ fixture, attempt }) => attemptRow(fixture, attempt))
    .join(",\n  ")};

INSERT INTO result_classifications
  (id, result_id, result_attempt_id, airfoil_id,
   simulation_preset_revision_id, aoa_deg, regime, classifier_version,
   state, reasons)
VALUES
  ${classifications
    .map(
      ({ fixture, attempt, resultId }) =>
        `(${text(attempt.classificationId!)}, ${text(resultId)}, ${text(attempt.id)},
         '${ID.airfoil}', '${ID.revision}', ${fixture.aoa}, '${fixture.regime}',
         'exact-generation-migration-v1', '${attempt.classificationState}',
         ARRAY[]::text[])`,
    )
    .join(",\n  ")};

INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, sim_job_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, storage_key, mime_type, sha256, byte_size)
VALUES
  ${manifests
    .map(
      ({ fixture, attempt, manifest }) =>
        `(${text(manifest.id)}, ${text(fixture.resultId)}, ${text(attempt.id)},
         '${ID.airfoil}', NULL, ${text(fixture.engineJobId)},
         ${text(fixture.engineCaseSlug)}, ${fixture.aoa}, 'manifest',
         ${text(`exact-0053/${manifest.id}/manifest.json`)}, 'application/json',
         ${text(manifest.sha256)}, 128)`,
    )
    .join(",\n  ")};

INSERT INTO force_history
  (id, result_id, t, cl, cd, cm, cl_mean, cl_rms, cd_mean, cd_rms,
   strouhal, shedding_freq_hz, sample_count)
VALUES
  ('${id(601)}', '${ID.snakeResult}', '[0,1]'::jsonb, '[0.4,0.6]'::jsonb,
   '[0.02,0.03]'::jsonb, '[-0.01,-0.02]'::jsonb, 0.5, 0.1, 0.025,
   0.005, 0.17, 2.4, 2),
  ('${id(602)}', '${ID.normalizedResult}', '[0,1]'::jsonb, '[0.68,0.72]'::jsonb,
   '[0.03,0.04]'::jsonb, '[-0.02,-0.03]'::jsonb, 0.7, 0.02, 0.035,
   0.005, 0.19, 3.1, 2),
  ('${id(603)}', '${ID.forceMismatchResult}', '[0,1]'::jsonb,
   '[0.78,0.82]'::jsonb, '[0.04,0.06]'::jsonb,
   '[-0.03,-0.04]'::jsonb, 0.8, 0.02, 0.045, 0.005, 0.21, 3.5, 2);

INSERT INTO result_media
  (id, result_id, kind, field, role, storage_key, mime_type,
   render_profile_key, evidence_sha256, sha256, byte_size)
VALUES
  ('${ID.exactMedia}', '${ID.snakeResult}', 'image', 'pressure', 'mean',
   'exact-0053/media-pressure.png', 'image/png', 'default:v1:zoom2',
   '${sha(1)}', '${sha(101)}', 1024),
  ('${ID.mismatchedMedia}', '${ID.snakeResult}', 'image', 'velocity_x', 'mean',
   'exact-0053/media-velocity.png', 'image/png', 'default:v1:zoom2',
   '${sha(999)}', '${sha(102)}', 1024),
  ('${ID.snakeVideo}', '${ID.snakeResult}', 'video', 'velocity_magnitude',
   'instantaneous', 'exact-0053/snake.mp4', 'video/mp4', 'default:v1:zoom2',
   '${sha(1)}', '${sha(106)}', 2048),
  ('${ID.normalizedVideo}', '${ID.normalizedResult}', 'video', 'velocity_magnitude',
   'instantaneous', 'exact-0053/normalized.mp4', 'video/mp4', 'default:v1:zoom2',
   '${sha(2)}', '${sha(107)}', 2048),
  ('${ID.forceMismatchVideo}', '${ID.forceMismatchResult}', 'video',
   'velocity_magnitude', 'instantaneous', 'exact-0053/force-mismatch.mp4',
   'video/mp4', 'default:v1:zoom2', '${sha(3)}', '${sha(108)}', 2048),
  ('${ID.priorityVideo}', '${ID.priorityResult}', 'video', 'velocity_magnitude',
   'instantaneous', 'exact-0053/priority.mp4', 'video/mp4', 'default:v1:zoom2',
   '${sha(5)}', '${sha(109)}', 2048),
  ('${ID.legacyUransVideo}', '${ID.legacyUransResult}', 'video',
   'velocity_magnitude', 'instantaneous', 'exact-0053/legacy-urans.mp4',
   'video/mp4', 'default:v1:zoom2', '${sha(11)}', '${sha(110)}', 2048),
  ('${ID.duplicateNullMediaA}', '${ID.missingManifestResult}', 'video', NULL,
   'history', 'exact-0053/legacy-history-a.mp4', 'video/mp4',
   'default:v1:zoom2', NULL, '${sha(103)}', 2048),
  ('${ID.duplicateNullMediaB}', '${ID.missingManifestResult}', 'video', NULL,
   'history', 'exact-0053/legacy-history-b.mp4', 'video/mp4',
   'default:v1:zoom2', NULL, '${sha(104)}', 2048);

INSERT INTO result_field_extents
  (id, result_id, airfoil_id, simulation_preset_revision_id, field,
   render_profile_key, vmin, vmax, finite_count, evidence_sha256)
VALUES
  ('${ID.exactExtent}', '${ID.snakeResult}', '${ID.airfoil}', '${ID.revision}',
   'pressure', 'default:v1:zoom2', -1, 1, 100, '${sha(1)}'),
  ('${ID.mismatchedExtent}', '${ID.snakeResult}', '${ID.airfoil}', '${ID.revision}',
   'velocity_x', 'default:v1:zoom2', -2, 2, 100, '${sha(999)}');

INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, sim_job_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, field, role, storage_key, mime_type,
   sha256, byte_size, engine_url, metadata)
VALUES
  ('${ID.repairedLegacyArtifact}', '${ID.repairTargetResult}', NULL,
   '${ID.airfoil}', NULL, 'repair-engine', 'repair-case', 10, 'log', NULL,
   'stdout', 'exact-0053/repair.log', 'text/plain', '${sha(900)}', 256,
   'http://engine.test', '{"segment":1,"source":"legacy"}'::jsonb),
  ('${ID.repairedInvalidArtifact}', '${ID.repairTargetResult}',
   '${ID.repairOtherAttempt}', '${ID.airfoil}', NULL, 'repair-engine',
   'repair-case', 10, 'log', NULL, 'stdout', 'exact-0053/repair.log',
   'text/plain', '${sha(900)}', 256, 'http://engine.test',
   '{"source":"legacy","segment":1}'::jsonb);

-- Production-shaped bffc25c-era wrong-condition links: the artifact's result
-- and redundant provenance are trustworthy, but its attempt was selected by
-- AoA without the condition/revision. One has a unique exact replacement;
-- the other has no replacement and must remain as result-scoped evidence.
INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, engine_job_id, engine_case_slug, cl, cd, cm,
   cl_cd, stalled, unsteady, converged)
VALUES
  ('${ID.repointTargetResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}',
   14, 'done', 'solved', 'rans', 'rans', 'repoint-engine',
   'aoa-14-target', 0.8, 0.025, -0.025, 32, false, false, true),
  ('${ID.repointOtherResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.otherRevision}', 14, 'done', 'solved', 'rans', 'rans',
   'wrong-condition-engine', 'aoa-14-wrong', 0.81, 0.026, -0.026,
   31.153846153846153, false, false, true),
  ('${ID.detachTargetResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}',
   16, 'done', 'solved', 'rans', 'rans', 'detached-declared-engine',
   'aoa-16-declared', 0.9, 0.03, -0.03, 30, false, false, true),
  ('${ID.detachOtherResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.otherRevision}', 16, 'done', 'solved', 'rans', 'rans',
   'wrong-condition-engine-16', 'aoa-16-wrong', 0.91, 0.031, -0.031,
   29.35483870967742, false, false, true);

INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   engine_job_id, engine_case_slug, status, source, regime, valid_for_polar,
   cl, cd, cm, cl_cd, stalled, unsteady, converged, evidence_payload)
VALUES
  ('${ID.repointCorrectAttempt}', '${ID.repointTargetResult}', '${ID.airfoil}',
   '${ID.bc}', '${ID.revision}', 14, 'repoint-engine', 'aoa-14-target',
   'done', 'solved', 'rans', true, 0.8, 0.025, -0.025, 32, false, false,
   true, '{"fidelity":"rans"}'::jsonb),
  ('${ID.repointWrongAttempt}', '${ID.repointOtherResult}', '${ID.airfoil}',
   '${ID.bc}', '${ID.otherRevision}', 14, 'wrong-condition-engine',
   'aoa-14-wrong', 'done', 'solved', 'rans', true, 0.81, 0.026, -0.026,
   31.153846153846153, false, false, true, '{"fidelity":"rans"}'::jsonb),
  ('${ID.detachWrongAttempt}', '${ID.detachOtherResult}', '${ID.airfoil}',
   '${ID.bc}', '${ID.otherRevision}', 16, 'wrong-condition-engine-16',
   'aoa-16-wrong', 'done', 'solved', 'rans', true, 0.91, 0.031, -0.031,
   29.35483870967742, false, false, true, '{"fidelity":"rans"}'::jsonb);

INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, sim_job_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, field, role, storage_key, mime_type,
   sha256, byte_size, engine_url, metadata)
VALUES
  ('${ID.repointedArtifact}', '${ID.repointTargetResult}',
   '${ID.repointWrongAttempt}', '${ID.airfoil}', NULL, 'repoint-engine',
   'aoa-14-target', 14, 'log', NULL, 'stdout',
   'exact-0053/repoint.log', 'text/plain', '${sha(903)}', 903,
   'http://engine.test', '{"case":"repoint"}'::jsonb),
  ('${ID.detachedArtifact}', '${ID.detachTargetResult}',
   '${ID.detachWrongAttempt}', '${ID.airfoil}', NULL, 'detached-declared-engine',
   'aoa-16-declared', 16, 'log', NULL, 'stdout',
   'exact-0053/detach.log', 'text/plain', '${sha(904)}', 904,
   'http://engine.test', '{"case":"detach"}'::jsonb),
  ('${ID.halfOwnedArtifact}', NULL, '${ID.repairOtherAttempt}',
   '${ID.airfoil}', NULL, 'exact-0053-repair-other', 'aoa-12', 12,
   'dictionary', NULL, 'controlDict', 'exact-0053/half-owned.dict',
   'text/plain', '${sha(905)}', 905, 'http://engine.test',
   '{"case":"half-owned"}'::jsonb);
`;
}

function divergentSetupSql(): string {
  const target = fixtures.find(
    (fixture) => fixture.resultId === ID.repairTargetResult,
  )!;
  const other = fixtures.find(
    (fixture) => fixture.resultId === ID.repairOtherResult,
  )!;
  const otherAttempt = other.attempts[0]!;
  return `
${baseDomainSql("exact-0053-divergent")}
INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, sim_job_id, engine_job_id, engine_case_slug,
   cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled, unsteady,
   converged, first_order_fallback)
VALUES
  ${resultRow(target)},
  ${resultRow(other)};
INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled,
   unsteady, converged, first_order_fallback, evidence_payload)
VALUES
  ${attemptRow(other, otherAttempt)};
INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, sim_job_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, field, role, storage_key, mime_type,
   sha256, byte_size, engine_url, metadata)
VALUES
  ('${ID.repairedLegacyArtifact}', '${ID.repairTargetResult}', NULL,
   '${ID.airfoil}', NULL, 'repair-engine', 'repair-case', 12, 'log', NULL,
   'stdout', 'exact-0053/divergent.log', 'text/plain', '${sha(901)}', 256,
   'http://engine.test', '{"segment":1}'::jsonb),
  ('${ID.repairedInvalidArtifact}', '${ID.repairTargetResult}',
   '${ID.repairOtherAttempt}', '${ID.airfoil}', NULL, 'repair-engine',
   'repair-case', 12, 'log', NULL, 'stdout', 'exact-0053/divergent.log',
   'text/plain', '${sha(901)}', 256, 'http://engine.test',
   '{"segment":2}'::jsonb);
`;
}

function halfOwnedMismatchSetupSql(): string {
  const other = fixtures.find(
    (fixture) => fixture.resultId === ID.repairOtherResult,
  )!;
  const otherAttempt = other.attempts[0]!;
  return `
${baseDomainSql("exact-0053-half-mismatch")}
INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, sim_job_id, engine_job_id, engine_case_slug,
   cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled, unsteady,
   converged, first_order_fallback)
VALUES
  ${resultRow(other)};
INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, cl, cd, cm, cl_cd, cl_std, cd_std, strouhal, stalled,
   unsteady, converged, first_order_fallback, evidence_payload)
VALUES
  ${attemptRow(other, otherAttempt)};
INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, sim_job_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, field, role, storage_key, mime_type,
   sha256, byte_size, engine_url, metadata)
VALUES
  ('${ID.halfOwnedArtifact}', NULL, '${ID.repairOtherAttempt}',
   '${ID.airfoil}', NULL, 'exact-0053-repair-other', 'aoa-12', 13,
   'dictionary', NULL, 'controlDict', 'exact-0053/half-mismatch.dict',
   'text/plain', '${sha(906)}', 906, 'http://engine.test',
   '{"case":"half-mismatch"}'::jsonb);
`;
}

function makeBaselineFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0052-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 52);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

type SqlClient = ReturnType<typeof postgres>;

let admin: SqlClient | null = null;
let validClient: SqlClient | null = null;
let divergentClient: SqlClient | null = null;
let halfOwnedMismatchClient: SqlClient | null = null;
let baselineDir = "";
let divergentMigrationError: unknown = null;
let halfOwnedMismatchMigrationError: unknown = null;

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  baselineDir = makeBaselineFolder();
  for (const dbName of [
    validDbName,
    divergentDbName,
    halfOwnedMismatchDbName,
  ]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  }

  validClient = postgres(validUrl.toString(), { max: 1 });
  const validDb = drizzle(validClient);
  await migrate(validDb, { migrationsFolder: baselineDir });
  await validClient.unsafe(validSetupSql());
  await migrate(validDb, { migrationsFolder: migrations });

  divergentClient = postgres(divergentUrl.toString(), { max: 1 });
  const divergentDb = drizzle(divergentClient);
  await migrate(divergentDb, { migrationsFolder: baselineDir });
  await divergentClient.unsafe(divergentSetupSql());
  try {
    await migrate(divergentDb, { migrationsFolder: migrations });
  } catch (error) {
    divergentMigrationError = error;
  }
  await divergentClient.end();
  divergentClient = postgres(divergentUrl.toString(), { max: 1 });

  halfOwnedMismatchClient = postgres(halfOwnedMismatchUrl.toString(), {
    max: 1,
  });
  const halfOwnedMismatchDb = drizzle(halfOwnedMismatchClient);
  await migrate(halfOwnedMismatchDb, { migrationsFolder: baselineDir });
  await halfOwnedMismatchClient.unsafe(halfOwnedMismatchSetupSql());
  try {
    await migrate(halfOwnedMismatchDb, { migrationsFolder: migrations });
  } catch (error) {
    halfOwnedMismatchMigrationError = error;
  }
  await halfOwnedMismatchClient.end();
  halfOwnedMismatchClient = postgres(halfOwnedMismatchUrl.toString(), {
    max: 1,
  });
}, 240_000);

afterAll(async () => {
  if (validClient) await validClient.end();
  if (divergentClient) await divergentClient.end();
  if (halfOwnedMismatchClient) await halfOwnedMismatchClient.end();
  if (admin) {
    for (const dbName of [
      validDbName,
      divergentDbName,
      halfOwnedMismatchDbName,
    ]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }
    await admin.end();
  }
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

describe.sequential("0052→0055 exact result-generation upgrade", () => {
  it("elects one exact strongest generation and fails closed on ties or bad manifests", async () => {
    const rows = (await validClient!.unsafe(`
      SELECT id, aoa_deg::float8 AS aoa, current_result_attempt_id
      FROM results
      WHERE id IN (
        '${ID.snakeResult}', '${ID.normalizedResult}',
        '${ID.forceMismatchResult}', '${ID.priorityResult}', '${ID.tiedResult}',
        '${ID.missingManifestResult}', '${ID.duplicateManifestResult}',
        '${ID.invalidManifestResult}', '${ID.legacyUransResult}',
        '${ID.legacyRansResult}'
      )
      ORDER BY aoa_deg
    `)) as unknown as Array<{
      id: string;
      aoa: number;
      current_result_attempt_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: ID.snakeResult,
        aoa: -10,
        current_result_attempt_id: ID.snakeAttempt,
      },
      {
        id: ID.normalizedResult,
        aoa: -8,
        current_result_attempt_id: ID.normalizedAttempt,
      },
      {
        id: ID.forceMismatchResult,
        aoa: -6,
        current_result_attempt_id: ID.forceMismatchAttempt,
      },
      {
        id: ID.priorityResult,
        aoa: -4,
        current_result_attempt_id: ID.priorityAcceptedAttempt,
      },
      { id: ID.tiedResult, aoa: -2, current_result_attempt_id: null },
      {
        id: ID.missingManifestResult,
        aoa: 0,
        current_result_attempt_id: null,
      },
      {
        id: ID.duplicateManifestResult,
        aoa: 2,
        current_result_attempt_id: null,
      },
      {
        id: ID.invalidManifestResult,
        aoa: 4,
        current_result_attempt_id: null,
      },
      {
        id: ID.legacyUransResult,
        aoa: 6,
        current_result_attempt_id: ID.legacyUransAttempt,
      },
      {
        id: ID.legacyRansResult,
        aoa: 8,
        current_result_attempt_id: ID.legacyRansAttempt,
      },
    ]);
  });

  it("binds exact force/media/extents provenance and leaves mismatches legacy", async () => {
    const histories = (await validClient!.unsafe(`
      SELECT result_id, result_attempt_id
      FROM force_history
      WHERE result_id IN (
        '${ID.snakeResult}', '${ID.normalizedResult}', '${ID.forceMismatchResult}'
      )
      ORDER BY result_id
    `)) as unknown as Array<{
      result_id: string;
      result_attempt_id: string | null;
    }>;
    expect(histories).toEqual([
      { result_id: ID.snakeResult, result_attempt_id: ID.snakeAttempt },
      {
        result_id: ID.normalizedResult,
        result_attempt_id: ID.normalizedAttempt,
      },
      { result_id: ID.forceMismatchResult, result_attempt_id: null },
    ]);

    const media = (await validClient!.unsafe(`
      SELECT id, result_attempt_id
      FROM result_media
      WHERE id IN ('${ID.exactMedia}', '${ID.mismatchedMedia}')
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string | null;
    }>;
    expect(media).toEqual([
      { id: ID.exactMedia, result_attempt_id: ID.snakeAttempt },
      { id: ID.mismatchedMedia, result_attempt_id: null },
    ]);

    const extents = (await validClient!.unsafe(`
      SELECT id, result_attempt_id
      FROM result_field_extents
      WHERE id IN ('${ID.exactExtent}', '${ID.mismatchedExtent}')
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string | null;
    }>;
    expect(extents).toEqual([
      { id: ID.exactExtent, result_attempt_id: ID.snakeAttempt },
      { id: ID.mismatchedExtent, result_attempt_id: null },
    ]);
  });

  it("preserves duplicate NULL-field legacy media and repairs only exact duplicate evidence", async () => {
    const legacyMedia = (await validClient!.unsafe(`
      SELECT id, field, result_attempt_id
      FROM result_media
      WHERE id IN ('${ID.duplicateNullMediaA}', '${ID.duplicateNullMediaB}')
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      field: string | null;
      result_attempt_id: string | null;
    }>;
    expect(legacyMedia).toEqual([
      { id: ID.duplicateNullMediaA, field: null, result_attempt_id: null },
      { id: ID.duplicateNullMediaB, field: null, result_attempt_id: null },
    ]);

    const artifacts = (await validClient!.unsafe(`
      SELECT id, result_id, result_attempt_id, storage_key, metadata
      FROM solver_evidence_artifacts
      WHERE storage_key = 'exact-0053/repair.log'
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_id: string;
      result_attempt_id: string | null;
      storage_key: string;
      metadata: Record<string, unknown>;
    }>;
    expect(artifacts).toEqual([
      {
        id: ID.repairedInvalidArtifact,
        result_id: ID.repairTargetResult,
        result_attempt_id: null,
        storage_key: "exact-0053/repair.log",
        metadata: { segment: 1, source: "legacy" },
      },
    ]);
  });

  it("repairs production-shaped wrong-condition and half-owned artifact links without changing evidence", async () => {
    const artifacts = (await validClient!.unsafe(`
      SELECT id, result_id, result_attempt_id, airfoil_id,
             engine_job_id, engine_case_slug, aoa_deg::float8 AS aoa,
             storage_key, sha256, byte_size::int AS byte_size, metadata
      FROM solver_evidence_artifacts
      WHERE id IN (
        '${ID.repointedArtifact}', '${ID.detachedArtifact}',
        '${ID.halfOwnedArtifact}'
      )
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_id: string;
      result_attempt_id: string | null;
      airfoil_id: string;
      engine_job_id: string;
      engine_case_slug: string;
      aoa: number;
      storage_key: string;
      sha256: string;
      byte_size: number;
      metadata: Record<string, unknown>;
    }>;
    expect(artifacts).toEqual([
      {
        id: ID.repointedArtifact,
        result_id: ID.repointTargetResult,
        result_attempt_id: ID.repointCorrectAttempt,
        airfoil_id: ID.airfoil,
        engine_job_id: "repoint-engine",
        engine_case_slug: "aoa-14-target",
        aoa: 14,
        storage_key: "exact-0053/repoint.log",
        sha256: sha(903),
        byte_size: 903,
        metadata: { case: "repoint" },
      },
      {
        id: ID.detachedArtifact,
        result_id: ID.detachTargetResult,
        result_attempt_id: null,
        airfoil_id: ID.airfoil,
        engine_job_id: "detached-declared-engine",
        engine_case_slug: "aoa-16-declared",
        aoa: 16,
        storage_key: "exact-0053/detach.log",
        sha256: sha(904),
        byte_size: 904,
        metadata: { case: "detach" },
      },
      {
        id: ID.halfOwnedArtifact,
        result_id: ID.repairOtherResult,
        result_attempt_id: ID.repairOtherAttempt,
        airfoil_id: ID.airfoil,
        engine_job_id: "exact-0053-repair-other",
        engine_case_slug: "aoa-12",
        aoa: 12,
        storage_key: "exact-0053/half-owned.dict",
        sha256: sha(905),
        byte_size: 905,
        metadata: { case: "half-owned" },
      },
    ]);
  });

  it("rolls all of 0053 back rather than deleting divergent immutable evidence", async () => {
    expect(String(divergentMigrationError)).toContain(
      "0053 refuses to detach an artifact whose declared result provenance is inconsistent",
    );
    const [state] = (await divergentClient!.unsafe(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'results'
            AND column_name = 'current_result_attempt_id'
        ) AS has_current_pointer,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations)
          AS latest_migration
    `)) as unknown as Array<{
      has_current_pointer: boolean;
      latest_migration: string;
    }>;
    expect(state).toEqual({
      has_current_pointer: false,
      latest_migration: "1785369600000",
    });
    const artifacts = (await divergentClient!.unsafe(`
      SELECT id, result_attempt_id, metadata
      FROM solver_evidence_artifacts
      WHERE storage_key = 'exact-0053/divergent.log'
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string | null;
      metadata: Record<string, unknown>;
    }>;
    expect(artifacts).toEqual([
      {
        id: ID.repairedLegacyArtifact,
        result_attempt_id: null,
        metadata: { segment: 1 },
      },
      {
        id: ID.repairedInvalidArtifact,
        result_attempt_id: ID.repairOtherAttempt,
        metadata: { segment: 2 },
      },
    ]);
  });

  it("rolls 0053 back when a half-owned artifact disagrees with its attempt", async () => {
    expect(String(halfOwnedMismatchMigrationError)).toContain(
      "0053 refuses to infer result ownership for an artifact whose provenance differs from its attempt",
    );
    const [state] = (await halfOwnedMismatchClient!.unsafe(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'results'
            AND column_name = 'current_result_attempt_id'
        ) AS has_current_pointer,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations)
          AS latest_migration
    `)) as unknown as Array<{
      has_current_pointer: boolean;
      latest_migration: string;
    }>;
    expect(state).toEqual({
      has_current_pointer: false,
      latest_migration: "1785369600000",
    });
    const artifacts = (await halfOwnedMismatchClient!.unsafe(`
      SELECT id, result_id, result_attempt_id, aoa_deg::float8 AS aoa, metadata
      FROM solver_evidence_artifacts
      WHERE id = '${ID.halfOwnedArtifact}'
    `)) as unknown as Array<{
      id: string;
      result_id: string | null;
      result_attempt_id: string;
      aoa: number;
      metadata: Record<string, unknown>;
    }>;
    expect(artifacts).toEqual([
      {
        id: ID.halfOwnedArtifact,
        result_id: null,
        result_attempt_id: ID.repairOtherAttempt,
        aoa: 13,
        metadata: { case: "half-mismatch" },
      },
    ]);
  });

  it("installs the current ownership constraints and supporting 0053–0055 indexes", async () => {
    const constraints = (await validClient!.unsafe(`
      SELECT conname, contype, confdeltype
      FROM pg_constraint
      WHERE conname IN (
        'result_attempts_id_result_id_uq',
        'results_current_attempt_owner_fk',
        'result_media_attempt_owner_fk',
        'force_history_attempt_owner_fk',
        'result_field_extents_attempt_owner_fk',
        'solver_evidence_artifacts_attempt_owner_fk',
        'result_classifications_attempt_owner_fk',
        'sim_campaign_points_attempt_owner_fk',
        'sync_sweep_promise_points_attempt_owner_fk',
        'sync_remote_result_deliveries_attempt_owner_fk',
        'remote_asset_references_attempt_owner_fk',
        'sim_precalc_obligations_source_attempt_owner_fk',
        'sync_upload_capacity_reservations_bytes_check',
        'sync_remote_promise_cancellations_promise_fk',
        'sync_remote_promise_cancellations_state_check',
        'sync_remote_promise_cancellations_attempt_check'
      )
      ORDER BY conname
    `)) as unknown as Array<{
      conname: string;
      contype: string;
      confdeltype: string;
    }>;
    expect(constraints).toEqual([
      {
        conname: "force_history_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "remote_asset_references_attempt_owner_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "result_attempts_id_result_id_uq",
        contype: "u",
        confdeltype: " ",
      },
      {
        conname: "result_classifications_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "result_field_extents_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "result_media_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "results_current_attempt_owner_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "sim_campaign_points_attempt_owner_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "sim_precalc_obligations_source_attempt_owner_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "solver_evidence_artifacts_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "sync_remote_promise_cancellations_attempt_check",
        contype: "c",
        confdeltype: " ",
      },
      {
        conname: "sync_remote_promise_cancellations_promise_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "sync_remote_promise_cancellations_state_check",
        contype: "c",
        confdeltype: " ",
      },
      {
        conname: "sync_remote_result_deliveries_attempt_owner_fk",
        contype: "f",
        confdeltype: "c",
      },
      {
        conname: "sync_sweep_promise_points_attempt_owner_fk",
        contype: "f",
        confdeltype: "a",
      },
      {
        conname: "sync_upload_capacity_reservations_bytes_check",
        contype: "c",
        confdeltype: " ",
      },
    ]);

    const expectedIndexes = [
      "force_history_attempt_uq",
      "force_history_legacy_result_uq",
      "force_history_result_idx",
      "remote_asset_references_result_attempt_idx",
      "result_field_extents_attempt_field_uq",
      "result_field_extents_attempt_idx",
      "result_field_extents_legacy_result_field_uq",
      "result_media_attempt_idx",
      "result_media_attempt_role_uq",
      "result_media_legacy_result_role_idx",
      "result_attempts_job_result_aoa_regime_uq",
      "results_current_attempt_idx",
      "sim_precalc_obligation_attempts_result_attempt_idx",
      "sim_precalc_obligations_source_result_attempt_idx",
      "sync_remote_promise_cancellations_ready_idx",
      "sync_remote_result_deliveries_result_attempt_idx",
      "sync_upload_capacity_reservations_expiry_idx",
      "sync_upload_capacity_reservations_token_uq",
    ].sort();
    const indexes = (await validClient!.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (${expectedIndexes.map(text).join(", ")})
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toEqual(expectedIndexes);

    const removed = (await validClient!.unsafe(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'result_media_uq',
          'result_field_extents_result_field_uq',
          'result_attempts_job_aoa_regime_uq'
        )
    `)) as unknown as Array<{ indexname: string }>;
    expect(removed).toEqual([]);

    const [attemptIndex] = (await validClient!.unsafe(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'result_attempts_job_result_aoa_regime_uq'
    `)) as unknown as Array<{ indexdef: string }>;
    expect(attemptIndex.indexdef).toMatch(
      /\(sim_job_id, engine_job_id, result_id, aoa_deg, regime\)$/,
    );

    await expect(
      validClient!.unsafe(`
        INSERT INTO sync_upload_capacity_reservations
          (token, reserved_bytes, expires_at)
        VALUES ('${id(990)}', 0, now() + interval '1 minute')
      `),
    ).rejects.toThrow(/sync_upload_capacity_reservations_bytes_check/);
    await validClient!.unsafe(`
      INSERT INTO sync_upload_capacity_reservations
        (token, reserved_bytes, expires_at)
      VALUES ('${id(991)}', 1, now() + interval '1 minute')
    `);
    await expect(
      validClient!.unsafe(`
        INSERT INTO sync_upload_capacity_reservations
          (token, reserved_bytes, expires_at)
        VALUES ('${id(991)}', 2, now() + interval '1 minute')
      `),
    ).rejects.toThrow(/sync_upload_capacity_reservations_token_uq/);

    await validClient!.unsafe(`
      INSERT INTO sim_jobs
        (id, engine_job_id, airfoil_id, bc_ids, simulation_preset_revision_id,
         job_kind, reference_chord_m, wave, status, total_cases,
         completed_cases, request_payload)
      VALUES
        ('${ID.sharedJob}', 'shared-job-engine', '${ID.airfoil}',
         '["${ID.bc}"]'::jsonb, NULL, 'sweep', 1, 1, 'done', 2, 2,
         '{}'::jsonb);
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
         aoa_deg, sim_job_id, engine_job_id, engine_case_slug, status, source,
         regime, valid_for_polar, cl, cd, cm, cl_cd, stalled, unsteady,
         converged, evidence_payload)
      VALUES
        ('${ID.sharedJobTargetAttempt}', '${ID.repointTargetResult}',
         '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 14, '${ID.sharedJob}',
         'shared-job-engine', 'shared-target', 'done', 'solved', 'rans', true,
         0.8, 0.025, -0.025, 32, false, false, true,
         '{"fidelity":"rans"}'::jsonb),
        ('${ID.sharedJobOtherAttempt}', '${ID.repointOtherResult}',
         '${ID.airfoil}', '${ID.bc}', '${ID.otherRevision}', 14,
         '${ID.sharedJob}', 'shared-job-engine', 'shared-other', 'done',
         'solved', 'rans', true, 0.81, 0.026, -0.026,
         31.153846153846153, false, false, true,
         '{"fidelity":"rans"}'::jsonb);
    `);
    const sharedAttempts = (await validClient!.unsafe(`
      SELECT id, result_id FROM result_attempts
      WHERE id IN (
        '${ID.sharedJobTargetAttempt}', '${ID.sharedJobOtherAttempt}'
      )
      ORDER BY id
    `)) as unknown as Array<{ id: string; result_id: string }>;
    expect(sharedAttempts).toEqual([
      {
        id: ID.sharedJobTargetAttempt,
        result_id: ID.repointTargetResult,
      },
      {
        id: ID.sharedJobOtherAttempt,
        result_id: ID.repointOtherResult,
      },
    ]);
    await expect(
      validClient!.unsafe(`
        INSERT INTO result_attempts
          (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
           aoa_deg, sim_job_id, engine_job_id, engine_case_slug, status,
           source, regime, valid_for_polar, cl, cd, cm, cl_cd, stalled,
           unsteady, converged, evidence_payload)
        VALUES
          ('${ID.sharedJobDuplicateAttempt}', '${ID.repointTargetResult}',
           '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 14,
           '${ID.sharedJob}', 'shared-job-engine', 'shared-duplicate', 'done',
           'solved', 'rans', true, 0.8, 0.025, -0.025, 32, false, false,
           true, '{"fidelity":"rans"}'::jsonb)
      `),
    ).rejects.toThrow(/result_attempts_job_result_aoa_regime_uq/);
  });

  it("rejects cross-result owners, blocks direct current-attempt deletion, and permits result cascade", async () => {
    await expect(
      validClient!.unsafe(`
        UPDATE result_media
        SET result_attempt_id = '${ID.normalizedAttempt}'
        WHERE id = '${ID.exactMedia}'
      `),
    ).rejects.toThrow(/result_media_attempt_owner_fk/);
    const [media] = (await validClient!.unsafe(`
      SELECT result_attempt_id FROM result_media WHERE id = '${ID.exactMedia}'
    `)) as unknown as Array<{ result_attempt_id: string }>;
    expect(media.result_attempt_id).toBe(ID.snakeAttempt);

    await validClient!.unsafe(`
      INSERT INTO results
        (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
         status, source, regime, fidelity, engine_job_id, engine_case_slug,
         cl, cd, cm, cl_cd, stalled, unsteady, converged)
      VALUES
        ('${ID.deletionResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}',
         20, 'done', 'solved', 'rans', 'rans', 'exact-0053-delete', 'aoa-20',
         1, 0.05, -0.05, 20, false, false, true);
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
         aoa_deg, engine_job_id, engine_case_slug, status, source, regime,
         valid_for_polar, cl, cd, cm, cl_cd, stalled, unsteady, converged,
         evidence_payload)
      VALUES
        ('${ID.deletionAttempt}', '${ID.deletionResult}', '${ID.airfoil}',
         '${ID.bc}', '${ID.revision}', 20, 'exact-0053-delete', 'aoa-20',
         'done', 'solved', 'rans', true, 1, 0.05, -0.05, 20, false, false,
         true, '{"fidelity":"rans"}'::jsonb);
      UPDATE results SET current_result_attempt_id = '${ID.deletionAttempt}'
      WHERE id = '${ID.deletionResult}';
      INSERT INTO result_media
        (id, result_id, result_attempt_id, kind, field, role, storage_key,
         mime_type, render_profile_key, sha256, byte_size)
      VALUES
        ('${ID.deletionMedia}', '${ID.deletionResult}', '${ID.deletionAttempt}',
         'image', 'pressure', 'mean', 'exact-0053/delete.png', 'image/png',
         'default:v1:zoom2', '${sha(950)}', 512);
    `);

    await expect(
      validClient!.unsafe(`
        DELETE FROM result_attempts WHERE id = '${ID.deletionAttempt}'
      `),
    ).rejects.toThrow(/results_current_attempt_owner_fk/);

    await validClient!.unsafe(`
      DELETE FROM results WHERE id = '${ID.deletionResult}'
    `);
    const [remaining] = (await validClient!.unsafe(`
      SELECT
        (SELECT count(*)::int FROM results WHERE id = '${ID.deletionResult}') AS results,
        (SELECT count(*)::int FROM result_attempts WHERE id = '${ID.deletionAttempt}') AS attempts,
        (SELECT count(*)::int FROM result_media WHERE id = '${ID.deletionMedia}') AS media
    `)) as unknown as Array<{
      results: number;
      attempts: number;
      media: number;
    }>;
    expect(remaining).toEqual({ results: 0, attempts: 0, media: 0 });
  });
});
