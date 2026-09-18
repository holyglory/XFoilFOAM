import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import {
  publicProgressiveCatalog,
  publicProgressiveConditions,
} from "@aerodb/db/progressive-catalog";
import { publicProgressivePolars } from "@aerodb/db/progressive-public";
import { createMinimalSolverFixture } from "../../../packages/db/test/solver-fixture";

const isolated = vi.hoisted(() => ({ connection: null as DB | null }));
vi.mock("../src/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        if (!isolated.connection)
          throw new Error("Missing isolated catalog connection");
        const value = Reflect.get(isolated.connection, key);
        return typeof value === "function"
          ? value.bind(isolated.connection)
          : value;
      },
    },
  ),
}));
import { listAirfoils } from "../src/services/catalog";

const { db, sql: client } = createClient({ max: 1 });
afterAll(() => client.end({ timeout: 5 }));
const signature = () => createHash("sha256").update(randomUUID()).digest("hex");

it("uses available prediction or composite curves for catalog metrics and exact condition selection", async () => {
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
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    isolated.connection = null;
  }
});
