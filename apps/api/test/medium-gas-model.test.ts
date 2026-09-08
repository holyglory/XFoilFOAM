import { randomUUID } from "node:crypto";
import { evaluateGasState } from "@aerodb/core";
import { flowConditions, mediums } from "@aerodb/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceAirModel } from "../../../packages/core/test/fixtures/source-air-model";
import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";

const prefix = `pw-material-${randomUUID()}`;
const mediumIds = new Set<string>();
const flowIds = new Set<string>();
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  app = await buildServer();
});
afterAll(async () => {
  if (flowIds.size)
    await db
      .delete(flowConditions)
      .where(
        and(
          inArray(flowConditions.id, [...flowIds]),
          sql`not exists (select 1 from simulation_presets where flow_condition_id = ${flowConditions.id})`,
          sql`not exists (select 1 from sim_campaign_conditions where flow_condition_id = ${flowConditions.id})`,
        ),
      );
  if (mediumIds.size)
    await db.delete(mediums).where(inArray(mediums.id, [...mediumIds]));
  await app?.close();
  await pgClient.end({ timeout: 5 });
});

function materialPayload(label: string) {
  return {
    slug: `${prefix}-${label}`,
    name: "Isolated sourced air candidate",
    phase: "gas",
    density: 1.225539021373505,
    refTemperatureK: 288.15,
    refPressurePa: 101325,
    viscosityModel: "constant",
    constantDynamicViscosity: 1.7961537371721837e-5,
    speedOfSound: 340.40998328942305,
    gasThermodynamics: sourceAirModel(),
    notes: "Isolated material lifecycle test; not installed in production",
  };
}

