import { DEFAULT_TRANSIENT_MAX_COURANT, type Point } from "@aerodb/core";
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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  DEFAULT_SOLVER_IMPLEMENTATION_ID,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";

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
export const mediaRoleEnum = pgEnum("media_role", [
  "instantaneous",
  "mean",
  "history",
]);
export const evidenceArtifactKindEnum = pgEnum("evidence_artifact_kind", [
  "manifest",
  "engine_bundle",
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
export const presetTargetScopeEnum = pgEnum("preset_target_scope", [
  "all",
  "airfoils",
]);
export const simJobStatusEnum = pgEnum("sim_job_status", [
  "pending",
  "submitted",
  "running",
  "ingesting",
  "done",
  "failed",
  "cancelled",
]);
export const resultClassificationStateEnum = pgEnum(
  "result_classification_state",
  ["accepted", "needs_urans", "superseded_by_urans", "rejected"],
);
export const resultClassificationRegionEnum = pgEnum(
  "result_classification_region",
  ["attached", "near_stall", "post_stall", "unknown"],
);
export const polarFitStatusEnum = pgEnum("polar_fit_status", [
  "final",
  "provisional",
  "insufficient",
]);
export const colorScaleStatusEnum = pgEnum("color_scale_status", [
  "active",
  "rebalancing",
  "failed",
]);
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
export const syncPromiseStatusEnum = pgEnum("sync_promise_status", [
  "active",
  "fulfilled",
  "expired",
  "cancelled",
]);
export const syncImportConflictStatusEnum = pgEnum(
  "sync_import_conflict_status",
  ["pending", "promoted", "archived"],
);
export const syncModeEnum = pgEnum("sync_mode", [
  "full",
  "db_only_remote_assets",
]);
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
export const remoteAssetAvailabilityEnum = pgEnum("remote_asset_availability", [
  "remote_only",
  "cached",
  "missing",
  "failed",
]);
export const solverEvidenceBlobBackendEnum = pgEnum(
  "solver_evidence_blob_backend",
  ["volume", "gcs"],
);
export const solverEvidenceBlobCompressionEnum = pgEnum(
  "solver_evidence_blob_compression",
  ["gzip", "zstd"],
);
export const solverEvidenceArchiveStateEnum = pgEnum(
  "solver_evidence_archive_state",
  ["current", "superseded"],
);

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
    refMetricsSource: dataSourceEnum("ref_metrics_source")
      .notNull()
      .default("queued"),
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
  refTemperatureK: doublePrecision("ref_temperature_k")
    .notNull()
    .default(288.15),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    mediumIdx: index("medium_viscosity_points_medium_idx").on(t.mediumId),
    orderUq: uniqueIndex("medium_viscosity_points_order_uq").on(
      t.mediumId,
      t.sortOrder,
    ),
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
    dynamicViscosity: doublePrecision("dynamic_viscosity")
      .notNull()
      .default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity")
      .notNull()
      .default(1.46e-5),
    mach: doublePrecision("mach"),
    isSeeded: boolean("is_seeded").notNull().default(false),
    origin: text("origin").notNull().default("user"), // seeded | user | campaign — set once at INSERT
    createdByCampaignId: uuid("created_by_campaign_id").references(
      (): AnyPgColumn => simCampaigns.id,
      {
        onDelete: "set null",
      },
    ),
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
    canonicalKeyUq: uniqueIndex("flow_conditions_canonical_key_uq").on(
      t.canonicalKey,
    ),
  }),
);

export const referenceGeometryProfiles = pgTable(
  "reference_geometry_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    geometryType: text("geometry_type").notNull().default("airfoil_2d"),
    referenceLengthKind: text("reference_length_kind")
      .notNull()
      .default("chord"),
    referenceLengthM: doublePrecision("reference_length_m")
      .notNull()
      .default(1.0),
    spanM: doublePrecision("span_m"),
    referenceAreaM2: doublePrecision("reference_area_m2"),
    isSeeded: boolean("is_seeded").notNull().default(false),
    origin: text("origin").notNull().default("user"), // seeded | user | campaign — set once at INSERT
    createdByCampaignId: uuid("created_by_campaign_id").references(
      (): AnyPgColumn => simCampaigns.id,
      {
        onDelete: "set null",
      },
    ),
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
    geometryTypeIdx: index("reference_geometry_profiles_type_idx").on(
      t.geometryType,
    ),
    canonicalKeyUq: uniqueIndex(
      "reference_geometry_profiles_canonical_key_uq",
    ).on(t.canonicalKey),
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
    referenceChordM: doublePrecision("reference_chord_m")
      .notNull()
      .default(1.0),
    temperatureK: doublePrecision("temperature_k").notNull().default(288.15),
    pressurePa: doublePrecision("pressure_pa").notNull().default(101325),
    speedMps: doublePrecision("speed_mps").notNull().default(50),
    density: doublePrecision("density").notNull().default(1.225),
    dynamicViscosity: doublePrecision("dynamic_viscosity")
      .notNull()
      .default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity")
      .notNull()
      .default(1.46e-5),
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
  turbulenceIntensity: doublePrecision("turbulence_intensity")
    .notNull()
    .default(0.001),
  viscosityRatio: doublePrecision("viscosity_ratio").notNull().default(10),
  sandGrainHeight: doublePrecision("sand_grain_height").notNull().default(0),
  roughnessConstant: doublePrecision("roughness_constant")
    .notNull()
    .default(0.5),
  isSeeded: boolean("is_seeded").notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// Solver identity and runtime topology. A solver implementation is the
// immutable logical/numerical identity used for compatibility. Runtime builds
// are exact executable provenance. Execution pools are mutable operational
// routing/capacity and deliberately do not participate in numerical identity.
// ---------------------------------------------------------------------------
export const solverImplementations = pgTable(
  "solver_implementations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    family: text("family").notNull(),
    distribution: text("distribution").notNull(),
    releaseVersion: text("release_version").notNull(),
    methodFamily: text("method_family").notNull(),
    adapterContractVersion: integer("adapter_contract_version").notNull(),
    numericsRevision: text("numerics_revision").notNull(),
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    upstreamUrl: text("upstream_url"),
    licenseSpdx: text("license_spdx"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    logicalIdentityUq: uniqueIndex(
      "solver_implementations_logical_identity_uq",
    ).on(
      t.family,
      t.distribution,
      t.releaseVersion,
      t.adapterContractVersion,
      t.numericsRevision,
    ),
    activeIdx: index("solver_implementations_active_idx")
      .on(t.family, t.distribution, t.releaseVersion)
      .where(sql`${t.retiredAt} IS NULL`),
    adapterVersionCheck: check(
      "solver_implementations_adapter_version_check",
      sql`${t.adapterContractVersion} >= 0`,
    ),
  }),
);

