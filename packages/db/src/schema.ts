import type { Point } from "@aerodb/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums — pgEnum for stable closed domains. Python-mirroring domains that may
// grow (turbulence_model, viscosity_model, point_format, airfoil source) are
// plain text to avoid migration churn.
// ---------------------------------------------------------------------------
export const phaseEnum = pgEnum("phase", ["gas", "liquid"]);
export const dataSourceEnum = pgEnum("data_source", ["queued", "solved"]);
export const resultStatusEnum = pgEnum("result_status", [
  "pending",
  "queued",
  "running",
  "done",
  "failed",
  "stale",
]);
export const regimeEnum = pgEnum("regime", ["rans", "urans"]);
export const mediaKindEnum = pgEnum("media_kind", ["image", "video"]);
export const mediaRoleEnum = pgEnum("media_role", ["instantaneous", "mean", "history"]);
export const evidenceArtifactKindEnum = pgEnum("evidence_artifact_kind", [
  "manifest",
  "openfoam_bundle",
  "vtk_window",
  "time_directory",
  "log",
  "force_coefficients",
  "mesh",
  "dictionary",
  "field_data",
  // Per-frame URANS PNGs from the frame-track contract (migration 0032) —
  // pinned cross-runtime as FRAME_IMAGE_ARTIFACT_KIND in @aerodb/engine-client.
  "frame_image",
]);
export const presetTargetScopeEnum = pgEnum("preset_target_scope", ["all", "airfoils"]);
export const simJobStatusEnum = pgEnum("sim_job_status", [
  "pending",
  "submitted",
  "running",
  "ingesting",
  "done",
  "failed",
  "cancelled",
]);
export const resultClassificationStateEnum = pgEnum("result_classification_state", [
  "accepted",
  "needs_urans",
  "superseded_by_urans",
  "rejected",
]);
export const resultClassificationRegionEnum = pgEnum("result_classification_region", [
  "attached",
  "near_stall",
  "post_stall",
  "unknown",
]);
export const polarFitStatusEnum = pgEnum("polar_fit_status", ["final", "provisional", "insufficient"]);
export const colorScaleStatusEnum = pgEnum("color_scale_status", ["active", "rebalancing", "failed"]);
export const syncDataTypeEnum = pgEnum("sync_data_type", [
  "sweeps",
  "airfoils",
  "catalog_metadata",
  "mediums",
  "simulation_setup",
  "polars",
  "evidence_artifacts",
  "result_media",
]);
export const syncPromiseStatusEnum = pgEnum("sync_promise_status", ["active", "fulfilled", "expired", "cancelled"]);
export const syncImportConflictStatusEnum = pgEnum("sync_import_conflict_status", ["pending", "promoted", "archived"]);
export const syncModeEnum = pgEnum("sync_mode", ["full", "db_only_remote_assets"]);
export const remoteSolverStatusEnum = pgEnum("remote_solver_status", [
  "disabled",
  "idle",
  "syncing",
  "claiming",
  "solving",
  "pushing",
  "error",
  "offline",
]);
export const remoteAssetAvailabilityEnum = pgEnum("remote_asset_availability", ["remote_only", "cached", "missing", "failed"]);

const ts = () => timestamp({ withTimezone: true });
export const ALL_IMAGE_FIELDS = [
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
] as const;

// ---------------------------------------------------------------------------
// 1. Categories — tree via parent_id, with a denormalized materialized `path`
//    (slugs joined by '/') for O(1) breadcrumbs and subtree queries.
// ---------------------------------------------------------------------------
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id),
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    description: text("description"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugUq: uniqueIndex("categories_slug_uq").on(t.slug),
    pathIdx: index("categories_path_idx").on(t.path),
    parentIdx: index("categories_parent_idx").on(t.parentId),
  }),
);

// ---------------------------------------------------------------------------
// 2. Airfoils — point data (jsonb) + promoted derived-geometry scalars.
// ---------------------------------------------------------------------------
export const airfoils = pgTable(
  "airfoils",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    source: text("source").notNull().default("naca-analytic"),
    points: jsonb("points").$type<Point[]>().notNull(),
    pointFormat: text("point_format").notNull().default("selig"),
    nacaT: doublePrecision("naca_t"),
    nacaM: doublePrecision("naca_m"),
    nacaP: doublePrecision("naca_p"),
    thicknessPct: doublePrecision("thickness_pct"),
    thicknessXPct: doublePrecision("thickness_x_pct"),
    camberPct: doublePrecision("camber_pct"),
    camberXPct: doublePrecision("camber_x_pct"),
    leRadiusPct: doublePrecision("le_radius_pct"),
    teThicknessPct: doublePrecision("te_thickness_pct"),
    areaProfile: doublePrecision("area_profile"),
    areaUpper: doublePrecision("area_upper"),
    areaLower: doublePrecision("area_lower"),
    areaCamber: doublePrecision("area_camber"),
    areaUpperPositive: doublePrecision("area_upper_positive"),
    areaUpperNegative: doublePrecision("area_upper_negative"),
    areaLowerPositive: doublePrecision("area_lower_positive"),
    areaLowerNegative: doublePrecision("area_lower_negative"),
    areaCamberPositive: doublePrecision("area_camber_positive"),
    areaCamberNegative: doublePrecision("area_camber_negative"),
    refRe: bigint("ref_re", { mode: "number" }).default(300000),
    refLdmax: doublePrecision("ref_ldmax"),
    refClmax: doublePrecision("ref_clmax"),
    refCdmin: doublePrecision("ref_cdmin"),
    refMetricsSource: dataSourceEnum("ref_metrics_source").notNull().default("queued"),
    // Computed geometric property (see @aerodb/core isAirfoilSymmetric); campaigns
    // solve only α ≥ 0 for symmetric airfoils and derive the negative side.
    isSymmetric: boolean("is_symmetric").notNull().default(false),
    symmetryCheckedAt: ts(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    archivedAt: ts(),
    deletedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    categoryIdx: index("airfoils_category_idx").on(t.categoryId),
    thicknessIdx: index("airfoils_thickness_idx").on(t.thicknessPct),
    ldmaxIdx: index("airfoils_ldmax_idx").on(t.refLdmax),
    archivedIdx: index("airfoils_archived_idx").on(t.archivedAt),
    deletedIdx: index("airfoils_deleted_idx").on(t.deletedAt),
  }),
);

export const hashtags = pgTable(
  "hashtags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugUq: uniqueIndex("hashtags_slug_uq").on(t.slug),
    nameIdx: index("hashtags_name_idx").on(t.name),
  }),
);

export const airfoilHashtags = pgTable(
  "airfoil_hashtags",
  {
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    hashtagId: uuid("hashtag_id")
      .notNull()
      .references(() => hashtags.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.airfoilId, t.hashtagId] }),
    hashtagIdx: index("airfoil_hashtags_hashtag_idx").on(t.hashtagId),
  }),
);

// ---------------------------------------------------------------------------
// 3. Mediums — density + a discriminated viscosity model. The resolved
//    dynamic/kinematic viscosity scalars are what feed Reynolds and the solver.
// ---------------------------------------------------------------------------
export const mediums = pgTable("mediums", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  phase: phaseEnum("phase").notNull(),
  density: doublePrecision("density").notNull(),
  refTemperatureK: doublePrecision("ref_temperature_k").notNull().default(288.15),
  refPressurePa: doublePrecision("ref_pressure_pa").notNull().default(101325),
  viscosityModel: text("viscosity_model").notNull(), // constant | sutherland | table
  constantDynamicViscosity: doublePrecision("constant_dynamic_viscosity"),
  sutherlandMuRef: doublePrecision("sutherland_mu_ref"),
  sutherlandTRef: doublePrecision("sutherland_t_ref"),
  sutherlandS: doublePrecision("sutherland_s"),
  dynamicViscosity: doublePrecision("dynamic_viscosity").notNull(),
  kinematicViscosity: doublePrecision("kinematic_viscosity").notNull(),
  speedOfSound: doublePrecision("speed_of_sound"),
  notes: text("notes"),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const mediumViscosityTablePoints = pgTable(
  "medium_viscosity_table_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediumId: uuid("medium_id")
      .notNull()
      .references(() => mediums.id, { onDelete: "cascade" }),
    temperatureK: doublePrecision("temperature_k").notNull(),
    dynamicViscosity: doublePrecision("dynamic_viscosity").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    mediumIdx: index("medium_viscosity_points_medium_idx").on(t.mediumId),
    orderUq: uniqueIndex("medium_viscosity_points_order_uq").on(t.mediumId, t.sortOrder),
  }),
);

