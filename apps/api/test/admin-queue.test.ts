// Admin queue endpoint under a SLOW engine (spec §10/§12): while OpenFOAM
// solves saturate the CPU the engine's uvicorn answers in seconds — this is
// the measured production defect (1.8–3.0 s per authenticated queue poll on
// localhost with near-empty data). The queue handler must never await a live
// engine round-trip: every engine-dependent block is TTL-cached with
// stale-while-refresh and a bounded race cap, and missing/stale data is
// presented honestly (null blocks, error strings, engineRuntimeAsOf) — never
// invented.
//
// MUST-CATCH: the slow-engine tests below fail against the pre-fix handler,
// which awaited a live POST /jobs/runtime per request (≥3 s with this stub).
//
// Shared-database integration test: rows are pw- prefixed and deleted in
// afterAll (global test-hygiene rule).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { airfoils, categories, simJobs, sweeperState } from "@aerodb/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const PREFIX = `pw-queue-${Date.now().toString(36)}`;
const ADMIN_EMAIL = "admin@airfoils.pro";
const ADMIN_PASSWORD = "queue-test-password";
/** Simulates the saturated engine: every endpoint answers after 3 s. */
const ENGINE_DELAY_MS = 3_000;

let engineStub: Server;
const engineHits: Record<string, number> = {};

let app: Awaited<ReturnType<typeof import("../src/server")["buildServer"]>>;
let db: typeof import("../src/db")["db"];
let adminCookie = "";
let categoryId = "";
let airfoilId = "";
const jobIds: string[] = [];

function engineResponseBody(url: string): string | null {
  if (url === "/health") return JSON.stringify({ status: "ok", version: "stub", build_id: "stub-build" });
  if (url === "/queue") {
    return JSON.stringify({
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    });
  }
  if (url === "/cache/stats") {
    return JSON.stringify({ mesh_entries: 1, seed_entries: 1, total_bytes: 10, cap_bytes: 100, oldest_last_used: null });
  }
  if (url === "/jobs/runtime") return JSON.stringify({ jobs: [] });
  return null;
}

async function authedQueue(path: string) {
  return app.inject({ method: "GET", url: path, headers: { cookie: adminCookie } });
}