export const solverRuntimeBuilds = pgTable(
  "solver_runtime_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    provenanceKey: text("provenance_key").notNull().unique(),
    buildId: text("build_id").notNull(),
    sourceRevision: text("source_revision"),
    imageDigest: text("image_digest"),
    applicationSourceSha256: text("application_source_sha256"),
    packageSha256: text("package_sha256"),
    binarySha256: text("binary_sha256"),
    architecture: text("architecture"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    ownerUq: unique("solver_runtime_builds_id_implementation_uq").on(
      t.id,
      t.solverImplementationId,
    ),
    provenanceKeyCheck: check(
      "solver_runtime_builds_provenance_key_check",
      sql`${t.provenanceKey} ~ '^[0-9a-f]{64}$'`,
    ),
    applicationSourceSha256Check: check(
      "solver_runtime_builds_application_source_sha256_check",
      sql`${t.applicationSourceSha256} IS NULL OR ${t.applicationSourceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    imageDigestCheck: check(
      "solver_runtime_builds_image_digest_check",
      sql`${t.imageDigest} IS NULL OR ${t.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    packageSha256Check: check(
      "solver_runtime_builds_package_sha256_check",
      sql`${t.packageSha256} IS NULL OR ${t.packageSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    binarySha256Check: check(
      "solver_runtime_builds_binary_sha256_check",
      sql`${t.binarySha256} IS NULL OR ${t.binarySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    contentFingerprintCheck: check(
      "solver_runtime_builds_content_fingerprint_check",
      sql`COALESCE(${t.applicationSourceSha256} ~ '^[0-9a-f]{64}$', false)
        OR COALESCE(${t.imageDigest} ~ '^sha256:[0-9a-f]{64}$', false)
        OR COALESCE(${t.packageSha256} ~ '^[0-9a-f]{64}$', false)
        OR COALESCE(${t.binarySha256} ~ '^[0-9a-f]{64}$', false)`,
    ),
    implementationIdx: index("solver_runtime_builds_implementation_idx").on(
      t.solverImplementationId,
      t.createdAt,
    ),
    buildIdIdx: index("solver_runtime_builds_build_id_idx").on(
      t.solverImplementationId,
      t.buildId,
    ),
  }),
);

export const solverExecutionPools = pgTable(
  "solver_execution_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    routingKey: text("routing_key").notNull(),
    capacityKind: text("capacity_kind").notNull().default("cpu_slots"),
    capacityLimit: integer("capacity_limit"),
    enabled: boolean("enabled").notNull().default(false),
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
    ownerUq: unique("solver_execution_pools_id_implementation_uq").on(
      t.id,
      t.solverImplementationId,
    ),
    routingUq: uniqueIndex("solver_execution_pools_routing_uq").on(
      t.routingKey,
    ),
    implementationIdx: index("solver_execution_pools_implementation_idx").on(
      t.solverImplementationId,
      t.enabled,
    ),
    capacityCheck: check(
      "solver_execution_pools_capacity_check",
      sql`${t.capacityLimit} IS NULL OR ${t.capacityLimit} >= 0`,
    ),
  }),
);

/** Immutable proof that a production canary suite completed through one exact
 * live execution pool and runtime build. The receipt is deliberately stored
 * with its canonical digest: a deploy retry can identify an exact replay, but
 * cannot silently substitute different jobs, artifacts, or executable bytes. */
export const solverEngineCanaryAttestations = pgTable(
  "solver_engine_canary_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    solverRuntimeBuildId: uuid("solver_runtime_build_id")
      .notNull()
      .references(() => solverRuntimeBuilds.id),
    solverExecutionPoolId: uuid("solver_execution_pool_id")
      .notNull()
      .references(() => solverExecutionPools.id),
    receiptSha256: text("receipt_sha256").notNull().unique(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    attestedBy: text("attested_by"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    runtimeBuildOwnerFk: foreignKey({
      columns: [t.solverRuntimeBuildId, t.solverImplementationId],
      foreignColumns: [
        solverRuntimeBuilds.id,
        solverRuntimeBuilds.solverImplementationId,
      ],
      name: "solver_engine_canary_attestations_runtime_owner_fk",
    }),
    executionPoolOwnerFk: foreignKey({
      columns: [t.solverExecutionPoolId, t.solverImplementationId],
      foreignColumns: [
        solverExecutionPools.id,
        solverExecutionPools.solverImplementationId,
      ],
      name: "solver_engine_canary_attestations_pool_owner_fk",
    }),
    receiptSha256Check: check(
      "solver_engine_canary_attestations_receipt_sha256_check",
      sql`${t.receiptSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    implementationCreatedIdx: index(
      "solver_engine_canary_attestations_implementation_created_idx",
    ).on(t.solverImplementationId, t.createdAt),
  }),
);

export const meshProfiles = pgTable("mesh_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  mesher: text("mesher").notNull().default("blockmesh-cgrid"),
  farfieldRadiusChords: doublePrecision("farfield_radius_chords")
    .notNull()
    .default(15),
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

export const solverProfiles = pgTable(
  "solver_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .default(DEFAULT_SOLVER_IMPLEMENTATION_ID)
      .references(() => solverImplementations.id),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    turbulenceModel: text("turbulence_model").notNull().default("kOmegaSST"),
    nIterations: integer("n_iterations").notNull().default(3000),
    convergenceTolerance: doublePrecision("convergence_tolerance")
      .notNull()
      .default(1e-5),
    momentumScheme: text("momentum_scheme").notNull().default("linearUpwind"),
    transientCycles: doublePrecision("transient_cycles").notNull().default(10),
    transientDiscardFraction: doublePrecision("transient_discard_fraction")
      .notNull()
      .default(0.4),
    transientMaxCourant: doublePrecision("transient_max_courant")
      .notNull()
      .default(DEFAULT_TRANSIENT_MAX_COURANT),
    isSeeded: boolean("is_seeded").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    implementationIdx: index("solver_profiles_implementation_idx").on(
      t.solverImplementationId,
    ),
  }),
);

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
    referenceChordM: doublePrecision("reference_chord_m")
      .notNull()
      .default(1.0),
    temperatureK: doublePrecision("temperature_k").notNull().default(288.15),
    pressurePa: doublePrecision("pressure_pa").notNull().default(101325),
    speedMps: doublePrecision("speed_mps").notNull().default(50),
    density: doublePrecision("density").notNull().default(1.225),
    dynamicViscosity: doublePrecision("dynamic_viscosity")
      .notNull()
      .default(1.789e-5),
    kinematicViscosity: doublePrecision("kinematic_viscosity")
      .notNull()
      .default(1.46e-5),
    mach: doublePrecision("mach"),
    // turbulence
    turbulenceModel: text("turbulence_model").notNull().default("kOmegaSST"),
    turbulenceIntensity: doublePrecision("turbulence_intensity")
      .notNull()
      .default(0.001),
    viscosityRatio: doublePrecision("viscosity_ratio").notNull().default(10),
    // roughness
    sandGrainHeight: doublePrecision("sand_grain_height").notNull().default(0),
    roughnessConstant: doublePrecision("roughness_constant")
      .notNull()
      .default(0.5),
    // mesh
    mesher: text("mesher").notNull().default("blockmesh-cgrid"),
    farfieldRadiusChords: doublePrecision("farfield_radius_chords")
      .notNull()
      .default(15),
    wakeLengthChords: doublePrecision("wake_length_chords")
      .notNull()
      .default(12),
    nSurface: integer("n_surface").notNull().default(130),
    nRadial: integer("n_radial").notNull().default(80),
    nWake: integer("n_wake").notNull().default(60),
    targetYPlus: doublePrecision("target_y_plus").notNull().default(1),
    spanChords: doublePrecision("span_chords").notNull().default(0.1),
    // solver
    nIterations: integer("n_iterations").notNull().default(3000),
    convergenceTolerance: doublePrecision("convergence_tolerance")
      .notNull()
      .default(1e-5),
    momentumScheme: text("momentum_scheme").notNull().default("linearUpwind"),
    transientCycles: doublePrecision("transient_cycles").notNull().default(10),
    transientDiscardFraction: doublePrecision("transient_discard_fraction")
      .notNull()
      .default(0.4),
    transientMaxCourant: doublePrecision("transient_max_courant")
      .notNull()
      .default(DEFAULT_TRANSIENT_MAX_COURANT),
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
    operatingConditionId: uuid("operating_condition_id").references(
      () => operatingConditions.id,
    ),
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
    uransMeshProfileId: uuid("urans_mesh_profile_id").references(
      () => meshProfiles.id,
    ),
    uransPrecalcMeshProfileId: uuid("urans_precalc_mesh_profile_id").references(
      () => meshProfiles.id,
    ),
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
    legacyBoundaryConditionId: uuid("legacy_boundary_condition_id").references(
      () => boundaryConditions.id,
    ),
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
    flowConditionIdx: index("simulation_presets_flow_condition_idx").on(
      t.flowConditionId,
    ),
    referenceGeometryIdx: index("simulation_presets_reference_geometry_idx").on(
      t.referenceGeometryProfileId,
    ),
    legacyBcIdx: index("simulation_presets_legacy_bc_idx").on(
      t.legacyBoundaryConditionId,
    ),
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
    // Historical snapshots did not record an implementation. Migration 0065
    // associates those rows with the explicit legacy/unknown identity without
    // rewriting their immutable JSON or claiming an exact release/build.
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .default(LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID)
      .references(() => solverImplementations.id),
    // sha256 over ONLY the physics+numerics snapshot blocks (see
    // physicsHashForSnapshot in simulation-setup.ts). Nullable until backfilled.
    physicsHash: text("physics_hash"),
    // Versioned compatibility includes the logical solver implementation and
    // numerics revision. Runtime build and execution pool are intentionally
    // excluded. Nullable until lazily derived from an immutable snapshot.
    methodCompatibilityHashVersion: integer(
      "method_compatibility_hash_version",
    ),
    methodCompatibilityHash: text("method_compatibility_hash"),
    // Deterministic canonical-revision election per physicsHash: the campaign
    // launch materializer reuses the canonical row (prefer enabled-preset
    // revision, else oldest createdAt, tie-break lowest id).
    isCanonicalPhysics: boolean("is_canonical_physics")
      .notNull()
      .default(false),
    isCanonicalMethod: boolean("is_canonical_method").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    presetIdx: index("simulation_preset_revisions_preset_idx").on(t.presetId),
    reynoldsIdx: index("simulation_preset_revisions_reynolds_idx").on(
      t.reynolds,
    ),
    signatureUq: uniqueIndex("simulation_preset_revisions_signature_uq").on(
      t.presetId,
      t.signatureHash,
    ),
    revisionUq: uniqueIndex("simulation_preset_revisions_revision_uq").on(
      t.presetId,
      t.revisionNumber,
    ),
    physicsHashIdx: index("simulation_preset_revisions_physics_hash_idx").on(
      t.physicsHash,
    ),
    methodCompatibilityHashIdx: index(
      "simulation_preset_revisions_method_compatibility_hash_idx",
    ).on(t.methodCompatibilityHashVersion, t.methodCompatibilityHash),
    canonicalPhysicsUq: uniqueIndex(
      "simulation_preset_revisions_canonical_physics_uq",
    )
      .on(t.physicsHash)
      .where(sql`${t.isCanonicalPhysics}`),
    canonicalMethodUq: uniqueIndex(
      "simulation_preset_revisions_canonical_method_uq",
    )
      .on(t.methodCompatibilityHashVersion, t.methodCompatibilityHash)
      .where(sql`${t.isCanonicalMethod}`),
    methodHashShapeCheck: check(
      "simulation_preset_revisions_method_hash_shape_check",
      sql`(${t.methodCompatibilityHashVersion} IS NULL AND ${t.methodCompatibilityHash} IS NULL) OR (${t.methodCompatibilityHashVersion} > 0 AND ${t.methodCompatibilityHash} ~ '^[0-9a-f]{64}$')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 5. Result attempts — immutable-ish solver evidence snapshots. Declared
//    before results so the canonical result can express a composite
//    (attempt_id, result_id) ownership FK without a schema-only cycle.
// ---------------------------------------------------------------------------
export const resultAttempts = pgTable(
  "result_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcId: uuid("bc_id")
      .notNull()
      .references(() => boundaryConditions.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid(
      "simulation_preset_revision_id",
    ).references(() => simulationPresetRevisions.id),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    methodKey: text("method_key"),
    solverImplementationId: uuid("solver_implementation_id").references(
      () => solverImplementations.id,
    ),
    solverRuntimeBuildId: uuid("solver_runtime_build_id").references(
      () => solverRuntimeBuilds.id,
    ),
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
    firstOrderFallback: boolean("first_order_fallback")
      .notNull()
      .default(false),
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
    airfoilBcIdx: index("result_attempts_airfoil_bc_idx").on(
      t.airfoilId,
      t.bcId,
    ),
    presetRevisionIdx: index("result_attempts_preset_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
    simJobIdx: index("result_attempts_sim_job_idx").on(t.simJobId),
    solverImplementationIdx: index(
      "result_attempts_solver_implementation_idx",
    ).on(t.solverImplementationId),
    solverRuntimeBuildIdx: index("result_attempts_solver_runtime_build_idx").on(
      t.solverRuntimeBuildId,
    ),
    runtimeBuildOwnerFk: foreignKey({
      columns: [t.solverRuntimeBuildId, t.solverImplementationId],
      foreignColumns: [
        solverRuntimeBuilds.id,
        solverRuntimeBuilds.solverImplementationId,
      ],
      name: "result_attempts_runtime_build_owner_fk",
    }),
    runtimeBuildShapeCheck: check(
      "result_attempts_runtime_build_shape_check",
      sql`${t.solverRuntimeBuildId} IS NULL OR ${t.solverImplementationId} IS NOT NULL`,
    ),
    methodKeyCheck: check(
      "result_attempts_method_key_check",
      sql`${t.methodKey} IS NULL OR btrim(${t.methodKey}) <> ''`,
    ),
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
    attemptUq: uniqueIndex("result_attempts_job_result_aoa_regime_uq").on(
      t.simJobId,
      t.engineJobId,
      t.resultId,
      t.aoaDeg,
      t.regime,
    ),
    ownerUq: unique("result_attempts_id_result_id_uq").on(t.id, t.resultId),
    remoteAttemptUq: uniqueIndex("result_attempts_remote_engine_aoa_regime_uq")
      .on(t.engineJobId, t.aoaDeg, t.regime)
      .where(
        sql`${t.simJobId} IS NULL AND ${t.engineJobId} ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$'`,
      ),
    remoteRegimeCheck: check(
      "result_attempts_remote_regime_required_check",
      sql`NOT (${t.simJobId} IS NULL AND ${t.engineJobId} ~ '^sync:[A-Za-z0-9._-]{1,200}:[A-Za-z0-9._-]{1,200}$') OR ${t.regime} IS NOT NULL`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 6. Results — per (airfoil, preset revision, aoa) fact table. `bc_id` is
//    retained during migration as a deprecated compatibility bridge.
// ---------------------------------------------------------------------------
export const results = pgTable(
  "results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    currentResultAttemptId: uuid("current_result_attempt_id"),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcId: uuid("bc_id")
      .notNull()
      .references(() => boundaryConditions.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid(
      "simulation_preset_revision_id",
    ).references(() => simulationPresetRevisions.id),
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
    firstOrderFallback: boolean("first_order_fallback")
      .notNull()
      .default(false),
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
     *  that fails AGAIN with this set stays terminal/unavailable instead of a
     *  second silent retry or a human-review chore. Deliberately NEVER written by the ingest upsert
     *  (absent from its SET list), so it survives re-ingest of the same
     *  failed job. NULL = never auto-retried. */
    autoRetriedAt: timestamp("auto_retried_at", { withTimezone: true }),
    // linkage to the engine run
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    methodKey: text("method_key"),
    solverImplementationId: uuid("solver_implementation_id").references(
      () => solverImplementations.id,
    ),
    solverRuntimeBuildId: uuid("solver_runtime_build_id").references(
      () => solverRuntimeBuilds.id,
    ),
    priority: integer("priority").notNull().default(0),
    solvedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    runtimeBuildOwnerFk: foreignKey({
      columns: [t.solverRuntimeBuildId, t.solverImplementationId],
      foreignColumns: [
        solverRuntimeBuilds.id,
        solverRuntimeBuilds.solverImplementationId,
      ],
      name: "results_runtime_build_owner_fk",
    }),
    runtimeBuildShapeCheck: check(
      "results_runtime_build_shape_check",
      sql`${t.solverRuntimeBuildId} IS NULL OR ${t.solverImplementationId} IS NOT NULL`,
    ),
    methodKeyCheck: check(
      "results_method_key_check",
      sql`${t.methodKey} IS NULL OR btrim(${t.methodKey}) <> ''`,
    ),
    currentAttemptOwnerFk: foreignKey({
      columns: [t.currentResultAttemptId, t.id],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "results_current_attempt_owner_fk",
    }).onDelete("no action"),
    currentAttemptIdx: index("results_current_attempt_idx").on(
      t.currentResultAttemptId,
    ),
    naturalUq: uniqueIndex("results_revision_natural_uq").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.aoaDeg,
    ),
    airfoilBcIdx: index("results_airfoil_bc_idx").on(t.airfoilId, t.bcId),
    bcIdx: index("results_bc_idx").on(t.bcId),
    presetRevisionIdx: index("results_preset_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
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
    updatedAtIdIdx: index("results_updated_at_id_idx").on(
      sql`${t.updatedAt} DESC`,
      sql`${t.id} DESC`,
    ),
  }),
);

/** Durable execution policy for answered engine submit failures. Kept
 * separate from canonical solver results: no row here claims that OpenFOAM
 * ran or that coefficient evidence exists. */
export const simResultSubmitRetries = pgTable(
  "sim_result_submit_retries",
  {
    resultId: uuid("result_id")
      .primaryKey()
      .references(() => results.id, { onDelete: "cascade" }),
    // retry_wait | blocked
    state: text("state").notNull(),
    /** Number of automatic answered-5xx retries consumed (0 or 1). */
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error").notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    stateCheck: check(
      "sim_result_submit_retries_state_check",
      sql`${t.state} IN ('retry_wait', 'blocked')`,
    ),
    attemptCheck: check(
      "sim_result_submit_retries_attempt_check",
      sql`${t.attemptCount} BETWEEN 0 AND 1`,
    ),
    stateShapeCheck: check(
      "sim_result_submit_retries_state_shape_check",
      sql`(
        (${t.state} = 'retry_wait' AND ${t.attemptCount} = 1 AND ${t.nextAttemptAt} IS NOT NULL)
        OR (${t.state} = 'blocked' AND ${t.nextAttemptAt} IS NULL)
      )`,
    ),
    readyIdx: index("sim_result_submit_retries_ready_idx").on(
      t.state,
      t.nextAttemptAt,
    ),
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
    renderProfileKey: text("render_profile_key")
      .notNull()
      .default("default:v1:zoom2"),
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
    scopeIdx: index("field_color_scales_scope_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.field,
      t.renderProfileKey,
    ),
    activeUq: uniqueIndex("field_color_scales_active_uq")
      .on(
        t.airfoilId,
        t.simulationPresetRevisionId,
        t.field,
        t.renderProfileKey,
      )
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
    resultAttemptId: uuid("result_attempt_id"),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    renderProfileKey: text("render_profile_key")
      .notNull()
      .default("default:v1:zoom2"),
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
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "result_field_extents_attempt_owner_fk",
    }).onDelete("cascade"),
    resultIdx: index("result_field_extents_result_idx").on(t.resultId),
    attemptIdx: index("result_field_extents_attempt_idx").on(t.resultAttemptId),
    scopeIdx: index("result_field_extents_scope_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.field,
      t.renderProfileKey,
    ),
    attemptUq: uniqueIndex("result_field_extents_attempt_field_uq")
      .on(t.resultAttemptId, t.field, t.renderProfileKey)
      .where(sql`${t.resultAttemptId} IS NOT NULL`),
    legacyResultUq: uniqueIndex("result_field_extents_legacy_result_field_uq")
      .on(t.resultId, t.field, t.renderProfileKey)
      .where(sql`${t.resultAttemptId} IS NULL`),
  }),
);

export const resultMedia = pgTable(
  "result_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    resultAttemptId: uuid("result_attempt_id"),
    kind: mediaKindEnum("kind").notNull(),
    field: text("field"),
    role: mediaRoleEnum("role").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    frameCount: integer("frame_count"),
    durationS: doublePrecision("duration_s"),
    colorScaleId: uuid("color_scale_id").references(() => fieldColorScales.id, {
      onDelete: "set null",
    }),
    colorScaleVersion: integer("color_scale_version"),
    scaleVmin: doublePrecision("scale_vmin"),
    scaleVmax: doublePrecision("scale_vmax"),
    scalePolicy: text("scale_policy"),
    renderProfileKey: text("render_profile_key")
      .notNull()
      .default("default:v1:zoom2"),
    /** Manifest checksum whose immutable fields produced this presentation
     * artifact. NULL is legacy/unverified and never satisfies a durable
     * default-media repair obligation. */
    evidenceSha256: text("evidence_sha256"),
    /** Verified artifact identity. NULL marks legacy/unverified media and
     * cannot settle a durable repair. */
    sha256: text("sha256"),
    byteSize: bigint("byte_size", { mode: "number" }),
    engineUrl: text("engine_url"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "result_media_attempt_owner_fk",
    }).onDelete("cascade"),
    resultIdx: index("result_media_result_idx").on(t.resultId),
    attemptIdx: index("result_media_attempt_idx").on(t.resultAttemptId),
    resultProfileEvidenceIdx: index(
      "result_media_result_profile_evidence_idx",
    ).on(t.resultId, t.renderProfileKey, t.evidenceSha256),
    attemptUq: uniqueIndex("result_media_attempt_role_uq")
      .on(
        t.resultAttemptId,
        t.kind,
        sql`COALESCE(${t.field}, '')`,
        t.role,
        t.renderProfileKey,
      )
      .where(sql`${t.resultAttemptId} IS NOT NULL`),
    legacyResultIdx: index("result_media_legacy_result_role_idx")
      .on(t.resultId, t.kind, t.field, t.role, t.renderProfileKey)
      .where(sql`${t.resultAttemptId} IS NULL`),
  }),
);

/**
 * Durable execution/output obligation for rebuilding default media from
 * already-stored solver evidence. This is deliberately separate from
 * `results`, `result_attempts`, and `solver_evidence_artifacts`: retry state,
 * leases, and errors are mutable scheduler metadata, never solver evidence.
 *
 * One row owns the current media obligation for one canonical result. A new
 * evidence signature may reopen a previously completed/blocked obligation;
 * repeated discovery of the same evidence is idempotent.
 */
export const resultMediaRepairs = pgTable(
  "result_media_repairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    /** Exact immutable solver generation whose raw fields are rendered. */
    resultAttemptId: uuid("result_attempt_id").notNull(),
    // pending | running | retry_wait | done | blocked
    state: text("state").notNull().default("pending"),
    /** Engine job/case + manifest checksum for the evidence being repaired. */
    evidenceSignature: text("evidence_signature").notNull(),
    /** Persisted current provenance: true when the producing work has an
     * independent background owner. It remains true if campaigns also share
     * the result or acquire/release their own associations. */
    backgroundOwner: boolean("background_owner").notNull().default(false),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Per-lease fencing token; stale renderers cannot settle a newer claim. */
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Written only after cache/classification/verification/campaign hooks
     * finish. NULL makes a crash after media settlement resumable. */
    downstreamFinalizedAt: timestamp("downstream_finalized_at", {
      withTimezone: true,
    }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "result_media_repairs_attempt_owner_fk",
    }).onDelete("cascade"),
    resultUq: uniqueIndex("result_media_repairs_result_uq").on(t.resultId),
    attemptIdx: index("result_media_repairs_attempt_idx").on(t.resultAttemptId),
    readyIdx: index("result_media_repairs_ready_idx").on(
      t.state,
      t.nextAttemptAt,
    ),
    leaseIdx: index("result_media_repairs_lease_idx").on(
      t.state,
      t.claimExpiresAt,
    ),
    stateCheck: check(
      "result_media_repairs_state_check",
      sql`${t.state} IN ('pending', 'running', 'retry_wait', 'done', 'blocked')`,
    ),
    attemptCheck: check(
      "result_media_repairs_attempt_check",
      sql`${t.attemptCount} >= 0 AND ${t.maxAttempts} BETWEEN 1 AND 3 AND ${t.attemptCount} <= ${t.maxAttempts}`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 8. Solver evidence artifacts and custom field render cache.
// ---------------------------------------------------------------------------
export const solverEvidenceArtifacts = pgTable(
  "solver_evidence_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "cascade" },
    ),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    engineJobId: text("engine_job_id"),
    engineCaseSlug: text("engine_case_slug"),
    methodKey: text("method_key"),
    solverImplementationId: uuid("solver_implementation_id").references(
      () => solverImplementations.id,
    ),
    solverRuntimeBuildId: uuid("solver_runtime_build_id").references(
      () => solverRuntimeBuilds.id,
    ),
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
    runtimeBuildOwnerFk: foreignKey({
      columns: [t.solverRuntimeBuildId, t.solverImplementationId],
      foreignColumns: [
        solverRuntimeBuilds.id,
        solverRuntimeBuilds.solverImplementationId,
      ],
      name: "solver_evidence_artifacts_runtime_build_owner_fk",
    }),
    runtimeBuildShapeCheck: check(
      "solver_evidence_artifacts_runtime_build_shape_check",
      sql`${t.solverRuntimeBuildId} IS NULL OR ${t.solverImplementationId} IS NOT NULL`,
    ),
    methodKeyCheck: check(
      "solver_evidence_artifacts_method_key_check",
      sql`${t.methodKey} IS NULL OR btrim(${t.methodKey}) <> ''`,
    ),
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "solver_evidence_artifacts_attempt_owner_fk",
    }).onDelete("cascade"),
    resultIdx: index("solver_evidence_artifacts_result_idx").on(t.resultId),
    attemptIdx: index("solver_evidence_artifacts_attempt_idx").on(
      t.resultAttemptId,
    ),
    airfoilIdx: index("solver_evidence_artifacts_airfoil_idx").on(
      t.airfoilId,
      t.aoaDeg,
    ),
    blobIdx: index("solver_evidence_artifacts_blob_idx").on(
      t.storageKey,
      t.sha256,
    ),
    solverImplementationIdx: index(
      "solver_evidence_artifacts_solver_implementation_idx",
    ).on(t.solverImplementationId),
    solverRuntimeBuildIdx: index(
      "solver_evidence_artifacts_solver_runtime_build_idx",
    ).on(t.solverRuntimeBuildId),
    idAttemptResultUq: unique(
      "solver_evidence_artifacts_id_attempt_result_uq",
    ).on(t.id, t.resultAttemptId, t.resultId),
    attemptContentUq: uniqueIndex(
      "solver_evidence_artifacts_attempt_content_uq",
    )
      .on(
        t.resultAttemptId,
        t.kind,
        sql`COALESCE(${t.field}, '')`,
        sql`COALESCE(${t.role}, '')`,
        t.storageKey,
        t.sha256,
      )
      .where(sql`${t.resultAttemptId} IS NOT NULL`),
    resultContentUq: uniqueIndex("solver_evidence_artifacts_result_content_uq")
      .on(
        t.resultId,
        t.kind,
        sql`COALESCE(${t.field}, '')`,
        sql`COALESCE(${t.role}, '')`,
        t.storageKey,
        t.sha256,
      )
      .where(sql`${t.resultAttemptId} IS NULL AND ${t.resultId} IS NOT NULL`),
  }),
);

