import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "components/admin/HealthPanel.tsx"),
  "utf8",
);

describe("admin health compute fleet", () => {
  it("applies the health layout styles to extracted child components", () => {
    expect(source).toContain("<style jsx global>");
    expect(source).toContain('className="fleet-node"');
    expect(source).toContain('className="throughput-bars"');
    expect(source).toContain('className="health-card"');
  });

  it("distinguishes configured capacity from real active execution", () => {
    expect(source).toContain('data-testid="health-compute-fleet"');
    expect(source).toContain("reservedCpuSlots");
    expect(source).toContain("capacityCpuSlots");
    expect(source).toContain("activeJobs");
    expect(source).toContain("admissionBlocked");
  });

  it("labels whole-host load with its CPU scope so it cannot masquerade as solver-slot utilization", () => {
    expect(source).toContain("1m whole-host load · not solver CPU");
    expect(source).toContain("load1.toFixed(1)");
    expect(source).toContain("availableCpus");
    expect(source).not.toContain("<span>host load</span>");
    expect(source).not.toContain("formatPct(node.health?.cpu.loadPct, 0)");
  });

  it("shows per-solver and overall daily point throughput", () => {
    expect(source).toContain('data-testid="health-performance"');
    expect(source).toContain("performance.daily");
    expect(source).toContain("performance.sources");
    expect(source).toContain("RANS");
    expect(source).toContain("Fast URANS");
    expect(source).toContain("Final URANS");
  });

  it("MUST-CATCH: every per-node chart names and colors each solver stage", () => {
    expect(source).toContain(
      "aria-label={`${source.name} daily accepted points by solver stage.",
    );
    expect(source).toContain('className="source-spark-rans"');
    expect(source).toContain('className="source-spark-preliminary"');
    expect(source).toContain('className="source-spark-final"');
    expect(source).toMatch(
      /const totalHeight = item\.total[\s\S]*?\?\s*Math\.max\(3,[\s\S]*?:\s*0;/,
    );
    expect(source).toMatch(
      /\.source-spark-rans,[\s\S]*?background:\s*\$\{C\.teal\}/,
    );
    expect(source).toMatch(
      /\.source-spark-preliminary,[\s\S]*?background:\s*\$\{C\.violet\}/,
    );
    expect(source).toMatch(
      /\.source-spark-final,[\s\S]*?background:\s*\$\{C\.amber\}/,
    );
    expect(source).toContain("RANS");
    expect(source).toContain("FAST URANS");
    expect(source).toContain("FINAL URANS");
    expect(source).not.toContain("totals24h.rans} R ·");
    expect(source).not.toContain("totals24h.preliminary} P ·");
    expect(source).not.toContain("totals24h.final} F");
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
