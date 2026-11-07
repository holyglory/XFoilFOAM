import { expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import {
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
  progressiveReportBackpressureIsActive,
  reconcileProgressiveRemoteProgress,
} from "../src/progressive-remote-progress";

it("raises the report drain budget from the actual backlog, not job count", () => {
  expect(progressiveReportBackpressureIsActive(PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT - 1)).toBe(false);
  expect(progressiveReportBackpressureIsActive(PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT)).toBe(true);
  expect(progressiveReportBackpressureIsActive(2500)).toBe(true);
  expect(progressiveReportBackpressureIsActive(Number.NaN)).toBe(false);
});

it.each([0, PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT - 1, PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT])(
  "keeps reserved terminal reports inside actual campaign budgets at backlog %i",
  async (pendingReports) => {
    const campaignId = "bounded-campaign";
    const reports = Array.from({ length: 64 }, (_, index) => ({
      sim_job_id: index === 6 || index === 7 ? `stopped-report-${index}` : `active-report-${index}`,
      campaign_id: campaignId,
    }));
    const settlements = Array.from({ length: 128 }, (_, index) => ({
      sim_job_id: `settlement-${index}`, campaign_id: campaignId,
    }));
    const execute = vi.fn().mockResolvedValue([])
      .mockResolvedValueOnce(reports).mockResolvedValueOnce(settlements)
      .mockResolvedValueOnce([{ pending_reports: pendingReports }]);
    const missingDispatch = { execute: vi.fn().mockResolvedValue([]) } as unknown as DB;
    const connection = { execute, transaction: (run: (transaction: DB) => Promise<unknown>) => run(missingDispatch) } as unknown as DB;
    const receipt = await reconcileProgressiveRemoteProgress(connection);
    const pressured = pendingReports >= PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT;
    const processed = receipt.errors.map((error) => error.executionId);
    expect(processed).toHaveLength(pressured ? 64 : 16);
    expect(processed.filter((id) => id.startsWith("settlement-"))).toHaveLength(pressured ? 32 : 8);
    expect(processed).toEqual(expect.arrayContaining(["stopped-report-6", "stopped-report-7"]));
    expect(processed).not.toContain(pressured ? "active-report-32" : "active-report-8");
    expect(receipt.errors.every((error) => error.reason === "Remote progress has no exact dispatch owner")).toBe(true);
    expect(receipt.settled).toBe(0);
  },
);