/**
 * One immutable physical evidence archive. Solver implementation, runtime
 * build, numerical method, and exact result ownership deliberately remain on
 * the source solverEvidenceArtifacts row instead of being duplicated here.
 */
export const solverEvidenceBlobs = pgTable(
  "solver_evidence_blobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backend: solverEvidenceBlobBackendEnum("backend").notNull(),
    bucket: text("bucket"),
    objectKey: text("object_key").notNull(),
    /** GCS uint64 generation, stored as decimal text to prevent JS rounding. */
    generation: text("generation"),
    compression: solverEvidenceBlobCompressionEnum("compression").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Digest and size of the compressed bytes at the physical location. */
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /** Canonical base64 big-endian CRC32C, matching the GCS representation. */
    crc32c: text("crc32c").notNull(),
    /** Digest and size of the decompressed tar stream. */
    uncompressedTarSha256: text("uncompressed_tar_sha256").notNull(),
    uncompressedTarByteSize: bigint("uncompressed_tar_byte_size", {
      mode: "number",
    }).notNull(),
    verifiedAt: ts().notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    volumeIdentityUq: uniqueIndex("solver_evidence_blobs_volume_identity_uq")
      .on(t.objectKey)
      .where(sql`${t.backend} = 'volume'`),
    gcsIdentityUq: uniqueIndex("solver_evidence_blobs_gcs_identity_uq")
      .on(t.bucket, t.objectKey, t.generation)
      .where(sql`${t.backend} = 'gcs'`),
    contentIdx: index("solver_evidence_blobs_content_idx").on(
      t.sha256,
      t.byteSize,
    ),
    backendShapeCheck: check(
      "solver_evidence_blobs_backend_shape_check",
      sql`(
        (${t.backend} = 'volume' AND ${t.bucket} IS NULL AND ${t.generation} IS NULL)
        OR (${t.backend} = 'gcs' AND btrim(COALESCE(${t.bucket}, '')) <> '' AND ${t.generation} ~ '^[1-9][0-9]{0,19}$')
      )`,
    ),
    objectKeyCheck: check(
      "solver_evidence_blobs_object_key_check",
      sql`btrim(${t.objectKey}) <> '' AND ${t.objectKey} NOT LIKE '/%' AND ${t.objectKey} !~ '(^|/)[.]{1,2}(/|$)' AND position(E'\\\\' in ${t.objectKey}) = 0`,
    ),
    mimeTypeCheck: check(
      "solver_evidence_blobs_mime_type_check",
      sql`btrim(${t.mimeType}) <> ''`,
    ),
    sha256Check: check(
      "solver_evidence_blobs_sha256_check",
      sql`${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    byteSizeCheck: check(
      "solver_evidence_blobs_byte_size_check",
      sql`${t.byteSize} > 0`,
    ),
    crc32cCheck: check(
      "solver_evidence_blobs_crc32c_check",
      sql`${t.crc32c} ~ '^[A-Za-z0-9+/]{6}==$'`,
    ),
    tarSha256Check: check(
      "solver_evidence_blobs_tar_sha256_check",
      sql`${t.uncompressedTarSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    tarByteSizeCheck: check(
      "solver_evidence_blobs_tar_byte_size_check",
      sql`${t.uncompressedTarByteSize} > 0`,
    ),
    metadataCheck: check(
      "solver_evidence_blobs_metadata_check",
      sql`jsonb_typeof(${t.metadata}) = 'object'`,
    ),
  }),
);

/**
 * Versioned archive selection for one exact result attempt. The partial
 * unique index permits at most one current archive while retaining immutable
 * superseded generations for audit and rollback.
 */
export const solverEvidenceArchives = pgTable(
  "solver_evidence_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").notNull(),
    resultAttemptId: uuid("result_attempt_id").notNull(),
    sourceArtifactId: uuid("source_artifact_id").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => solverEvidenceBlobs.id),
    state: solverEvidenceArchiveStateEnum("state").notNull().default("current"),
    supersededByArchiveId: uuid("superseded_by_archive_id"),
    supersededAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "solver_evidence_archives_attempt_owner_fk",
    }).onDelete("cascade"),
    sourceOwnerFk: foreignKey({
      columns: [t.sourceArtifactId, t.resultAttemptId, t.resultId],
      foreignColumns: [
        solverEvidenceArtifacts.id,
        solverEvidenceArtifacts.resultAttemptId,
        solverEvidenceArtifacts.resultId,
      ],
      name: "solver_evidence_archives_source_owner_fk",
    }).onDelete("cascade"),
    // Migration 0067 adds the composite self-FK
    // (supersededByArchiveId, resultAttemptId) -> (id, resultAttemptId).
    // It is kept migration-only because a self-referential composite FK makes
    // TypeScript infer this table recursively as `any`.
    idAttemptUq: unique("solver_evidence_archives_id_attempt_uq").on(
      t.id,
      t.resultAttemptId,
    ),
    attemptBlobUq: unique("solver_evidence_archives_attempt_blob_uq").on(
      t.resultAttemptId,
      t.blobId,
    ),
    currentAttemptUq: uniqueIndex("solver_evidence_archives_current_attempt_uq")
      .on(t.resultAttemptId)
      .where(sql`${t.state} = 'current'`),
    resultIdx: index("solver_evidence_archives_result_idx").on(
      t.resultId,
      t.resultAttemptId,
    ),
    sourceArtifactIdx: index("solver_evidence_archives_source_artifact_idx").on(
      t.sourceArtifactId,
    ),
    blobIdx: index("solver_evidence_archives_blob_idx").on(t.blobId),
    supersessionShapeCheck: check(
      "solver_evidence_archives_supersession_shape_check",
      sql`(
        (${t.state} = 'current' AND ${t.supersededByArchiveId} IS NULL AND ${t.supersededAt} IS NULL)
        OR (${t.state} = 'superseded' AND ${t.supersededAt} IS NOT NULL)
      )`,
    ),
    noSelfSupersessionCheck: check(
      "solver_evidence_archives_no_self_supersession_check",
      sql`${t.supersededByArchiveId} IS NULL OR ${t.supersededByArchiveId} <> ${t.id}`,
    ),
  }),
);

/**
 * Maps an existing logical evidence-artifact row to its relative tar member.
 * The migration owner trigger proves that member and archive share the same
 * exact result attempt, without duplicating runtime identity on this row.
 */
