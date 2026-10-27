import type { DB, Sql } from "@aerodb/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProgressiveReportService } from "../src/progressive-report-service";
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
  validateProgressiveRemoteReport: vi.fn(),
  verifyProgressiveRemoteExecution: vi.fn(),
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
  const pending = new Map([
    [activeId, options.active === false ? [] : [1]],
    [
      terminalId,
      Array.from(
        { length: options.terminalCount ?? 40 },
        (_, index) => index + 1,
      ),
    ],
  ]);
  const deliveries: Array<{ executionId: string; sequence: number }> = [];
  const selectedPasses: ProgressivePublicationPass[] = [];
  const acknowledged: Array<{ executionId: string; sequence: number }> = [];
  const dialect = new PgDialect();
  const lane = options.lane ?? 0;
  const laneCount = options.laneCount ?? 1;
  const selectionQueries = new Map(
    (["active", "backlog"] as const).map((pass) => [
      JSON.stringify(
        dialect.sqlToQuery(
          progressivePublicationSelectionSql(lane, laneCount, pass),
        ),
      ),
      pass,
    ]),
  );
  const db = {
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const pass = selectionQueries.get(JSON.stringify(query));
      if (pass) {
        selectedPasses.push(pass);
        const active = pending.get(activeId)!.length > 0;
        const terminal = pending.get(terminalId)!.length > 0;
        const executionId =
          pass === "active" && active
            ? activeId
            : terminal
              ? terminalId
              : active
                ? activeId
                : null;
        return executionId ? [{ sim_job_id: executionId }] : [];
      }
      expect(query.sql).toContain("AS solver_id");
      const executionId = String(query.params[0]);
      expect(pending.has(executionId)).toBe(true);
      return [
        {
          solver_id: "00000000-0000-4000-8000-000000000003",
          auth_token: "fixture-token",
          paused: false,
          upstream_base_url: "https://hub.invalid/api/sync/v1",
          source_base_url: "https://hub.invalid/api/sync/v1",
          promise_id: executionId,
          request_payload: {
            upstreamBaseUrl: "https://hub.invalid/api/sync/v1",
            remoteProgressiveExecution: {},
          },
        },
      ];
    }),
  } as unknown as DB;
  publicationEvidence.verifyProgressiveRemoteExecution.mockReturnValue({});
  publicationEvidence.validateProgressiveRemoteReport.mockImplementation(
    (report) => report,
  );
  publicationEvidence.readPendingProgressiveWorkerReport.mockImplementation(
    async (_db, input) => {
      const sequence = pending.get(input.executionId)?.[0];
      if (sequence === undefined) return null;
      return {
        sequence,
        contentSignature: "a".repeat(64),
        report: {
          executionId: input.executionId,
          sequence,
          contentSignature: "a".repeat(64),
          assignmentSignature: "b".repeat(64),
        },
      };
    },
  );
  publicationEvidence.acknowledgeProgressiveWorkerReport.mockImplementation(
    async (_db, input) => {
      const queue = pending.get(input.executionId)!;
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
    const { report } = JSON.parse(String(init?.body));
    deliveries.push({
      executionId: report.executionId,
      sequence: report.sequence,
    });
    if (options.failActive && report.executionId === activeId)
      return new Response("active publication unavailable", { status: 401 });
    return new Response(
      JSON.stringify({
        received: true,
        receipt: {
          executionId: report.executionId,
          sequence: report.sequence,
          contentSignature: report.contentSignature,
          replayed: false,
        },
      }),
      { status: 200 },
    );
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
  it.each([0, 1, 2])(
    "advances active and terminal reports in lane %i while new active reports keep arriving",
    async (lane) => {
      const fixture = publicationFixture({ lane, laneCount: 3 });
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
      expect(fixture.acknowledged).toEqual(
        Array.from({ length: 64 }, (_, index) => ({
          executionId: index % 2 === 0 ? fixture.activeId : fixture.terminalId,
          sequence: Math.floor(index / 2) + 1,
        })),
      );
    },
  );

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
    await vi.advanceTimersByTimeAsync(100);
    await running;
    expect(fixture.acknowledged).toEqual([
      { executionId: fixture.terminalId, sequence: 1 },
      { executionId: fixture.terminalId, sequence: 2 },
    ]);
    expect(fixture.deliveries.map((delivery) => delivery.executionId)).toEqual([
      fixture.activeId,
      fixture.terminalId,
      fixture.activeId,
      fixture.terminalId,
      fixture.activeId,
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
