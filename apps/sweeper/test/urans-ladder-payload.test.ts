import { describe, expect, it } from "vitest";

import { assertNoReservedLadderPayloadKeys } from "../src/urans-ladder";

describe("ladder payload execution-provenance guard", () => {
  it.each([
    "aoas",
    "meshRecoveryVersion",
    "resources",
    "setupSnapshot",
    "speedMap",
    "uransFidelity",
  ])("MUST-CATCH: rejects a payloadExtras override of %s", (key) => {
    expect(() =>
      assertNoReservedLadderPayloadKeys({
        uransRequestId: "request-id",
        [key]: "untrusted override",
      }),
    ).toThrow(`reserved execution provenance: ${key}`);
  });

  it("FALSE-POSITIVE GUARD: permits non-reserved relationship metadata", () => {
    expect(() =>
      assertNoReservedLadderPayloadKeys({
        uransRequestId: "request-id",
        precalcObligationIds: ["obligation-id"],
        continueFromResultAttemptId: "attempt-id",
        budgetOverrideS: 21_600,
      }),
    ).not.toThrow();
  });
});