export const solverEvidenceArtifactMembers = pgTable(
  "solver_evidence_artifact_members",
  {
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => solverEvidenceArchives.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => solverEvidenceArtifacts.id, { onDelete: "cascade" }),
    memberPath: text("member_path").notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.archiveId, t.artifactId],
      name: "solver_evidence_artifact_members_pk",
    }),
    archivePathUq: unique(
      "solver_evidence_artifact_members_archive_path_uq",
    ).on(t.archiveId, t.memberPath),
    artifactIdx: index("solver_evidence_artifact_members_artifact_idx").on(
      t.artifactId,
    ),
    pathCheck: check(
      "solver_evidence_artifact_members_path_check",
      sql`btrim(${t.memberPath}) <> '' AND ${t.memberPath} NOT LIKE '/%' AND ${t.memberPath} !~ '(^|/)[.]{1,2}(/|$)' AND position(E'\\\\' in ${t.memberPath}) = 0`,
    ),
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
    renderUq: uniqueIndex("field_render_cache_result_params_uq").on(
      t.resultId,
      t.field,
      t.role,
      t.paramsHash,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 9. Force history — URANS Cl(t)/Cd(t) as columnar jsonb (1:1 with a result).
// ---------------------------------------------------------------------------
export const forceHistory = pgTable(
  "force_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    resultAttemptId: uuid("result_attempt_id"),
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
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "force_history_attempt_owner_fk",
    }).onDelete("cascade"),
    resultIdx: index("force_history_result_idx").on(t.resultId),
    attemptUq: uniqueIndex("force_history_attempt_uq")
      .on(t.resultAttemptId)
      .where(sql`${t.resultAttemptId} IS NOT NULL`),
    legacyResultUq: uniqueIndex("force_history_legacy_result_uq")
      .on(t.resultId)
      .where(sql`${t.resultAttemptId} IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// 10. Result classifications and fitted polar cache — solver evidence stays
//    immutable, while this derived layer tells the product which evidence is
//    accepted, provisional, superseded, or rejected for polar display/search.
// ---------------------------------------------------------------------------
export const resultClassifications = pgTable(
  "result_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "cascade" },
    ),
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
    region: resultClassificationRegionEnum("region")
      .notNull()
      .default("unknown"),
    confidence: doublePrecision("confidence").notNull().default(1),
    reasons: text("reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    supersededByResultId: uuid("superseded_by_result_id").references(
      (): AnyPgColumn => results.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "result_classifications_attempt_owner_fk",
    }).onDelete("cascade"),
    resultUq: uniqueIndex("result_classifications_result_uq").on(t.resultId),
    attemptUq: uniqueIndex("result_classifications_attempt_uq").on(
      t.resultAttemptId,
    ),
    polarIdx: index("result_classifications_polar_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.state,
      t.aoaDeg,
    ),
  }),
);

export const resultReviewVerdicts = pgTable(
  "result_review_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(),
    note: text("note"),
    reviewer: text("reviewer").notNull(),
    createdAt: ts().notNull().defaultNow(),
    revokedAt: ts(),
    revokedBy: text("revoked_by"),
  },
  (t) => ({
    verdictCheck: check(
      "result_review_verdicts_verdict_check",
      sql`${t.verdict} IN ('waive', 'exclude', 'defer')`,
    ),
    activeResultIdx: index("result_review_verdicts_active_result_idx")
      .on(t.resultId)
      .where(sql`${t.revokedAt} IS NULL`),
    resultHistoryIdx: index("result_review_verdicts_result_history_idx").on(
      t.resultId,
      t.createdAt,
    ),
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
    provisionalPointCount: integer("provisional_point_count")
      .notNull()
      .default(0),
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
    fitUq: uniqueIndex("polar_fit_sets_signature_uq").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.fitVersion,
      t.evidenceSignature,
    ),
    currentUq: uniqueIndex("polar_fit_sets_current_uq")
      .on(t.airfoilId, t.simulationPresetRevisionId)
      .where(sql`${t.isCurrent}`),
    airfoilIdx: index("polar_fit_sets_airfoil_idx").on(
      t.airfoilId,
      t.isCurrent,
      t.status,
    ),
    revisionIdx: index("polar_fit_sets_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
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
// Public polar compatibility cache — evidence-derived read model spanning
// value-identical immutable setup revisions. Revision-scoped polar_fit_sets
// remain authoritative for campaign/refinement work; these tables exist so a
// public series can combine evidence split only by sweep/batch revisions
// without relabelling that evidence as belonging to one canonical revision.
// ---------------------------------------------------------------------------
export const polarCompatibilityFitSets = pgTable(
  "polar_compatibility_fit_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    compatibilityVersion: text("compatibility_version").notNull(),
    compatibilityHash: text("compatibility_hash").notNull(),
    fitVersion: text("fit_version").notNull(),
    evidenceSignature: text("evidence_signature").notNull(),
    status: polarFitStatusEnum("status").notNull(),
    confidence: doublePrecision("confidence").notNull().default(0),
    acceptedPointCount: integer("accepted_point_count").notNull().default(0),
    provisionalPointCount: integer("provisional_point_count")
      .notNull()
      .default(0),
    rejectedPointCount: integer("rejected_point_count").notNull().default(0),
    conflictPointCount: integer("conflict_point_count").notNull().default(0),
    reynolds: bigint("reynolds", { mode: "number" }),
    mach: doublePrecision("mach"),
    ldmax: doublePrecision("ldmax"),
    alphaLdmax: doublePrecision("alpha_ldmax"),
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
    signatureUq: uniqueIndex("polar_compatibility_fit_sets_signature_uq").on(
      t.airfoilId,
      t.compatibilityVersion,
      t.compatibilityHash,
      t.fitVersion,
      t.evidenceSignature,
    ),
    currentUq: uniqueIndex("polar_compatibility_fit_sets_current_uq")
      .on(t.airfoilId, t.compatibilityVersion, t.compatibilityHash)
      .where(sql`${t.isCurrent}`),
    airfoilIdx: index("polar_compatibility_fit_sets_airfoil_idx").on(
      t.airfoilId,
      t.isCurrent,
      t.status,
    ),
    compatibilityIdx: index(
      "polar_compatibility_fit_sets_compatibility_idx",
    ).on(t.compatibilityVersion, t.compatibilityHash),
  }),
);

export const polarCompatibilityFitPoints = pgTable(
  "polar_compatibility_fit_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitSetId: uuid("fit_set_id")
      .notNull()
      .references(() => polarCompatibilityFitSets.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    cl: doublePrecision("cl").notNull(),
    cd: doublePrecision("cd").notNull(),
    cm: doublePrecision("cm").notNull(),
    clCd: doublePrecision("cl_cd").notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    fitSetIdx: index("polar_compatibility_fit_points_fit_set_idx").on(
      t.fitSetId,
    ),
    fitAoaUq: uniqueIndex("polar_compatibility_fit_points_aoa_uq").on(
      t.fitSetId,
      t.aoaDeg,
    ),
  }),
);

export const polarCompatibilityFitMembers = pgTable(
  "polar_compatibility_fit_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitSetId: uuid("fit_set_id")
      .notNull()
      .references(() => polarCompatibilityFitSets.id, { onDelete: "cascade" }),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    simulationPresetRevisionId: uuid("simulation_preset_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    role: text("role").notNull(),
    selectionRank: integer("selection_rank").notNull(),
    selectionReason: text("selection_reason").notNull(),
    classificationState: resultClassificationStateEnum(
      "classification_state",
    ).notNull(),
    classificationRegion: resultClassificationRegionEnum(
      "classification_region",
    ).notNull(),
    classificationReasons: text("classification_reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    classificationConfidence: doublePrecision(
      "classification_confidence",
    ).notNull(),
    reviewVerdict: text("review_verdict"),
    fidelity: text("fidelity"),
    regime: regimeEnum("regime"),
    cl: doublePrecision("cl").notNull(),
    cd: doublePrecision("cd").notNull(),
    cm: doublePrecision("cm"),
    clCd: doublePrecision("cl_cd"),
    clStd: doublePrecision("cl_std"),
    cdStd: doublePrecision("cd_std"),
    cmStd: doublePrecision("cm_std"),
    stalled: boolean("stalled").notNull(),
    unsteady: boolean("unsteady").notNull(),
    converged: boolean("converged").notNull(),
    resultUpdatedAt: timestamp("result_updated_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    roleCheck: check(
      "polar_compatibility_fit_members_role_check",
      sql`${t.role} IN ('selected', 'shadowed', 'conflict')`,
    ),
    fitResultUq: uniqueIndex("polar_compatibility_fit_members_result_uq").on(
      t.fitSetId,
      t.resultId,
    ),
    fitRoleIdx: index("polar_compatibility_fit_members_fit_role_idx").on(
      t.fitSetId,
      t.role,
      t.aoaDeg,
    ),
    resultIdx: index("polar_compatibility_fit_members_result_idx").on(
      t.resultId,
    ),
    revisionIdx: index("polar_compatibility_fit_members_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
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
    methodKey: text("method_key"),
    solverImplementationId: uuid("solver_implementation_id").references(
      () => solverImplementations.id,
    ),
    solverRuntimeBuildId: uuid("solver_runtime_build_id").references(
      () => solverRuntimeBuilds.id,
    ),
    solverExecutionPoolId: uuid("solver_execution_pool_id").references(
      () => solverExecutionPools.id,
    ),
    parentJobId: uuid("parent_job_id").references(
      (): AnyPgColumn => simJobs.id,
      { onDelete: "set null" },
    ),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    bcIds: jsonb("bc_ids").$type<string[]>().notNull(),
    simulationPresetRevisionId: uuid(
      "simulation_preset_revision_id",
    ).references(() => simulationPresetRevisions.id),
    campaignId: uuid("campaign_id").references(
      (): AnyPgColumn => simCampaigns.id,
      { onDelete: "set null" },
    ),
    jobKind: text("job_kind").notNull().default("sweep"), // sweep | targeted
    referenceChordM: doublePrecision("reference_chord_m").notNull(),
    wave: integer("wave").notNull().default(1),
    status: simJobStatusEnum("status").notNull().default("pending"),
    totalCases: integer("total_cases").notNull().default(0),
    completedCases: integer("completed_cases").notNull().default(0),
    requestPayload: jsonb("request_payload"),
    engineState: text("engine_state"),
    error: text("error"),
    // Exclusive, renewable evidence-ingest ownership. The token belongs to
    // one sweeper process; expiry makes a crashed owner's job recoverable
    // without holding a transaction across engine/media work.
    ingestLeaseToken: text("ingest_lease_token"),
    ingestLeaseClaimedAt: timestamp("ingest_lease_claimed_at", {
      withTimezone: true,
    }),
    ingestLeaseExpiresAt: timestamp("ingest_lease_expires_at", {
      withTimezone: true,
    }),
    submittedAt: ts(),
    polledAt: ts(),
    ingestedAt: ts(),
    finishedAt: ts(),
    strippedAt: timestamp("stripped_at", { withTimezone: true }),
    stripReport: jsonb("strip_report").$type<{
      bytes_freed?: number;
      files_removed?: number;
      kept_case_state?: boolean;
      note?: string;
    }>(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    runtimeBuildOwnerFk: foreignKey({
      columns: [t.solverRuntimeBuildId, t.solverImplementationId],
      foreignColumns: [
        solverRuntimeBuilds.id,
        solverRuntimeBuilds.solverImplementationId,
      ],
      name: "sim_jobs_runtime_build_owner_fk",
    }),
    executionPoolOwnerFk: foreignKey({
      columns: [t.solverExecutionPoolId, t.solverImplementationId],
      foreignColumns: [
        solverExecutionPools.id,
        solverExecutionPools.solverImplementationId,
      ],
      name: "sim_jobs_execution_pool_owner_fk",
    }),
    runtimeShapeCheck: check(
      "sim_jobs_runtime_shape_check",
      sql`(${t.solverRuntimeBuildId} IS NULL AND ${t.solverExecutionPoolId} IS NULL) OR ${t.solverImplementationId} IS NOT NULL`,
    ),
    methodKeyCheck: check(
      "sim_jobs_method_key_check",
      sql`${t.methodKey} IS NULL OR btrim(${t.methodKey}) <> ''`,
    ),
    noDirectFullRequestCheck: check(
      "sim_jobs_no_direct_full_request_check",
      sql`${t.requestPayload} IS NULL OR NOT (
        ${t.requestPayload} ? 'uransRequestId'
        AND ${t.requestPayload} ->> 'uransFidelity' = 'full'
        AND NOT (${t.requestPayload} ? 'verifyQueueItemId')
      )`,
    ),
    statusIdx: index("sim_jobs_status_idx").on(t.status),
    engineJobIdx: index("sim_jobs_engine_job_idx").on(t.engineJobId),
    solverImplementationIdx: index("sim_jobs_solver_implementation_idx").on(
      t.solverImplementationId,
    ),
    solverRuntimeBuildIdx: index("sim_jobs_solver_runtime_build_idx").on(
      t.solverRuntimeBuildId,
    ),
    solverExecutionPoolIdx: index("sim_jobs_solver_execution_pool_idx").on(
      t.solverExecutionPoolId,
    ),
    airfoilIdx: index("sim_jobs_airfoil_idx").on(t.airfoilId),
    presetRevisionIdx: index("sim_jobs_preset_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
    campaignIdx: index("sim_jobs_campaign_idx").on(t.campaignId),
    parentJobIdx: index("sim_jobs_parent_job_idx").on(t.parentJobId),
    ingestLeaseIdx: index("sim_jobs_ingest_lease_idx").on(
      t.status,
      t.ingestLeaseExpiresAt,
    ),
  }),
);

/** Durable post-cutover liveness proof. `routed` means a job for the newly
 * created campaign generation was stamped with the exact 2606 implementation
 * and pool; `evidence` additionally proves ingestion from the attested runtime
 * build. Status is monotonic and remains pending across deploy retries. */
export const solverCutoverContinuationChecks = pgTable(
  "solver_cutover_continuation_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canaryAttestationId: uuid("canary_attestation_id")
      .notNull()
      .references(() => solverEngineCanaryAttestations.id)
      .unique(),
    status: text("status").notNull().default("pending"),
    simJobId: uuid("sim_job_id").references(() => simJobs.id, {
      onDelete: "set null",
    }),
    evidenceResultId: uuid("evidence_result_id").references(() => results.id, {
      onDelete: "set null",
    }),
    lastError: text("last_error"),
    createdAt: ts().notNull().defaultNow(),
    checkedAt: ts().notNull().defaultNow(),
    routedAt: ts(),
    evidenceAt: ts(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusCheck: check(
      "solver_cutover_continuation_checks_status_check",
      sql`${t.status} IN ('pending', 'routed', 'evidence', 'not_required')`,
    ),
    stageShapeCheck: check(
      "solver_cutover_continuation_checks_stage_shape_check",
      sql`(${t.status} = 'pending' AND ${t.simJobId} IS NULL AND ${t.evidenceResultId} IS NULL AND ${t.routedAt} IS NULL AND ${t.evidenceAt} IS NULL)
        OR (${t.status} = 'routed' AND ${t.simJobId} IS NOT NULL AND ${t.evidenceResultId} IS NULL AND ${t.routedAt} IS NOT NULL AND ${t.evidenceAt} IS NULL)
        OR (${t.status} = 'evidence' AND ${t.simJobId} IS NOT NULL AND ${t.evidenceResultId} IS NOT NULL AND ${t.routedAt} IS NOT NULL AND ${t.evidenceAt} IS NOT NULL)
        OR (${t.status} = 'not_required' AND ${t.simJobId} IS NULL AND ${t.evidenceResultId} IS NULL AND ${t.routedAt} IS NULL AND ${t.evidenceAt} IS NULL)`,
    ),
    statusCheckedIdx: index(
      "solver_cutover_continuation_checks_status_checked_idx",
    ).on(t.status, t.checkedAt),
  }),
);

// ---------------------------------------------------------------------------
// 12. Sweeper state — single control row (id = 1).
// ---------------------------------------------------------------------------
export const sweeperState = pgTable("sweeper_state", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  // 0 = auto: derive concurrent polar-job admission from the worker token
  // budget (or the visible cpuSlots cap). A positive value is an explicit
  // API-only override; it must never remain an invisible legacy ceiling.
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(0),
  // THE single global solver-capacity setting ("OpenFOAM CPU slots").
  // 0 = auto: submit jobs without a cpu_budget cap so the engine resolves its
  // own worker budget — exactly the pre-campaign effective behavior (scheduling
  // profiles defaulted cpuBudget to NULL). Job building passes a positive value
  // into the engine `resources` block, and auto job admission follows this
  // same capacity instead of a separate hidden ceiling.
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
  // Storage admission is a scheduler gate, not a campaign lifecycle state.
  // Persist the last real engine measurement so Queue/campaign surfaces can
  // explain why an enabled scheduler is intentionally not submitting work.
  diskAdmissionBlocked: boolean("disk_admission_blocked")
    .notNull()
    .default(false),
  diskAdmissionReason: text("disk_admission_reason"),
  diskUsedPct: doublePrecision("disk_used_pct"),
  diskFreeBytes: bigint("disk_free_bytes", { mode: "number" }),
  diskRequiredFreeBytes: bigint("disk_required_free_bytes", {
    mode: "number",
  }),
  diskCheckedAt: timestamp("disk_checked_at", { withTimezone: true }),
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
    currentConditionGeneration: integer("current_condition_generation")
      .notNull()
      .default(1),
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
    idempotencyKeyUq: uniqueIndex("sim_campaigns_idempotency_key_uq").on(
      t.idempotencyKey,
    ),
    statusIdx: index("sim_campaigns_status_idx").on(t.status),
    priorityCheck: check(
      "sim_campaigns_priority_check",
      sql`${t.priority} >= 0 AND ${t.priority} <= 9`,
    ),
    conditionGenerationCheck: check(
      "sim_campaigns_condition_generation_check",
      sql`${t.currentConditionGeneration} > 0`,
    ),
  }),
);

// Append-only lifecycle provenance. Campaign status is the current scheduling
// state; this ledger explains who changed it, why, and when without overwriting
// earlier operational history. The API never asks users to infer pause/resume
// provenance from a mutable `updatedAt` timestamp.
export const simCampaignLifecycleEvents = pgTable(
  "sim_campaign_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // pause | resume | cancel | close | archive | unarchive
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actor: text("actor"),
    reason: text("reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    campaignCreatedIdx: index(
      "sim_campaign_lifecycle_events_campaign_created_idx",
    ).on(t.campaignId, t.createdAt),
    actionCheck: check(
      "sim_campaign_lifecycle_events_action_check",
      sql`${t.action} IN ('pause', 'resume', 'cancel', 'close', 'archive', 'unarchive')`,
    ),
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
    kind: text("kind").notNull(), // initial | edit | force_release | engine_cutover
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(), // canonical byte-stable plan document (spec §3.1)
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by"),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    revisionUq: uniqueIndex("sim_campaign_plan_revisions_revision_uq").on(
      t.campaignId,
      t.revisionNumber,
    ),
    campaignIdx: index("sim_campaign_plan_revisions_campaign_idx").on(
      t.campaignId,
    ),
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
    generation: integer("generation").notNull().default(1),
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
    status: text("status").notNull().default("active"), // active | kept | released | superseded
    supersedesConditionId: uuid("supersedes_condition_id").references(
      (): AnyPgColumn => simCampaignConditions.id,
      { onDelete: "set null" },
    ),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    introducedInPlanRevisionId: uuid("introduced_in_plan_revision_id")
      .notNull()
      .references(() => simCampaignPlanRevisions.id),
    statusChangedInPlanRevisionId: uuid(
      "status_changed_in_plan_revision_id",
    ).references(() => simCampaignPlanRevisions.id),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Re-adding a released combo reactivates it only inside the current
    // generation. A solver cutover creates a successor generation instead of
    // ever relabelling the old condition/evidence.
    comboUq: uniqueIndex("sim_campaign_conditions_combo_uq").on(
      t.campaignId,
      t.flowConditionId,
      t.referenceGeometryProfileId,
      t.generation,
    ),
    campaignStatusIdx: index("sim_campaign_conditions_campaign_status_idx").on(
      t.campaignId,
      t.status,
    ),
    revisionIdx: index("sim_campaign_conditions_revision_idx").on(
      t.simulationPresetRevisionId,
    ),
    campaignGenerationIdx: index(
      "sim_campaign_conditions_campaign_generation_idx",
    ).on(t.campaignId, t.generation, t.status),
    supersedesUq: uniqueIndex("sim_campaign_conditions_supersedes_uq")
      .on(t.supersedesConditionId)
      .where(sql`${t.supersedesConditionId} IS NOT NULL`),
    generationCheck: check(
      "sim_campaign_conditions_generation_check",
      sql`${t.generation} > 0`,
    ),
    supersessionShapeCheck: check(
      "sim_campaign_conditions_supersession_shape_check",
      sql`(${t.status} = 'superseded' AND ${t.supersededAt} IS NOT NULL) OR (${t.status} <> 'superseded' AND ${t.supersededAt} IS NULL)`,
    ),
  }),
);

/** Audited, staged solver cutover for one campaign generation. Preparation
 * closes admission and pauses; finalization creates the successor generation;
 * completion is allowed only after the target execution pool is live. */
export const simCampaignSolverCutovers = pgTable(
  "sim_campaign_solver_cutovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    fromSolverImplementationId: uuid("from_solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    toSolverImplementationId: uuid("to_solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    canaryAttestationId: uuid("canary_attestation_id").references(
      () => solverEngineCanaryAttestations.id,
    ),
    sourcePlanRevisionId: uuid("source_plan_revision_id")
      .notNull()
      .references(() => simCampaignPlanRevisions.id),
    targetPlanRevisionId: uuid("target_plan_revision_id").references(
      () => simCampaignPlanRevisions.id,
    ),
    sourceGeneration: integer("source_generation").notNull(),
    targetGeneration: integer("target_generation").notNull(),
    priorCampaignStatus: text("prior_campaign_status").notNull(),
    status: text("status").notNull().default("prepared"),
    reason: text("reason"),
    preparedBy: text("prepared_by"),
    finalizedBy: text("finalized_by"),
    completedBy: text("completed_by"),
    sourceConditionCount: integer("source_condition_count")
      .notNull()
      .default(0),
    targetConditionCount: integer("target_condition_count")
      .notNull()
      .default(0),
    targetPointCount: integer("target_point_count").notNull().default(0),
    preparedAt: timestamp("prepared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    campaignTargetGenerationUq: uniqueIndex(
      "sim_campaign_solver_cutovers_campaign_target_generation_uq",
    ).on(t.campaignId, t.targetGeneration),
    statusIdx: index("sim_campaign_solver_cutovers_status_idx").on(
      t.status,
      t.campaignId,
    ),
    generationCheck: check(
      "sim_campaign_solver_cutovers_generation_check",
      sql`${t.sourceGeneration} > 0 AND ${t.targetGeneration} = ${t.sourceGeneration} + 1`,
    ),
    statusCheck: check(
      "sim_campaign_solver_cutovers_status_check",
      sql`${t.status} IN ('prepared', 'finalized', 'completed')`,
    ),
    priorStatusCheck: check(
      "sim_campaign_solver_cutovers_prior_status_check",
      sql`${t.priorCampaignStatus} IN ('active', 'paused', 'attention')`,
    ),
    countsCheck: check(
      "sim_campaign_solver_cutovers_counts_check",
      sql`${t.sourceConditionCount} >= 0 AND ${t.targetConditionCount} >= 0 AND ${t.targetPointCount} >= 0`,
    ),
    distinctImplementationCheck: check(
      "sim_campaign_solver_cutovers_distinct_implementation_check",
      sql`${t.fromSolverImplementationId} <> ${t.toSolverImplementationId}`,
    ),
    stageShapeCheck: check(
      "sim_campaign_solver_cutovers_stage_shape_check",
      sql`(${t.status} = 'prepared' AND ${t.canaryAttestationId} IS NULL AND ${t.targetPlanRevisionId} IS NULL AND ${t.finalizedAt} IS NULL AND ${t.completedAt} IS NULL)
        OR (${t.status} = 'finalized' AND ${t.canaryAttestationId} IS NOT NULL AND ${t.targetPlanRevisionId} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL AND ${t.completedAt} IS NULL)
        OR (${t.status} = 'completed' AND ${t.canaryAttestationId} IS NOT NULL AND ${t.targetPlanRevisionId} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
  }),
);

