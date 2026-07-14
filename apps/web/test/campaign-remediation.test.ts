import { describe, expect, it } from "vitest";

import { campaignRemediationCopy } from "../components/admin/campaigns/campaign-remediation";

describe("campaign remediation copy", () => {
  it("MUST-CATCH: distinguishes exhausted preliminary evidence from RANS work waiting for URANS", () => {
    expect(
      campaignRemediationCopy({
        repairing: 0,
        blocked: 11,
        groups: [
          {
            reason: "precalc_attempts_exhausted",
            state: "blocked",
            owner: "system",
            points: 11,
          },
        ],
      }),
    ).toMatchObject({
      label: "preliminary unavailable",
      detail: expect.stringContaining("no user action is required"),
    });
  });

  it("does not invent an unavailable state when no terminal remediation exists", () => {
    expect(
      campaignRemediationCopy({ repairing: 4, blocked: 0, groups: [] }),
    ).toBeNull();
  });
});