// ---------------------------------------------------------------------------
// 4. CFD setup registries — separate physical, reference-geometry, numerical, execution, output,
//    and sweep records. Simulation preset revisions are immutable job/result
//    snapshots assembled from the reusable records.
// ---------------------------------------------------------------------------
export const flowConditions = pgTable(
  "flow_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    mediumId: uuid("medium_id")
      .notNull()
      .references(() => mediums.id),
    temperatureK: doublePrecision("temperature_k").notNull().default(288.15),
    pressurePa: doublePrecision("pressure_pa").notNull().default(101325),
    speedMps: doublePrecision("speed_mps").notNull().default(50),
    density: doublePrecision("density").notNull().default(1.225),
    dynamicViscosity: doublePrecision("dynamic_viscosity").notNull().default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity").notNull().default(1.46e-5),
    mach: doublePrecision("mach"),
    isSeeded: boolean("is_seeded").notNull().default(false),
    origin: text("origin").notNull().default("user"), // seeded | user | campaign — set once at INSERT
    createdByCampaignId: uuid("created_by_campaign_id").references((): AnyPgColumn => simCampaigns.id, {
      onDelete: "set null",
    }),
    // mediumId|T|P|speed at canonical SI precision, INPUT values only (see
    // flowConditionCanonicalKey in simulation-setup.ts). Nullable until backfilled.
    canonicalKey: text("canonical_key"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    mediumIdx: index("flow_conditions_medium_idx").on(t.mediumId),
    canonicalKeyUq: uniqueIndex("flow_conditions_canonical_key_uq").on(t.canonicalKey),
  }),
);

export const referenceGeometryProfiles = pgTable(
  "reference_geometry_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    geometryType: text("geometry_type").notNull().default("airfoil_2d"),
    referenceLengthKind: text("reference_length_kind").notNull().default("chord"),
    referenceLengthM: doublePrecision("reference_length_m").notNull().default(1.0),
    spanM: doublePrecision("span_m"),
    referenceAreaM2: doublePrecision("reference_area_m2"),
    isSeeded: boolean("is_seeded").notNull().default(false),
    origin: text("origin").notNull().default("user"), // seeded | user | campaign — set once at INSERT
    createdByCampaignId: uuid("created_by_campaign_id").references((): AnyPgColumn => simCampaigns.id, {
      onDelete: "set null",
    }),
    // type|kind|chord|span|area at canonical SI precision, INPUT values only (see
    // referenceGeometryCanonicalKey in simulation-setup.ts). Nullable until backfilled.
    canonicalKey: text("canonical_key"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    geometryTypeIdx: index("reference_geometry_profiles_type_idx").on(t.geometryType),
    canonicalKeyUq: uniqueIndex("reference_geometry_profiles_canonical_key_uq").on(t.canonicalKey),
  }),
);

// Deprecated compatibility bridge. Do not use this table for new setup logic:
// flow_conditions owns medium/T/P/speed, reference_geometry_profiles owns
// chord/reference scale, and simulation_preset_revisions cache Reynolds.
export const operatingConditions = pgTable(
  "operating_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    mediumId: uuid("medium_id")
      .notNull()
      .references(() => mediums.id),
    referenceChordM: doublePrecision("reference_chord_m").notNull().default(1.0),
    temperatureK: doublePrecision("temperature_k").notNull().default(288.15),
    pressurePa: doublePrecision("pressure_pa").notNull().default(101325),
    speedMps: doublePrecision("speed_mps").notNull().default(50),
    density: doublePrecision("density").notNull().default(1.225),
    dynamicViscosity: doublePrecision("dynamic_viscosity").notNull().default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity").notNull().default(1.46e-5),
    reynolds: bigint("reynolds", { mode: "number" }).notNull(),
    mach: doublePrecision("mach"),
    isSeeded: boolean("is_seeded").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    mediumIdx: index("operating_conditions_medium_idx").on(t.mediumId),
    reIdx: index("operating_conditions_reynolds_idx").on(t.reynolds),
  }),
);