/** Exact eligible source-cell membership captured while finalization still
 * has the pre-release source grid. Continuation compares the live successor
 * grid to these rows, so unrelated older released points cannot widen the
 * proof and a deleted/replaced target point cannot be hidden by a count. */
export const simCampaignSolverCutoverPoints = pgTable(
  "sim_campaign_solver_cutover_points",
  {
    cutoverId: uuid("cutover_id")
      .notNull()
      .references(() => simCampaignSolverCutovers.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => simCampaigns.id, { onDelete: "cascade" }),
    sourceConditionId: uuid("source_condition_id")
      .notNull()
      .references(() => simCampaignConditions.id),
    targetConditionId: uuid("target_condition_id")
      .notNull()
      .references(() => simCampaignConditions.id),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    targetRevisionId: uuid("target_revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.cutoverId, t.sourceConditionId, t.airfoilId, t.aoaDeg],
    }),
    targetCellUq: uniqueIndex(
      "sim_campaign_solver_cutover_points_target_cell_uq",
    ).on(t.cutoverId, t.targetConditionId, t.airfoilId, t.aoaDeg),
    campaignIdx: index("sim_campaign_solver_cutover_points_campaign_idx").on(
      t.campaignId,
      t.cutoverId,
    ),
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
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "set null",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
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
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "sim_campaign_points_attempt_owner_fk",
    }).onDelete("no action"),
    pk: primaryKey({
      columns: [t.campaignId, t.conditionId, t.airfoilId, t.aoaDeg],
    }),
    requestedIdx: index("sim_campaign_points_requested_idx")
      .on(t.campaignId)
      .where(sql`${t.state} = 'requested'`),
    requestedRevisionIdx: index("sim_campaign_points_requested_revision_idx")
      .on(t.revisionId, t.airfoilId, t.aoaDeg)
      .where(sql`${t.state} = 'requested'`),
    resultIdx: index("sim_campaign_points_result_idx").on(t.resultId),
    resultAttemptIdx: index("sim_campaign_points_result_attempt_idx").on(
      t.resultAttemptId,
    ),
    conditionAoaIdx: index("sim_campaign_points_condition_aoa_idx").on(
      t.conditionId,
      t.aoaDeg,
      t.state,
    ),
    derivedTerminalIdx: index("sim_campaign_points_derived_terminal_idx")
      .on(sql`${t.updatedAt} DESC`)
      .where(sql`${t.derivedBySymmetry} AND ${t.state} = 'terminal'`),
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
    // Machine-owned PRECALC obligations which reached a terminal blocked
    // state. This is deliberately disjoint from failed/rejected: a physical
    // cell whose bounded PRECALC ledger is blocked is unavailable work, not a
    // human review item and not an ordinary RANS retry candidate.
    blocked: integer("blocked").notNull().default(0),
    // Open work which the engine-capability reconciler has already reopened
    // under a newer deterministic mesh-recovery strategy. This is progress,
    // not a terminal blocked point, so it is deliberately excluded from the
    // blocked conservation groups below.
    precalcMeshRepairing: integer("precalc_mesh_repairing")
      .notNull()
      .default(0),
    // Terminal blocked groups are mutually exclusive and exhaustive. The
    // database check below prevents a read-model drift where the headline
    // blocked count no longer agrees with its user-facing reasons.
    blockedMeshQuality: integer("blocked_mesh_quality").notNull().default(0),
    blockedPrecalcExhausted: integer("blocked_precalc_exhausted")
      .notNull()
      .default(0),
    blockedEngineSubmit: integer("blocked_engine_submit").notNull().default(0),
    blockedOther: integer("blocked_other").notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.campaignId, t.conditionId, t.airfoilId] }),
    conditionIdx: index("sim_campaign_progress_condition_idx").on(
      t.conditionId,
    ),
    remediationNonnegativeCheck: check(
      "sim_campaign_progress_remediation_nonnegative_check",
      sql`${t.precalcMeshRepairing} >= 0
        AND ${t.blockedMeshQuality} >= 0
        AND ${t.blockedPrecalcExhausted} >= 0
        AND ${t.blockedEngineSubmit} >= 0
        AND ${t.blockedOther} >= 0`,
    ),
    blockedReasonConservationCheck: check(
      "sim_campaign_progress_blocked_reason_conservation_check",
      sql`${t.blocked} = ${t.blockedMeshQuality}
        + ${t.blockedPrecalcExhausted}
        + ${t.blockedEngineSubmit}
        + ${t.blockedOther}`,
    ),
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
    witnessFitSetId: uuid("witness_fit_set_id").references(
      () => polarFitSets.id,
      { onDelete: "set null" },
    ),
    extraRoundsGranted: integer("extra_rounds_granted").notNull().default(0), // "Continue +N iterations"
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.campaignId, t.airfoilId, t.conditionId, t.objective],
    }),
    stateIdx: index("sim_campaign_lanes_state_idx").on(
      t.campaignId,
      t.objective,
      t.state,
    ),
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
    solvedResultId: uuid("solved_result_id").references(
      (): AnyPgColumn => results.id,
      { onDelete: "set null" },
    ),
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
    /** @deprecated Migration 0043 normalizes queue ownership into
     * sim_urans_verify_queue_campaigns plus background_owner. Retained for one
     * expand/contract deployment so an old control plane can coexist while
     * the migration is applied; new code must not read or write it. */
    campaignId: uuid("campaign_id").references(
      (): AnyPgColumn => simCampaigns.id,
      { onDelete: "set null" },
    ),
    /** True when this physical verification obligation also belongs to the
     * independent background catalog lane. Campaign ownership is many-to-many
     * in sim_urans_verify_queue_campaigns. */
    backgroundOwner: boolean("background_owner").notNull().default(false),
    /** Exact currently-authorized execution owner. request_payload carries
     * descriptive provenance only and must never authorize publication. */
    simJobId: uuid("sim_job_id").references(() => simJobs.id, {
      onDelete: "set null",
    }),
    // pending | running | done | disagreed | blocked | cancelled
    state: text("state").notNull().default("pending"),
    precalcResultId: uuid("precalc_result_id")
      .notNull()
      .references((): AnyPgColumn => results.id, { onDelete: "cascade" }),
    verifyResultId: uuid("verify_result_id").references(
      (): AnyPgColumn => results.id,
      { onDelete: "set null" },
    ),
    deltaCl: doublePrecision("delta_cl"),
    deltaCd: doublePrecision("delta_cd"),
    deltaCm: doublePrecision("delta_cm"),
    /** Physical full-URANS starts consumed by this verification item.
     * Same-case continuations are tracked separately and never consume a
     * fresh-start allowance. */
    freshAttemptCount: integer("fresh_attempt_count").notNull().default(0),
    maxFreshAttempts: integer("max_fresh_attempts").notNull().default(2),
    /** At most one continuation is authorized for each fresh trajectory. */
    continuationAttemptCount: integer("continuation_attempt_count")
      .notNull()
      .default(0),
    /** Admin-requested budget for a seeded same-case final continuation.
     * NULL uses the controller default. Shared request ownership keeps the
     * largest explicit override so attaching another owner cannot shorten an
     * already-promised physical continuation. */
    continuationBudgetOverrideS: integer("continuation_budget_override_s"),
    /** Latest immutable exact full-fidelity attempt, including rejected
     * evidence that the canonical-result replace guard deliberately did not
     * select over the accepted preliminary result. */
    latestResultAttemptId: uuid("latest_result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
    nextSubmitAt: timestamp("next_submit_at", { withTimezone: true }),
    /** Stable machine outcome for scheduling and incident aggregation. */
    lastOutcome: text("last_outcome"),
    lastError: text("last_error"),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    freshAttemptCountCheck: check(
      "sim_urans_verify_queue_fresh_attempt_count_check",
      sql`${t.freshAttemptCount} >= 0`,
    ),
    maxFreshAttemptsCheck: check(
      "sim_urans_verify_queue_max_fresh_attempts_check",
      sql`${t.maxFreshAttempts} >= 1`,
    ),
    continuationAttemptCountCheck: check(
      "sim_urans_verify_queue_continuation_attempt_count_check",
      sql`${t.continuationAttemptCount} >= 0 AND ${t.continuationAttemptCount} <= ${t.freshAttemptCount}`,
    ),
    continuationBudgetOverrideCheck: check(
      "sim_urans_verify_queue_continuation_budget_override_check",
      sql`${t.continuationBudgetOverrideS} IS NULL OR ${t.continuationBudgetOverrideS} > 0`,
    ),
    // Idempotent enqueue: one open item per cell (partial unique).
    openCellUq: uniqueIndex("sim_urans_verify_queue_open_cell_uq")
      .on(t.airfoilId, t.revisionId, t.aoaDeg)
      .where(sql`${t.state} IN ('pending', 'running')`),
    simJobUq: uniqueIndex("sim_urans_verify_queue_sim_job_uq")
      .on(t.simJobId)
      .where(sql`${t.simJobId} IS NOT NULL`),
    stateIdx: index("sim_urans_verify_queue_state_idx").on(t.state),
    pendingDueIdx: index("sim_urans_verify_queue_pending_due_idx")
      .on(t.nextSubmitAt, t.createdAt)
      .where(sql`${t.state} = 'pending'`),
    campaignIdx: index("sim_urans_verify_queue_campaign_idx").on(
      t.campaignId,
      t.state,
    ),
  }),
);

