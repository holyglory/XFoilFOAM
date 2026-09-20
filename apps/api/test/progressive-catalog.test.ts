import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { progressiveCurveMetrics } from "@aerodb/core";
import { createClient, type DB } from "@aerodb/db/client";
import {
  publicProgressiveCatalog,
  publicProgressiveConditions,
} from "@aerodb/db/progressive-catalog";
import { publicProgressivePolars } from "@aerodb/db/progressive-public";
import { createMinimalSolverFixture } from "../../../packages/db/test/solver-fixture";
import { simJobs } from "@aerodb/db";

const isolated = vi.hoisted(() => ({
  connection: null as DB | null,
  selectedTables: [] as unknown[],
}));
vi.mock("../src/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        if (!isolated.connection)
          throw new Error("Missing isolated catalog connection");
        const value = Reflect.get(isolated.connection, key);
        if (key === "select") {
          return (...args: unknown[]) =>
            new Proxy(value.apply(isolated.connection, args), {
              get(builder, property) {
                if (property === "from") {
                  return (table: unknown) => {
                    isolated.selectedTables.push(table);
                    return builder.from(table);
                  };
                }
                return Reflect.get(builder, property);
              },
            });
        }
        return typeof value === "function"
          ? value.bind(isolated.connection)
          : value;
      },
    },
  ),
}));
import { listAirfoils } from "../src/services/catalog";
import { assembleDetail } from "../src/services/detail";

const { db, sql: client } = createClient({ max: 1 });
afterAll(() => client.end({ timeout: 5 }));
const signature = () => createHash("sha256").update(randomUUID()).digest("hex");