export const boundaryProfiles = pgTable("boundary_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  turbulenceIntensity: doublePrecision("turbulence_intensity").notNull().default(0.001),
  viscosityRatio: doublePrecision("viscosity_ratio").notNull().default(10),
  sandGrainHeight: doublePrecision("sand_grain_height").notNull().default(0),
  roughnessConstant: doublePrecision("roughness_constant").notNull().default(0.5),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const meshProfiles = pgTable("mesh_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  mesher: text("mesher").notNull().default("blockmesh-cgrid"),
  farfieldRadiusChords: doublePrecision("farfield_radius_chords").notNull().default(15),
  wakeLengthChords: doublePrecision("wake_length_chords").notNull().default(12),
  nSurface: integer("n_surface").notNull().default(130),
  nRadial: integer("n_radial").notNull().default(80),
  nWake: integer("n_wake").notNull().default(60),
  targetYPlus: doublePrecision("target_y_plus").notNull().default(1),
  spanChords: doublePrecision("span_chords").notNull().default(0.1),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const solverProfiles = pgTable("solver_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  turbulenceModel: text("turbulence_model").notNull().default("kOmegaSST"),
  nIterations: integer("n_iterations").notNull().default(3000),
  convergenceTolerance: doublePrecision("convergence_tolerance").notNull().default(1e-5),
  momentumScheme: text("momentum_scheme").notNull().default("linearUpwind"),
  transientCycles: doublePrecision("transient_cycles").notNull().default(10),
  transientDiscardFraction: doublePrecision("transient_discard_fraction").notNull().default(0.4),
  transientMaxCourant: doublePrecision("transient_max_courant").notNull().default(15),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const schedulingProfiles = pgTable("scheduling_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  schedulingPolicy: text("scheduling_policy").notNull().default("auto"),
  cpuBudget: integer("cpu_budget"),
  caseConcurrency: integer("case_concurrency"),
  solverProcesses: integer("solver_processes"),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const outputProfiles = pgTable("output_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  writeImages: jsonb("write_images")
    .$type<string[]>()
    .notNull()
    .default([...ALL_IMAGE_FIELDS]),
  imageZoomChords: doublePrecision("image_zoom_chords").notNull().default(2),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const sweepDefinitions = pgTable("sweep_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  aoaStart: doublePrecision("aoa_start").notNull().default(-8),
  aoaStop: doublePrecision("aoa_stop").notNull().default(20),
  aoaStep: doublePrecision("aoa_step").notNull().default(1),
  aoaList: jsonb("aoa_list").$type<number[] | null>(),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// Deprecated compatibility bridge. New code composes simulation presets from
// the profile tables above and references immutable preset revisions. This
// table remains only to preserve old foreign keys/API compatibility during the
// migration window.
// ---------------------------------------------------------------------------
export const boundaryConditions = pgTable(
  "boundary_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    mediumId: uuid("medium_id")
      .notNull()
      .references(() => mediums.id),
    reynolds: bigint("reynolds", { mode: "number" }).notNull(),
    referenceChordM: doublePrecision("reference_chord_m").notNull().default(1.0),
    temperatureK: doublePrecision("temperature_k").notNull().default(288.15),
    pressurePa: doublePrecision("pressure_pa").notNull().default(101325),
    speedMps: doublePrecision("speed_mps").notNull().default(50),
    density: doublePrecision("density").notNull().default(1.225),
    dynamicViscosity: doublePrecision("dynamic_viscosity").notNull().default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity").notNull().default(1.46e-5),
    mach: doublePrecision("mach"),
    // turbulence
    turbulenceModel: text("turbulence_model").notNull().default("kOmegaSST"),
    turbulenceIntensity: doublePrecision("turbulence_intensity").notNull().default(0.001),
    viscosityRatio: doublePrecision("viscosity_ratio").notNull().default(10),
    // roughness
    sandGrainHeight: doublePrecision("sand_grain_height").notNull().default(0),
    roughnessConstant: doublePrecision("roughness_constant").notNull().default(0.5),
    // mesh
    mesher: text("mesher").notNull().default("blockmesh-cgrid"),
    farfieldRadiusChords: doublePrecision("farfield_radius_chords").notNull().default(15),
    wakeLengthChords: doublePrecision("wake_length_chords").notNull().default(12),
    nSurface: integer("n_surface").notNull().default(130),
    nRadial: integer("n_radial").notNull().default(80),
    nWake: integer("n_wake").notNull().default(60),
    targetYPlus: doublePrecision("target_y_plus").notNull().default(1),
    spanChords: doublePrecision("span_chords").notNull().default(0.1),
    // solver
    nIterations: integer("n_iterations").notNull().default(3000),
    convergenceTolerance: doublePrecision("convergence_tolerance").notNull().default(1e-5),
    momentumScheme: text("momentum_scheme").notNull().default("linearUpwind"),
    transientCycles: doublePrecision("transient_cycles").notNull().default(10),
    transientDiscardFraction: doublePrecision("transient_discard_fraction").notNull().default(0.4),
    transientMaxCourant: doublePrecision("transient_max_courant").notNull().default(15),
    writeImages: jsonb("write_images")
      .$type<string[]>()
      .notNull()
      .default([...ALL_IMAGE_FIELDS]),
    imageZoomChords: doublePrecision("image_zoom_chords").notNull().default(2),
    // scheduling
    schedulingPolicy: text("scheduling_policy").notNull().default("auto"),
    cpuBudget: integer("cpu_budget"),
    caseConcurrency: integer("case_concurrency"),
    solverProcesses: integer("solver_processes"),
    // sweep definition
    aoaStart: doublePrecision("aoa_start").notNull().default(-8),
    aoaStop: doublePrecision("aoa_stop").notNull().default(20),
    aoaStep: doublePrecision("aoa_step").notNull().default(1),
    aoaList: jsonb("aoa_list").$type<number[] | null>(),
    enabled: boolean("enabled").notNull().default(true),
    isSeeded: boolean("is_seeded").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    mediumIdx: index("bc_medium_idx").on(t.mediumId),
    reIdx: index("bc_reynolds_idx").on(t.reynolds),
    enabledIdx: index("bc_enabled_idx").on(t.enabled),
  }),
);

export const simulationPresets = pgTable(
  "simulation_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    operatingConditionId: uuid("operating_condition_id").references(() => operatingConditions.id),
    flowConditionId: uuid("flow_condition_id")
      .notNull()
      .references(() => flowConditions.id),
    referenceGeometryProfileId: uuid("reference_geometry_profile_id")
      .notNull()
      .references(() => referenceGeometryProfiles.id),
    boundaryProfileId: uuid("boundary_profile_id")
      .notNull()
      .references(() => boundaryProfiles.id),
    meshProfileId: uuid("mesh_profile_id")
      .notNull()
      .references(() => meshProfiles.id),
    uransMeshProfileId: uuid("urans_mesh_profile_id").references(() => meshProfiles.id),
    uransPrecalcMeshProfileId: uuid("urans_precalc_mesh_profile_id").references(() => meshProfiles.id),
    solverProfileId: uuid("solver_profile_id")
      .notNull()
      .references(() => solverProfiles.id),
    schedulingProfileId: uuid("scheduling_profile_id")
      .notNull()
      .references(() => schedulingProfiles.id),
    outputProfileId: uuid("output_profile_id")
      .notNull()
      .references(() => outputProfiles.id),
    sweepDefinitionId: uuid("sweep_definition_id")
      .notNull()
      .references(() => sweepDefinitions.id),
    legacyBoundaryConditionId: uuid("legacy_boundary_condition_id").references(() => boundaryConditions.id),
    targetScope: presetTargetScopeEnum("target_scope").notNull().default("all"),
    // library | campaign — set ONCE at INSERT, never reassigned. No campaignId
    // column: campaign linkage is many-to-many via sim_campaign_conditions.
    origin: text("origin").notNull().default("library"),
    enabled: boolean("enabled").notNull().default(true),
    isSeeded: boolean("is_seeded").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    enabledIdx: index("simulation_presets_enabled_idx").on(t.enabled),
    legacyBcIdx: index("simulation_presets_legacy_bc_idx").on(t.legacyBoundaryConditionId),
  }),
);

export const simulationPresetAirfoilTargets = pgTable(
  "simulation_preset_airfoil_targets",
  {
    presetId: uuid("preset_id")
      .notNull()
      .references(() => simulationPresets.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.presetId, t.airfoilId] }),
    presetIdx: index("simulation_preset_targets_preset_idx").on(t.presetId),
    airfoilIdx: index("simulation_preset_targets_airfoil_idx").on(t.airfoilId),
  }),
);

export const simulationPresetRevisions = pgTable(
  "simulation_preset_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    presetId: uuid("preset_id")
      .notNull()
      .references(() => simulationPresets.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    signatureHash: text("signature_hash").notNull(),
    reynolds: bigint("reynolds", { mode: "number" }).notNull(),
    mach: doublePrecision("mach"),
    referenceLengthM: doublePrecision("reference_length_m").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    // sha256 over ONLY the physics+numerics snapshot blocks (see
    // physicsHashForSnapshot in simulation-setup.ts). Nullable until backfilled.
    physicsHash: text("physics_hash"),
    // Deterministic canonical-revision election per physicsHash: the campaign
    // launch materializer reuses the canonical row (prefer enabled-preset
    // revision, else oldest createdAt, tie-break lowest id).
    isCanonicalPhysics: boolean("is_canonical_physics").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    presetIdx: index("simulation_preset_revisions_preset_idx").on(t.presetId),
    reynoldsIdx: index("simulation_preset_revisions_reynolds_idx").on(t.reynolds),
    signatureUq: uniqueIndex("simulation_preset_revisions_signature_uq").on(t.presetId, t.signatureHash),
    revisionUq: uniqueIndex("simulation_preset_revisions_revision_uq").on(t.presetId, t.revisionNumber),
    physicsHashIdx: index("simulation_preset_revisions_physics_hash_idx").on(t.physicsHash),
    canonicalPhysicsUq: uniqueIndex("simulation_preset_revisions_canonical_physics_uq")
      .on(t.physicsHash)
      .where(sql`${t.isCanonicalPhysics}`),
  }),
);