/** Many-to-many owners of one global physical verification obligation.
 * Association lifecycle is independent: cancelling one campaign marks only
 * its row cancelled, while shared/background ownership can keep the physical
 * queue item runnable. */
export const simUransVerifyQueueCampaigns = pgTable(
  "sim_urans_verify_queue_campaigns",
  {
    queueId: uuid("queue_id")
      .notNull()
      .references(() => simUransVerifyQueue.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references((): AnyPgColumn => simCampaigns.id, { onDelete: "cascade" }),
    // active | cancelled
    state: text("state").notNull().default("active"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.queueId, t.campaignId] }),
    stateCheck: check(
      "sim_urans_verify_queue_campaigns_state_check",
      sql`${t.state} IN ('active', 'cancelled')`,
    ),
    campaignStateIdx: index(
      "sim_urans_verify_queue_campaigns_campaign_state_idx",
    ).on(t.campaignId, t.state),
    queueStateIdx: index("sim_urans_verify_queue_campaigns_queue_state_idx").on(
      t.queueId,
      t.state,
    ),
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
    // pending | running | done | blocked | cancelled
    state: text("state").notNull().default("pending"),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    /** Continuation (migration 0037, amendment C): the rejected results row
     *  whose SAVED engine case state (engine_job_id + engine_case_slug on that
     *  row) this request resumes from. The ladder tick composes
     *  { continue_from: { engine_job_id, case_slug } } into the engine request
     *  and the engine restarts the transient from latestTime, merging
     *  coefficient history. NULL = ordinary fresh-solve request. */
    continueFromResultId: uuid("continue_from_result_id").references(
      (): AnyPgColumn => results.id,
      { onDelete: "set null" },
    ),
    /** Continuation budget override [s]: replaces the fidelity-derived solver
     *  budget for the resumed run (+2h / +6h UI choices). NULL = tier default. */
    budgetOverrideS: integer("budget_override_s"),
    /** Immutable audit provenance for the creator. Never infer current
     * scheduling or cancellation ownership from this value. */
    requestedBy: text("requested_by"),
    /** True when this physical request also has an independent admin/catalog
     * owner. Campaign beneficiaries are stored separately in
     * sim_urans_request_campaigns; requestedBy is creator provenance only. */
    backgroundOwner: boolean("background_owner").notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    openCellUq: uniqueIndex("sim_urans_requests_open_cell_uq")
      .on(
        t.airfoilId,
        t.revisionId,
        sql`COALESCE(${t.aoaDeg}, 'NaN'::float8)`,
        t.fidelity,
      )
      .where(sql`${t.state} IN ('pending', 'running')`),
    stateIdx: index("sim_urans_requests_state_idx").on(t.state),
  }),
);

/** Many-to-many campaign beneficiaries of one physical request. Automatic
 * continuations/fresh reused-evidence requests are campaign-owned; a covering
 * manual/admin request may also gain associations while retaining its
 * independent owner and global lifecycle. */
export const simUransRequestCampaigns = pgTable(
  "sim_urans_request_campaigns",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => simUransRequests.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references((): AnyPgColumn => simCampaigns.id, { onDelete: "cascade" }),
    // active | cancelled
    state: text("state").notNull().default("active"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.requestId, t.campaignId] }),
    stateCheck: check(
      "sim_urans_request_campaigns_state_check",
      sql`${t.state} IN ('active', 'cancelled')`,
    ),
    campaignStateIdx: index(
      "sim_urans_request_campaigns_campaign_state_idx",
    ).on(t.campaignId, t.state),
    requestStateIdx: index("sim_urans_request_campaigns_request_state_idx").on(
      t.requestId,
      t.state,
    ),
  }),
);

/** Durable request coverage for one global physical final-verification
 * obligation. A whole-polar admin request links to one queue row per angle;
 * an already-existing automatic queue row can be shared without copying the
 * request's independent lifecycle into background_owner. */
export const simUransVerifyQueueRequests = pgTable(
  "sim_urans_verify_queue_requests",
  {
    queueId: uuid("queue_id")
      .notNull()
      .references(() => simUransVerifyQueue.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => simUransRequests.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.queueId, t.requestId] }),
    requestIdx: index("sim_urans_verify_queue_requests_request_idx").on(
      t.requestId,
    ),
  }),
);

/** Durable answered-submit policy for full-fidelity ladder work. Exactly one
 * physical owner is present: either an explicit full URANS request or an
 * automatic full verification item. These rows never assert that OpenFOAM ran
 * and therefore never substitute for results or result_attempts evidence. */
export const simLadderSubmitRetries = pgTable(
  "sim_ladder_submit_retries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uransRequestId: uuid("urans_request_id").references(
      (): AnyPgColumn => simUransRequests.id,
      { onDelete: "cascade" },
    ),
    verifyQueueId: uuid("verify_queue_id").references(
      (): AnyPgColumn => simUransVerifyQueue.id,
      { onDelete: "cascade" },
    ),
    // retry_wait | blocked
    state: text("state").notNull(),
    /** Number of automatic answered-5xx retries consumed (0 or 1). */
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    latestSimJobId: uuid("latest_sim_job_id").references(
      (): AnyPgColumn => simJobs.id,
      { onDelete: "set null" },
    ),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error").notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    ownerXorCheck: check(
      "sim_ladder_submit_retries_owner_xor_check",
      sql`(${t.uransRequestId} IS NOT NULL) <> (${t.verifyQueueId} IS NOT NULL)`,
    ),
    stateCheck: check(
      "sim_ladder_submit_retries_state_check",
      sql`${t.state} IN ('retry_wait', 'blocked')`,
    ),
    attemptCheck: check(
      "sim_ladder_submit_retries_attempt_check",
      sql`${t.attemptCount} BETWEEN 0 AND 1`,
    ),
    stateShapeCheck: check(
      "sim_ladder_submit_retries_state_shape_check",
      sql`(
        (${t.state} = 'retry_wait' AND ${t.attemptCount} = 1 AND ${t.nextAttemptAt} IS NOT NULL)
        OR (${t.state} = 'blocked' AND ${t.nextAttemptAt} IS NULL)
      )`,
    ),
    requestUq: uniqueIndex("sim_ladder_submit_retries_request_uq")
      .on(t.uransRequestId)
      .where(sql`${t.uransRequestId} IS NOT NULL`),
    verifyUq: uniqueIndex("sim_ladder_submit_retries_verify_uq")
      .on(t.verifyQueueId)
      .where(sql`${t.verifyQueueId} IS NOT NULL`),
    readyIdx: index("sim_ladder_submit_retries_ready_idx").on(
      t.state,
      t.nextAttemptAt,
    ),
    latestJobIdx: index("sim_ladder_submit_retries_latest_job_idx").on(
      t.latestSimJobId,
    ),
  }),
);

/** One physical preliminary-URANS obligation per compatible setup cell.
 * Canonical result rows remain immutable evidence; scheduler attempts and
 * terminal unavailable outcomes live here instead of rewriting accepted or
 * needs_urans RANS coefficients into fake failed/queued evidence. */
export const simPrecalcObligations = pgTable(
  "sim_precalc_obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    sourceResultId: uuid("source_result_id").references(
      (): AnyPgColumn => results.id,
      { onDelete: "set null" },
    ),
    sourceResultAttemptId: uuid("source_result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
    // pending | running | satisfied | blocked | cancelled
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    submitFailureCount: integer("submit_failure_count").notNull().default(0),
    nextSubmitAt: timestamp("next_submit_at", { withTimezone: true }),
    /** Count of completed physical same-case continuation segments. A
     * continuation-stage infrastructure failure does not advance this count. */
    continuationSegmentCount: integer("continuation_segment_count")
      .notNull()
      .default(0),
    /** Consecutive completed continuation segments that failed to extend the
     * retained simulated-time/period window meaningfully. */
    continuationNoProgressCount: integer("continuation_no_progress_count")
      .notNull()
      .default(0),
    latestSimJobId: uuid("latest_sim_job_id").references(
      (): AnyPgColumn => simJobs.id,
      { onDelete: "set null" },
    ),
    backgroundOwner: boolean("background_owner").notNull().default(false),
    lastOutcome: text("last_outcome"),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    sourceAttemptOwnerFk: foreignKey({
      columns: [t.sourceResultAttemptId, t.sourceResultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "sim_precalc_obligations_source_attempt_owner_fk",
    }).onDelete("no action"),
    stateCheck: check(
      "sim_precalc_obligations_state_check",
      sql`${t.state} IN ('pending', 'running', 'satisfied', 'blocked', 'cancelled')`,
    ),
    attemptBoundsCheck: check(
      "sim_precalc_obligations_attempt_bounds_check",
      sql`${t.attemptCount} >= 0 AND ${t.maxAttempts} = 2 AND ${t.attemptCount} <= ${t.maxAttempts}`,
    ),
    submitFailureBoundsCheck: check(
      "sim_precalc_obligations_submit_failure_bounds_check",
      sql`${t.submitFailureCount} >= 0 AND ${t.submitFailureCount} <= 2`,
    ),
    continuationProgressBoundsCheck: check(
      "sim_precalc_obligations_continuation_progress_bounds_check",
      sql`${t.continuationSegmentCount} >= 0 AND ${t.continuationNoProgressCount} >= 0 AND ${t.continuationNoProgressCount} <= ${t.continuationSegmentCount}`,
    ),
    cellUq: unique("sim_precalc_obligations_cell_uq").on(
      t.airfoilId,
      t.revisionId,
      t.aoaDeg,
    ),
    stateIdx: index("sim_precalc_obligations_state_idx").on(
      t.state,
      t.updatedAt,
    ),
    submitDueIdx: index("sim_precalc_obligations_submit_due_idx").on(
      t.state,
      t.nextSubmitAt,
    ),
    latestJobIdx: index("sim_precalc_obligations_latest_job_idx").on(
      t.latestSimJobId,
    ),
    sourceAttemptIdx: index(
      "sim_precalc_obligations_source_result_attempt_idx",
    ).on(t.sourceResultAttemptId),
    meshRecoveryCandidateIdx: index(
      "sim_precalc_obligations_mesh_recovery_candidate_idx",
    )
      .on(t.id)
      .where(
        sql`${t.state} = 'blocked' AND ${t.attemptCount} < ${t.maxAttempts} AND ${t.lastOutcome} = 'deterministic_failure'`,
      ),
  }),
);

