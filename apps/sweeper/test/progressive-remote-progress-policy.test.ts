import { expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  progressiveReportJobsSql,
  progressiveSettlementJobsSql,
} from "../src/progressive-progress-selection";
import {
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
  progressiveReportBackpressureIsActive,
  reconcileProgressiveRemoteProgress,
} from "../src/progressive-remote-progress";

it("raises the report drain budget from the actual backlog, not job count", () => {
  expect(
    progressiveReportBackpressureIsActive(
      PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT - 1,
    ),
  ).toBe(false);
  expect(
    progressiveReportBackpressureIsActive(
      PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
    ),
  ).toBe(true);
  expect(progressiveReportBackpressureIsActive(2500)).toBe(true);
  expect(progressiveReportBackpressureIsActive(Number.NaN)).toBe(false);
});

it.each([
  0,
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT - 1,
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
])(
  "keeps reserved terminal reports inside actual campaign budgets at backlog %i",
  async (pendingReports) => {
    const campaignId = "bounded-campaign";
    const reports = Array.from({ length: 64 }, (_, index) => ({
      sim_job_id:
        index === 6 || index === 7
          ? `stopped-report-${index}`
          : `active-report-${index}`,
      campaign_id: campaignId,
    }));
    const settlements = Array.from({ length: 128 }, (_, index) => ({
      sim_job_id: `settlement-${index}`,
      campaign_id: campaignId,
    }));
    const selectionExecute = vi
      .fn()
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ jit: "on" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(settlements);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(reports)
      .mockResolvedValueOnce([{ pending_reports: pendingReports }]);
    const missingDispatch = {
      execute: vi.fn().mockResolvedValue([]),
    } as unknown as DB;
    const transaction = vi
      .fn((run: (transaction: DB) => Promise<unknown>, _config?: unknown) =>
        run(missingDispatch),
      )
      .mockImplementationOnce((run) =>
        run({ execute: selectionExecute } as unknown as DB),
      );
    const connection = { execute, transaction } as unknown as DB;
    const receipt = await reconcileProgressiveRemoteProgress(connection);
    const dialect = new PgDialect();
    const statement = (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      return { sql, params };
    };
    const selectionQueries = selectionExecute.mock.calls.map(([query]) =>
      statement(query as SQL),
    );
    expect(selectionQueries).toEqual([
      { sql: "SHOW jit", params: [] },
      { sql: "SET LOCAL jit = off", params: [] },
      statement(progressiveSettlementJobsSql()),
      { sql: "SELECT set_config('jit', $1, true)", params: ["on"] },
    ]);
    expect(statement(execute.mock.calls[0][0] as SQL)).toEqual(
      statement(progressiveReportJobsSql()),
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      selectionExecute.mock.invocationCallOrder[0],
    );
    expect(transaction.mock.calls[0][1]).toEqual({ accessMode: "read only" });
    // Reconciliation runs after the settlement transaction has restored JIT.
    expect(selectionExecute.mock.invocationCallOrder.at(-1)).toBeLessThan(
      execute.mock.invocationCallOrder[1],
    );
    expect(missingDispatch.execute).toHaveBeenCalled();
    const pressured = pendingReports >= PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT;
    const processed = receipt.errors.map((error) => error.executionId);
    expect(processed).toHaveLength(pressured ? 64 : 16);
    expect(processed.filter((id) => id.startsWith("settlement-"))).toHaveLength(
      pressured ? 32 : 8,
    );
    expect(processed).toEqual(
      expect.arrayContaining(["stopped-report-6", "stopped-report-7"]),
    );
    expect(processed).not.toContain(
      pressured ? "active-report-32" : "active-report-8",
    );
    expect(
      receipt.errors.every(
        (error) =>
          error.reason === "Remote progress has no exact dispatch owner",
      ),
    ).toBe(true);
    expect(receipt.settled).toBe(0);
  },
);

it.each(["report", "settlement"])(
  "propagates %s selection failure before any reconciliation",
  async (phase) => {
    const failure = new Error("selection unavailable");
    let index = 0;
    const selectionExecute = vi.fn(async () => {
      const current = index++;
      if (current === 2) throw failure;
      return current === 0 ? [{ jit: "on" }] : [];
    });
    const execute =
      phase === "report"
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue([]);
    const transaction = vi.fn(
      async (run: (transaction: DB) => Promise<unknown>) =>
        run({ execute: selectionExecute } as unknown as DB),
    );
    await expect(
      reconcileProgressiveRemoteProgress({
        execute,
        transaction,
      } as unknown as DB),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
    if (phase === "report") expect(transaction).not.toHaveBeenCalled();
    else expect(transaction).toHaveBeenCalledOnce();
  },
);

it("returns an empty scope without opening a selection transaction", async () => {
  const execute = vi.fn();
  const transaction = vi.fn();
  expect(
    await reconcileProgressiveRemoteProgress(
      { execute, transaction } as unknown as DB,
      { jobIds: [] },
    ),
  ).toEqual({
    applied: 0,
    indexed: 0,
    stopped: 0,
    settled: 0,
    waiting: 0,
    errors: [],
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