// ---------------------------------------------------------------------------
// 5. Results — per (airfoil, preset revision, aoa) fact table. `bc_id` is
//    retained during migration as a deprecated compatibility bridge.
// ---------------------------------------------------------------------------
export const results = pgTable(
  "results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcId: uuid("bc_id")
      .notNull()
      .references(() => boundaryConditions.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id").references(() => simulationPresetRevisions.id),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    status: resultStatusEnum("status").notNull().default("pending"),
    source: dataSourceEnum("source").notNull().default("queued"),
    regime: regimeEnum("regime"),
    // derived operating point at solve time
    reynolds: bigint("reynolds", { mode: "number" }),
    speed: doublePrecision("speed"),
    chord: doublePrecision("chord"),
    mach: doublePrecision("mach"),
    // PolarPoint payload
    cl: doublePrecision("cl"),
    cd: doublePrecision("cd"),
    cm: doublePrecision("cm"),
    clCd: doublePrecision("cl_cd"),
    clStd: doublePrecision("cl_std"),
    cdStd: doublePrecision("cd_std"),
    cmStd: doublePrecision("cm_std"),
    stalled: boolean("stalled").notNull().default(false),
    unsteady: boolean("unsteady").notNull().default(false),
    converged: boolean("converged").notNull().default(false),
    finalResidual: doublePrecision("final_residual"),
    iterations: integer("iterations"),
    yPlusAvg: doublePrecision("y_plus_avg"),
    yPlusMax: doublePrecision("y_plus_max"),
    nCells: integer("n_cells"),
    firstOrderFallback: boolean("first_order_fallback").notNull().default(false),
    strouhal: doublePrecision("strouhal"),
    error: text("error"),
    /** Engine per-point non-fatal quality warnings (PolarPoint.quality_warnings),
     *  persisted at ingest. NULL on pre-0030 rows — honest absence, no backfill. */
    qualityWarnings: text("quality_warnings").array(),
    /** URANS frame-track contract payload (PolarPoint.frame_track, migration
     *  0032): period-locked recording window, time-weighted stats, <=120
     *  frame samples, image_pattern. Persisted verbatim (snake_case engine
     *  shape). NULL = steady/no-shedding point OR legacy pre-contract
     *  evidence — the classifier's stationarity gate applies only to non-NULL
     *  values, so history is never mass-rejected by deploy. */
    frameTrack: jsonb("frame_track"),
    /** Fidelity ladder tier this row's evidence was solved at (contract 3,
     *  migration 0034): 'rans' | 'urans_precalc' | 'urans_full'. Echoed by the
     *  engine on PolarPoint.fidelity; backfill graded pre-ladder urans rows
     *  'urans_full' and steady rows 'rans'. NULL = unsolved row. */
    fidelity: text("fidelity"),
    /** Oscillating-averaged steady solve evidence (contract 2, migration
     *  0034): { iterations[], cl[], cd[], cm[], window{start_iter,end_iter},
     *  mean_stable, note }, <=2000 samples downsampled engine-side. NULL =
     *  classic pointwise convergence or legacy pre-contract evidence.
     *  result_attempts carry it inside evidence_payload (whole PolarPoint). */
    steadyHistory: jsonb("steady_history"),
    /** Auto-retry-once marker (migration 0036): set when the sweeper's
     *  crash-class auto-retry requeued this cell after a failed ingest. A row
     *  that fails AGAIN with this set escalates to needs_review instead of a
     *  second silent retry. Deliberately NEVER written by the ingest upsert
     *  (absent from its SET list), so it survives re-ingest of the same
     *  failed job. NULL = never auto-retried. */
    autoRetriedAt: timestamp("auto_retried_at", { withTimezone: true }),
    // linkage to the engine run
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, { onDelete: "set null" }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    priority: integer("priority").notNull().default(0),
    solvedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    naturalUq: uniqueIndex("results_revision_natural_uq").on(t.airfoilId, t.simulationPresetRevisionId, t.aoaDeg),
    airfoilBcIdx: index("results_airfoil_bc_idx").on(t.airfoilId, t.bcId),
    bcIdx: index("results_bc_idx").on(t.bcId),
    presetRevisionIdx: index("results_preset_revision_idx").on(t.simulationPresetRevisionId),
    statusIdx: index("results_status_idx").on(t.status),
    simJobIdx: index("results_sim_job_idx").on(t.simJobId),
    catalogMetricsIdx: index("results_catalog_metrics_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.status,
      t.source,
      t.regime,
      t.aoaDeg,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 6. Result attempts — immutable-ish solver evidence snapshots.
//    The results table is the canonical per-airfoil/BC/AoA state. Attempts keep
//    rejected RANS and replacement URANS outputs available for audit/exploration.
// ---------------------------------------------------------------------------
export const resultAttempts = pgTable(
  "result_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcId: uuid("bc_id")
      .notNull()
      .references(() => boundaryConditions.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id").references(() => simulationPresetRevisions.id),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, { onDelete: "set null" }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    status: resultStatusEnum("status").notNull().default("done"),
    source: dataSourceEnum("source").notNull().default("solved"),
    regime: regimeEnum("regime"),
    validForPolar: boolean("valid_for_polar").notNull().default(false),
    cl: doublePrecision("cl"),
    cd: doublePrecision("cd"),
    cm: doublePrecision("cm"),
    clCd: doublePrecision("cl_cd"),
    clStd: doublePrecision("cl_std"),
    cdStd: doublePrecision("cd_std"),
    cmStd: doublePrecision("cm_std"),
    stalled: boolean("stalled").notNull().default(false),
    unsteady: boolean("unsteady").notNull().default(false),
    converged: boolean("converged").notNull().default(false),
    finalResidual: doublePrecision("final_residual"),
    iterations: integer("iterations"),
    yPlusAvg: doublePrecision("y_plus_avg"),
    yPlusMax: doublePrecision("y_plus_max"),
    nCells: integer("n_cells"),
    firstOrderFallback: boolean("first_order_fallback").notNull().default(false),
    strouhal: doublePrecision("strouhal"),
    error: text("error"),
    /** Engine per-attempt non-fatal quality warnings (PolarPoint.quality_warnings)
     *  — the honest "why" lines on the point-story timeline. NULL on pre-0030
     *  attempts (no backfill; absence is shown as absence). */
    qualityWarnings: text("quality_warnings").array(),
    evidencePayload: jsonb("evidence_payload"),
    solvedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    resultIdx: index("result_attempts_result_idx").on(t.resultId),
    airfoilBcIdx: index("result_attempts_airfoil_bc_idx").on(t.airfoilId, t.bcId),
    presetRevisionIdx: index("result_attempts_preset_revision_idx").on(t.simulationPresetRevisionId),
    simJobIdx: index("result_attempts_sim_job_idx").on(t.simJobId),
    validIdx: index("result_attempts_valid_idx").on(t.validForPolar),
    catalogRejectedIdx: index("result_attempts_catalog_rejected_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.status,
      t.source,
      t.regime,
      t.validForPolar,
      t.aoaDeg,
    ),
    attemptUq: uniqueIndex("result_attempts_job_aoa_regime_uq").on(t.simJobId, t.engineJobId, t.aoaDeg, t.regime),
  }),
);

// ---------------------------------------------------------------------------
// 7. Field extents, shared track color scales, and result media.
// ---------------------------------------------------------------------------
export const fieldColorScales = pgTable(
  "field_color_scales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    renderProfileKey: text("render_profile_key").notNull().default("default:v1:zoom2"),
    scalePolicy: text("scale_policy").notNull(),
    vmin: doublePrecision("vmin").notNull(),
    vmax: doublePrecision("vmax").notNull(),
    evidenceSignature: text("evidence_signature").notNull(),
    status: colorScaleStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull(),
    active: boolean("active").notNull().default(true),
    failureReason: text("failure_reason"),
    /** FAILED render attempts for this scale row; the sweeper retries
     *  status='failed' rows until this reaches MAX_SCALE_RENDER_ATTEMPTS. */
    renderAttempts: integer("render_attempts").notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    activatedAt: ts(),
  },
  (t) => ({
    scopeIdx: index("field_color_scales_scope_idx").on(t.airfoilId, t.simulationPresetRevisionId, t.field, t.renderProfileKey),
    activeUq: uniqueIndex("field_color_scales_active_uq")
      .on(t.airfoilId, t.simulationPresetRevisionId, t.field, t.renderProfileKey)
      .where(sql`${t.active}`),
    versionUq: uniqueIndex("field_color_scales_version_uq").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.field,
      t.renderProfileKey,
      t.version,
    ),
  }),
);

export const resultFieldExtents = pgTable(
  "result_field_extents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    renderProfileKey: text("render_profile_key").notNull().default("default:v1:zoom2"),
    vmin: doublePrecision("vmin").notNull(),
    vmax: doublePrecision("vmax").notNull(),
    finiteCount: integer("finite_count").notNull(),
    sourceTimeStart: doublePrecision("source_time_start"),
    sourceTimeEnd: doublePrecision("source_time_end"),
    evidenceSha256: text("evidence_sha256").notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    resultIdx: index("result_field_extents_result_idx").on(t.resultId),
    scopeIdx: index("result_field_extents_scope_idx").on(t.airfoilId, t.simulationPresetRevisionId, t.field, t.renderProfileKey),
    uq: uniqueIndex("result_field_extents_result_field_uq").on(t.resultId, t.field, t.renderProfileKey),
  }),
);

export const resultMedia = pgTable(
  "result_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    kind: mediaKindEnum("kind").notNull(),
    field: text("field"),
    role: mediaRoleEnum("role").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    frameCount: integer("frame_count"),
    durationS: doublePrecision("duration_s"),
    colorScaleId: uuid("color_scale_id").references(() => fieldColorScales.id, { onDelete: "set null" }),
    colorScaleVersion: integer("color_scale_version"),
    scaleVmin: doublePrecision("scale_vmin"),
    scaleVmax: doublePrecision("scale_vmax"),
    scalePolicy: text("scale_policy"),
    renderProfileKey: text("render_profile_key").notNull().default("default:v1:zoom2"),
    engineUrl: text("engine_url"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    resultIdx: index("result_media_result_idx").on(t.resultId),
    uq: uniqueIndex("result_media_uq").on(t.resultId, t.kind, t.field, t.role),
  }),
);

