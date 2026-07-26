import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "components/admin/HealthPanel.tsx"),
  "utf8",
);

describe("admin health compute fleet", () => {
  it("distinguishes configured capacity from real active execution", () => {
    expect(source).toContain('data-testid="health-compute-fleet"');
    expect(source).toContain("reservedCpuSlots");
    expect(source).toContain("capacityCpuSlots");
    expect(source).toContain("activeJobs");
    expect(source).toContain("admissionBlocked");
  });

  it("shows per-solver and overall daily point throughput", () => {
    expect(source).toContain('data-testid="health-performance"');
    expect(source).toContain("performance.daily");
    expect(source).toContain("performance.sources");
    expect(source).toContain("RANS");
    expect(source).toContain("Fast URANS");
    expect(source).toContain("Final URANS");
  });

  it("stacks fleet and performance content at narrow widths", () => {
    expect(source).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.fleet-grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(source).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.performance-source-grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });
});
