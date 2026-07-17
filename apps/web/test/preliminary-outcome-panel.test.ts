import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(
    new URL(
      "../components/admin/campaigns/PreliminaryOutcomePanel.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("per-point solver sequence panel", () => {
  it("MUST-CATCH: maps every AoA to one row containing the complete three-stage rail", () => {
    expect(source).toContain("POINT RESULTS");
    expect(source).toContain("outcomes.items.map((item)");
    expect(source).toContain("key={`${item.aoaDeg}:${item.sourceAoaDeg}`}");
    expect(source).toContain(
      "data-testid={`cell-preliminary-outcome-${item.aoaDeg}`}",
    );
    expect(source).toContain("testId={`cell-preliminary-rans-${item.aoaDeg}`}");
    expect(source).toContain("testId={`cell-preliminary-fast-${item.aoaDeg}`}");
    expect(source).toContain(
      "testId={`cell-preliminary-final-${item.aoaDeg}`}",
    );
    expect(source.match(/data-flow-stage="rans"/g)).toHaveLength(1);
    expect(source.match(/data-flow-stage="fast"/g)).toHaveLength(1);
    expect(source.match(/data-flow-stage="final"/g)).toHaveLength(1);
    expect(source).toContain("RANS non-convergence is a normal handoff");
  });

  it("keeps technical evidence collapsed and makes critical rows system-owned and visually red", () => {
    expect(source).toContain("<details");
    expect(source).not.toMatch(/<details[^>]+open=/);
    expect(source).toContain("Technical details for ${label}");
    expect(source).toContain("system investigation required");
    expect(source).toContain(
      "System-owned incident; automatic investigation required",
    );
    expect(source).toContain("box-shadow: inset 3px 0 ${C.red}");
    expect(source).not.toMatch(/RANS (?:failed|failure)/i);
    expect(source).not.toContain("FAILED POINTS");
    expect(source).not.toContain("no action required");
    expect(source).not.toContain("solver evidence rejected");
  });

  it("separates evidence-record counts from confirmed physical work in the compact stage summaries", () => {
    expect(source).toContain('data-detail-stage="rans"');
    expect(source).toContain('data-detail-stage="fast"');
    expect(source).toContain('data-detail-stage="final"');
    expect(source).toContain("RANS SCREEN");
    expect(source).toContain("URANS FAST");
    expect(source).toContain("URANS FINAL");
    expect(source).toContain("evidence record");
    expect(source).not.toMatch(/ransEvidenceRuns\}\s*physical run/);
    expect(source).toContain("physical");
    expect(source).toContain("before CFD");
    expect(source).toContain("SYSTEM INCIDENT · AUTO-INVESTIGATE");
    expect(source).not.toContain("physical runs counted separately");
  });

  it("keeps accepted final comparison and update warnings amber, never red critical", () => {
    expect(source).toContain("comparison-warning");
    expect(source).toContain("update-warning");
    expect(source).toContain(".row-status.warning");
    expect(source).toContain("color: ${C.amber}");
    expect(source).not.toContain('state === "critical" || disagreed');
  });

  it("keeps the stage guide on the same responsive columns as each AoA row", () => {
    expect(
      source.match(
        /grid-template-columns: 72px minmax\(180px, 1fr\) 152px 28px;/g,
      ),
    ).toHaveLength(2);
    expect(
      source.match(
        /grid-template-columns: 58px minmax\(120px, 1fr\) 124px 26px;/g,
      ),
    ).toHaveLength(2);
    expect(
      source.match(/grid-template-columns: 50px minmax\(0, 1fr\) 26px;/g),
    ).toHaveLength(2);
  });
});