// ---------------------------------------------------------------------------
// 8. Solver evidence artifacts and custom field render cache.
// ---------------------------------------------------------------------------
export const solverEvidenceArtifacts = pgTable(
  "solver_evidence_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    resultAttemptId: uuid("result_attempt_id").references((): AnyPgColumn => resultAttempts.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, { onDelete: "set null" }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    aoaDeg: doublePrecision("aoa_deg"),
    kind: evidenceArtifactKindEnum("kind").notNull(),
    field: text("field"),
    role: text("role"),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    engineUrl: text("engine_url"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    resultIdx: index("solver_evidence_artifacts_result_idx").on(t.resultId),
    attemptIdx: index("solver_evidence_artifacts_attempt_idx").on(t.resultAttemptId),
    airfoilIdx: index("solver_evidence_artifacts_airfoil_idx").on(t.airfoilId, t.aoaDeg),
    storageUq: uniqueIndex("solver_evidence_artifacts_storage_uq").on(t.storageKey, t.sha256),
  }),
);

export const fieldRenderCache = pgTable(
  "field_render_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    role: text("role").notNull().default("instantaneous"),
    paramsHash: text("params_hash").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    kind: mediaKindEnum("kind").notNull().default("image"),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    frameCount: integer("frame_count"),
    durationS: doublePrecision("duration_s"),
    engineUrl: text("engine_url"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    resultIdx: index("field_render_cache_result_idx").on(t.resultId),
    renderUq: uniqueIndex("field_render_cache_result_params_uq").on(t.resultId, t.field, t.role, t.paramsHash),
  }),
);

// ---------------------------------------------------------------------------
// 9. Force history — URANS Cl(t)/Cd(t) as columnar jsonb (1:1 with a result).
// ---------------------------------------------------------------------------
export const forceHistory = pgTable("force_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  resultId: uuid("result_id")
    .notNull()
    .unique()
    .references(() => results.id, { onDelete: "cascade" }),
  t: jsonb("t").$type<number[]>().notNull(),
  cl: jsonb("cl").$type<number[]>().notNull(),
  cd: jsonb("cd").$type<number[]>().notNull(),
  cm: jsonb("cm").$type<number[]>(),
  clMean: doublePrecision("cl_mean"),
  clRms: doublePrecision("cl_rms"),
  cdMean: doublePrecision("cd_mean"),
  cdRms: doublePrecision("cd_rms"),
  strouhal: doublePrecision("strouhal"),
  sheddingFreqHz: doublePrecision("shedding_freq_hz"),
  sampleCount: integer("sample_count"),
  createdAt: ts().notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 10. Result classifications and fitted polar cache — solver evidence stays
//    immutable, while this derived layer tells the product which evidence is
//    accepted, provisional, superseded, or rejected for polar display/search.
// ---------------------------------------------------------------------------
export const resultClassifications = pgTable(
  "result_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    resultAttemptId: uuid("result_attempt_id").references((): AnyPgColumn => resultAttempts.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    regime: regimeEnum("regime"),
    classifierVersion: text("classifier_version").notNull(),
    state: resultClassificationStateEnum("state").notNull(),
    region: resultClassificationRegionEnum("region").notNull().default("unknown"),
    confidence: doublePrecision("confidence").notNull().default(1),
    reasons: text("reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    supersededByResultId: uuid("superseded_by_result_id").references((): AnyPgColumn => results.id, {
      onDelete: "set null",
    }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    resultUq: uniqueIndex("result_classifications_result_uq").on(t.resultId),
    attemptUq: uniqueIndex("result_classifications_attempt_uq").on(t.resultAttemptId),
    polarIdx: index("result_classifications_polar_idx").on(t.airfoilId, t.simulationPresetRevisionId, t.state, t.aoaDeg),
  }),
);

export const polarFitSets = pgTable(
  "polar_fit_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    fitVersion: text("fit_version").notNull(),
    evidenceSignature: text("evidence_signature").notNull(),
    status: polarFitStatusEnum("status").notNull(),
    confidence: doublePrecision("confidence").notNull().default(0),
    acceptedPointCount: integer("accepted_point_count").notNull().default(0),
    provisionalPointCount: integer("provisional_point_count").notNull().default(0),
    rejectedPointCount: integer("rejected_point_count").notNull().default(0),
    reynolds: bigint("reynolds", { mode: "number" }),
    mach: doublePrecision("mach"),
    ldmax: doublePrecision("ldmax"),
    alphaLdmax: doublePrecision("alpha_ldmax"),
    // Fine refinement targets computed inside buildPolarFit (densified argmax /
    // root near the coarse grid value, canonical 0.01°) — see spec §8.
    alphaLdmaxFine: doublePrecision("alpha_ldmax_fine"),
    alphaClZeroFine: doublePrecision("alpha_cl_zero_fine"),
    alphaClmaxFine: doublePrecision("alpha_cl_max_fine"),
    clmax: doublePrecision("clmax"),
    alphaClmax: doublePrecision("alpha_clmax"),
    cdmin: doublePrecision("cdmin"),
    clAtCdmin: doublePrecision("cl_at_cdmin"),
    cd0: doublePrecision("cd0"),
    cm0: doublePrecision("cm0"),
    aoaMin: doublePrecision("aoa_min"),
    aoaMax: doublePrecision("aoa_max"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    fitUq: uniqueIndex("polar_fit_sets_signature_uq").on(t.airfoilId, t.simulationPresetRevisionId, t.fitVersion, t.evidenceSignature),
    airfoilIdx: index("polar_fit_sets_airfoil_idx").on(t.airfoilId, t.isCurrent, t.status),
    revisionIdx: index("polar_fit_sets_revision_idx").on(t.simulationPresetRevisionId),
  }),
);

export const polarFitPoints = pgTable(
  "polar_fit_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitSetId: uuid("fit_set_id")
      .notNull()
      .references(() => polarFitSets.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    cl: doublePrecision("cl").notNull(),
    cd: doublePrecision("cd").notNull(),
    cm: doublePrecision("cm").notNull(),
    clCd: doublePrecision("cl_cd").notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    fitSetIdx: index("polar_fit_points_fit_set_idx").on(t.fitSetId),
    fitAoaUq: uniqueIndex("polar_fit_points_aoa_uq").on(t.fitSetId, t.aoaDeg),
  }),
);

// ---------------------------------------------------------------------------
// 11. Sim jobs — maps Postgres intent to a Python engine job_id (two-wave).
// ---------------------------------------------------------------------------
export const simJobs = pgTable(
  "sim_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engineJobId: text("engine_job_id"),
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => simJobs.id, { onDelete: "set null" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcIds: jsonb("bc_ids").$type<string[]>().notNull(),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id").references(() => simulationPresetRevisions.id),
    campaignId: uuid("campaign_id").references((): AnyPgColumn => simCampaigns.id, { onDelete: "set null" }),
    jobKind: text("job_kind").notNull().default("sweep"), // sweep | targeted
    referenceChordM: doublePrecision("reference_chord_m").notNull(),
    wave: integer("wave").notNull().default(1),
    status: simJobStatusEnum("status").notNull().default("pending"),
    totalCases: integer("total_cases").notNull().default(0),
    completedCases: integer("completed_cases").notNull().default(0),
    requestPayload: jsonb("request_payload"),
    engineState: text("engine_state"),
    error: text("error"),
    submittedAt: ts(),
    polledAt: ts(),
    ingestedAt: ts(),
    finishedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusIdx: index("sim_jobs_status_idx").on(t.status),
    engineJobIdx: index("sim_jobs_engine_job_idx").on(t.engineJobId),
    airfoilIdx: index("sim_jobs_airfoil_idx").on(t.airfoilId),
    presetRevisionIdx: index("sim_jobs_preset_revision_idx").on(t.simulationPresetRevisionId),
    campaignIdx: index("sim_jobs_campaign_idx").on(t.campaignId),
  }),
);

