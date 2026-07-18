import { sweeperState } from "@aerodb/db";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql } from "../src/db";
import { buildServer } from "../src/server";
import {
  readSweeperState,
  writeSweeperState,
} from "../src/services/sweeper-state";

let originalState: typeof sweeperState.$inferSelect;
let app: Awaited<ReturnType<typeof buildServer>>;

async function readRawState() {
  const [row] = await db
    .select()
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  if (!row) throw new Error("seeded sweeper_state singleton missing");
  return row;
}

beforeAll(async () => {
  app = await buildServer();
  originalState = await readRawState();
  await db
    .update(sweeperState)
    .set({
      enabled: false,
      maxConcurrentJobs: 0,
      cpuSlots: 0,
      admissionFenceActive: true,
      lastAdmissionFenceAt: new Date(),
      lastAdmissionFenceReason: "blocked_final_urans",
      lastAdmissionFenceTriggerKey: "verify:test-resume-contract",
      lastAdmissionFenceDetails: {
        stage: "final",
        fidelity: "full",
        incidentId: "00000000-0000-4000-8000-000000000001",
        solverImplementationId: "00000000-0000-4000-8000-000000000002",
        previousEnabled: true,
        previousMaxConcurrentJobs: 9,
        previousCpuSlots: 8,
      },
    })
    .where(eq(sweeperState.id, 1));
});

afterAll(async () => {
  if (originalState) {
    await db
      .update(sweeperState)
      .set({
        enabled: originalState.enabled,
        maxConcurrentJobs: originalState.maxConcurrentJobs,
        cpuSlots: originalState.cpuSlots,
        pollIntervalMs: originalState.pollIntervalMs,
        submitIntervalMs: originalState.submitIntervalMs,
        admissionFenceActive: originalState.admissionFenceActive,
        lastAdmissionFenceAt: originalState.lastAdmissionFenceAt,
        lastAdmissionFenceReason: originalState.lastAdmissionFenceReason,
        lastAdmissionFenceTriggerKey:
          originalState.lastAdmissionFenceTriggerKey,
        lastAdmissionFenceDetails: originalState.lastAdmissionFenceDetails,
      })
      .where(eq(sweeperState.id, 1));
  }
  await app?.close();
  await sql.end();
});