beforeAll(async () => {
  engineStub = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    engineHits[url] = (engineHits[url] ?? 0) + 1;
    // Drain the request body, then answer slowly like a saturated uvicorn.
    req.resume();
    setTimeout(() => {
      const body = engineResponseBody(url);
      res.statusCode = body == null ? 404 : 200;
      res.setHeader("content-type", "application/json");
      res.end(body ?? "{}");
    }, ENGINE_DELAY_MS);
  });
  await new Promise<void>((resolve) => engineStub.listen(0, "127.0.0.1", resolve));
  const port = (engineStub.address() as AddressInfo).port;

  // src/env snapshots process.env at module load — configure BEFORE the
  // dynamic import of the server (static imports would hoist above this).
  process.env.ENGINE_URL = `http://127.0.0.1:${port}`;
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "queue-test-secret";
  delete process.env.ADMIN_GOOGLE_CLIENT_ID;
  delete process.env.ADMIN_GOOGLE_CLIENT_SECRET;

  const [{ buildServer }, dbModule] = await Promise.all([import("../src/server"), import("../src/db")]);
  db = dbModule.db;
  app = await buildServer();

  // Seed two ACTIVE jobs with engine ids so the queue handler actually takes
  // the POST /jobs/runtime annotation path (the reported defect); without
  // engine ids the runtime call is skipped and even the broken handler would
  // look fast.
  const [category] = await db
    .insert(categories)
    .values({ slug: PREFIX, name: PREFIX, path: PREFIX, depth: 0 })
    .returning({ id: categories.id });
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-af`,
      name: `${PREFIX} airfoil`,
      categoryId,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.06 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.06 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  airfoilId = airfoil.id;
  const jobs = await db
    .insert(simJobs)
    .values([
      {
        airfoilId,
        bcIds: [],
        referenceChordM: 1,
        status: "running",
        engineJobId: `${PREFIX}-engine-1`,
        engineState: "running",
        totalCases: 3,
        submittedAt: new Date(),
      },
      {
        airfoilId,
        bcIds: [],
        referenceChordM: 1,
        status: "submitted",
        engineJobId: `${PREFIX}-engine-2`,
        engineState: "pending",
        submittedAt: new Date(),
      },
    ])
    .returning({ id: simJobs.id });
  jobIds.push(...jobs.map((j) => j.id));

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  adminCookie = String(raw).split(";")[0];
}, 30_000);

afterAll(async () => {
  // Test hygiene: remove every row this suite created from the shared DB.
  if (db) {
    if (jobIds.length > 0) await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
    if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
    if (categoryId) await db.delete(categories).where(eq(categories.id, categoryId));
  }
  await app?.close();
  await new Promise<void>((resolve) => engineStub.close(() => resolve()));
  process.env = { ...ORIGINAL_ENV };
}, 30_000);

describe("queue payload with a saturated (3 s) engine", () => {
  it("scope=activity answers well under 1 s cold and presents missing engine data honestly", async () => {
    const started = Date.now();
    const res = await authedQueue("/api/admin/queue?scope=activity");
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // Cold path: every engine probe is race-capped (500–750 ms, run in
    // parallel); pre-fix this request awaited the 3 s runtime call.
    expect(elapsed).toBeLessThan(1_500);

    const body = res.json();
    expect(body.scope).toBe("activity");
    // Engine blocks are pending/unavailable — said so, not invented.
    expect(body.engineHealth).toBeNull();
    expect(String(body.engineHealthError ?? "")).toContain("still running");
    expect(body.engineQueue).toBeNull();
    expect(String(body.engineQueueError ?? "")).toContain("still running");
    expect(body.engineRuntimeAsOf).toBeNull();
    expect(String(body.engineRuntimeError ?? "")).toContain("still running");
    // Jobs are present (DB truth) and annotated as runtime-unknown.
    const seeded = (body.activeJobs as Array<{ engineJobId: string | null; runtimeState: string }>).filter((j) =>
      (j.engineJobId ?? "").startsWith(PREFIX),
    );
    expect(seeded.length).toBe(2);
    for (const job of seeded) expect(job.runtimeState).toBe("unknown");
  });

  it("scope=activity stays fast on the warm path too (fresh cache entry still resolving)", async () => {
    const started = Date.now();
    const res = await authedQueue("/api/admin/queue?scope=activity");
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // Within the probe TTLs the in-flight (still slow) refresh must not be
    // awaited beyond the race cap.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("serves the engine snapshot with stale-while-refresh once the slow probe lands", async () => {
    // Wait out the 3 s stub delay so the background refresh resolves.
    await new Promise((resolve) => setTimeout(resolve, ENGINE_DELAY_MS + 500));
    const started = Date.now();
    const res = await authedQueue("/api/admin/queue?scope=activity");
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(1_000);
    const body = res.json();
    // Health landed (15 s TTL still fresh) — served from cache instantly.
    expect(body.engineHealth).toMatchObject({ status: "ok", build_id: "stub-build" });
    expect(body.engineHealthError).toBeNull();
    // The runtime snapshot resolved in the background; its asOf is its true
    // fetch time (stale data never presented as fresh).
    expect(typeof body.engineRuntimeAsOf).toBe("string");
    expect(Date.parse(body.engineRuntimeAsOf)).toBeGreaterThan(0);
  }, 15_000);
});

describe("tab-scoped payload shapes", () => {
  it("scope=activity omits background-only sections as null", async () => {
    const body = (await authedQueue("/api/admin/queue?scope=activity")).json();
    expect(body.pendingSweeps).toBeNull();
    expect(body.externalPromises).toBeNull();
    expect(body.engineCache).toBeNull();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(Array.isArray(body.activeJobs)).toBe(true);
    expect(Array.isArray(body.finishedJobs)).toBe(true);
    expect(body.results).toBeTruthy();
    expect(body.backlogStrip).toBeTruthy();
    expect(body.sweeper).toBeTruthy();
  });

  it("scope=background carries the gap-scan list and omits job/engine sections", async () => {
    const res = await authedQueue("/api/admin/queue?scope=background");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("background");
    expect(Array.isArray(body.pendingSweeps)).toBe(true);
    expect(Array.isArray(body.externalPromises)).toBe(true);
    expect(typeof body.pendingSweepsTotal).toBe("number");
    expect(typeof body.pendingPointsTotal).toBe("number");
    expect(body.jobs).toBeNull();
    expect(body.activeJobs).toBeNull();
    expect(body.finishedJobs).toBeNull();
    expect(body.results).toBeNull();
    expect(body.backlogStrip).toBeNull();
    expect(body.engineHealth).toBeNull();
    expect(body.engineHealthError).toBeNull();
    expect(body.engineRuntimeAsOf).toBeNull();
    expect(body.sweeper).toBeTruthy();
  }, 15_000);

  it("scope=engine carries engine blocks + activeJobs, omits activity/background lists", async () => {
    const body = (await authedQueue("/api/admin/queue?scope=engine")).json();
    expect(body.scope).toBe("engine");
    expect(Array.isArray(body.activeJobs)).toBe(true);
    expect(typeof body.inFlight).toBe("number");
    expect(body.jobs).toBeNull();
    expect(body.finishedJobs).toBeNull();
    expect(body.pendingSweeps).toBeNull();
    expect(body.externalPromises).toBeNull();
    expect(body.results).toBeNull();
    expect(body.backlogStrip).toBeNull();
    // engineCache is in scope; with the slow stub it is either the landed
    // snapshot or an honest null — never invented.
    expect("engineCache" in body).toBe(true);
  });

  it("scope=all (default) keeps the full back-compat payload", async () => {
    const body = (await authedQueue("/api/admin/queue")).json();
    expect(body.scope).toBe("all");
    for (const key of ["jobs", "activeJobs", "finishedJobs", "pendingSweeps", "externalPromises"]) {
      expect(Array.isArray(body[key])).toBe(true);
    }
    expect(body.results).toBeTruthy();
    expect(body.backlogStrip).toBeTruthy();
    expect(typeof body.pendingSweepsTotal).toBe("number");
  }, 15_000);

  it("rejects an unknown scope with 400", async () => {
    const res = await authedQueue("/api/admin/queue?scope=everything");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("scope");
  });
});

describe("admin login validation", () => {
  it("returns 400 with a plain error when email/password are missing (was a raw ZodError 500)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/login", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "email and password are required" });
  });

  it("still rejects bad credentials with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: ADMIN_EMAIL, password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("automatic scheduler admission", () => {
  it("accepts zero as the explicit auto admission setting", async () => {
    const [original] = await db
      .select({ maxConcurrentJobs: sweeperState.maxConcurrentJobs })
      .from(sweeperState)
      .where(eq(sweeperState.id, 1))
      .limit(1);
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/admin/sweeper",
        headers: { cookie: adminCookie },
        payload: { maxConcurrentJobs: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().maxConcurrentJobs).toBe(0);
    } finally {
      if (original) {
        await db
          .update(sweeperState)
          .set({ maxConcurrentJobs: original.maxConcurrentJobs })
          .where(eq(sweeperState.id, 1));
      }
    }
  });
});
