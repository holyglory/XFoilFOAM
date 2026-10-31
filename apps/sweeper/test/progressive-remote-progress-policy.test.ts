import { expect, it } from "vitest";
import {
  PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT,
  progressiveReportBackpressureIsActive,
} from "../src/progressive-remote-progress";

it("raises the report drain budget from the actual backlog, not job count", () => {
  expect(progressiveReportBackpressureIsActive(PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT - 1)).toBe(false);
  expect(progressiveReportBackpressureIsActive(PROGRESSIVE_REPORT_BACKPRESSURE_LIMIT)).toBe(true);
  expect(progressiveReportBackpressureIsActive(2500)).toBe(true);
  expect(progressiveReportBackpressureIsActive(Number.NaN)).toBe(false);
});
