import { describe, expect, it } from "vitest";

import { containedBadgePosition } from "../lib/polar-badge";

describe("polar floating badge containment", () => {
  it("flips left and clamps inside a narrow chart when the cursor is at the right edge", () => {
    expect(
      containedBadgePosition({
        anchorX: 460,
        anchorY: 130,
        badgeWidth: 238,
        badgeHeight: 180,
        containerWidth: 478,
        containerHeight: 260,
      }),
    ).toEqual({ left: 210, top: 40 });
  });

  it("clamps oversized badge geometry to the inset rather than allowing negative coordinates", () => {
    expect(
      containedBadgePosition({
        anchorX: 6,
        anchorY: 4,
        badgeWidth: 520,
        badgeHeight: 300,
        containerWidth: 478,
        containerHeight: 260,
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});
