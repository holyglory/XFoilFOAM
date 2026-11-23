import { randomUUID } from "node:crypto";
import {
  analysisContentHash,
  sealProgressiveRemoteExecution,
  validateProgressiveRemoteReport,
  type DB,
  type Sql,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type ProgressiveExecutionScope,
} from "@aerodb/engine-client";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredReportPublicationLanes,
  runProgressiveReportService,
} from "../src/progressive-report-service";
import { runSweeperServices } from "../src/service-lifecycle";
import {
  publishProgressiveWorkerReports,
  type ProgressivePublicationCursor,
} from "../src/progressive-remote-publication";
import {
  progressivePublicationSelectionSql,
  type ProgressivePublicationPass,
} from "../src/progressive-publication-selection";

const publicationEvidence = vi.hoisted(() => ({
  readPendingProgressiveWorkerReport: vi.fn(),
  acknowledgeProgressiveWorkerReport: vi.fn(),
}));

vi.mock("@aerodb/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aerodb/db")>()),
  ...publicationEvidence,
}));

function publicationFixture(
  options: {
    lane?: number;
    laneCount?: number;
    active?: boolean;
    terminalCount?: number;
    failActive?: boolean;
    onAcknowledged?: () => void;
  } = {},
) {
  const activeId = "00000000-0000-4000-8000-000000000001";
  const terminalId = "00000000-0000-4000-8000-000000000002";
  const solverId = "00000000-0000-4000-8000-000000000003";
  function assignment(executionId: string) {
    const unit = {
      unitId: randomUUID(),
      token: randomUUID(),
      alpha: 0,
      activeBudgetSeconds: 900,
    };
    const scope: ProgressiveExecutionScope = {
      executionContract: "progressive-cfd-v1",
      executionId,
      epochId: randomUUID(),
      generationId: randomUUID(),
      targetId: "a".repeat(64),
      recipeId: "b".repeat(64),
      stage: 2,
      tokens: [unit.token],
      units: [unit],
    };
    return sealProgressiveRemoteExecution({
      solverId,
      promiseId: executionId,
      scope,
      request: {
        execution_id: executionId,
        expected_engine: { ...OPENCFD_2606_ENGINE },
        expected_execution_pool: "test-pool",
        expected_solver_budget_version: 2,
        expected_mesh_recovery_version: 1,
        airfoil: { name: "lane contract" },
        chord_lengths: [1],
        speeds: [30],
        aoa: { angles: [0] },
        solver: { warm_start: true },
        resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
      },
    });
  }
  const envelopes = new Map(
    [activeId, terminalId].map((id) => [id, assignment(id)]),
  );
  const terminalCount = options.terminalCount ?? 40;
  function original(id: string, sequence: number): ProgressiveRemoteReport {
    const timestamp = new Date(
      Date.UTC(2020, 0, 1) + sequence * 1000,
    ).toISOString();
    const stopped = id === terminalId && sequence === terminalCount;
    return {
      version: 1,
      solverId,
      promiseId: id,
      executionId: id,
      assignmentSignature: envelopes.get(id)!.contentSignature,
      sequence,
      result: null,
      status: {
        job_id: id,
        state: stopped ? "cancelled" : "running",
        total_cases: 1,
        completed_cases: 0,
        updated_at: timestamp,
      },
      stopProof: stopped
        ? {
            version: 1,
            job_id: id,
            execution_stopped: true,
            producer_stopped: true,
            namespace_verified: true,
            observed_at: timestamp,
            remaining: [],
            error: null,
            fence: "cancel_marker",
          }
        : null,
    };
  }
  const pending = new Map([
    [activeId, options.active === false ? [] : [1]],
    [
      terminalId,
      Array.from({ length: terminalCount }, (_, index) => index + 1),
    ],
  ]);
  const deliveries: Array<{
    executionId: string;
    sequence: number;
    count: number;
    stopped: boolean;
  }> = [];
  const selectedPasses: ProgressivePublicationPass[] = [];
  const acknowledged: Array<{ executionId: string; sequence: number }> = [];
  const dialect = new PgDialect();
  const lane = options.lane ?? 0;
  const laneCount = options.laneCount ?? 1;
  const selectionQueries = new Map<
    string,
    { pass: ProgressivePublicationPass; after?: string }
  >();
  for (const pass of ["active", "backlog"] as const) {
    for (const after of [undefined, activeId, terminalId]) {
      const selection = progressivePublicationSelectionSql(
        lane,
        laneCount,
        pass,
        after,
      );
      selectionQueries.set(JSON.stringify(dialect.sqlToQuery(selection)), {
        pass,
        after,
      });
    }
  }
  const db = {
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const selection = selectionQueries.get(JSON.stringify(query));
      if (selection) {
        const { pass, after } = selection;
        selectedPasses.push(pass);
        // The terminal job's backlog is older. Once a cursor exists, use
        // exactly the selector's UUID rotation within each priority group.
        const candidates = [terminalId, activeId].filter(
          (id) => pending.get(id)!.length,
        );
        candidates.sort(
          (a, b) =>
            (pass === "active"
              ? Number(b === activeId) - Number(a === activeId)
              : 0) ||
            (after
              ? Number(b > after) - Number(a > after) || a.localeCompare(b)
              : 0),
        );
        return candidates.length ? [{ sim_job_id: candidates[0] }] : [];
      }
      if (query.sql.includes("AS same_source")) {
        const id = query.params.find(
          (v) => v === activeId || v === terminalId,
        ) as string;
        return pending
          .get(id)!
          .slice(1, 16)
          .map((n) => {
            const r = original(id, n);
            return {
              sequence: n,
              content_signature: analysisContentHash(r),
              status: r.status,
              same_source: r.stopProof === null,
            };
          });
      }
      expect(query.sql).toContain("AS solver_id");
      const executionId = String(query.params[0]);
      expect(pending.has(executionId)).toBe(true);
      return [
        {
          solver_id: solverId,
          auth_token: "fixture-token",
          paused: false,
          upstream_base_url: "https://hub.invalid/api/sync/v1",
          source_base_url: "https://hub.invalid/api/sync/v1",
          promise_id: executionId,
          request_payload: {
            upstreamBaseUrl: "https://hub.invalid/api/sync/v1",
            remoteProgressiveExecution: envelopes.get(executionId),
          },
        },
      ];
    }),
    transaction: (fn: (connection: DB) => Promise<unknown>) => fn(db),
  } as unknown as DB;
  publicationEvidence.readPendingProgressiveWorkerReport.mockImplementation(
    async (_db, input) => {
      const sequence = pending.get(input.executionId)?.[0];
      if (sequence === undefined) return null;
      const report = original(input.executionId, sequence);
      return {
        executionId: input.executionId,
        sequence,
        report,
        contentSignature: analysisContentHash(report),
      };
    },
  );
  publicationEvidence.acknowledgeProgressiveWorkerReport.mockImplementation(
    async (_db, input) => {
      const queue = pending.get(input.executionId)!;
      expect(input.contentSignature).toBe(
        analysisContentHash(original(input.executionId, input.sequence)),
      );
      expect(queue.shift()).toBe(input.sequence);
      acknowledged.push({
        executionId: input.executionId,
        sequence: input.sequence,
      });
      if (input.executionId === activeId) queue.push(input.sequence + 1);
      options.onAcknowledged?.();
    },
  );
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const { report, updates = [] } = JSON.parse(String(init?.body));
    const envelope = envelopes.get(report.executionId)!;
    const receipts = [
      report,
      ...updates.map(
        (u: {
          sequence: number;
          status: ProgressiveRemoteReport["status"];
        }) => ({ ...report, sequence: u.sequence, status: u.status }),
      ),
    ].map((r, i) => {
      const validated = validateProgressiveRemoteReport(r, envelope);
      expect(validated.report).toEqual(original(r.executionId, r.sequence));
      if (i)
        expect(updates[i - 1].contentSignature).toBe(
          validated.contentSignature,
        );
      return {
        executionId: r.executionId,
        sequence: r.sequence,
        contentSignature: validated.contentSignature,
        replayed: false,
      };
    });
    deliveries.push({
      executionId: report.executionId,
      sequence: report.sequence,
      count: receipts.length,
      stopped: report.stopProof !== null,
    });
    if (options.failActive && report.executionId === activeId)
      throw new Error("active publication unavailable");
    return Response.json({
      received: true,
      receipt: receipts[0],
      ...(updates.length ? { receipts } : {}),
    });
  });
  return {
    db,
    fetcher,
    activeId,
    terminalId,
    deliveries,
    acknowledged,
    selectedPasses,
  };
}