// ---------------------------------------------------------------------------
// 12. Sweeper state — single control row (id = 1).
// ---------------------------------------------------------------------------
export const sweeperState = pgTable("sweeper_state", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(2),
  // THE single global solver-capacity setting ("OpenFOAM CPU slots").
  // 0 = auto: submit jobs without a cpu_budget cap so the engine resolves its
  // own worker budget — exactly the pre-campaign effective behavior (scheduling
  // profiles defaulted cpuBudget to NULL). Job building passes a positive value
  // into the engine `resources` block; maxConcurrentJobs is subordinate to it.
  cpuSlots: integer("cpu_slots").notNull().default(0),
  // Engine-down backoff (spec §7): set when a submit-path probe/submit fails
  // with a connection error, cleared on the first successful probe/submit.
  // While set, Queue + campaign pages show one truthful "Engine unreachable
  // since …" banner; job status `failed` stays reserved for jobs the engine
  // actually rejected/ran.
  engineUnreachableSince: ts(),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(5000),
  submitIntervalMs: integer("submit_interval_ms").notNull().default(15000),
  heartbeatAt: ts(),
  // Liveness/progress split (migration 0033): heartbeatAt is written by an
  // INDEPENDENT 15 s timer in the sweeper process (pure liveness — stale >90 s
  // now really means process death), while these two are stamped by the loop
  // at tick begin/end (pure progress). A fresh heartbeat with a started-but-
  // not-completed tick older than 5 min derives the AMBER tick_stalled state
  // instead of a false red "PROCESS NOT RUNNING" (2026-07-06 prod incident:
  // one hung engine HTTP call starved the in-tick heartbeat writes).
  lastTickStartedAt: ts(),
  lastTickCompletedAt: ts(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// 12b. Simulation campaigns — user-launched batch execution records (spec:
//     docs/simulation-campaigns-spec.md §3.1). Campaigns own NO physics values:
//     every condition pins an immutable simulation_preset_revisions row, and
//     points/lanes/progress are pure execution ledger state. Status/state
//     domains are plain text (Python-mirroring/growing domains policy above).
// ---------------------------------------------------------------------------
export const simCampaigns = pgTable(
  "sim_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(), // auto-suffixed -2, -3 on collision at launch
    name: text("name").notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("active"), // active | paused | attention | completed | cancelled | archived
    priority: integer("priority").notNull().default(5),
    idempotencyKey: text("idempotency_key").notNull(), // client-generated at Review; replay returns the existing campaign
    currentPlanRevisionId: uuid("current_plan_revision_id").references(
      (): AnyPgColumn => simCampaignPlanRevisions.id,
    ),
    closedWithFailedCount: integer("closed_with_failed_count"), // set by "Close with failures"
    closedWithRejectedCount: integer("closed_with_rejected_count"), // set alongside; null on pre-0028 closes (unknown, not zero)
    completedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugUq: uniqueIndex("sim_campaigns_slug_uq").on(t.slug),
    idempotencyKeyUq: uniqueIndex("sim_campaigns_idempotency_key_uq").on(t.idempotencyKey),
    statusIdx: index("sim_campaigns_status_idx").on(t.status),
    priorityCheck: check("sim_campaigns_priority_check", sql`${t.priority} >= 0 AND ${t.priority} <= 9`),
  }),
);

// Campaign scope resolved to an explicit airfoil list at launch; growth is via
// the Add airfoils action only.
export const simCampaignAirfoils = pgTable(
  "sim_campaign_airfoils",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.airfoilId] }),
    airfoilIdx: index("sim_campaign_airfoils_airfoil_idx").on(t.airfoilId),
  }),
);

// Append-only audit trail of the campaign's editable intent; also the
// optimistic-concurrency anchor for the plan-edit acknowledge protocol.
export const simCampaignPlanRevisions = pgTable(
  "sim_campaign_plan_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    kind: text("kind").notNull(), // initial | edit | force_release
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(), // canonical byte-stable plan document (spec §3.1)
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    revisionUq: uniqueIndex("sim_campaign_plan_revisions_revision_uq").on(t.campaignId, t.revisionNumber),
    campaignIdx: index("sim_campaign_plan_revisions_campaign_idx").on(t.campaignId),
  }),
);

export const simCampaignConditions = pgTable(
  "sim_campaign_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    // Provenance only — display reads the pinned revision snapshot, never live
    // registry rows.
    flowConditionId: uuid("flow_condition_id")
      .notNull()
      .references(() => flowConditions.id),
    referenceGeometryProfileId: uuid("reference_geometry_profile_id")
      .notNull()
      .references(() => referenceGeometryProfiles.id),
    presetId: uuid("preset_id")
      .notNull()
      .references(() => simulationPresets.id),
    // PINNED at creation, never re-pinned.
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id),
    // Cached from the pinned revision.
    reynolds: bigint("reynolds", { mode: "number" }).notNull(),
    mach: doublePrecision("mach"),
    status: text("status").notNull().default("active"), // active | kept | released
    introducedInPlanRevisionId: uuid("introduced_in_plan_revision_id")
      .notNull()
      .references(() => simCampaignPlanRevisions.id),
    statusChangedInPlanRevisionId: uuid("status_changed_in_plan_revision_id").references(
      () => simCampaignPlanRevisions.id,
    ),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Re-adding a previously released combo RE-ACTIVATES this row (same pinned
    // revision; evidence continuity; no duplicate rows).
    comboUq: uniqueIndex("sim_campaign_conditions_combo_uq").on(
      t.campaignId,
      t.flowConditionId,
      t.referenceGeometryProfileId,
    ),
    campaignStatusIdx: index("sim_campaign_conditions_campaign_status_idx").on(t.campaignId, t.status),
    revisionIdx: index("sim_campaign_conditions_revision_idx").on(t.simulationPresetRevisionId),
  }),
);

// Materialized execution ledger: one row per requested solve cell. Writes are
// set-based (INSERT…SELECT ON CONFLICT DO NOTHING; UPDATE…FROM results).
export const simCampaignPoints = pgTable(
  "sim_campaign_points",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    conditionId: uuid("condition_id")
      .notNull()
      .references(() => simCampaignConditions.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(), // canonicalAoa at every write
    revisionId: uuid("revision_id").notNull(), // denormalized pin (join key with results)
    planRevisionNumber: integer("plan_revision_number").notNull(),
    state: text("state").notNull().default("requested"), // requested | released | terminal
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "set null" }),
    // Negative-α cells of symmetric airfoils; terminal immediately when the +α
    // source is terminal (spec §9).
    derivedBySymmetry: boolean("derived_by_symmetry").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.conditionId, t.airfoilId, t.aoaDeg] }),
    requestedIdx: index("sim_campaign_points_requested_idx")
      .on(t.campaignId)
      .where(sql`${t.state} = 'requested'`),
    requestedRevisionIdx: index("sim_campaign_points_requested_revision_idx")
      .on(t.revisionId, t.airfoilId, t.aoaDeg)
      .where(sql`${t.state} = 'requested'`),
    resultIdx: index("sim_campaign_points_result_idx").on(t.resultId),
  }),
);

// Counters — the only thing polled reads scan. Written at launch/plan-edit in
// the same transaction, incremented in the sweeper ingest path, healed by a
// low-frequency reconciler. Completion flip = counter comparison on ingest.
export const simCampaignProgress = pgTable(
  "sim_campaign_progress",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    conditionId: uuid("condition_id")
      .notNull()
      .references(() => simCampaignConditions.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    requested: integer("requested").notNull().default(0),
    solved: integer("solved").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    running: integer("running").notNull().default(0),
    superseded: integer("superseded").notNull().default(0),
    derived: integer("derived").notNull().default(0),
    // Terminal-done points whose result CLASSIFIED rejected (physics-invalid
    // evidence). Excluded from solved — surfaced like failed so a campaign
    // never books a rejected point as solved work.
    rejected: integer("rejected").notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.conditionId, t.airfoilId] }),
    conditionIdx: index("sim_campaign_progress_condition_idx").on(t.conditionId),
  }),
);

