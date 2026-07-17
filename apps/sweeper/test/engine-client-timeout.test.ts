// Must-catch layer for the fetch-timeout half of the 2026-07-06 incident: an
// engine API saturated by solvers ACCEPTED connections and then never
// answered ("computeFieldExtents FAILED … fetch failed" only after unbounded
// stalls). Every EngineClient call now carries an AbortSignal timeout; a hung
// request must abort at its budget and surface as the sweeper's EXISTING
// connection-failure class (isEngineConnectionFailure → release + backoff),
// never as a new unhandled rejection and never as an EngineError "the engine
// answered" failure. Shaped like the real breakage: a live TCP server that
// accepts requests and never writes a response.

import {
  ENGINE_POLL_TIMEOUT_MS,
  ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS,
  ENGINE_RENDER_TIMEOUT_MS,
  ENGINE_SUBMIT_TIMEOUT_MS,
  MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
  EngineClient,
  EngineError,
  EngineTimeoutError,
  type FinalizeRemoteEvidenceRequest,
  type PolarRequest,
} from "@aerodb/engine-client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isEngineConnectionFailure } from "../src/engine-backoff";

let hungServer: Server; // accepts requests, never responds
let liveServer: Server; // responds instantly (false-positive guard)
let hungUrl = "";
let liveUrl = "";
let cleanupCalls = 0;
let cleanupCommitObserver: (() => void) | null = null;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  hungServer = createServer(() => {
    /* saturated engine: hold the request open forever */
  });
  liveServer = createServer((req, res) => {
    if (
      req.method === "POST" &&
      req.url === "/jobs/cleanup-job/evidence/finalize-remote"
    ) {
      const callNumber = (cleanupCalls += 1);
      cleanupCommitObserver?.();
      const respond = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            state: callNumber === 1 ? "complete" : "no_local_bytes",
            evidence_base: "evidence",
            bytes_freed: callNumber === 1 ? 100 : 0,
            verification: "archive+manifest+all-members-restore:4",
            association_count: 1,
          }),
        );
      };
      if (callNumber === 1) setTimeout(respond, 500);
      else respond();
      return;
    }
    if (req.method === "POST" && req.url === "/polars") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          detail: {
            code: MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
            requested_version: 1,
            actual_version: 2,
            message: "mesh recovery changed during rolling cutover",
          },
        }),
      );
      return;
    }
    if (req.url?.includes("boom")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"solver exploded"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"job_id":"j1","state":"running","total_cases":3}');
  });
  [hungUrl, liveUrl] = await Promise.all([
    listen(hungServer),
    listen(liveServer),
  ]);
});

afterAll(async () => {
  hungServer.closeAllConnections?.();
  liveServer.closeAllConnections?.();
  await Promise.all([
    new Promise((r) => hungServer.close(r)),
    new Promise((r) => liveServer.close(r)),
  ]);
});