function notifications() {
  let notify: () => void = () => undefined;
  const unlisten = vi.fn(async () => undefined);
  return {
    connection: {
      listen: vi.fn(async (_channel: string, callback: () => void) => {
        notify = callback;
        return { unlisten };
      }),
    } as unknown as Pick<Sql, "listen">,
    notify: () => notify(),
    unlisten,
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("independent progressive report delivery", () => {
  it("defaults to eight publishers and accepts only bounded positive counts", () => {
    const count = (value?: string) =>
      configuredReportPublicationLanes({
        SWEEPER_PROGRESSIVE_REPORT_PUBLICATION_LANES: value,
      });
    expect(count()).toBe(8);
    expect(count("")).toBe(8);
    for (const n of [1, 2, 3, 8]) expect(count(String(n))).toBe(n);
    for (const value of ["0", "-1", "2.5", "9", "abc"]) {
      expect(() => count(value)).toThrow(
        "SWEEPER_PROGRESSIVE_REPORT_PUBLICATION_LANES",
      );
    }
  });

  it("starts exactly the configured report publishers on the remote sweeper entry point", async () => {
    const config = await import("../src/config");
    const service = await import("../src/progressive-report-service");
    const lifecycle = await import("../src/service-lifecycle");
    const heartbeat = await import("../src/heartbeat");
    const remote = await import("../src/remote-solver");
    const reader = await import("@aerodb/db/progressive-report-reader");
    const signals = (["SIGTERM", "SIGINT"] as const).map(
      (event) => [event, new Set(process.listeners(event))] as const,
    );
    const connection = {
      db: {
        select: () => ({
          from: () => ({
            limit: async () => [
              {
                remoteSolverEnabled: true,
                upstreamBaseUrl: "https://hub.invalid/api/sync/v1",
              },
            ],
          }),
        }),
      },
      sql: { end: vi.fn() },
    } as unknown as ReturnType<typeof config.makeIsolatedDatabase>;
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "");
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "false");
    vi.stubEnv("ENGINE_CONTROL_PLANE_TOKEN", "fixture-control-token".repeat(2));
    vi.stubEnv("SWEEPER_PROGRESSIVE_REPORT_PUBLICATION_LANES", "3");
    try {
      vi.spyOn(config, "makeContext").mockReturnValue({
        ...connection,
        engine: { baseUrl: "http://engine.invalid" },
      } as ReturnType<typeof config.makeContext>);
      const pool = vi
        .spyOn(config, "makeIsolatedDatabase")
        .mockReturnValue(connection);
      vi.spyOn(config, "makeReportStorageDatabase").mockReturnValue(connection);
      vi.spyOn(
        reader,
        "installProgressiveReportArchiveReader",
      ).mockImplementation(() => {});
      vi.spyOn(heartbeat, "startHeartbeatTimer").mockReturnValue(() => {});
      vi.spyOn(remote, "startRemoteSolverFleetHeartbeatTimer").mockReturnValue(
        () => {},
      );
      const publish = vi
        .spyOn(service, "runProgressiveReportService")
        .mockResolvedValue(undefined);
      vi.spyOn(lifecycle, "runSweeperServices").mockImplementation(
        async (signal, services) => {
          const publishers = services.filter((s) =>
            s.name.startsWith("progressive-report-delivery-"),
          );
          expect(publishers.map((s) => s.name)).toEqual(
            [0, 1, 2].map((lane) => `progressive-report-delivery-${lane}`),
          );
          for (const publisher of publishers) await publisher.run(signal);
        },
      );
      await import("../src/index");
      expect(pool).toHaveBeenCalledWith(3);
      expect(publish.mock.calls.map(([, , , partition]) => partition)).toEqual([
        { lane: 0, laneCount: 3 },
        { lane: 1, laneCount: 3 },
        { lane: 2, laneCount: 3 },
      ]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const [event, prior] of signals) {
        for (const listener of process.listeners(event))
          if (!prior.has(listener)) process.off(event, listener);
      }
    }
  });

  it.each([0, 1, 2])(
    "advances active and terminal reports in lane %i while new active reports keep arriving",
    async (lane) => {
      const terminalCount = 15 * 16 + 1;
      const fixture = publicationFixture({ lane, laneCount: 3, terminalCount });
      const cursor: ProgressivePublicationCursor = { nextPass: "active" };
      for (let batch = 0; batch < 2; batch += 1)
        expect(
          await publishProgressiveWorkerReports(
            fixture.db,
            fixture.fetcher,
            lane,
            3,
            cursor,
          ),
        ).toBe(true);
      expect(fixture.selectedPasses).toEqual(
        Array.from({ length: 64 }, (_, index) =>
          index % 2 === 0 ? "active" : "backlog",
        ),
      );
      const terminal = fixture.deliveries.filter(
        (d) => d.executionId === fixture.terminalId,
      );
      expect(terminal.map((d) => d.count)).toEqual([...Array(15).fill(16), 1]);
      expect(terminal.at(-1)).toMatchObject({
        sequence: terminalCount,
        stopped: true,
      });
      expect(
        fixture.acknowledged
          .filter((d) => d.executionId === fixture.terminalId)
          .map((d) => d.sequence),
      ).toEqual(Array.from({ length: terminalCount }, (_, i) => i + 1));
      expect(
        fixture.acknowledged
          .filter((d) => d.executionId === fixture.activeId)
          .map((d) => d.sequence),
      ).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
      expect(fixture.deliveries.map((d) => d.executionId)).toEqual(
        Array.from({ length: 64 }, (_, i) =>
          i % 4 === 1 ? fixture.terminalId : fixture.activeId,
        ),
      );
    },
  );

  it("aborts a capacity retry without acknowledging or re-sending its signed head", async () => {
    const owner = new AbortController();
    const waiting = deferred();
    const fixture = publicationFixture({ terminalCount: 1 });
    const busy = vi.fn<typeof fetch>(async () => {
      waiting.resolve();
      return new Response(null, {
        status: 503,
        headers: { "retry-after": "5" },
      });
    });
    vi.stubGlobal("fetch", busy);
    const channel = notifications();
    const stopped = runProgressiveReportService(
      fixture.db,
      channel.connection,
      owner.signal,
      { reportError: vi.fn() },
    );
    await waiting.promise;
    // The 503 body has been consumed and its five-second retry is pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(busy).toHaveBeenCalledOnce();
    const requestSignal = busy.mock.calls[0]![1]?.signal;
    expect(requestSignal?.aborted).toBe(false);
    owner.abort();
    expect(requestSignal?.aborted).toBe(true);
    await stopped;
    expect(busy).toHaveBeenCalledOnce();
    expect(fixture.acknowledged).toEqual([]);
    expect(channel.unlisten).toHaveBeenCalledOnce();
  });

  it("publishes backlog immediately when the active-priority pass is idle", async () => {
    const fixture = publicationFixture({ active: false, terminalCount: 1 });
    expect(
      await publishProgressiveWorkerReports(fixture.db, fixture.fetcher),
    ).toBe(true);
    expect(fixture.selectedPasses).toEqual(["active", "backlog"]);
    expect(fixture.acknowledged).toEqual([
      { executionId: fixture.terminalId, sequence: 1 },
    ]);
  });

  it("preserves alternation across service retries when active publication keeps failing", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    let completed = 0;
    const fixture = publicationFixture({
      failActive: true,
      terminalCount: 2,
      lane: 1,
      laneCount: 3,
      onAcknowledged: () => {
        completed += 1;
        if (completed === 2) owner.abort();
      },
    });
    vi.stubGlobal("fetch", fixture.fetcher);
    const channel = notifications();
    const reportError = vi.fn();
    const running = runProgressiveReportService(
      fixture.db,
      channel.connection,
      owner.signal,
      {
        lane: 1,
        laneCount: 3,
        reportError,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(fixture.acknowledged).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.acknowledged).toEqual([
      { executionId: fixture.terminalId, sequence: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    await running;
    expect(fixture.acknowledged).toEqual([
      { executionId: fixture.terminalId, sequence: 1 },
      { executionId: fixture.terminalId, sequence: 2 },
    ]);
    expect(fixture.deliveries.map((d) => d.executionId)).toEqual([
      fixture.activeId,
      fixture.terminalId,
      fixture.activeId,
      fixture.activeId,
      fixture.activeId,
      fixture.terminalId,
    ]);
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("publishes queued observations while an archive transfer remains blocked", async () => {
    const channel = notifications();
    const owner = new AbortController();
    const archive = deferred();
    const published = deferred();
    let archiveFinished = false;
    const publish = vi.fn(async () => {
      published.resolve();
      return false;
    });
    const running = runSweeperServices(owner.signal, [
      {
        name: "archive-transfer",
        run: async () => {
          await archive.promise;
          archiveFinished = true;
        },
      },
      {
        name: "reports",
        run: (signal) =>
          runProgressiveReportService({} as DB, channel.connection, signal, {
            publish,
          }),
      },
    ]);
    await published.promise;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(archiveFinished).toBe(false);
    owner.abort();
    archive.resolve();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("drains pending reports serially, sleeps when idle and resumes on notification", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const publish = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(publish).toHaveBeenCalledTimes(2);
    channel.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(3);
    owner.abort();
    await running;
  });

  it("polls for reports when the notification was missed", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const publish = vi.fn().mockResolvedValue(false);
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish, pollIntervalMs: 5_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
  });

  it("retains wakeups during a slow publication and awaits it during shutdown", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const pending = deferred();
    const publish = vi
      .fn()
      .mockImplementationOnce(async () => {
        await pending.promise;
        return false;
      })
      .mockResolvedValue(false);
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    );
    await vi.advanceTimersByTimeAsync(0);
    channel.notify();
    channel.notify();
    expect(publish).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not close the subscription or exit while its final publication is in flight", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const pending = deferred();
    const publish = vi.fn(async () => {
      await pending.promise;
      return false;
    });
    let finished = false;
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    ).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(channel.unlisten).not.toHaveBeenCalled();
    pending.resolve();
    await running;
    expect(finished).toBe(true);
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("retries a failed publication without a new report and cancels retry on shutdown", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const failure = new Error("isolated unavailable hub");
    const publish = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(false);
    const reportError = vi.fn();
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish, reportError },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reportError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("does not subscribe after shutdown and propagates subscription failure", async () => {
    const channel = notifications();
    const owner = new AbortController();
    owner.abort();
    await runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
    );
    expect(channel.connection.listen).not.toHaveBeenCalled();
    const failure = new Error("isolated subscription failure");
    vi.mocked(channel.connection.listen).mockRejectedValueOnce(failure);
    await expect(
      runProgressiveReportService(
        {} as DB,
        channel.connection,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  });
});