// One refinement track per (airfoil, condition, objective) — spec §8.
export const simCampaignLanes = pgTable(
  "sim_campaign_lanes",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    conditionId: uuid("condition_id")
      .notNull()
      .references(() => simCampaignConditions.id, { onDelete: "cascade" }),
    objective: text("objective").notNull(), // ld_max | cl_zero
    // awaiting_seed | iterating | converged_provisional | converged_final |
    // converged_window | converged_stale | stalled | insufficient_evidence |
    // failed | symmetric_definition
    state: text("state").notNull().default("awaiting_seed"),
    currentTargetAlpha: doublePrecision("current_target_alpha"),
    iterationCount: integer("iteration_count").notNull().default(0),
    // The fit convergence was judged against.
    witnessFitSetId: uuid("witness_fit_set_id").references(() => polarFitSets.id, { onDelete: "set null" }),
    extraRoundsGranted: integer("extra_rounds_granted").notNull().default(0), // "Continue +N iterations"
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.airfoilId, t.conditionId, t.objective] }),
    stateIdx: index("sim_campaign_lanes_state_idx").on(t.campaignId, t.objective, t.state),
  }),
);

// Append-only refinement evidence: one row per lane iteration.
export const simCampaignLaneSteps = pgTable(
  "sim_campaign_lane_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").notNull(),
    airfoilId: uuid("airfoil_id").notNull(),
    conditionId: uuid("condition_id").notNull(),
    objective: text("objective").notNull(),
    iteration: integer("iteration").notNull(),
    predictedAlpha: doublePrecision("predicted_alpha").notNull(), // canonical 0.01°
    fitSetId: uuid("fit_set_id")
      .notNull()
      .references(() => polarFitSets.id),
    solvedResultId: uuid("solved_result_id").references((): AnyPgColumn => results.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull().default("predicted"), // predicted | solved | superseded | released
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    laneFk: foreignKey({
      columns: [t.campaignId, t.airfoilId, t.conditionId, t.objective],
      foreignColumns: [
        simCampaignLanes.campaignId,
        simCampaignLanes.airfoilId,
        simCampaignLanes.conditionId,
        simCampaignLanes.objective,
      ],
      name: "sim_campaign_lane_steps_lane_fk",
    }).onDelete("cascade"),
    iterationUq: uniqueIndex("sim_campaign_lane_steps_iteration_uq").on(
      t.campaignId,
      t.airfoilId,
      t.conditionId,
      t.objective,
      t.iteration,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 12c. URANS fidelity ladder (migration 0034).
//   sim_urans_verify_queue (pinned contract 4): precalc-accepted points queued
//   for a full-fidelity verification re-solve at the LOWEST scheduler rank.
//   sim_urans_requests (contract 6): admin request-URANS work items scheduled
//   at precalc rank, idempotent per (cell, fidelity); aoaDeg NULL = whole polar.
// ---------------------------------------------------------------------------
export const simUransVerifyQueue = pgTable(
  "sim_urans_verify_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    campaignId: uuid("campaign_id").references((): AnyPgColumn => simCampaigns.id, { onDelete: "set null" }),
    // pending | running | done | disagreed | cancelled
    state: text("state").notNull().default("pending"),
    precalcResultId: uuid("precalc_result_id")
      .notNull()
      .references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    verifyResultId: uuid("verify_result_id").references((): AnyPgColumn => results.id, { onDelete: "set null" }),
    deltaCl: doublePrecision("delta_cl"),
    deltaCd: doublePrecision("delta_cd"),
    deltaCm: doublePrecision("delta_cm"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Idempotent enqueue: one open item per cell (partial unique).
    openCellUq: uniqueIndex("sim_urans_verify_queue_open_cell_uq")
      .on(t.airfoilId, t.revisionId, t.aoaDeg)
      .where(sql`${t.state} IN ('pending', 'running')`),
    stateIdx: index("sim_urans_verify_queue_state_idx").on(t.state),
    campaignIdx: index("sim_urans_verify_queue_campaign_idx").on(t.campaignId, t.state),
  }),
);

export const simUransRequests = pgTable(
  "sim_urans_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    /** NULL = whole polar (every angle of the pinned revision's sweep). */
    aoaDeg: doublePrecision("aoa_deg"),
    // precalc | full (contract 1 request fidelities)
    fidelity: text("fidelity").notNull(),
    // pending | running | done | cancelled
    state: text("state").notNull().default("pending"),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, { onDelete: "set null" }),
    /** Continuation (migration 0037, amendment C): the rejected results row
     *  whose SAVED engine case state (engine_job_id + engine_case_slug on that
     *  row) this request resumes from. The ladder tick composes
     *  { continue_from: { engine_job_id, case_slug } } into the engine request
     *  and the engine restarts the transient from latestTime, merging
     *  coefficient history. NULL = ordinary fresh-solve request. */
    continueFromResultId: uuid("continue_from_result_id").references((): AnyPgColumn => results.id, { onDelete: "set null" }),
    /** Continuation budget override [s]: replaces the fidelity-derived solver
     *  budget for the resumed run (+2h / +6h UI choices). NULL = tier default. */
    budgetOverrideS: integer("budget_override_s"),
    requestedBy: text("requested_by"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // The idempotency unique index is an EXPRESSION index (COALESCE(aoa_deg,
    // 'NaN')) created in raw SQL by migration 0034 — drizzle cannot express it.
    stateIdx: index("sim_urans_requests_state_idx").on(t.state),
  }),
);

