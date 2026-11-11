import { expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  progressiveReportJobsSql,
  progressiveReportPressureSql,
  progressiveSettlementJobsSql,
} from "../src/progressive-progress-selection";
import {
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
  PROGRESSIVE_TERMINAL_REPORT_JOB_PRESSURE_LIMIT,
  PROGRESSIVE_TERMINAL_REPORT_AGE_PRESSURE_MS,
  progressiveReportBackpressureIsActive,
  reconcileProgressiveRemoteProgress,
} from "../src/progressive-remote-progress";

it("preserves report-only backpressure and raises drain pressure for overdue or numerous terminal jobs", () => {
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
  expect(progressiveReportBackpressureIsActive(1, 1, PROGRESSIVE_TERMINAL_REPORT_AGE_PRESSURE_MS - 1)).toBe(false);
  expect(progressiveReportBackpressureIsActive(1, 1, PROGRESSIVE_TERMINAL_REPORT_AGE_PRESSURE_MS)).toBe(true);
  expect(progressiveReportBackpressureIsActive(8, PROGRESSIVE_TERMINAL_REPORT_JOB_PRESSURE_LIMIT, 0)).toBe(true);
  expect(progressiveReportBackpressureIsActive(7, PROGRESSIVE_TERMINAL_REPORT_JOB_PRESSURE_LIMIT - 1, 0)).toBe(false);
  expect(progressiveReportBackpressureIsActive(1, 0, PROGRESSIVE_TERMINAL_REPORT_AGE_PRESSURE_MS)).toBe(false);
  expect(progressiveReportBackpressureIsActive(1, Number.NaN, 60_000)).toBe(false);
  expect(progressiveReportBackpressureIsActive(1, 1, Number.NaN)).toBe(false);
});

it.each([
  { pendingReports: 0, terminalJobs: 0, ageMs: 0, pressured: false },
  { pendingReports: 1999, terminalJobs: 0, ageMs: 0, pressured: false },
  { pendingReports: 2000, terminalJobs: 0, ageMs: 0, pressured: true },
  { pendingReports: 100, terminalJobs: 1, ageMs: 60_000, pressured: true },
  { pendingReports: 100, terminalJobs: 8, ageMs: 0, pressured: true },
])(
  "keeps both selected budgets through the campaign cap: $pendingReports reports, $terminalJobs terminal, $ageMs ms",
  async ({ pendingReports, terminalJobs, ageMs, pressured }) => {
    const campaignId = "bounded-campaign";
    const reports = Array.from({ length: 64 }, (_, index) => ({
      sim_job_id:
        index >= 6 && index < 48
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
      .mockResolvedValueOnce([{ pending_reports: pendingReports, pending_terminal_jobs: terminalJobs, oldest_terminal_age_ms: ageMs }])
      .mockResolvedValueOnce(reports)
      .mockResolvedValue([]);
    let activeTransactions = 0;
    let maximumActive = 0;
    const missingDispatch = {
      execute: vi.fn(async () => {
        maximumActive = Math.max(maximumActive, ++activeTransactions);
        await Promise.resolve();
        activeTransactions -= 1;
        return [];
      }),
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
    expect(statement(execute.mock.calls[0][0] as SQL)).toEqual(statement(progressiveReportPressureSql()));
    expect(statement(execute.mock.calls[1][0] as SQL)).toEqual(
      statement(progressiveReportJobsSql(undefined, pressured ? 48 : 8)),
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      selectionExecute.mock.invocationCallOrder[0],
    );
    expect(transaction.mock.calls[0][1]).toEqual({ accessMode: "read only" });
    // Reconciliation runs after the settlement transaction has restored JIT.
    expect(selectionExecute.mock.invocationCallOrder.at(-1)).toBeLessThan(
      execute.mock.invocationCallOrder[2],
    );
    expect(missingDispatch.execute).toHaveBeenCalled();
    const processed = receipt.errors.map((error) => error.executionId);
    expect(processed).toHaveLength(pressured ? 80 : 16);
    expect(processed.filter((id) => id.startsWith("settlement-"))).toHaveLength(
      pressured ? 32 : 8,
    );
    expect(processed).toEqual(
      expect.arrayContaining(["stopped-report-6", "stopped-report-7"]),
    );
    expect(processed.filter((id) => id.includes("report-"))).toHaveLength(pressured ? 48 : 8);
    expect(processed.filter((id) => id.startsWith("active-report-"))).toHaveLength(6);
    expect(processed).not.toContain(pressured ? "active-report-48" : "stopped-report-8");
    if (pressured) expect(processed).toContain("stopped-report-47");
    expect(
      receipt.errors.every(
        (error) =>
          error.reason === "Remote progress has no exact dispatch owner",
      ),
    ).toBe(true);
    expect(receipt.settled).toBe(0);
    expect(maximumActive).toBe(1);
  },
);

it.each(["pressure", "report", "settlement"])(
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
      phase === "pressure" ? vi.fn().mockRejectedValue(failure)
        : phase === "report" ? vi.fn().mockResolvedValueOnce([{}]).mockRejectedValue(failure)
          : vi.fn().mockResolvedValueOnce([{}]).mockResolvedValue([]);
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
    expect(execute).toHaveBeenCalledTimes(phase === "pressure" ? 1 : 2);
    if (phase !== "settlement") expect(transaction).not.toHaveBeenCalled();
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