describe("sweeper admission-fence operator recovery", () => {
  it("keeps exact safety-stop provenance on the authenticated admin DTO only", async () => {
    const publicResponse = await app.inject({
      method: "GET",
      url: "/api/sweeper",
    });
    expect(publicResponse.statusCode).toBe(200);
    const publicState = publicResponse.json();
    expect(publicState.admissionFenceActive).toBe(true);
    expect(publicState).not.toHaveProperty("lastAdmissionFenceAt");
    expect(publicState).not.toHaveProperty("lastAdmissionFenceReason");
    expect(publicState).not.toHaveProperty("lastAdmissionFenceTriggerKey");
    expect(publicState).not.toHaveProperty("lastAdmissionFenceDetails");

    const adminResponse = await app.inject({
      method: "GET",
      url: "/api/admin/sweeper",
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json()).toMatchObject({
      admissionFenceActive: true,
      lastAdmissionFenceReason: "blocked_final_urans",
      lastAdmissionFenceTriggerKey: "verify:test-resume-contract",
      lastAdmissionFenceDetails: {
        stage: "final",
        fidelity: "full",
        previousMaxConcurrentJobs: 9,
        previousCpuSlots: 8,
      },
    });

    const campaignsResponse = await app.inject({
      method: "GET",
      url: "/api/admin/campaigns?limit=1",
    });
    expect(campaignsResponse.statusCode).toBe(200);
    const campaignState = campaignsResponse.json().solverState;
    expect(campaignState).toMatchObject({
      admissionFenceActive: true,
      lastAdmissionFenceReason: "blocked_final_urans",
      lastAdmissionFenceDetails: { stage: "final", fidelity: "full" },
    });
    expect(campaignState.lastAdmissionFenceDetails).toEqual({
      stage: "final",
      fidelity: "full",
    });
    expect(campaignState).not.toHaveProperty("lastAdmissionFenceTriggerKey");
    expect(campaignState.lastAdmissionFenceDetails).not.toHaveProperty(
      "incidentId",
    );
    expect(campaignState.lastAdmissionFenceDetails).not.toHaveProperty(
      "solverImplementationId",
    );
    expect(campaignState.lastAdmissionFenceDetails).not.toHaveProperty(
      "previousCpuSlots",
    );
  });

  it("keeps capacity-only edits as the saved resume configuration, then plain {enabled:true} restores it atomically", async () => {
    const fenced = await readSweeperState();
    expect(fenced).toMatchObject({
      enabled: false,
      admissionFenceActive: true,
      // API capacity is the saved operator setting, not the physical 0/0 gate.
      maxConcurrentJobs: 9,
      cpuSlots: 8,
    });

    const edited = await writeSweeperState({
      maxConcurrentJobs: 11,
      cpuSlots: 10,
    });
    expect(edited).toMatchObject({
      enabled: false,
      admissionFenceActive: true,
      maxConcurrentJobs: 11,
      cpuSlots: 10,
    });
    const stillFenced = await readRawState();
    expect(stillFenced).toMatchObject({
      enabled: false,
      admissionFenceActive: true,
      maxConcurrentJobs: 0,
      cpuSlots: 0,
    });
    expect(stillFenced.lastAdmissionFenceDetails).toMatchObject({
      previousMaxConcurrentJobs: 11,
      previousCpuSlots: 10,
    });

    // This is the existing Resume UI payload: no hidden capacity values.
    const resumed = await writeSweeperState({ enabled: true });
    expect(resumed).toMatchObject({
      enabled: true,
      admissionFenceActive: false,
      maxConcurrentJobs: 11,
      cpuSlots: 10,
      lastAdmissionFenceReason: "blocked_final_urans",
      lastAdmissionFenceTriggerKey: "verify:test-resume-contract",
    });
    expect(await readRawState()).toMatchObject({
      enabled: true,
      admissionFenceActive: false,
      maxConcurrentJobs: 11,
      cpuSlots: 10,
    });
  });

  it("serializes a capacity patch behind a concurrent safety trip and preserves the latch", async () => {
    await db
      .update(sweeperState)
      .set({
        enabled: true,
        maxConcurrentJobs: 11,
        cpuSlots: 10,
        admissionFenceActive: false,
      })
      .where(eq(sweeperState.id, 1));

    let announceLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    let releaseTrip!: () => void;
    const mayTrip = new Promise<void>((resolve) => {
      releaseTrip = resolve;
    });
    const breaker = db.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`
        SELECT id FROM sweeper_state WHERE id = 1 FOR UPDATE
      `);
      announceLocked();
      await mayTrip;
      await transaction.execute(drizzleSql`
        UPDATE sweeper_state
        SET enabled = false,
            max_concurrent_jobs = 0,
            cpu_slots = 0,
            admission_fence_active = true,
            last_admission_fence_at = now(),
            last_admission_fence_reason = 'blocked_final_urans',
            last_admission_fence_trigger_key = 'verify:concurrent-trip',
            last_admission_fence_details = jsonb_build_object(
              'previousEnabled', true,
              'previousMaxConcurrentJobs', 11,
              'previousCpuSlots', 10
            ),
            "updatedAt" = now()
        WHERE id = 1
      `);
    });

    await locked;
    const writer = writeSweeperState({ maxConcurrentJobs: 13, cpuSlots: 12 });
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const [row] = (await db.execute(drizzleSql`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%writeSweeperState admission fence serialization%'
        `)) as unknown as Array<{ count: number }>;
        blocked = Number(row?.count ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      releaseTrip();
    }
    await breaker;
    const written = await writer;

    expect(written).toMatchObject({
      enabled: false,
      admissionFenceActive: true,
      maxConcurrentJobs: 13,
      cpuSlots: 12,
      lastAdmissionFenceTriggerKey: "verify:concurrent-trip",
    });
    expect(await readRawState()).toMatchObject({
      enabled: false,
      admissionFenceActive: true,
      maxConcurrentJobs: 0,
      cpuSlots: 0,
      lastAdmissionFenceTriggerKey: "verify:concurrent-trip",
      lastAdmissionFenceDetails: {
        previousMaxConcurrentJobs: 13,
        previousCpuSlots: 12,
      },
    });
  });
});
