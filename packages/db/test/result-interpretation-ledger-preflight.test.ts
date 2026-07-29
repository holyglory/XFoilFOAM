import { describe, expect, it } from "vitest";

import {
  assertResultInterpretationLedgerPreflight,
  classifyResultInterpretationLedgerPreflight,
  mayApplyResultInterpretationLedgerMigrations,
  type ResultInterpretationLedgerPreflightFacts,
} from "../src/result-interpretation-ledger-preflight";

function facts(
  overrides: Partial<ResultInterpretationLedgerPreflightFacts> = {},
): ResultInterpretationLedgerPreflightFacts {
  return {
    hasApplicationAnchors: false,
    journalState: "absent",
    footprintPresent: false,
    preledger0093Issues: [],
    post0093MarkersPresent: false,
    postledger0099Issues: [],
    ...overrides,
  };
}

describe("result-interpretation ledger migration preflight state partition", () => {
  it("accepts only a genuinely fresh database", () => {
    const fresh = classifyResultInterpretationLedgerPreflight(facts());
    expect(fresh).toMatchObject({ state: "fresh", issues: [] });
    expect(mayApplyResultInterpretationLedgerMigrations(fresh)).toBe(true);

    const dirtyFresh = classifyResultInterpretationLedgerPreflight(
      facts({ hasApplicationAnchors: true }),
    );
    expect(dirtyFresh.state).toBe("incompatible");
  });

  it("accepts the exact production 0093 baseline and rejects missing anchors", () => {
    const accepted = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "preledger_0093",
      }),
    );
    expect(accepted).toMatchObject({ state: "preledger_0093", issues: [] });

    const missingAnchor = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "preledger_0093",
        preledger0093Issues: ["0093 ingest-completion table is missing"],
      }),
    );
    expect(missingAnchor.state).toBe("incompatible");
    expect(missingAnchor.issues).toContain("0093 ingest-completion table is missing");
  });

  it("rejects 0092, reordered, and partial 0094–0099 shapes", () => {
    for (const bad of [
      facts({ hasApplicationAnchors: true, journalState: "other" }),
      facts({
        hasApplicationAnchors: true,
        journalState: "preledger_0093",
        post0093MarkersPresent: true,
      }),
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0099",
        footprintPresent: true,
        postledger0099Issues: ["archive-reduction queue indexes are incomplete"],
      }),
    ]) {
      const fingerprint = classifyResultInterpretationLedgerPreflight(bad);
      expect(fingerprint.state).toBe("incompatible");
      expect(() => assertResultInterpretationLedgerPreflight(fingerprint)).toThrow(
        /refusing result-interpretation ledger migration/,
      );
    }
  });

  it("accepts only a fully verified 0099 postflight shape", () => {
    const full = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0099",
        footprintPresent: true,
      }),
    );
    expect(full).toMatchObject({ state: "postledger_0099", issues: [] });
  });
});
