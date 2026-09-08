import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveGeometry, parseCoordinates } from "@aerodb/core";
import { eq } from "drizzle-orm";
import { createClient, type DB } from "./client";
import {
  materializeCampaignLaunch,
  reconcileCampaignProfileEnrollment,
} from "./campaigns";
import { analysisContentHash } from "./analysis-target";
import { materializeProgressiveCampaignScope } from "./progressive-materialization";
import {
  seedRuntimeProfiles,
  SEEDED_RUNTIME_PROFILE_SLUGS,
} from "../seed/runtime-profiles";
import { assertSeedCoordinateIntegrity } from "../seed/coordinate-integrity";
import {
  airfoils,
  boundaryProfiles,
  categories,
  mediums,
  mediumViscosityTablePoints,
  meshProfiles,
  outputProfiles,
  simCampaigns,
  solverProfiles,
  sweeperState,
} from "./schema";
import { runProgressiveBaselineBatch } from "../../../apps/sweeper/src/progressive-baselines";
import type { EngineClient } from "../../engine-client/src/client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (
  process.env.DC2_COMPONENT !== "api" ||
  !process.env.DC2_POSTGRES_DB_URL ||
  process.env.DATABASE_URL !== process.env.DC2_POSTGRES_DB_URL
)
  throw new Error(
    "Preview initialization requires its coordinator-owned isolated database",
  );