it("keeps stored catalog summaries equivalent to curve metrics and rejects malformed caches", async () => {
  const cases = [
    {
      alpha: [-2, 0, 2],
      coefficients: [
        [-0.2, 0.02, 0],
        [0, 0.01, -0.01],
        [1, 0.02, -0.03],
      ],
    },
    {
      alpha: [0, 1],
      coefficients: [
        [-1, 0.02, 0],
        [-0.5, 0.01, 0],
      ],
    },
    {
      alpha: [0, 1],
      coefficients: [
        [1e308, 1e-308, 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [0, 0],
      coefficients: [
        [0, 0.01, 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [1, 0],
      coefficients: [
        [0, 0.01, 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [0, 1],
      coefficients: [
        [0, 0, 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [0, 1],
      coefficients: [
        [0, -0.01, 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [0, 1],
      coefficients: [
        [0, 0.01, NaN],
        [1, 0.02, 0],
      ],
    },
  ];
  for (const fixture of cases) {
    const expected = progressiveCurveMetrics(
      fixture.alpha.map((alpha, index) => ({
        alpha,
        cl: fixture.coefficients[index][0],
        cd: fixture.coefficients[index][1],
        cm: fixture.coefficients[index][2],
      })),
    );
    const [row] = await db.execute(
      sql`SELECT public_curve_metrics_v1(${JSON.stringify(fixture.alpha)}::jsonb, ${JSON.stringify(fixture.coefficients)}::jsonb) AS metrics`,
    );
    expect(row.metrics).toEqual(
      expected
        ? {
            ldmax: expected.liftToDragMaximum,
            clmax: expected.liftMaximum,
            cdmin: expected.dragMinimum,
          }
        : null,
    );
  }
  for (const fixture of [
    { alpha: [], coefficients: [] },
    { alpha: [0], coefficients: [[0, 0.01, 0]] },
    { alpha: [0, 1], coefficients: [[0, 0.01, 0]] },
    {
      alpha: [0, 1],
      coefficients: [
        [0, 0.01],
        [1, 0.02, 0],
      ],
    },
    { alpha: [0, 1], coefficients: [null, [1, 0.02, 0]] },
    {
      alpha: [0, 1],
      coefficients: [
        [0, "0.01", 0],
        [1, 0.02, 0],
      ],
    },
    {
      alpha: [0, "1"],
      coefficients: [
        [0, 0.01, 0],
        [1, 0.02, 0],
      ],
    },
    { alpha: {}, coefficients: [] },
    { alpha: null, coefficients: null },
  ]) {
    const [row] = await db.execute(
      sql`SELECT public_curve_metrics_v1(${JSON.stringify(fixture.alpha)}::jsonb, ${JSON.stringify(fixture.coefficients)}::jsonb) AS metrics`,
    );
    expect(row.metrics).toBeNull();
  }
});

async function verifyPublicCatalog(fullScale: boolean) {
  const rollback = new Error("isolated public catalog proof");
  try {
    await expect(
      db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        isolated.connection = connection;
        const prefix = `public-metrics-${randomUUID()}`;
        const fixture = await createMinimalSolverFixture(connection, prefix);
        await connection.execute(
          sql`UPDATE simulation_preset_revisions SET snapshot=jsonb_set(snapshot,'{flowState,mediumSlug}','"air"') WHERE id=${fixture.revisionId}`,
        );
        const [category] = await connection.execute(
          sql`SELECT id FROM categories LIMIT 1`,
        );
        const profiles = [];
        for (const suffix of ["A", "Z", "Missing"]) {
          const [profile] = await connection.execute(sql`
          INSERT INTO airfoils(slug,name,category_id,points)
          VALUES(${prefix + suffix},${prefix + suffix},${category.id},'[{"x":1,"y":0},{"x":0,"y":0.1},{"x":1,"y":0}]') RETURNING id
        `);
          profiles.push(String(profile.id));
        }
        const campaignId = randomUUID();
        const revisionId = randomUUID();
        await connection.execute(
          sql`INSERT INTO sim_campaigns(id,slug,name,idempotency_key) VALUES(${campaignId},${prefix},${prefix},${prefix})`,
        );
        await connection.execute(
          sql`INSERT INTO sim_campaign_plan_revisions(id,campaign_id,revision_number,kind,plan,summary) VALUES(${revisionId},${campaignId},1,'launch','{}','{}')`,
        );
        await connection.execute(
          sql`UPDATE sim_campaigns SET current_plan_revision_id=${revisionId} WHERE id=${campaignId}`,
        );
        const [epoch] = await connection.execute(
          sql`SELECT id FROM calculation_epochs WHERE current`,
        );
        const generationId = randomUUID();
        await connection.execute(
          sql`INSERT INTO progressive_generations(id,epoch_id,campaign_id,plan_revision_id,scope_key,scope_signature) VALUES(${generationId},${epoch.id},${campaignId},${revisionId},${prefix},${signature()})`,
        );
        const makePrediction = async (
          airfoilId: string,
          speed: number,
          lift: number,
          epochId = String(epoch.id),
        ) => {
          const targetId = signature();
          const predictionId = signature();
          const physical = {
            version: "physical-analysis-target-v1",
            airfoilId,
            geometry: [
              [1, 0],
              [0, 0.1],
              [1, 0],
            ],
            material: { phase: "gas" },
            flow: { speedMps: speed, temperatureK: 288.15, pressurePa: 101325 },
            reference: { referenceLengthM: 1 },
            boundary: { turbulenceIntensity: 0.001 },
            transition: { model: "fully_turbulent" },
            branch: "increasing",
            derived: { reynolds: speed * 10000, mach: speed / 340 },
          };
          const payload = {
            kind: "prediction",
            method: "neuralfoil",
            cfd_evidence: false,
            alpha: [0, 2],
            coefficients: [
              [0, 0.01, 0],
              [lift, 0.01, -0.02],
            ],
            model: { neuralfoil: "isolated-test" },
            geometry_fit: { rms_chord: 0, maximum_chord: 0 },
          };
          await connection.execute(
            sql`INSERT INTO polar_analysis_targets(id,airfoil_id,physical) VALUES(${targetId},${airfoilId},${JSON.stringify(physical)}::jsonb)`,
          );
          await connection.execute(
            sql`INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes) VALUES(${generationId},${targetId},${fixture.revisionId},ARRAY[0,2]::float8[],'{}')`,
          );
          await connection.execute(
            sql`INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload) VALUES(${predictionId},${epochId},${targetId},${JSON.stringify(payload)}::jsonb)`,
          );
          return { targetId, predictionId };
        };
        const first = await makePrediction(profiles[0], 30, 1);
        await makePrediction(profiles[0], 90, 0.5);
        await makePrediction(profiles[1], 30, 2);
        const obsoleteEpoch = randomUUID();
        await connection.execute(
          sql`INSERT INTO calculation_epochs(id,current,reason) VALUES(${obsoleteEpoch},false,'isolated obsolete prediction')`,
        );
        await makePrediction(profiles[0], 166, 9, obsoleteEpoch);
        const catalog = await publicProgressiveCatalog(connection, profiles);
        expect(catalog.conditions).toHaveLength(2);
        expect(catalog.metrics.get(profiles[0])).toMatchObject({
          ldmax: 100,
          clmax: 1,
          cdmin: 0.01,
          source: "prediction",
          polarCount: 2,
        });
        expect(catalog.metrics.has(profiles[2])).toBe(false);
        const detail = await publicProgressivePolars(connection, profiles[0]);
        isolated.selectedTables = [];
        const curveDetail = await assembleDetail(prefix + "A", {
          view: "curves",
        });
        expect(curveDetail).toMatchObject({
          id: profiles[0],
          cfdPointsDeferred: true,
          simulationWorksDeferred: true,
          simulationWorks: [],
          progressivePolars: detail,
        });
        expect(isolated.selectedTables).not.toContain(simJobs);
        for (const options of [
          {},
          { view: "curves" as const, revisionId: fixture.revisionId },
        ]) {
          isolated.selectedTables = [];
          const fullDetail = await assembleDetail(prefix + "A", options);
          expect(fullDetail?.simulationWorksDeferred).toBeUndefined();
          expect(fullDetail?.cfdPointsDeferred).toBeUndefined();
          expect(isolated.selectedTables).toContain(simJobs);
        }
        isolated.selectedTables = [];
        const missingCurves = await assembleDetail(prefix + "Missing", {
          view: "curves",
        });
        expect(missingCurves?.progressivePolars).toEqual([]);
        expect(missingCurves?.simulationWorksDeferred).toBeUndefined();
        expect(isolated.selectedTables).toContain(simJobs);
        expect(
          detail.every(
            (series) => series.condition?.key === series.conditionKey,
          ),
        ).toBe(true);
        expect(
          Math.max(
            ...detail.map(
              (series) => series.curves[0].metrics!.liftToDragMaximum!,
            ),
          ),
        ).toBe(100);
        const selected = catalog.conditions.find(
          (condition) => condition.speedMps === 90,
        )!;
        const narrowed = await publicProgressiveCatalog(
          connection,
          profiles,
          selected.key,
        );
        expect(narrowed.metrics.get(profiles[0])?.ldmax).toBe(50);
        expect(narrowed.metrics.has(profiles[1])).toBe(false);
        expect(
          (await publicProgressiveConditions(connection)).some(
            (condition) => condition.key === selected.key,
          ),
        ).toBe(true);
        const ranked = await listAirfoils({
          q: prefix,
          sort: "ldmax",
          dir: "desc",
          limit: 1,
          includePoints: false,
        });
        expect(ranked[0]).toMatchObject({
          id: profiles[1],
          ldmax: 200,
          metricsSource: "prediction",
          points: [],
        });
        const missing = await listAirfoils({
          q: prefix + "Z",
          metricConditionKey: selected.key,
        });
        expect(missing[0].ldmax).toBeNull();
        const modelId = signature();
        const response = {
          estimate: {
            alpha: [0, 2],
            curves: {
              composite: {
                coefficients: [
                  [0, 0.02, 0],
                  [0.4, 0.02, -0.01],
                ],
                lower: [
                  [0, 0.01, 0],
                  [0.3, 0.01, -0.02],
                ],
                upper: [
                  [0.1, 0.03, 0],
                  [0.5, 0.03, 0],
                ],
              },
            },
            calibration_status: "unvalidated",
            version: "isolated-test",
            signature: modelId,
            contributors: [],
            excluded: [],
          },
        };
        await connection.execute(
          sql`INSERT INTO progressive_polar_models(id,prediction_id,source_signature,request,response) VALUES(${modelId},${first.predictionId},${modelId},'{}',${JSON.stringify(response)}::jsonb)`,
        );
        await connection.execute(
          sql`INSERT INTO progressive_polar_fit_work(prediction_id,state,model_id) VALUES(${first.predictionId},'ready',${modelId}) ON CONFLICT(prediction_id) DO UPDATE SET state='ready',model_id=EXCLUDED.model_id`,
        );
        const firstCondition = catalog.conditions.find(
          (condition) => condition.speedMps === 30,
        )!;
        expect(
          (
            await publicProgressiveCatalog(
              connection,
              profiles,
              firstCondition.key,
            )
          ).metrics.get(profiles[0]),
        ).toMatchObject({
          ldmax: 20,
          source: "estimate",
          modelId,
          targetId: first.targetId,
        });
        await connection.execute(
          sql`UPDATE progressive_polar_fit_work SET state='pending' WHERE prediction_id=${first.predictionId}`,
        );
        expect(
          (
            await publicProgressiveCatalog(
              connection,
              profiles,
              firstCondition.key,
            )
          ).metrics.get(profiles[0]),
        ).toMatchObject({
          ldmax: 100,
          source: "prediction",
          modelId: first.predictionId,
        });
        if (!fullScale) throw rollback;
        const scalePrefix = `${prefix}-scale-`;
        await connection.execute(sql`
          INSERT INTO airfoils(slug,name,category_id,points)
          SELECT ${scalePrefix} || profile_index, ${scalePrefix} || profile_index, ${category.id}, '[]'
          FROM generate_series(1,1600) profile_index
        `);
        await connection.execute(sql`
          INSERT INTO polar_analysis_targets(id,airfoil_id,physical)
          SELECT encode(sha256(jsonb_send(jsonb_build_array(profile.id, condition_index))), 'hex'), profile.id,
            jsonb_set(jsonb_set(jsonb_set(jsonb_set(template.physical,
              '{airfoilId}', to_jsonb(profile.id)), '{flow,speedMps}', to_jsonb(condition_index * 30)),
              '{derived,reynolds}', to_jsonb(condition_index * 300000)), '{derived,mach}', to_jsonb(condition_index * 30.0 / 340))
          FROM airfoils profile CROSS JOIN generate_series(1,20) condition_index
          CROSS JOIN polar_analysis_targets template
          WHERE profile.slug LIKE ${scalePrefix + "%"} AND template.id = ${first.targetId}
        `);
        await connection.execute(sql`
          INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes)
          SELECT ${generationId}, target.id, ${fixture.revisionId}, ARRAY[0,2]::float8[], '{}'
          FROM polar_analysis_targets target JOIN airfoils profile ON profile.id = target.airfoil_id
          WHERE profile.slug LIKE ${scalePrefix + "%"}
        `);
        await connection.execute(sql`
          INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload)
          SELECT target.id, ${epoch.id}, target.id, jsonb_build_object(
            'kind','prediction','method','neuralfoil','cfd_evidence',false,
            'alpha', curve.alpha, 'coefficients', curve.coefficients)
          FROM polar_analysis_targets target JOIN airfoils profile ON profile.id = target.airfoil_id
          CROSS JOIN (SELECT jsonb_agg(sample_index * 0.25 ORDER BY sample_index) AS alpha,
            jsonb_agg(jsonb_build_array(0.5 + sample_index * 0.01, 0.01, -0.02) ORDER BY sample_index) AS coefficients
            FROM generate_series(0,120) sample_index) curve
          WHERE profile.slug LIKE ${scalePrefix + "%"}
        `);
        const scaleProfiles = (
          await connection.execute(
            sql`SELECT id FROM airfoils WHERE slug LIKE ${scalePrefix + "%"}`,
          )
        ).map((row) => String(row.id));
        await connection.execute(
          sql`ANALYZE neuralfoil_predictions, polar_analysis_targets, progressive_generation_targets, simulation_preset_revisions, airfoils`,
        );
        const started = performance.now();
        const scaled = await publicProgressiveCatalog(
          connection,
          scaleProfiles,
        );
        const elapsed = performance.now() - started;
        expect(scaled.metrics.size).toBe(1600);
        expect(scaled.conditions).toHaveLength(20);
        expect(
          [...scaled.metrics.values()].every(
            (metric) => metric.polarCount === 20 && metric.ldmax === 170,
          ),
        ).toBe(true);
        console.info(
          JSON.stringify({
            catalogScale: {
              profiles: 1600,
              curves: 32000,
              samplesPerCurve: 121,
              elapsedMs: elapsed,
            },
          }),
        );
        expect(elapsed).toBeLessThan(3000);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    isolated.connection = null;
  }
}

it("uses available prediction or composite curves for catalog metrics and exact condition selection", () =>
  verifyPublicCatalog(false));

it.skipIf(process.env.RUN_CATALOG_SCALE !== "1")(
  "keeps full campaign catalog reads within their time budget",
  () => verifyPublicCatalog(true),
  120000,
);
