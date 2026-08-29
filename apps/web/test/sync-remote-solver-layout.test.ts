import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "components/admin/AdminConsole.tsx"),
  "utf8",
);

describe("registered remote solver responsive layout", () => {
  it("stacks the solver/assets cards before their content can collide", () => {
    expect(source).toContain('className="sync-remote-overview-grid"');
    expect(source).toContain('className="sync-connection-grid"');
    expect(source).toContain('className="sync-permissions-grid"');
    expect(source).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.sync-connection-grid,[\s\S]*?\.sync-permissions-grid,[\s\S]*?\.sync-remote-overview-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(source).not.toContain(
      'gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 0.85fr)"',
    );
    expect(source).not.toContain(
      'gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.7fr)"',
    );
  });

  it("uses named layout regions instead of competing auto-width text columns", () => {
    expect(source).toContain('className="registered-remote-solver"');
    expect(source).toContain('className="registered-remote-solver-heading"');
    expect(source).toContain('className="registered-remote-solver-stats"');
    expect(source).toContain('className="registered-remote-solver-controls"');
    expect(source).not.toMatch(
      /REGISTERED REMOTE SOLVERS[\s\S]{0,1800}gridTemplateColumns:\s*"minmax\(0,\s*1fr\) auto"/,
    );
  });

  it("reduces solver statistics to two columns on very narrow screens", () => {
    expect(source).toMatch(
      /@media \(max-width: 460px\)[\s\S]*?\.registered-remote-solver-stats\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  it("shows canonical GCS delivery instead of irrelevant zero remote-reference counts", () => {
    expect(source).toContain("GCS EVIDENCE DELIVERY");
    expect(source).toContain("evidenceTransfers.byState");
    expect(source).not.toContain(">REMOTE ASSETS<");
    expect(source).not.toContain(
      '["remote_only", "cached", "missing", "failed"]',
    );
  });

  it("separates live promise bundles from all-time individual AoA outcomes", () => {
    expect(source).toContain("REMOTE SOLVER WORK");
    expect(source).toContain("active promise bundles");
    expect(source).toContain("INDIVIDUAL AOA OUTCOMES · ALL TIME");
    expect(source).toContain("PROMISE BUNDLE OUTCOMES · ALL TIME");
    expect(source).toContain("Current campaign plans");
    expect(source).toContain("Background solves");
    expect(source).toContain("Released for another solve");
    expect(source).toContain(
      "Accepted AoAs remain stored if unfinished AoAs are",
    );
    expect(source).not.toContain(
      '{["active", "fulfilled", "expired", "cancelled"].map(',
    );
  });

  it("gives the promise summary responsive named regions and readable insets", () => {
    expect(source).toContain('className="sync-promise-card"');
    expect(source).toContain('data-ui-region="sync-promise-summary"');
    expect(source).toContain('data-ui-verify-min-content-inset="12"');
    expect(source).toMatch(
      /\.sync-promise-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto/,
    );
  });
});
