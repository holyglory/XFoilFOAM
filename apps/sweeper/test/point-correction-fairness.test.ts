import { describe, expect, it } from "vitest";

import {
  campaignFastMayUseThisIteration,
  shouldAttemptPointCorrectionFast,
} from "../src/loop";

describe("bounded point-correction refill fairness", () => {
  it("gives one waiting correction the first non-promotion opportunity", () => {
    expect(
      shouldAttemptPointCorrectionFast({
        promotionSubmitted: false,
        localCapacityOpen: true,
        consideredThisTick: false,
      }),
    ).toBe(true);
  });

  it("attempts at most one correction per refill cycle", () => {
    expect(
      shouldAttemptPointCorrectionFast({
        promotionSubmitted: false,
        localCapacityOpen: true,
        consideredThisTick: true,
      }),
    ).toBe(false);
  });

  it("packs campaign work when a correction cannot fit or fails to submit", () => {
    expect(
      campaignFastMayUseThisIteration({
        promotionSubmitted: false,
        pointCorrectionSubmitted: false,
        localCapacityOpen: true,
      }),
    ).toBe(true);
  });

  it("moves to campaign packing after one correction consumed this iteration", () => {
    expect(
      campaignFastMayUseThisIteration({
        promotionSubmitted: false,
        pointCorrectionSubmitted: true,
        localCapacityOpen: true,
      }),
    ).toBe(false);
    expect(
      campaignFastMayUseThisIteration({
        promotionSubmitted: false,
        pointCorrectionSubmitted: false,
        localCapacityOpen: true,
      }),
    ).toBe(true);
  });

  it("preserves recorded-promotion priority and never fabricates capacity", () => {
    expect(
      shouldAttemptPointCorrectionFast({
        promotionSubmitted: true,
        localCapacityOpen: true,
        consideredThisTick: false,
      }),
    ).toBe(false);
    expect(
      shouldAttemptPointCorrectionFast({
        promotionSubmitted: false,
        localCapacityOpen: false,
        consideredThisTick: false,
      }),
    ).toBe(false);
    expect(
      campaignFastMayUseThisIteration({
        promotionSubmitted: false,
        pointCorrectionSubmitted: false,
        localCapacityOpen: false,
      }),
    ).toBe(false);
  });
});
