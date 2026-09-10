import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const config = JSON.parse(
  readFileSync(new URL("./progressive-ui.json", import.meta.url), "utf8"),
);
const response = await fetch(`${origin}/api/airfoils/ag24/solver-work`);
assert(response.ok);
const works = await response.json();
let revision;
for (const condition of works.conditions.slice(0, 24)) {
  const response = await fetch(
    `${origin}/api/airfoils/ag24?revisionId=${condition.presetRevisionId}`,
  );
  assert(response.ok);
  const detail = await response.json();
  if (
    !detail.progressivePolars?.length &&
    detail.polars.some((polar) => polar.points.length)
  ) {
    revision = condition.presetRevisionId;
    break;
  }
}
assert(revision, "Real CFD-only evidence is required");
const viewer = "[data-testid='polar-viewer']";
const toggle = `${viewer} button[aria-pressed][style*='min-height']`;
const target = config.targets[0];
target.name = "cfd-only-polar";
target.url = `${origin}/airfoils/ag24?revision=${revision}`;
target.waitFor = { selector: viewer };
target.regions[0].selector = viewer;
target.themeExceptions = [
  {
    selector: "svg",
    reason: "Plots retain the existing dark plotting surface in both themes.",
  },
];
target.reviewInputs.push(
  { path: "apps/web/components/detail/PolarViewer.tsx", kind: "ui-code" },
  { path: "apps/web/components/detail/PolarChart.tsx", kind: "ui-code" },
);
const points = { action: "click", selector: toggle };
const light = {
  action: "click",
  selector: "button[aria-label='Switch to light theme']",
};
target.states = [
  {
    name: "points",
    actions: [points],
    continuation: {
      kind: "in-page",
      anchor: "[data-testid='polar-chart-svg']",
      focusWithin: toggle,
      maxScrollDelta: 8,
    },
  },
  {
    name: "light",
    theme: "light",
    actions: [light],
    continuation: {
      kind: "in-page",
      anchor: "[data-testid='polar-chart-svg']",
      focusWithin: "button[aria-label='Switch to dark theme']",
      maxScrollDelta: 8,
    },
  },
  {
    name: "light-points",
    theme: "light",
    actions: [light, points],
    continuation: {
      kind: "in-page",
      anchor: "[data-testid='polar-chart-svg']",
      focusWithin: toggle,
      maxScrollDelta: 8,
    },
  },
];
config.targets = [target];
config.maxPageCount = config.viewports.length * (target.states.length + 1);
const directory = mkdtempSync(join(tmpdir(), "cfd-only-layout-"));
try {
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(
    "/usr/local/bin/devcoordinator2-tooling",
    ["formal-ui", "verify", "--config", path, "--fail-on", "critical"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