// ---------------------------------------------------------------------------
// 13. Cross-instance sync — settings, permissions, external scheduling leases,
//     and reviewable import conflicts. Promises are scheduling metadata only;
//     real solver evidence still lands in results/result_attempts/artifacts.
// ---------------------------------------------------------------------------
export const syncApiSettings = pgTable("sync_api_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  instanceId: uuid("instance_id").notNull().defaultRandom(),
  instanceName: text("instance_name").notNull().default("XFoilFOAM instance"),
  publicEndpointOverride: text("public_endpoint_override"),
  secret: text("secret").notNull().default(""),
  defaultPromiseTtlHours: integer("default_promise_ttl_hours").notNull().default(24),
  upstreamBaseUrl: text("upstream_base_url"),
  upstreamSecret: text("upstream_secret").notNull().default(""),
  syncMode: syncModeEnum("sync_mode").notNull().default("full"),
  remoteSolverEnabled: boolean("remote_solver_enabled").notNull().default(false),
  remoteSolverCpuBudget: integer("remote_solver_cpu_budget").notNull().default(1),
  remoteSolverClaimSize: integer("remote_solver_claim_size").notNull().default(36),
  remoteSolverHeartbeatIntervalSeconds: integer("remote_solver_heartbeat_interval_seconds").notNull().default(60),
  remoteSolverRegisteredId: uuid("remote_solver_registered_id"),
  remoteSolverLastSyncAt: timestamp("remote_solver_last_sync_at", { withTimezone: true }),
  remoteSolverLastPromiseAt: timestamp("remote_solver_last_promise_at", { withTimezone: true }),
  remoteSolverLastPushAt: timestamp("remote_solver_last_push_at", { withTimezone: true }),
  remoteSolverLastStatus: remoteSolverStatusEnum("remote_solver_last_status").notNull().default("disabled"),
  remoteSolverLastError: text("remote_solver_last_error"),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const syncApiPermissions = pgTable("sync_api_permissions", {
  dataType: syncDataTypeEnum("data_type").primaryKey(),
  canFetch: boolean("can_fetch").notNull().default(false),
  canPush: boolean("can_push").notNull().default(false),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const syncSweepPromises = pgTable(
  "sync_sweep_promises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceInstanceId: text("source_instance_id"),
    sourceInstanceName: text("source_instance_name"),
    sourceBaseUrl: text("source_base_url"),
    status: syncPromiseStatusEnum("status").notNull().default("active"),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaCount: integer("aoa_count").notNull().default(0),
    expiresAt: ts().notNull(),
    fulfilledAt: ts(),
    cancelledAt: ts(),
    expiredAt: ts(),
    lastHeartbeatAt: ts(),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>(),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusIdx: index("sync_sweep_promises_status_idx").on(t.status),
    expiresIdx: index("sync_sweep_promises_expires_idx").on(t.expiresAt),
    scopeIdx: index("sync_sweep_promises_scope_idx").on(t.airfoilId, t.simulationPresetRevisionId),
  }),
);

export const syncSweepPromisePoints = pgTable(
  "sync_sweep_promise_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promiseId: uuid("promise_id")
      .notNull()
      .references(() => syncSweepPromises.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    status: syncPromiseStatusEnum("status").notNull().default("active"),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    promiseIdx: index("sync_sweep_promise_points_promise_idx").on(t.promiseId),
    statusIdx: index("sync_sweep_promise_points_status_idx").on(t.status),
    scopeIdx: index("sync_sweep_promise_points_scope_idx").on(t.airfoilId, t.simulationPresetRevisionId, t.aoaDeg),
    activePointUq: uniqueIndex("sync_sweep_promise_points_active_uq")
      .on(t.airfoilId, t.simulationPresetRevisionId, t.aoaDeg)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const syncImportConflicts = pgTable(
  "sync_import_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataType: syncDataTypeEnum("data_type").notNull(),
    naturalKey: text("natural_key").notNull(),
    sourceInstanceId: text("source_instance_id"),
    sourceInstanceName: text("source_instance_name"),
    status: syncImportConflictStatusEnum("status").notNull().default("pending"),
    incomingPayload: jsonb("incoming_payload").$type<Record<string, unknown>>().notNull(),
    localSnapshot: jsonb("local_snapshot").$type<Record<string, unknown>>(),
    artifactManifest: jsonb("artifact_manifest").$type<Record<string, unknown>>(),
    resolutionNote: text("resolution_note"),
    resolvedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusIdx: index("sync_import_conflicts_status_idx").on(t.status),
    naturalKeyIdx: index("sync_import_conflicts_natural_key_idx").on(t.dataType, t.naturalKey),
  }),
);

export const registeredRemoteSolvers = pgTable(
  "registered_remote_solvers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("instance_id").notNull(),
    instanceName: text("instance_name").notNull(),
    publicEndpoint: text("public_endpoint"),
    localEndpoint: text("local_endpoint"),
    cpuCapacity: integer("cpu_capacity").notNull().default(0),
    cpuBudget: integer("cpu_budget").notNull().default(0),
    buildVersion: text("build_version"),
    status: remoteSolverStatusEnum("status").notNull().default("idle"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    activePromiseCount: integer("active_promise_count").notNull().default(0),
    activeAoaCount: integer("active_aoa_count").notNull().default(0),
    solvedCount: integer("solved_count").notNull().default(0),
    pushedCount: integer("pushed_count").notNull().default(0),
    recentError: text("recent_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    instanceUq: uniqueIndex("registered_remote_solvers_instance_uq").on(t.instanceId),
    statusIdx: index("registered_remote_solvers_status_idx").on(t.status),
    heartbeatIdx: index("registered_remote_solvers_heartbeat_idx").on(t.lastHeartbeatAt),
  }),
);

export const remoteAssetReferences = pgTable(
  "remote_asset_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localKind: text("local_kind").notNull(),
    localRowId: uuid("local_row_id"),
    localStorageKey: text("local_storage_key").notNull(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    resultAttemptId: uuid("result_attempt_id").references((): AnyPgColumn => resultAttempts.id, { onDelete: "set null" }),
    sourceInstanceId: text("source_instance_id"),
    sourceInstanceName: text("source_instance_name"),
    remoteResultId: text("remote_result_id"),
    remoteArtifactId: text("remote_artifact_id"),
    remoteMediaId: text("remote_media_id"),
    remoteCacheId: text("remote_cache_id"),
    remoteDownloadUrl: text("remote_download_url").notNull(),
    remoteRenderUrl: text("remote_render_url"),
    sha256: text("sha256"),
    byteSize: bigint("byte_size", { mode: "number" }),
    mimeType: text("mime_type").notNull(),
    availability: remoteAssetAvailabilityEnum("availability").notNull().default("remote_only"),
    cachedStorageKey: text("cached_storage_key"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    storageUq: uniqueIndex("remote_asset_references_storage_uq").on(t.localStorageKey),
    localRowIdx: index("remote_asset_references_local_row_idx").on(t.localKind, t.localRowId),
    resultIdx: index("remote_asset_references_result_idx").on(t.resultId),
    remoteArtifactIdx: index("remote_asset_references_remote_artifact_idx").on(t.sourceInstanceId, t.remoteArtifactId),
    remoteMediaIdx: index("remote_asset_references_remote_media_idx").on(t.sourceInstanceId, t.remoteMediaId),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
export type Category = typeof categories.$inferSelect;
export type Airfoil = typeof airfoils.$inferSelect;
export type AirfoilInsert = typeof airfoils.$inferInsert;
export type Hashtag = typeof hashtags.$inferSelect;
export type AirfoilHashtag = typeof airfoilHashtags.$inferSelect;
export type Medium = typeof mediums.$inferSelect;
export type MediumViscosityTablePoint = typeof mediumViscosityTablePoints.$inferSelect;
export type FlowCondition = typeof flowConditions.$inferSelect;
export type ReferenceGeometryProfile = typeof referenceGeometryProfiles.$inferSelect;
export type OperatingCondition = typeof operatingConditions.$inferSelect;
export type BoundaryProfile = typeof boundaryProfiles.$inferSelect;
export type MeshProfile = typeof meshProfiles.$inferSelect;
export type SolverProfile = typeof solverProfiles.$inferSelect;
export type SchedulingProfile = typeof schedulingProfiles.$inferSelect;
export type OutputProfile = typeof outputProfiles.$inferSelect;
export type SweepDefinition = typeof sweepDefinitions.$inferSelect;
export type BoundaryCondition = typeof boundaryConditions.$inferSelect;
export type SimulationPreset = typeof simulationPresets.$inferSelect;
export type SimulationPresetAirfoilTarget = typeof simulationPresetAirfoilTargets.$inferSelect;
export type SyncApiSetting = typeof syncApiSettings.$inferSelect;
export type SyncApiPermission = typeof syncApiPermissions.$inferSelect;
export type SyncSweepPromise = typeof syncSweepPromises.$inferSelect;
export type SyncSweepPromisePoint = typeof syncSweepPromisePoints.$inferSelect;
export type SyncImportConflict = typeof syncImportConflicts.$inferSelect;
export type RegisteredRemoteSolver = typeof registeredRemoteSolvers.$inferSelect;
export type RemoteAssetReference = typeof remoteAssetReferences.$inferSelect;
export type SimulationPresetRevision = typeof simulationPresetRevisions.$inferSelect;
export type Result = typeof results.$inferSelect;
export type ResultInsert = typeof results.$inferInsert;
export type ResultAttempt = typeof resultAttempts.$inferSelect;
export type ResultAttemptInsert = typeof resultAttempts.$inferInsert;
export type ResultMedia = typeof resultMedia.$inferSelect;
export type SolverEvidenceArtifact = typeof solverEvidenceArtifacts.$inferSelect;
export type FieldRenderCache = typeof fieldRenderCache.$inferSelect;
export type ForceHistoryRow = typeof forceHistory.$inferSelect;
export type ResultClassification = typeof resultClassifications.$inferSelect;
export type PolarFitSet = typeof polarFitSets.$inferSelect;
export type PolarFitPointRow = typeof polarFitPoints.$inferSelect;
export type SimJob = typeof simJobs.$inferSelect;
export type SweeperState = typeof sweeperState.$inferSelect;
export type SimCampaign = typeof simCampaigns.$inferSelect;
export type SimCampaignInsert = typeof simCampaigns.$inferInsert;
export type SimCampaignAirfoil = typeof simCampaignAirfoils.$inferSelect;
export type SimCampaignPlanRevision = typeof simCampaignPlanRevisions.$inferSelect;
export type SimCampaignPlanRevisionInsert = typeof simCampaignPlanRevisions.$inferInsert;
export type SimCampaignCondition = typeof simCampaignConditions.$inferSelect;
export type SimCampaignConditionInsert = typeof simCampaignConditions.$inferInsert;
export type SimCampaignPoint = typeof simCampaignPoints.$inferSelect;
export type SimCampaignPointInsert = typeof simCampaignPoints.$inferInsert;
export type SimCampaignProgressRow = typeof simCampaignProgress.$inferSelect;
export type SimCampaignLane = typeof simCampaignLanes.$inferSelect;
export type SimCampaignLaneStep = typeof simCampaignLaneSteps.$inferSelect;
export type SimUransVerifyQueueItem = typeof simUransVerifyQueue.$inferSelect;
export type SimUransRequest = typeof simUransRequests.$inferSelect;