/** Immutable per-engine-submission audit rows for a bounded precalc
 * obligation. Solver-attempt numbers remain limited to the initial solve and
 * one correction; non-CFD infrastructure/setup submissions retain a monotonic
 * audit sequence without consuming that physical budget. */
export const simPrecalcObligationAttempts = pgTable(
  "sim_precalc_obligation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => simPrecalcObligations.id, { onDelete: "cascade" }),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    /** Monotonic engine-submission sequence. Infrastructure/setup failures
     * remain immutable audit rows and therefore still need their own sequence
     * even though they do not consume one of the two physical CFD attempts. */
    attemptNumber: integer("attempt_number").notNull(),
    /** Physical CFD-attempt ordinal. Null means the submission ended in
     * infrastructure or deterministic setup/mesh work before usable CFD
     * evidence and therefore did not consume the bounded solver budget. */
    solverAttemptNumber: integer("solver_attempt_number"),
    consumesSolverAttempt: boolean("consumes_solver_attempt")
      .notNull()
      .default(true),
    /** Effective engine mesh-recovery strategy used for this immutable
     * submission. Stored here because producing sim_jobs are retention-
     * eligible; default 0 is the honest legacy/pre-capability value. */
    meshRecoveryVersion: integer("mesh_recovery_version").notNull().default(0),
    /** Physical continuation ordinal. NULL for fresh solves and for
     * continuation submissions that never reached physical CFD evidence. */
    continuationSegmentNumber: integer("continuation_segment_number"),
    /** Cross-segment progress evidence copied from the immutable engine
     * payload. These values never replace result evidence; they make bounded
     * continuation policy restart-safe and auditable. */
    progressPeriodsRetained: doublePrecision("progress_periods_retained"),
    progressSimulatedTimeS: doublePrecision("progress_simulated_time_s"),
    progressDriftFrac: doublePrecision("progress_drift_frac"),
    progressStationary: boolean("progress_stationary"),
    continuationProgressed: boolean("continuation_progressed"),
    // submitted | accepted | rejected | failed | cancelled
    state: text("state").notNull().default("submitted"),
    outcome: text("outcome"),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
    error: text("error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    stateCheck: check(
      "sim_precalc_obligation_attempts_state_check",
      sql`${t.state} IN ('submitted', 'accepted', 'rejected', 'failed', 'cancelled')`,
    ),
    numberCheck: check(
      "sim_precalc_obligation_attempts_number_check",
      sql`${t.attemptNumber} > 0`,
    ),
    solverNumberCheck: check(
      "sim_precalc_obligation_attempts_solver_number_check",
      sql`${t.solverAttemptNumber} IS NULL OR ${t.solverAttemptNumber} IN (1, 2)`,
    ),
    meshRecoveryVersionCheck: check(
      "sim_precalc_obligation_attempts_mesh_recovery_version_check",
      sql`${t.meshRecoveryVersion} >= 0`,
    ),
    continuationSegmentCheck: check(
      "sim_precalc_obligation_attempts_continuation_segment_check",
      sql`${t.continuationSegmentNumber} IS NULL OR ${t.continuationSegmentNumber} > 0`,
    ),
    continuationProgressCheck: check(
      "sim_precalc_obligation_attempts_continuation_progress_check",
      sql`${t.continuationProgressed} IS NULL OR ${t.continuationSegmentNumber} IS NOT NULL`,
    ),
    jobUq: unique("sim_precalc_obligation_attempts_job_uq").on(
      t.obligationId,
      t.simJobId,
    ),
    numberUq: unique("sim_precalc_obligation_attempts_number_uq").on(
      t.obligationId,
      t.attemptNumber,
    ),
    solverNumberUq: uniqueIndex(
      "sim_precalc_obligation_attempts_solver_number_uq",
    )
      .on(t.obligationId, t.solverAttemptNumber)
      .where(sql`${t.solverAttemptNumber} IS NOT NULL`),
    jobIdx: index("sim_precalc_obligation_attempts_job_idx").on(t.simJobId),
    resultAttemptIdx: index(
      "sim_precalc_obligation_attempts_result_attempt_idx",
    ).on(t.resultAttemptId),
  }),
);

/** Many-to-many campaign beneficiaries of one physical preliminary solve. */
export const simPrecalcObligationCampaigns = pgTable(
  "sim_precalc_obligation_campaigns",
  {
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => simPrecalcObligations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references((): AnyPgColumn => simCampaigns.id, { onDelete: "cascade" }),
    // active | cancelled
    state: text("state").notNull().default("active"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.obligationId, t.campaignId] }),
    stateCheck: check(
      "sim_precalc_obligation_campaigns_state_check",
      sql`${t.state} IN ('active', 'cancelled')`,
    ),
    campaignStateIdx: index(
      "sim_precalc_obligation_campaigns_campaign_state_idx",
    ).on(t.campaignId, t.state),
    obligationStateIdx: index(
      "sim_precalc_obligation_campaigns_obligation_state_idx",
    ).on(t.obligationId, t.state),
  }),
);

/** Coverage links let a whole-polar/shared request drain several physical
 * obligations sequentially without declaring the request done after only the
 * first continuation settles. */
export const simPrecalcObligationRequests = pgTable(
  "sim_precalc_obligation_requests",
  {
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => simPrecalcObligations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => simUransRequests.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.obligationId, t.requestId] }),
    requestIdx: index("sim_precalc_obligation_requests_request_idx").on(
      t.requestId,
    ),
  }),
);

/** Durable solver recovery incidents. One row is one immutable recovery
 * occurrence, deduplicated by a controller-generated occurrence key. Current
 * severity/status are operational metadata; solver/result evidence remains in
 * result_attempts and is never copied or rewritten here. */
export const simSolverIncidents = pgTable(
  "sim_solver_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stage: text("stage").notNull(), // rans | preliminary | final
    reason: text("reason").notNull(),
    severity: text("severity").notNull(), // warning | critical
    status: text("status").notNull().default("open"), // open | resolved
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    precalcObligationId: uuid("precalc_obligation_id").references(
      () => simPrecalcObligations.id,
      { onDelete: "cascade" },
    ),
    verifyQueueId: uuid("verify_queue_id").references(
      () => simUransVerifyQueue.id,
      { onDelete: "cascade" },
    ),
    uransRequestId: uuid("urans_request_id").references(
      () => simUransRequests.id,
      { onDelete: "cascade" },
    ),
    solverImplementationId: uuid("solver_implementation_id")
      .notNull()
      .references(() => solverImplementations.id),
    simJobId: uuid("sim_job_id").references((): AnyPgColumn => simJobs.id, {
      onDelete: "set null",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
    /** Globally stable event identity, normally stage + physical owner +
     * immutable attempt/job identity. Reconciliation replay cannot double
     * count the same incident. */
    occurrenceKey: text("occurrence_key").notNull(),
    /** Version of the controller/remediation algorithm that observed this
     * occurrence. Recurrence summaries keep versions separate so an operator
     * can tell whether a deployed correction is actually reducing failures. */
    remediationVersion: text("remediation_version").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    resultAttemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "sim_solver_incidents_result_attempt_owner_fk",
    }),
    ownerXorCheck: check(
      "sim_solver_incidents_owner_xor_check",
      sql`num_nonnulls(${t.resultId}, ${t.precalcObligationId}, ${t.verifyQueueId}, ${t.uransRequestId}) = 1`,
    ),
    stageCheck: check(
      "sim_solver_incidents_stage_check",
      sql`${t.stage} IN ('rans', 'preliminary', 'final')`,
    ),
    severityCheck: check(
      "sim_solver_incidents_severity_check",
      sql`${t.severity} IN ('warning', 'critical')`,
    ),
    statusCheck: check(
      "sim_solver_incidents_status_check",
      sql`${t.status} IN ('open', 'resolved')`,
    ),
    statusShapeCheck: check(
      "sim_solver_incidents_status_shape_check",
      sql`(${t.status} = 'open' AND ${t.resolvedAt} IS NULL) OR (${t.status} = 'resolved' AND ${t.resolvedAt} IS NOT NULL)`,
    ),
    reasonCheck: check(
      "sim_solver_incidents_reason_check",
      sql`btrim(${t.reason}) <> ''`,
    ),
    occurrenceKeyCheck: check(
      "sim_solver_incidents_occurrence_key_check",
      sql`btrim(${t.occurrenceKey}) <> ''`,
    ),
    remediationVersionCheck: check(
      "sim_solver_incidents_remediation_version_check",
      sql`btrim(${t.remediationVersion}) <> ''`,
    ),
    occurrenceUq: uniqueIndex("sim_solver_incidents_occurrence_uq").on(
      t.occurrenceKey,
    ),
    aggregateIdx: index("sim_solver_incidents_aggregate_idx").on(
      t.stage,
      t.reason,
      t.solverImplementationId,
      t.remediationVersion,
      t.occurredAt,
    ),
    openIdx: index("sim_solver_incidents_open_idx")
      .on(t.severity, t.occurredAt)
      .where(sql`${t.status} = 'open'`),
    resultOwnerIdx: index("sim_solver_incidents_result_owner_idx").on(
      t.resultId,
      t.status,
    ),
    precalcOwnerIdx: index("sim_solver_incidents_precalc_owner_idx").on(
      t.precalcObligationId,
      t.status,
    ),
    verifyOwnerIdx: index("sim_solver_incidents_verify_owner_idx").on(
      t.verifyQueueId,
      t.status,
    ),
    requestOwnerIdx: index("sim_solver_incidents_request_owner_idx").on(
      t.uransRequestId,
      t.status,
    ),
  }),
);

/** Campaign beneficiaries of one physical incident. Historical associations
 * remain after a campaign pauses/completes so campaign-level recurrence
 * reports conserve the incidents that occurred while it owned the work. */
export const simSolverIncidentCampaigns = pgTable(
  "sim_solver_incident_campaigns",
  {
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => simSolverIncidents.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references((): AnyPgColumn => simCampaigns.id, { onDelete: "cascade" }),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.incidentId, t.campaignId] }),
    campaignIdx: index("sim_solver_incident_campaigns_campaign_idx").on(
      t.campaignId,
      t.incidentId,
    ),
  }),
);

/** Immutable, idempotent provenance for a conditional whole-polar promotion.
 * Mutable execution state remains in the shared physical obligations; this row
 * records why one exact RANS job/condition widened to its pinned polar scope. */
export const simRansPolarPromotions = pgTable(
  "sim_rans_polar_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentJobId: uuid("parent_job_id")
      .notNull()
      .references((): AnyPgColumn => simJobs.id, { onDelete: "cascade" }),
    airfoilId: uuid("airfoil_id")
      .notNull()
      .references(() => airfoils.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => simulationPresetRevisions.id, { onDelete: "cascade" }),
    conditionId: uuid("condition_id").references(
      (): AnyPgColumn => simCampaignConditions.id,
      { onDelete: "set null" },
    ),
    ownerKind: text("owner_kind").notNull(),
    campaignId: uuid("campaign_id").references(
      (): AnyPgColumn => simCampaigns.id,
      { onDelete: "cascade" },
    ),
    syncPromiseId: uuid("sync_promise_id").references(
      (): AnyPgColumn => syncSweepPromises.id,
      { onDelete: "cascade" },
    ),
    triggerResultAttemptId: uuid("trigger_result_attempt_id")
      .notNull()
      .references((): AnyPgColumn => resultAttempts.id, {
        onDelete: "cascade",
      }),
    triggerAoaDeg: doublePrecision("trigger_aoa_deg").notNull(),
    failureDisposition: text("failure_disposition").notNull(),
    requestOrigin: text("request_origin").notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    triggerUq: unique("sim_rans_polar_promotions_trigger_uq").on(
      t.triggerResultAttemptId,
    ),
    parentRevisionUq: unique("sim_rans_polar_promotions_parent_revision_uq").on(
      t.parentJobId,
      t.revisionId,
    ),
    triggerRangeCheck: check(
      "sim_rans_polar_promotions_trigger_range_check",
      sql`${t.triggerAoaDeg} >= 0 AND ${t.triggerAoaDeg} <= 5`,
    ),
    dispositionCheck: check(
      "sim_rans_polar_promotions_disposition_check",
      sql`${t.failureDisposition} = 'hard_solver'`,
    ),
    originCheck: check(
      "sim_rans_polar_promotions_origin_check",
      sql`${t.requestOrigin} = 'continuous-polar'`,
    ),
    ownerKindCheck: check(
      "sim_rans_polar_promotions_owner_kind_check",
      sql`${t.ownerKind} IN ('campaign', 'background', 'sync_promise')`,
    ),
    ownerShapeCheck: check(
      "sim_rans_polar_promotions_owner_shape_check",
      sql`(
        (${t.ownerKind} = 'campaign' AND ${t.campaignId} IS NOT NULL AND ${t.syncPromiseId} IS NULL)
        OR (${t.ownerKind} = 'background' AND ${t.campaignId} IS NULL AND ${t.syncPromiseId} IS NULL)
        OR (${t.ownerKind} = 'sync_promise' AND ${t.campaignId} IS NULL AND ${t.syncPromiseId} IS NOT NULL)
      )`,
    ),
    parentIdx: index("sim_rans_polar_promotions_parent_idx").on(t.parentJobId),
    revisionIdx: index("sim_rans_polar_promotions_revision_idx").on(
      t.airfoilId,
      t.revisionId,
    ),
    campaignIdx: index("sim_rans_polar_promotions_campaign_idx").on(
      t.campaignId,
    ),
    syncPromiseIdx: index("sim_rans_polar_promotions_sync_promise_idx").on(
      t.syncPromiseId,
    ),
  }),
);

/** Exact full-polar coverage of one promotion. The obligation link makes the
 * recovery path independent of in-memory retry planning and safe across a
 * process death between promotion commit and child composition. */
