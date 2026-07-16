import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_DIAL_TICK_COUNT,
  campaignDialGeometry,
} from "../components/admin/campaigns/CampaignProgressGauge";

describe("campaign completion dial geometry", () => {
  it("keeps the approved dense calibrated semicircle", () => {
    const dial = campaignDialGeometry(535, 277, 0, 631_410);

    expect(CAMPAIGN_DIAL_TICK_COUNT).toBe(60);
    expect(dial.centerX).toBeCloseTo(267.5, 4);
    expect(dial.startAngle).toBe(Math.PI);
    expect(dial.endAngle).toBe(Math.PI * 2);
    expect(dial.progressEndAngle).toBe(Math.PI);
    expect(dial.radius).toBeGreaterThan(225);
  });

  it.each([
    { value: 0, max: 100, fraction: 0 },
    { value: 1_010, max: 631_410, fraction: 1_010 / 631_410 },
    { value: 50, max: 100, fraction: 0.5 },
    { value: 100, max: 100, fraction: 1 },
  ])(
    "maps $value of $max to its exact $fraction semicircle fraction",
    ({ value, max, fraction }) => {
      const dial = campaignDialGeometry(535, 277, value, max);
      expect((dial.progressEndAngle - Math.PI) / Math.PI).toBeCloseTo(
        fraction,
        10,
      );
    },
  );

  it("clamps invalid or out-of-range values without manufacturing progress", () => {
    expect(campaignDialGeometry(535, 277, -1, 100).progressEndAngle).toBe(
      Math.PI,
    );
    expect(campaignDialGeometry(535, 277, 200, 100).progressEndAngle).toBe(
      Math.PI * 2,
    );
    expect(campaignDialGeometry(535, 277, 10, 0).progressEndAngle).toBe(
      Math.PI,
    );
    expect(
      campaignDialGeometry(535, 277, Number.NaN, 100).progressEndAngle,
    ).toBe(Math.PI);
    expect(
      campaignDialGeometry(535, 277, 10, Number.POSITIVE_INFINITY)
        .progressEndAngle,
    ).toBe(Math.PI);
  });
});
