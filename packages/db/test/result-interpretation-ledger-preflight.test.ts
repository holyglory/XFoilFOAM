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
    postledger0100Issues: [],
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

  it("accepts a fully verified 0099 shape only as an upgradeable 0100 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0099",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({ state: "postledger_0099_upgrade", issues: [] });
    expect(mayApplyResultInterpretationLedgerMigrations(upgradeable)).toBe(true);
  });

  it("accepts only the final 0100 archive source-identity topology", () => {
    const final = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0100",
        footprintPresent: true,
      }),
    );
    expect(final).toMatchObject({ state: "postledger_0100", issues: [] });

    const legacyArchiveIdentity = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0100",
        footprintPresent: true,
        postledger0100Issues: [
          "0100 archive interpretation source identity is incompatible",
        ],
      }),
    );
    expect(legacyArchiveIdentity.state).toBe("incompatible");
    expect(legacyArchiveIdentity.issues).toContain(
      "0100 archive interpretation source identity is incompatible",
    );
    expect(mayApplyResultInterpretationLedgerMigrations(legacyArchiveIdentity)).toBe(false);
  });
});
