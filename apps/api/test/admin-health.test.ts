import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/admin/health", () => {
  it("returns live host metrics and available 24h sample history", async () => {
    process.env.ADMIN_AUTH_DISABLED = "true";
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.asOf).toEqual(expect.any(String));
      expect(body.sampleIntervalSeconds).toBeGreaterThan(0);
      expect(body.windowHours).toBe(24);
      expect(body.current.cpu.availableCpus).toBeGreaterThan(0);
      expect(body.current.cpu.loadPct).toEqual(expect.any(Number));
      expect(body.current.memory.totalBytes).toBeGreaterThan(0);
      expect(body.current.memory.usedPct).toEqual(expect.any(Number));
      expect(body.averages24h.sampleCount).toBeGreaterThanOrEqual(1);
      expect(body.averages24h.cpuLoadPct).toEqual(expect.any(Number));
      expect(body.averages24h.memoryUsedPct).toEqual(expect.any(Number));
      expect(Array.isArray(body.history)).toBe(true);
      expect(body.current.storage || body.current.storageError).toBeTruthy();
      expect(body.solverIncidents).toMatchObject({
        threshold: expect.any(Number),
        occurrenceCount: expect.any(Number),
        openCount: expect.any(Number),
        criticalGroupCount: expect.any(Number),
        groups: expect.any(Array),
      });
      expect(body.solverIncidentEvents).toEqual(expect.any(Array));
    } finally {
      await app.close();
    }
  });

  it("exposes the chronological machine-readable incident log for agents", async () => {
    process.env.ADMIN_AUTH_DISABLED = "true";
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/solver-incidents?sinceHours=48&limit=25",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        asOf: expect.any(String),
        summary: {
          threshold: expect.any(Number),
          occurrenceCount: expect.any(Number),
          openCount: expect.any(Number),
          criticalGroupCount: expect.any(Number),
          groups: expect.any(Array),
        },
        events: expect.any(Array),
        agentContext: {
          schemaVersion: 1,
          source: "sim_solver_incidents",
          ordering: "occurredAt_desc",
          userActionRequired: false,
          completionLedgerRole: expect.stringContaining("CompletionLedger.md"),
        },
      });
      for (const event of body.events) {
        expect(event.userActionRequired).toBe(false);
      }
      expect(
        body.events.every(
          (
            event: { occurredAt: string },
            index: number,
            events: Array<{ occurredAt: string }>,
          ) =>
            index === 0 ||
            Date.parse(events[index - 1]!.occurredAt) >=
              Date.parse(event.occurredAt),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("is protected by the admin pre-handler when auth is required", async () => {
    process.env.ADMIN_AUTH_REQUIRED = "true";
    process.env.ADMIN_AUTH_DISABLED = "false";
    process.env.ADMIN_SESSION_SECRET = "health-test-secret";
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/health" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: "admin authentication required",
      });
      const log = await app.inject({
        method: "GET",
        url: "/api/admin/solver-incidents",
      });
      expect(log.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
