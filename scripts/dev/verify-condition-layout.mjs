import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = process.argv.includes("--production")
  ? "https://airfoils.pro"
  : progressivePreviewOrigin();
const root = resolve(new URL("../../", import.meta.url).pathname);
const output = mkdtempSync(join(tmpdir(), "airfoil-condition-layout-"));
const reviewInputs = [
  "apps/web/app/layout.tsx",
  "apps/web/app/globals.css",
  "apps/web/app/page.tsx",
  "apps/web/components/browse/BrowseView.tsx",
  "apps/web/components/MetricConditionSelector.tsx",
  "apps/web/components/PolarMiniChart.tsx",
  "apps/web/components/compare/ProgressiveCompareView.tsx",
  "apps/web/components/compare/CompareView.tsx",
  "apps/web/components/detail/ProgressivePolarViewer.tsx",
  "apps/web/lib/tokens.ts",
].map((path) => ({ path, kind: "ui-code" }));
const targets = [
  {
    name: "catalog",
    path: "/",
    selector: "[data-testid='browse-surface']",
    wait: "[data-testid='browse-surface'][data-hydrated='true']",
    journey: "rank-airfoils",
  },
  {
    name: "compare",
    path: "/compare?airfoil=ag24&airfoil=ag25",
    selector: "[data-testid='condition-comparison']",
    wait: "[data-testid='condition-comparison']",
    journey: "compare-at-condition",
  },
  {
    name: "detail",
    path: "/airfoils/ag24",
    selector: "[data-testid='progressive-polar-viewer']",
    wait: "[data-testid='progressive-polar-viewer'][aria-busy='false']",
    journey: "inspect-selected-polar",
  },
].map((target) => ({
  name: target.name,
  url: origin + target.path,
  waitFor: { selector: target.wait },
  journeys: [
    {
      id: target.journey,
      name: target.journey,
      frequencyPercent: 100,
      risk: "normal",
      rationale: "Selected public condition journey",
    },
  ],
  primaryJourney: target.journey,
  regions: [
    {
      name: target.name,
      selector: target.selector,
      role: "primary-content",
      journey: target.journey,
    },
  ],
  theme: "dark",
  reviewInputs,
  states: [
    {
      name: "light",
      theme: "light",
      actions: [
        {
          action: "click",
          selector: "button[aria-label='Switch to light theme']",
        },
      ],
      continuation: {
        kind: "in-page",
        anchor:
          target.name === "catalog"
            ? "select[aria-label='Metrics for']"
            : target.name === "compare"
              ? "select[aria-label='Comparison condition']"
              : "select[aria-label='Polar condition']",
        focusWithin: "button[aria-label='Switch to dark theme']",
        maxScrollDelta: 8,
      },
    },
  ],
}));
const config = {
  repoRoot: root,
  targets,
  viewports: [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "reported", width: 688, height: 1118 },
    { name: "narrow", width: 390, height: 844 },
  ],
  requiredCoverage: [
    { target: "catalog", state: "base", viewport: "reported", width: 688 },
  ],
  maxPageCount: 18,
  performance: { ttfbMs: 10, lcpMs: 800, ttfbLocalOnly: true },
};
const path = join(output, "config.json");
writeFileSync(path, JSON.stringify(config));
const run = spawnSync(
  "devcoordinator2-tooling",
  ["formal-ui", "verify", "--config", path, "--fail-on", "critical"],
  { stdio: "inherit" },
);
process.exitCode = run.status ?? 1;