describe("engine-client AbortSignal timeouts", () => {
  it("pins the approved default budgets including the 900 s GCS cleanup plus response overhead", () => {
    expect(ENGINE_POLL_TIMEOUT_MS).toBe(15_000);
    expect(ENGINE_SUBMIT_TIMEOUT_MS).toBe(60_000);
    expect(ENGINE_RENDER_TIMEOUT_MS).toBe(120_000);
    expect(ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS).toBe(960_000);
  });

  it("replays a cleanup after the first response is lost without reverting to the 60 s submit budget", async () => {
    cleanupCalls = 0;
    const client = new EngineClient(liveUrl, {
      controlPlaneToken: "engine-client-cleanup-test-token-at-least-32",
      evidenceCleanupTimeoutMs: 200,
    });
    const firstCommitted = new Promise<void>((resolve) => {
      cleanupCommitObserver = resolve;
    });
    const request: FinalizeRemoteEvidenceRequest = {
      case_slug: "case-1",
      evidence_base: "evidence",
      remote: {
        schemaVersion: 1,
        format: "tar+zstd" as const,
        bucket: "test-bucket",
        objectKey: "solver-evidence/archive.tar.zst",
        generation: "123",
        storedSha256: "a".repeat(64),
        storedSize: 10,
        tarSha256: "b".repeat(64),
        tarSize: 20,
        crc32c: "AAAAAA==",
        zstdLevel: 10,
        createdAt: "2026-07-17T00:00:00Z",
      },
      canary_evidence_registrations: [
        {
          registration_id: "11111111-1111-4111-8111-111111111111",
          receipt_sha256: "c".repeat(64),
          scenario: "serial-rans" as const,
          aoa_deg: 2,
          member_association_count: 5,
          member_associations_sha256: "d".repeat(64),
          manifest_member_set_sha256: "e".repeat(64),
        },
      ],
    };

    const lostResponse = client.finalizeRemoteEvidence("cleanup-job", request);
    await firstCommitted;
    await expect(lostResponse).rejects.toMatchObject({
      name: "EngineTimeoutError",
      timeoutMs: 200,
    });
    cleanupCommitObserver = null;
    expect(cleanupCalls).toBe(1);
    const replay = await client.finalizeRemoteEvidence("cleanup-job", request, {
      timeoutMs: 1_000,
    });

    expect(replay.state).toBe("no_local_bytes");
    expect(cleanupCalls).toBe(2);
  });

  it("MUST-CATCH: a hung status poll aborts at its (overridden) timeout as EngineTimeoutError", async () => {
    const client = new EngineClient(hungUrl);
    const t0 = Date.now();
    let caught: unknown;
    try {
      await client.getJob("job-1", { timeoutMs: 200 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(EngineTimeoutError);
    expect(caught).not.toBeInstanceOf(EngineError); // "engine answered" class stays reserved
    expect((caught as EngineTimeoutError).timeoutMs).toBe(200);
    expect((caught as Error).message).toContain("timed out after 200 ms");
    expect((caught as Error).message).toContain("/jobs/job-1");
    // Aborted AT the budget — not after an unbounded stall.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("MUST-CATCH: a hung submit aborts and lands in the EXISTING connection-failure class (release + backoff, never `failed`)", async () => {
    const client = new EngineClient(hungUrl);
    let caught: unknown;
    try {
      await client.submitPolar({} as PolarRequest, { timeoutMs: 200 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineTimeoutError);
    // The sweeper's submit path branches on exactly this predicate: true ⇒
    // release the composed job + record engine backoff (spec §7).
    expect(isEngineConnectionFailure(caught)).toBe(true);
  });

  it("hung render/extents calls honor the per-call override too", async () => {
    const client = new EngineClient(hungUrl);
    await expect(
      client.computeFieldExtents("job-1", { fields: [] } as never, {
        timeoutMs: 150,
      }),
    ).rejects.toBeInstanceOf(EngineTimeoutError);
    await expect(
      client.renderDefaultMedia("job-1", {} as never, { timeoutMs: 150 }),
    ).rejects.toBeInstanceOf(EngineTimeoutError);
  });

  it("hung health probe resolves false (existing contract) instead of hanging or throwing", async () => {
    const client = new EngineClient(hungUrl);
    await expect(client.health({ timeoutMs: 200 })).resolves.toBe(false);
  });

  it("false-positive guard: a responsive engine is untouched — fast responses resolve well inside the budget", async () => {
    const client = new EngineClient(liveUrl);
    const status = await client.getJob("j1", { timeoutMs: 2_000 });
    expect(status.job_id).toBe("j1");
    await expect(client.health({ timeoutMs: 2_000 })).resolves.toBe(true);
  });

  it("false-positive guard: an ANSWERED HTTP failure stays EngineError — never reclassified as a connection failure", async () => {
    const client = new EngineClient(liveUrl);
    let caught: unknown;
    try {
      await client.getJob("boom", { timeoutMs: 2_000 }); // live server answers 500 here
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).not.toBeInstanceOf(EngineTimeoutError);
    expect((caught as EngineError).status).toBe(500);
    // The engine ANSWERED → the sweeper's `failed` path, not release+backoff.
    expect(isEngineConnectionFailure(caught)).toBe(false);
  });

  it("MUST-CATCH: a structured mesh-recovery cutover conflict retains its stable error code", async () => {
    const client = new EngineClient(liveUrl);
    let caught: unknown;
    try {
      await client.submitPolar({} as PolarRequest, { timeoutMs: 2_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).toMatchObject({
      status: 409,
      code: MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
    });
    expect(isEngineConnectionFailure(caught)).toBe(false);
  });
});