describe.each(["/api/mediums", "/api/admin/mediums"])(
  "explicit gas material lifecycle through %s",
  (url) => {
    it("creates, copies, retains, updates and explicitly clears the selected model", async () => {
      const payload = materialPayload(randomUUID());
      const created = await app.inject({ method: "POST", url, payload });
      expect(created.statusCode, created.body).toBe(201);
      const original = created.json();
      mediumIds.add(original.id);
      expect(original.gasThermodynamics).toEqual(payload.gasThermodynamics);
      const renamed = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { name: "Updated name" },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json().gasThermodynamics).toEqual(
        payload.gasThermodynamics,
      );
      const updatedModel = {
        ...payload.gasThermodynamics,
        gas_constant: payload.gasThermodynamics.gas_constant * 1.0001,
      };
      const updated = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { gasThermodynamics: updatedModel },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().gasThermodynamics).toEqual(updatedModel);
      const copy = await app.inject({
        method: "POST",
        url,
        payload: { ...payload, slug: `${payload.slug}-copy` },
      });
      expect(copy.statusCode, copy.body).toBe(201);
      mediumIds.add(copy.json().id);
      const cleared = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { gasThermodynamics: null },
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().gasThermodynamics).toBeNull();
      const listed = await app.inject({ method: "GET", url });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(
        listed
          .json()
          .items.find((item: { id: string }) => item.id === copy.json().id)
          .gasThermodynamics,
      ).toEqual(payload.gasThermodynamics);
      expect(
        listed
          .json()
          .items.find((item: { id: string }) => item.id === original.id)
          .gasThermodynamics,
      ).toBeNull();
    });

    it("rejects incompatible phase, uncovered reference state and invalid models without writing", async () => {
      const payload = materialPayload(randomUUID());
      const created = await app.inject({ method: "POST", url, payload });
      expect(created.statusCode, created.body).toBe(201);
      const original = created.json();
      mediumIds.add(original.id);
      for (const update of [
        { phase: "liquid" },
        { refTemperatureK: 99 },
        {
          gasThermodynamics: { ...payload.gasThermodynamics, gas_constant: -1 },
        },
        {
          gasThermodynamics: { ...payload.gasThermodynamics, unexpected: true },
        },
      ]) {
        const rejected = await app.inject({
          method: "PATCH",
          url: `${url}/${original.id}`,
          payload: update,
        });
        expect(rejected.statusCode, rejected.body).toBe(400);
        const [stored] = await db
          .select()
          .from(mediums)
          .where(eq(mediums.id, original.id));
        expect(stored.gasThermodynamics).toEqual(payload.gasThermodynamics);
        expect(stored.phase).toBe("gas");
        expect(stored.refTemperatureK).toBe(288.15);
      }
      const invalidSlug = `${payload.slug}-invalid`;
      const invalidCreate = await app.inject({
        method: "POST",
        url,
        payload: { ...payload, slug: invalidSlug, phase: "liquid" },
      });
      expect(invalidCreate.statusCode, invalidCreate.body).toBe(400);
      expect(
        await db
          .select({ id: mediums.id })
          .from(mediums)
          .where(eq(mediums.slug, invalidSlug)),
      ).toEqual([]);
      const switched = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { gasThermodynamics: null, phase: "liquid" },
      });
      expect(switched.statusCode, switched.body).toBe(200);
      expect(switched.json().phase).toBe("liquid");
      expect(switched.json().gasThermodynamics).toBeNull();
    });

    it("preflights existing flow temperatures before changing the reusable model", async () => {
      const payload = materialPayload(randomUUID());
      const created = await app.inject({ method: "POST", url, payload });
      expect(created.statusCode, created.body).toBe(201);
      const original = created.json();
      mediumIds.add(original.id);
      const state = evaluateGasState(payload.gasThermodynamics, 125, 101325);
      const [flow] = await db
        .insert(flowConditions)
        .values({
          slug: `${payload.slug}-flow`,
          name: "Isolated low-temperature flow",
          mediumId: original.id,
          temperatureK: 125,
          pressurePa: 101325,
          speedMps: 123.456789,
          density: state.density,
          dynamicViscosity: state.dynamicViscosity,
          kinematicViscosity: state.kinematicViscosity,
          mach: 123.456789 / state.speedOfSound,
        })
        .returning();
      flowIds.add(flow.id);
      const narrowed = {
        ...payload.gasThermodynamics,
        nasa7: {
          ...payload.gasThermodynamics.nasa7!,
          minimum_temperature_k: 150,
        },
        polynomial_transport: {
          ...payload.gasThermodynamics.polynomial_transport!,
          minimum_temperature_k: 150,
        },
      };
      const rejected = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { gasThermodynamics: narrowed },
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error).toContain("existing flow condition");
      const [unchanged] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, original.id));
      const [unchangedFlow] = await db
        .select()
        .from(flowConditions)
        .where(eq(flowConditions.id, flow.id));
      expect(unchanged.gasThermodynamics).toEqual(payload.gasThermodynamics);
      expect(unchangedFlow).toEqual(flow);
      const updatedModel = {
        ...payload.gasThermodynamics,
        gas_constant: payload.gasThermodynamics.gas_constant * 1.0001,
      };
      const updated = await app.inject({
        method: "PATCH",
        url: `${url}/${original.id}`,
        payload: { gasThermodynamics: updatedModel },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const expected = evaluateGasState(
        updatedModel,
        flow.temperatureK,
        flow.pressurePa,
      );
      const [refreshed] = await db
        .select()
        .from(flowConditions)
        .where(eq(flowConditions.id, flow.id));
      expect(refreshed).toMatchObject({
        density: expected.density,
        dynamicViscosity: expected.dynamicViscosity,
        kinematicViscosity: expected.kinematicViscosity,
        mach: flow.speedMps / expected.speedOfSound,
      });
      expect(refreshed.density).not.toBe(flow.density);
      const setup = await app.inject({
        method: "GET",
        url: "/api/admin/simulation-setup",
      });
      expect(setup.statusCode, setup.body).toBe(200);
      expect(
        setup
          .json()
          .flowConditions.find((item: { id: string }) => item.id === flow.id),
      ).toMatchObject({
        density: expected.density,
        dynamicViscosity: expected.dynamicViscosity,
        mach: flow.speedMps / expected.speedOfSound,
      });
      const referencedDelete = await app.inject({
        method: "DELETE",
        url: `/api/mediums/${original.id}`,
      });
      expect(referencedDelete.statusCode, referencedDelete.body).toBe(409);
    });
    it("removes only an explicitly addressed unreferenced material", async () => {
      const created = await app.inject({
        method: "POST",
        url,
        payload: materialPayload(randomUUID()),
      });
      expect(created.statusCode, created.body).toBe(201);
      const original = created.json();
      mediumIds.add(original.id);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/mediums/${original.id}`,
      });
      expect(removed.statusCode, removed.body).toBe(204);
      mediumIds.delete(original.id);
      expect(
        await db
          .select({ id: mediums.id })
          .from(mediums)
          .where(eq(mediums.id, original.id)),
      ).toEqual([]);
      const replay = await app.inject({
        method: "DELETE",
        url: `/api/mediums/${original.id}`,
      });
      expect(replay.statusCode, replay.body).toBe(404);
    });
  },
);