export const simRansPolarPromotionPoints = pgTable(
  "sim_rans_polar_promotion_points",
  {
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => simRansPolarPromotions.id, { onDelete: "cascade" }),
    aoaDeg: doublePrecision("aoa_deg").notNull(),
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => simPrecalcObligations.id, { onDelete: "cascade" }),
    intentionallyOmittedByRans: boolean("intentionally_omitted_by_rans")
      .notNull()
      .default(false),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.promotionId, t.aoaDeg] }),
    promotionObligationUq: unique(
      "sim_rans_polar_promotion_points_promotion_obligation_uq",
    ).on(t.promotionId, t.obligationId),
    obligationIdx: index("sim_rans_polar_promotion_points_obligation_idx").on(
      t.obligationId,
    ),
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
  defaultPromiseTtlHours: integer("default_promise_ttl_hours")
    .notNull()
    .default(24),
  upstreamBaseUrl: text("upstream_base_url"),
  upstreamSecret: text("upstream_secret").notNull().default(""),
  syncMode: syncModeEnum("sync_mode").notNull().default("full"),
  remoteSolverEnabled: boolean("remote_solver_enabled")
    .notNull()
    .default(false),
  remoteSolverCpuBudget: integer("remote_solver_cpu_budget")
    .notNull()
    .default(1),
  remoteSolverClaimSize: integer("remote_solver_claim_size")
    .notNull()
    .default(36),
  remoteSolverHeartbeatIntervalSeconds: integer(
    "remote_solver_heartbeat_interval_seconds",
  )
    .notNull()
    .default(60),
  remoteSolverRegisteredId: uuid("remote_solver_registered_id"),
  remoteSolverLastSyncAt: timestamp("remote_solver_last_sync_at", {
    withTimezone: true,
  }),
  remoteSolverLastPromiseAt: timestamp("remote_solver_last_promise_at", {
    withTimezone: true,
  }),
  remoteSolverLastPushAt: timestamp("remote_solver_last_push_at", {
    withTimezone: true,
  }),
  remoteSolverLastStatus: remoteSolverStatusEnum("remote_solver_last_status")
    .notNull()
    .default("disabled"),
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
    scopeIdx: index("sync_sweep_promises_scope_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
    ),
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
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "set null",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "sync_sweep_promise_points_attempt_owner_fk",
    }).onDelete("no action"),
    promiseIdx: index("sync_sweep_promise_points_promise_idx").on(t.promiseId),
    statusIdx: index("sync_sweep_promise_points_status_idx").on(t.status),
    attemptIdx: index("sync_sweep_promise_points_attempt_idx").on(
      t.resultAttemptId,
    ),
    scopeIdx: index("sync_sweep_promise_points_scope_idx").on(
      t.airfoilId,
      t.simulationPresetRevisionId,
      t.aoaDeg,
    ),
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
    fingerprint: text("fingerprint"),
    status: syncImportConflictStatusEnum("status").notNull().default("pending"),
    incomingPayload: jsonb("incoming_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    localSnapshot: jsonb("local_snapshot").$type<Record<string, unknown>>(),
    artifactManifest:
      jsonb("artifact_manifest").$type<Record<string, unknown>>(),
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
    naturalKeyIdx: index("sync_import_conflicts_natural_key_idx").on(
      t.dataType,
      t.naturalKey,
    ),
    pendingFingerprintUq: uniqueIndex(
      "sync_import_conflicts_pending_fingerprint_uq",
    )
      .on(t.fingerprint)
      .where(sql`${t.status} = 'pending' AND ${t.fingerprint} IS NOT NULL`),
  }),
);

/** Leased process-independent byte reservations for sync-import staging. */
export const syncUploadCapacityReservations = pgTable(
  "sync_upload_capacity_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: uuid("token").notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    bytesCheck: check(
      "sync_upload_capacity_reservations_bytes_check",
      sql`${t.reservedBytes} > 0`,
    ),
    expiryIdx: index("sync_upload_capacity_reservations_expiry_idx").on(
      t.expiresAt,
    ),
    tokenUq: uniqueIndex("sync_upload_capacity_reservations_token_uq").on(
      t.token,
    ),
  }),
);

/** Durable execution/delivery state for evidence pushed by a remote solver.
 * This is deliberately separate from immutable result/attempt rows and from
 * sim_jobs.request_payload. One promise+result row follows the current attempt
 * generation; result_id NULL rows terminally account for empty/superseded
 * jobs so old history cannot starve current delivery discovery. */
export const syncRemoteResultDeliveries = pgTable(
  "sync_remote_result_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promiseId: uuid("promise_id")
      .notNull()
      .references(() => syncSweepPromises.id, { onDelete: "cascade" }),
    simJobId: uuid("sim_job_id")
      .notNull()
      .references((): AnyPgColumn => simJobs.id, { onDelete: "cascade" }),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "cascade" },
    ),
    aoaDeg: doublePrecision("aoa_deg"),
    generationKey: text("generation_key").notNull(),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error"),
    remoteConflictIds: jsonb("remote_conflict_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "sync_remote_result_deliveries_attempt_owner_fk",
    }).onDelete("cascade"),
    resultUq: uniqueIndex("sync_remote_result_deliveries_result_uq")
      .on(t.promiseId, t.resultId)
      .where(sql`${t.resultId} IS NOT NULL`),
    emptyJobUq: uniqueIndex("sync_remote_result_deliveries_empty_job_uq")
      .on(t.promiseId, t.simJobId)
      .where(sql`${t.resultId} IS NULL`),
    readyIdx: index("sync_remote_result_deliveries_ready_idx").on(
      t.state,
      t.nextAttemptAt,
    ),
    jobIdx: index("sync_remote_result_deliveries_job_idx").on(
      t.simJobId,
      t.state,
    ),
    attemptIdx: index("sync_remote_result_deliveries_result_attempt_idx").on(
      t.resultAttemptId,
    ),
    shapeCheck: check(
      "sync_remote_result_deliveries_shape_check",
      sql`(
        (${t.resultId} IS NULL AND ${t.resultAttemptId} IS NULL AND ${t.aoaDeg} IS NULL)
        OR (${t.resultId} IS NOT NULL AND ${t.resultAttemptId} IS NOT NULL AND ${t.aoaDeg} IS NOT NULL)
      )`,
    ),
    stateCheck: check(
      "sync_remote_result_deliveries_state_check",
      sql`${t.state} IN ('pending', 'pushing', 'retry_wait', 'delivered', 'blocked', 'superseded')`,
    ),
    attemptCheck: check(
      "sync_remote_result_deliveries_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
    claimShapeCheck: check(
      "sync_remote_result_deliveries_claim_shape_check",
      sql`(
        (${t.state} = 'pushing' AND ${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL)
        OR (${t.state} <> 'pushing' AND ${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL)
      )`,
    ),
  }),
);

/** Durable, idempotent upstream lease release after local terminal failure. */
export const syncRemotePromiseCancellations = pgTable(
  "sync_remote_promise_cancellations",
  {
    promiseId: uuid("promise_id").primaryKey(),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    promiseFk: foreignKey({
      columns: [t.promiseId],
      foreignColumns: [syncSweepPromises.id],
      name: "sync_remote_promise_cancellations_promise_fk",
    }).onDelete("no action"),
    stateCheck: check(
      "sync_remote_promise_cancellations_state_check",
      sql`${t.state} IN ('pending', 'retry_wait', 'delivered')`,
    ),
    attemptCheck: check(
      "sync_remote_promise_cancellations_attempt_check",
      sql`${t.attemptCount} >= 0`,
    ),
    readyIdx: index("sync_remote_promise_cancellations_ready_idx").on(
      t.state,
      t.nextAttemptAt,
    ),
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
    instanceUq: uniqueIndex("registered_remote_solvers_instance_uq").on(
      t.instanceId,
    ),
    statusIdx: index("registered_remote_solvers_status_idx").on(t.status),
    heartbeatIdx: index("registered_remote_solvers_heartbeat_idx").on(
      t.lastHeartbeatAt,
    ),
  }),
);

export const remoteAssetReferences = pgTable(
  "remote_asset_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localKind: text("local_kind").notNull(),
    localRowId: uuid("local_row_id"),
    localStorageKey: text("local_storage_key").notNull(),
    resultId: uuid("result_id").references((): AnyPgColumn => results.id, {
      onDelete: "cascade",
    }),
    resultAttemptId: uuid("result_attempt_id").references(
      (): AnyPgColumn => resultAttempts.id,
      { onDelete: "set null" },
    ),
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
    availability: remoteAssetAvailabilityEnum("availability")
      .notNull()
      .default("remote_only"),
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
    attemptOwnerFk: foreignKey({
      columns: [t.resultAttemptId, t.resultId],
      foreignColumns: [resultAttempts.id, resultAttempts.resultId],
      name: "remote_asset_references_attempt_owner_fk",
    }).onDelete("no action"),
    storageUq: uniqueIndex("remote_asset_references_storage_uq").on(
      t.localStorageKey,
    ),
    localRowIdx: index("remote_asset_references_local_row_idx").on(
      t.localKind,
      t.localRowId,
    ),
    resultIdx: index("remote_asset_references_result_idx").on(t.resultId),
    attemptIdx: index("remote_asset_references_result_attempt_idx").on(
      t.resultAttemptId,
    ),
    remoteArtifactIdx: index("remote_asset_references_remote_artifact_idx").on(
      t.sourceInstanceId,
      t.remoteArtifactId,
    ),
    remoteMediaIdx: index("remote_asset_references_remote_media_idx").on(
      t.sourceInstanceId,
      t.remoteMediaId,
    ),
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
export type MediumViscosityTablePoint =
  typeof mediumViscosityTablePoints.$inferSelect;
export type FlowCondition = typeof flowConditions.$inferSelect;
export type ReferenceGeometryProfile =
  typeof referenceGeometryProfiles.$inferSelect;
export type OperatingCondition = typeof operatingConditions.$inferSelect;
export type BoundaryProfile = typeof boundaryProfiles.$inferSelect;
export type MeshProfile = typeof meshProfiles.$inferSelect;
export type SolverImplementation = typeof solverImplementations.$inferSelect;
export type SolverRuntimeBuild = typeof solverRuntimeBuilds.$inferSelect;
export type SolverExecutionPool = typeof solverExecutionPools.$inferSelect;
export type SolverProfile = typeof solverProfiles.$inferSelect;
export type SchedulingProfile = typeof schedulingProfiles.$inferSelect;
export type OutputProfile = typeof outputProfiles.$inferSelect;
export type SweepDefinition = typeof sweepDefinitions.$inferSelect;
export type BoundaryCondition = typeof boundaryConditions.$inferSelect;
export type SimulationPreset = typeof simulationPresets.$inferSelect;
export type SimulationPresetAirfoilTarget =
  typeof simulationPresetAirfoilTargets.$inferSelect;
export type ResultReviewVerdict = typeof resultReviewVerdicts.$inferSelect;
export type SyncApiSetting = typeof syncApiSettings.$inferSelect;
export type SyncApiPermission = typeof syncApiPermissions.$inferSelect;
export type SyncSweepPromise = typeof syncSweepPromises.$inferSelect;
export type SyncSweepPromisePoint = typeof syncSweepPromisePoints.$inferSelect;
export type SyncImportConflict = typeof syncImportConflicts.$inferSelect;
export type RegisteredRemoteSolver =
  typeof registeredRemoteSolvers.$inferSelect;
export type RemoteAssetReference = typeof remoteAssetReferences.$inferSelect;
export type SimulationPresetRevision =
  typeof simulationPresetRevisions.$inferSelect;
export type Result = typeof results.$inferSelect;
export type ResultInsert = typeof results.$inferInsert;
export type ResultAttempt = typeof resultAttempts.$inferSelect;
export type ResultAttemptInsert = typeof resultAttempts.$inferInsert;
export type ResultMedia = typeof resultMedia.$inferSelect;
export type SolverEvidenceArtifact =
  typeof solverEvidenceArtifacts.$inferSelect;
export type SolverEvidenceBlob = typeof solverEvidenceBlobs.$inferSelect;
export type SolverEvidenceArchive = typeof solverEvidenceArchives.$inferSelect;
export type SolverEvidenceArtifactMember =
  typeof solverEvidenceArtifactMembers.$inferSelect;
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
export type SimCampaignPlanRevision =
  typeof simCampaignPlanRevisions.$inferSelect;
export type SimCampaignPlanRevisionInsert =
  typeof simCampaignPlanRevisions.$inferInsert;
export type SimCampaignCondition = typeof simCampaignConditions.$inferSelect;
export type SimCampaignConditionInsert =
  typeof simCampaignConditions.$inferInsert;
export type SimCampaignPoint = typeof simCampaignPoints.$inferSelect;
export type SimCampaignPointInsert = typeof simCampaignPoints.$inferInsert;
export type SimCampaignProgressRow = typeof simCampaignProgress.$inferSelect;
export type SimCampaignLane = typeof simCampaignLanes.$inferSelect;
export type SimCampaignLaneStep = typeof simCampaignLaneSteps.$inferSelect;
export type SimUransVerifyQueueItem = typeof simUransVerifyQueue.$inferSelect;
export type SimUransVerifyQueueCampaign =
  typeof simUransVerifyQueueCampaigns.$inferSelect;
export type SimUransRequest = typeof simUransRequests.$inferSelect;
export type SimLadderSubmitRetry = typeof simLadderSubmitRetries.$inferSelect;
export type SimUransRequestCampaign =
  typeof simUransRequestCampaigns.$inferSelect;
export type SimUransVerifyQueueRequest =
  typeof simUransVerifyQueueRequests.$inferSelect;
export type SimPrecalcObligation = typeof simPrecalcObligations.$inferSelect;
export type SimPrecalcObligationAttempt =
  typeof simPrecalcObligationAttempts.$inferSelect;
export type SimPrecalcObligationCampaign =
  typeof simPrecalcObligationCampaigns.$inferSelect;
export type SimPrecalcObligationRequest =
  typeof simPrecalcObligationRequests.$inferSelect;
export type SimSolverIncident = typeof simSolverIncidents.$inferSelect;
export type SimSolverIncidentCampaign =
  typeof simSolverIncidentCampaigns.$inferSelect;
export type SimRansPolarPromotion = typeof simRansPolarPromotions.$inferSelect;
export type SimRansPolarPromotionPoint =
  typeof simRansPolarPromotionPoints.$inferSelect;
