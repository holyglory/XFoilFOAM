import {
  airfoils,
  boundaryConditions,
  categories,
  createClient,
  mediums,
  simJobs,
} from "@aerodb/db";
import { eq } from "drizzle-orm";
import type { JobStatus } from "@aerodb/engine-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimJobForIngest,
  releaseIngestLeaseToRunning,
  renewIngestLease,
} from "../src/ingest-lease";
import { updateJobFromEngineStatus } from "../src/reconcile";

const { db, sql } = createClient({ max: 4 });
const PREFIX = `ingest-lease-${process.pid}-${Date.now().toString(36)}`;
const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.08 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.04 },
  { x: 1, y: 0 },
];

let categoryId = "";
let airfoilId = "";
let bcId = "";
let jobId = "";

beforeAll(async () => {
  const [medium] = await db.select().from(mediums).limit(1);
  if (!medium) throw new Error("a seeded medium is required");
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} category`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points,
      isSymmetric: false,
    })
    .returning();
  airfoilId = airfoil.id;
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} BC`,
      mediumId: medium.id,
      reynolds: 321_987,
      referenceChordM: 0.7319,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      speedMps: 17.319,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      enabled: true,
    })
    .returning();
  bcId = bc.id;
});

beforeEach(async () => {
  if (jobId) await db.delete(simJobs).where(eq(simJobs.id, jobId));
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      referenceChordM: 0.7319,
      status: "running",
      engineJobId: `${PREFIX}-engine-${Date.now()}`,
    })
    .returning();
  jobId = job.id;
});

afterAll(async () => {
  if (jobId) await db.delete(simJobs).where(eq(simJobs.id, jobId));
  if (bcId)
    await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  await sql.end();
});

describe("durable sim-job ingest lease", () => {
  const engineStatus = (state: JobStatus["state"]): JobStatus => ({
    job_id: `${PREFIX}-engine`,
    state,
    total_cases: 1,
    completed_cases: state === "completed" ? 1 : 0,
    message: state === "cancelled" ? "cancelled by engine" : null,
  });

  it("allows exactly one of two concurrent sweepers to claim ingestion", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const [a, b] = await Promise.all([
      claimJobForIngest(db, jobId, {
        token: `${PREFIX}-a`,
        now,
        leaseMs: 1_000,
      }),
      claimJobForIngest(db, jobId, {
        token: `${PREFIX}-b`,
        now,
        leaseMs: 1_000,
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ?? b!;
    const [row] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    expect(row).toMatchObject({
      status: "ingesting",
      ingestLeaseToken: winner.token,
    });
  });

  it("does not steal a live or renewed lease, but recovers it after expiry", async () => {
    const start = new Date("2026-07-11T13:00:00.000Z");
    const first = await claimJobForIngest(db, jobId, {
      token: `${PREFIX}-first`,
      now: start,
      leaseMs: 1_000,
    });
    expect(first).toBeTruthy();
    expect(
      await claimJobForIngest(db, jobId, {
        token: `${PREFIX}-early`,
        now: new Date(start.getTime() + 999),
        leaseMs: 1_000,
      }),
    ).toBeNull();

    // Expiry itself ends ownership: the stale token cannot revive its lease
    // during the gap before a recovery claimant arrives.
    expect(
      await renewIngestLease(db, first!, {
        now: new Date(start.getTime() + 1_001),
        leaseMs: 1_000,
      }),
    ).toBe(false);

    const recovered = await claimJobForIngest(db, jobId, {
      token: `${PREFIX}-recovered`,
      now: new Date(start.getTime() + 1_001),
      leaseMs: 1_000,
    });
    expect(recovered?.token).toBe(`${PREFIX}-recovered`);
    expect(await renewIngestLease(db, first!)).toBe(false);

    expect(
      await renewIngestLease(db, recovered!, {
        now: new Date(start.getTime() + 1_500),
        leaseMs: 1_000,
      }),
    ).toBe(true);
    expect(
      await claimJobForIngest(db, jobId, {
        token: `${PREFIX}-still-live`,
        now: new Date(start.getTime() + 2_499),
        leaseMs: 1_000,
      }),
    ).toBeNull();
    expect(await releaseIngestLeaseToRunning(db, first!)).toBe(false);
    expect(await releaseIngestLeaseToRunning(db, recovered!)).toBe(true);

    const [row] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    expect(row).toMatchObject({
      status: "running",
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    });
  });

  it("keeps a live ingest lease authoritative over stale terminal/cancel polls", async () => {
    const lease = await claimJobForIngest(db, jobId, {
      token: `${PREFIX}-poll-owner`,
      leaseMs: 60_000,
    });
    expect(lease).toBeTruthy();
    const [snapshot] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));

    await updateJobFromEngineStatus(db, snapshot, engineStatus("completed"));
    await updateJobFromEngineStatus(db, snapshot, engineStatus("cancelled"));

    const [after] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(after).toMatchObject({
      status: "ingesting",
      ingestLeaseToken: lease!.token,
    });
  });

  it("persists a terminal poll without a token and remains immediately claimable", async () => {
    const [snapshot] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    await updateJobFromEngineStatus(db, snapshot, engineStatus("completed"));
    const [polled] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(polled).toMatchObject({
      status: "running",
      engineState: "completed",
      ingestLeaseToken: null,
    });
    expect(
      await claimJobForIngest(db, jobId, { token: `${PREFIX}-immediate` }),
    ).toBeTruthy();
  });
});
