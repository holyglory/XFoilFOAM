import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertResultInterpretationLedgerPreflight,
  classifyResultInterpretationLedgerJournal,
  classifyResultInterpretationLedgerPreflight,
  mayApplyResultInterpretationLedgerMigrations,
  type ResultInterpretationLedgerPreflightFacts,
} from "../src/result-interpretation-ledger-preflight";

const preflightSource = readFileSync(
  new URL("../src/result-interpretation-ledger-preflight.ts", import.meta.url),
  "utf8",
);
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
    postledger0101Issues: [],
    postledger0102Issues: [],
    postledger0103Issues: [],
    postledger0104Issues: [],
    postledger0105Issues: [],
    postledger0106Issues: [],
    postledger0116Issues: [],
    postledger0118Issues: [],
    postledger0120Issues: [],
    postledger0121Issues: [],
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
    expect(missingAnchor.issues).toContain(
      "0093 ingest-completion table is missing",
    );
  });

  it("accepts a complete pre-ledger 0091 remote baseline for 0092+ upgrades", () => {
    const accepted = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "preledger_0091",
        preledger0093Issues: [
          "0092 result-media storage-key index is missing",
          "0093 ingest-completion table is missing",
        ],
      }),
    );
    expect(accepted).toMatchObject({ state: "preledger_0091", issues: [] });
    expect(mayApplyResultInterpretationLedgerMigrations(accepted)).toBe(true);
  });

  it("rejects reordered and partial 0094–0099 shapes", () => {
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
        postledger0099Issues: [
          "archive-reduction queue indexes are incomplete",
        ],
      }),
    ]) {
      const fingerprint = classifyResultInterpretationLedgerPreflight(bad);
      expect(fingerprint.state).toBe("incompatible");
      expect(() =>
        assertResultInterpretationLedgerPreflight(fingerprint),
      ).toThrow(/refusing result-interpretation ledger migration/);
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
    expect(upgradeable).toMatchObject({
      state: "postledger_0099_upgrade",
      issues: [],
    });
    expect(mayApplyResultInterpretationLedgerMigrations(upgradeable)).toBe(
      true,
    );
  });

  it("accepts a verified 0100 topology only as an upgradeable 0101 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0100",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({
      state: "postledger_0100_upgrade",
      issues: [],
    });

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
    expect(
      mayApplyResultInterpretationLedgerMigrations(legacyArchiveIdentity),
    ).toBe(false);

    const partialAudit = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0100",
        footprintPresent: true,
        postledger0100Issues: [
          "0101 historical audit marker exists before its journal entry",
        ],
      }),
    );
    expect(partialAudit.state).toBe("incompatible");
  });

  it("accepts a verified 0101 receipt topology only as an upgradeable 0102 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0101",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({
      state: "postledger_0101_upgrade",
      issues: [],
    });

    const schedulerTargetLeak = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0101",
        footprintPresent: true,
        postledger0101Issues: [
          "0101 historical audit must not carry scheduler targets",
        ],
      }),
    );
    expect(schedulerTargetLeak.state).toBe("incompatible");
    expect(schedulerTargetLeak.issues).toContain(
      "0101 historical audit must not carry scheduler targets",
    );
  });

  it("accepts a verified 0102 provenance topology only as an upgradeable 0103 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0102",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({
      state: "postledger_0102_upgrade",
      issues: [],
    });

    const missingProvenanceValidator =
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0102",
          footprintPresent: true,
          postledger0102Issues: [
            "0102 historical audit decision provenance trigger is missing",
          ],
        }),
      );
    expect(missingProvenanceValidator.state).toBe("incompatible");
    expect(missingProvenanceValidator.issues).toContain(
      "0102 historical audit decision provenance trigger is missing",
    );
  });

  it("accepts a verified 0103 audit source/state fence only as an upgradeable 0104 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0103",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({
      state: "postledger_0103_upgrade",
      issues: [],
    });

    const missingHardening = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0103",
        footprintPresent: true,
        postledger0103Issues: [
          "0103 historical audit decision source/state fence is incompatible",
        ],
      }),
    );
    expect(missingHardening.state).toBe("incompatible");
    expect(missingHardening.issues).toContain(
      "0103 historical audit decision source/state fence is incompatible",
    );
  });

  it("accepts a verified 0104 canonical-selection fence only as an upgradeable 0105 baseline", () => {
    const upgradeable = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0104",
        footprintPresent: true,
      }),
    );
    expect(upgradeable).toMatchObject({
      state: "postledger_0104_upgrade",
      issues: [],
    });

    const missingFence = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0104",
        footprintPresent: true,
        postledger0104Issues: [
          "0104 canonical selection and projection fence is incompatible",
        ],
      }),
    );
    expect(missingFence.state).toBe("incompatible");
    expect(missingFence.issues).toContain(
      "0104 canonical selection and projection fence is incompatible",
    );
  });

  it("accepts a verified 0105 run-identity fence only as an upgradeable 0106 baseline", () => {
    const final = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0105",
        footprintPresent: true,
      }),
    );
    expect(final).toMatchObject({ state: "postledger_0105", issues: [] });

    const missingFence = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0105",
        footprintPresent: true,
        postledger0105Issues: [
          "0105 historical audit run identity fence is incompatible",
        ],
      }),
    );
    expect(missingFence.state).toBe("incompatible");
    expect(missingFence.issues).toContain(
      "0105 historical audit run identity fence is incompatible",
    );

    const mismatchedHistory = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0105",
        footprintPresent: true,
        postledger0105Issues: [
          "historical archive audit decision does not match its immutable audit run identity",
        ],
      }),
    );
    expect(mismatchedHistory.state).toBe("incompatible");
    expect(mismatchedHistory.issues).toContain(
      "historical archive audit decision does not match its immutable audit run identity",
    );

    const duplicateOutcome = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0105",
        footprintPresent: true,
        postledger0105Issues: [
          "historical archive audit run has more than one immutable decision",
        ],
      }),
    );
    expect(duplicateOutcome.state).toBe("incompatible");
    expect(duplicateOutcome.issues).toContain(
      "historical archive audit run has more than one immutable decision",
    );
  });

  it("accepts only the final 0106 child execution-receipt fence", () => {
    const final = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0106",
        footprintPresent: true,
      }),
    );
    expect(final).toMatchObject({ state: "postledger_0106", issues: [] });

    for (const issue of [
      "0106 historical audit child receipt columns are incompatible",
      "0106 historical audit child decision foreign key is incompatible",
      "0106 historical audit child decision uniqueness fence is incompatible",
      "0106 historical audit child receipt validator functions are incompatible",
      "0106 historical audit child receipt triggers are incompatible",
      "historical archive audit decision does not match its terminal child execution receipt",
      "historical archive audit run does not have exactly one immutable child execution receipt",
    ]) {
      const incompatible = classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0106",
          footprintPresent: true,
          postledger0106Issues: [issue],
        }),
      );
      expect(incompatible.state).toBe("incompatible");
      expect(incompatible.issues).toContain(issue);
    }
  });

  it("accepts the exact 0109 policy-lineage journal as the current terminal baseline", () => {
    const final = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0109",
        footprintPresent: true,
      }),
    );
    expect(final).toMatchObject({ state: "postledger_0109", issues: [] });
    expect(mayApplyResultInterpretationLedgerMigrations(final)).toBe(true);
  });

  it("accepts the exact 0110 maintenance-drain journal as the current terminal baseline", () => {
    const final = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0110",
        footprintPresent: true,
      }),
    );
    expect(final).toMatchObject({ state: "postledger_0110", issues: [] });
    expect(mayApplyResultInterpretationLedgerMigrations(final)).toBe(true);
  });

  it("MUST-CATCH: accepts the exact 0121 journal only after the complete 0120 upgrade", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; when: number }> };
    const exact0116 = journal.entries
      .filter((entry) => entry.idx <= 116)
      .map((entry) => entry.when);
    const exact0118 = journal.entries
      .filter((entry) => entry.idx <= 118)
      .map((entry) => entry.when);
    const exact0119 = journal.entries
      .filter((entry) => entry.idx <= 119)
      .map((entry) => entry.when);
    const exact0120 = journal.entries
      .filter((entry) => entry.idx <= 120)
      .map((entry) => entry.when);
    const exact0121 = journal.entries
      .filter((entry) => entry.idx <= 121)
      .map((entry) => entry.when);

    expect(exact0116.at(-1)).toBe(1790899200000);
    expect(classifyResultInterpretationLedgerJournal(exact0116)).toBe(
      "postledger_0116",
    );
    expect(exact0118.at(-1)).toBe(1791072000000);
    expect(classifyResultInterpretationLedgerJournal(exact0118)).toBe(
      "postledger_0118",
    );
    expect(exact0119.at(-1)).toBe(1791158400000);
    expect(classifyResultInterpretationLedgerJournal(exact0119)).toBe(
      "postledger_0119",
    );
    expect(exact0120.at(-1)).toBe(1791244800000);
    expect(classifyResultInterpretationLedgerJournal(exact0120)).toBe(
      "postledger_0120",
    );
    expect(exact0121.at(-1)).toBe(1791331200000);
    expect(classifyResultInterpretationLedgerJournal(exact0121)).toBe(
      "postledger_0121",
    );
    expect(
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0116",
          footprintPresent: true,
        }),
      ),
    ).toMatchObject({ state: "postledger_0116", issues: [] });

    expect(
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0118",
          footprintPresent: true,
        }),
      ),
    ).toMatchObject({ state: "postledger_0118", issues: [] });

    expect(
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0119",
          footprintPresent: true,
        }),
      ),
    ).toMatchObject({ state: "postledger_0119", issues: [] });
    expect(
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0120",
          footprintPresent: true,
        }),
      ),
    ).toMatchObject({ state: "postledger_0120", issues: [] });
    expect(
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0121",
          footprintPresent: true,
        }),
      ),
    ).toMatchObject({ state: "postledger_0121", issues: [] });

    const obsoleteForensicPath = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0121",
        footprintPresent: true,
        postledger0121Issues: [
          "0121 obsolete terminal-forensic or quarantine table remains",
        ],
      }),
    );
    expect(obsoleteForensicPath).toMatchObject({ state: "incompatible" });
    expect(obsoleteForensicPath.issues).toContain(
      "0121 obsolete terminal-forensic or quarantine table remains",
    );

    const missingTerminalFence = classifyResultInterpretationLedgerPreflight(
      facts({
        hasApplicationAnchors: true,
        journalState: "postledger_0118",
        footprintPresent: true,
        postledger0116Issues: [
          "0116 reverse terminal quarantine ownership triggers are incompatible",
        ],
      }),
    );
    expect(missingTerminalFence).toMatchObject({ state: "incompatible" });
    expect(missingTerminalFence.issues).toContain(
      "0116 reverse terminal quarantine ownership triggers are incompatible",
    );

    for (const reciprocalFenceIssue of [
      "0117 remote terminal receipt reciprocal ownership function fence is incompatible",
      "0117 remote terminal receipt reciprocal ownership triggers are incompatible",
    ]) {
      const missingOrCorruptReciprocalFence =
        classifyResultInterpretationLedgerPreflight(
          facts({
            hasApplicationAnchors: true,
            journalState: "postledger_0119",
            footprintPresent: true,
            postledger0118Issues: [reciprocalFenceIssue],
          }),
        );
      expect(missingOrCorruptReciprocalFence).toMatchObject({
        state: "incompatible",
      });
      expect(missingOrCorruptReciprocalFence.issues).toContain(
        reciprocalFenceIssue,
      );
    }

    const incomplete0120 = [...exact0120];
    incomplete0120.splice(incomplete0120.length - 2, 1);
    expect(classifyResultInterpretationLedgerJournal(incomplete0120)).toBe(
      "other",
    );

    const reordered0120 = [...exact0120];
    const lastIndex = reordered0120.length - 1;
    [reordered0120[lastIndex - 1], reordered0120[lastIndex]] = [
      reordered0120[lastIndex],
      reordered0120[lastIndex - 1],
    ];
    expect(classifyResultInterpretationLedgerJournal(reordered0120)).toBe(
      "other",
    );

    expect(
      classifyResultInterpretationLedgerJournal([...exact0121, 1791417600000]),
    ).toBe("other");

    const incompleteReconciliation =
      classifyResultInterpretationLedgerPreflight(
        facts({
          hasApplicationAnchors: true,
          journalState: "postledger_0120",
          footprintPresent: true,
          postledger0120Issues: [
            "0120 period-roundoff reconciliation left an exact incident unresolved",
          ],
        }),
      );
    expect(incompleteReconciliation).toMatchObject({ state: "incompatible" });
    expect(incompleteReconciliation.issues).toContain(
      "0120 period-roundoff reconciliation left an exact incident unresolved",
    );

    // 0111–0115 and the 0117-only reciprocal fence are intermediate states;
    // a persisted prefix must never become a release baseline.
    expect(
      classifyResultInterpretationLedgerJournal(exact0118.slice(0, -1)),
    ).toBe("other");
  });

  it("rejects an unjournaled 0105 footprint on every earlier accepted ledger baseline", () => {
    const earlierBaselines = [
      ["postledger_0099", "postledger0099Issues"],
      ["postledger_0100", "postledger0100Issues"],
      ["postledger_0101", "postledger0101Issues"],
      ["postledger_0102", "postledger0102Issues"],
      ["postledger_0103", "postledger0103Issues"],
      ["postledger_0104", "postledger0104Issues"],
    ] as const;
    const marker =
      "0105 historical audit run identity fence marker exists before its journal entry";

    for (const [journalState, issueKey] of earlierBaselines) {
      const candidate = facts({
        hasApplicationAnchors: true,
        journalState,
        footprintPresent: true,
      });
      candidate[issueKey] = [marker];
      const result = classifyResultInterpretationLedgerPreflight(candidate);
      expect(result.state).toBe("incompatible");
      expect(result.issues).toContain(marker);
    }
  });

  it("rejects an unjournaled 0106 child-receipt footprint on every earlier accepted ledger baseline", () => {
    const earlierBaselines = [
      ["postledger_0099", "postledger0099Issues"],
      ["postledger_0100", "postledger0100Issues"],
      ["postledger_0101", "postledger0101Issues"],
      ["postledger_0102", "postledger0102Issues"],
      ["postledger_0103", "postledger0103Issues"],
      ["postledger_0104", "postledger0104Issues"],
      ["postledger_0105", "postledger0105Issues"],
    ] as const;
    const marker =
      "0106 historical audit child receipt fence marker exists before its journal entry";

    for (const [journalState, issueKey] of earlierBaselines) {
      const candidate = facts({
        hasApplicationAnchors: true,
        journalState,
        footprintPresent: true,
      });
      candidate[issueKey] = [marker];
      const result = classifyResultInterpretationLedgerPreflight(candidate);
      expect(result.state).toBe("incompatible");
      expect(result.issues).toContain(marker);
    }
  });
});