const { db, sql: connection } = createClient({ max: 2 });
try {
  const campaign = await db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    const campaignName = "Local AG24 progressive preview";
    let [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.name, campaignName));
    const text = readFileSync(
      resolve(root, "packages/db/seed/selig-database/ag24.dat"),
      "utf8",
    );
    assertSeedCoordinateIntegrity(text, "ag24.dat");
    const parsed = parseCoordinates(text);
    const displayName = parsed.name
      .split("|")[0]
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ");
    if (!campaign) {
      const geometry = deriveGeometry(parsed.points);
      const [category] = await db
        .insert(categories)
        .values({ slug: "drela", name: "Drela", path: "drela", depth: 0 })
        .onConflictDoUpdate({ target: categories.slug, set: { name: "Drela" } })
        .returning();
      const [airfoil] = await db
        .insert(airfoils)
        .values({
          slug: "ag24",
          name: displayName,
          categoryId: category.id,
          points: geometry.contour,
          pointFormat: parsed.format,
          source: "selig-database",
          thicknessPct: geometry.thicknessPct,
          camberPct: geometry.camberPct,
          thicknessXPct: geometry.thicknessXPct,
          camberXPct: geometry.camberXPct,
          leRadiusPct: geometry.leRadiusPct,
          teThicknessPct: geometry.teThicknessPct,
          areaProfile: geometry.areaProfile,
          areaUpper: geometry.areaUpper,
          areaLower: geometry.areaLower,
          areaCamber: geometry.areaCamber,
          refMetricsSource: "queued",
        })
        .onConflictDoNothing()
        .returning();
      const airData = JSON.parse(
        readFileSync(resolve(root, "packages/db/seed/mediums.json"), "utf8"),
      ).mediums.find((medium: { slug: string }) => medium.slug === "air");
      const [air] = await db
        .insert(mediums)
        .values({
          slug: airData.slug,
          name: airData.name,
          phase: airData.phase,
          density: airData.density,
          refTemperatureK: airData.refTemperatureK,
          refPressurePa: airData.refPressurePa,
          viscosityModel: airData.viscosityModel,
          dynamicViscosity: airData.dynamicViscosity,
          kinematicViscosity: airData.kinematicViscosity,
          speedOfSound: airData.speedOfSound,
          notes: airData.notes,
        })
        .onConflictDoNothing()
        .returning();
      if (!airfoil || !air)
        throw new Error(
          "Preview bootstrap found conflicting pre-existing canonical data",
        );
      await db
        .insert(mediumViscosityTablePoints)
        .values(
          airData.viscosityTable.map(
            (point: {
              temperatureK: number;
              dynamicViscosity: number;
              sortOrder: number;
            }) => ({ ...point, mediumId: air.id }),
          ),
        );
      await seedRuntimeProfiles(db);
      const [boundary] = await db
        .select()
        .from(boundaryProfiles)
        .where(
          eq(boundaryProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.boundary),
        );
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
      const launched = await materializeCampaignLaunch(db, {
        name: campaignName,
        priority: 5,
        idempotencyKey: "local-progressive-preview-v1",
        airfoilIds: [airfoil.id],
        plan: {
          mediumId: air.id,
          ambients: [[288.15, 101325]],
          speedsMps: [30, 90, 166],
          chordsM: [0.1, 1],
          spanM: 1,
          areaMode: "derived",
          excludedConditions: [],
          baseSweep: {
            fromDeg: null,
            toDeg: null,
            stepDeg: null,
            listDeg: Array.from({ length: 26 }, (_, index) => index - 5),
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
      [campaign] = await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, launched.campaign.id));
    }
    await db
      .update(airfoils)
      .set({ name: displayName })
      .where(eq(airfoils.slug, "ag24"));
    return campaign;
  });
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoNothing();
  const comparisonCoordinates = readFileSync(
    resolve(root, "packages/db/seed/selig-database/ag25.dat"),
    "utf8",
  );
  assertSeedCoordinateIntegrity(comparisonCoordinates, "ag25.dat");
  const comparisonParsed = parseCoordinates(comparisonCoordinates);
  const comparisonGeometry = deriveGeometry(comparisonParsed.points);
  const [comparisonCategory] = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, "drela"));
  if (!comparisonCategory)
    throw new Error("Preview profile category is missing");
  await db
    .insert(airfoils)
    .values({
      slug: "ag25",
      name: comparisonParsed.name
        .split("|")[0]
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .join(" "),
      categoryId: comparisonCategory.id,
      points: comparisonGeometry.contour,
      pointFormat: comparisonParsed.format,
      source: "selig-database",
      thicknessPct: comparisonGeometry.thicknessPct,
      camberPct: comparisonGeometry.camberPct,
      thicknessXPct: comparisonGeometry.thicknessXPct,
      camberXPct: comparisonGeometry.camberXPct,
      leRadiusPct: comparisonGeometry.leRadiusPct,
      teThicknessPct: comparisonGeometry.teThicknessPct,
      areaProfile: comparisonGeometry.areaProfile,
      areaUpper: comparisonGeometry.areaUpper,
      areaLower: comparisonGeometry.areaLower,
      areaCamber: comparisonGeometry.areaCamber,
      refMetricsSource: "queued",
    })
    .onConflictDoNothing();
  const [comparisonProfile] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.slug, "ag25"));
  if (
    !comparisonProfile ||
    comparisonProfile.archivedAt ||
    comparisonProfile.deletedAt ||
    analysisContentHash(comparisonProfile.points) !==
      analysisContentHash(comparisonGeometry.contour)
  )
    throw new Error(
      "Preview comparison profile conflicts with its trusted coordinates",
    );
  while (await reconcileCampaignProfileEnrollment(db)) {}
  await materializeProgressiveCampaignScope(db, campaign.id);
  const localPredictor: Pick<EngineClient, "predictNeuralFoil"> = {
    predictNeuralFoil: (request) =>
      new Promise((resolvePrediction, reject) => {
        const child = spawn(
          resolve(root, ".venv/bin/python"),
          ["-m", "airfoilfoam.prediction_batch"],
          {
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 120_000,
          },
        );
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          errors = (errors + chunk).slice(-4000);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0)
            reject(new Error(`Local NeuralFoil calculation failed: ${errors}`));
          else {
            try {
              resolvePrediction(JSON.parse(output));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stdin.end(JSON.stringify(request));
      }),
  };
  const totals = { claimed: 0, stored: 0, reused: 0 };
  for (;;) {
    const result = await runProgressiveBaselineBatch(
      db,
      localPredictor,
      "local-preview-bootstrap",
    );
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    if (!result.claimed) break;
    totals.claimed += result.claimed;
    totals.stored += result.stored;
    totals.reused += result.reused;
  }
  console.log(
    JSON.stringify({
      purpose: "local-progressive-preview",
      source: "repository AG24 and AG25 coordinates and medium data",
      ...totals,
    }),
  );
} finally {
  await connection.end();
}
