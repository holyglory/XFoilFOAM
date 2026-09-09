import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const config = JSON.parse(
  readFileSync(new URL("./progressive-ui.json", import.meta.url), "utf8"),
);
for (const target of config.targets) {
  const route = new URL(target.url, origin);
  target.url = new URL(
    `${route.pathname}${route.search}${route.hash}`,
    origin,
  ).href;
  target.themeExceptions = [
    {
      selector: "svg",
      reason:
        "Aerodynamic plots intentionally preserve their dark plotting surface in both themes.",
    },
  ];
  target.states.push({
    name: "light-theme",
    theme: "light",
    actions: [
      {
        action: "click",
        selector: "button[aria-label='Switch to light theme']",
      },
    ],
    continuation: {
      kind: "in-page",
      anchor: `${target.regions[0].selector} svg`,
      focusWithin: "button[aria-label='Switch to dark theme']",
      maxScrollDelta: 8,
    },
  });
}
const detailResponse = await fetch(new URL("/api/airfoils/ag24", origin), {
  signal: AbortSignal.timeout(15000),
});
assert(
  detailResponse.ok,
  "Real CFD formal coverage requires the preview detail API",
);
const detail = await detailResponse.json();
const series = detail.progressivePolars.find(
  (item) =>
    item.curves.some((curve) => curve.method === "composite") &&
    item.curves.length > 1 &&
    item.explanation?.contributors?.some(
      (entry) => entry.resultId && entry.attemptId,
    ),
);
assert(
  series,
  "Real CFD formal coverage cannot substitute a prediction-only curve",
);
const contributor = series.explanation.contributors.find(
  (entry) => entry.resultId && entry.attemptId,
);
assert(
  /^[a-f0-9-]{36}$/.test(contributor.resultId) &&
    /^[a-f0-9-]{36}$/.test(contributor.attemptId),
);
const polar = config.targets.find(
  (target) => target.name === "progressive-polar",
);
assert(polar);
const viewer = "[data-testid='progressive-polar-viewer']";
const selection = {
  action: "selectOption",
  selector: `${viewer} select[aria-label='Polar condition']`,
  value: series.targetId,
};
const selectionActions = [
  { action: "focus", selector: selection.selector },
  selection,
];
const evidenceButton = `${viewer} button[data-result-id='${contributor.resultId}'][data-result-attempt-id='${contributor.attemptId}']`;
const curveContinuation = {
  kind: "in-page",
  anchor: `${viewer} svg`,
  focusWithin: viewer,
  maxScrollDelta: 8,
};
polar.states.push(
  {
    name: "cfd-curve",
    actions: selectionActions,
    continuation: curveContinuation,
  },
  {
    name: "cfd-methods",
    continuation: curveContinuation,
    actions: [
      ...selectionActions,
      {
        action: "check",
        selector: `${viewer} label:has-text('Compare methods') input`,
      },
    ],
  },
  {
    name: "cfd-light",
    theme: "light",
    continuation: {
      ...curveContinuation,
      focusWithin: "button[aria-label='Switch to dark theme']",
    },
    actions: [
      ...selectionActions,
      {
        action: "click",
        selector: "button[aria-label='Switch to light theme']",
      },
    ],
  },
  {
    name: "cfd-evidence",
    actions: [
      ...selectionActions,
      { action: "click", selector: `${viewer} summary` },
      { action: "focus", selector: evidenceButton },
      { action: "click", selector: evidenceButton },
    ],
    waitFor: { selector: "[data-testid='sim-attempt-evidence']" },
    regions: [
      {
        name: "Recorded CFD evidence",
        selector: "[data-testid='sim-modal-dialog']",
        role: "primary-content",
        journey: "inspect-polar",
      },
    ],
    continuation: {
      kind: "in-page",
      anchor: "[data-testid='sim-attempt-evidence']",
      focusWithin: "[data-testid='sim-modal-dialog']",
      maxScrollDelta: 8,
      triggerActionIndex: 4,
    },
    reviewInputs: [
      { path: "apps/web/components/detail/SimModal.tsx", kind: "ui-code" },
      { path: "apps/web/lib/use-modal-layer.ts", kind: "ui-code" },
    ],
  },
);
config.maxPageCount = 30;
const directory = mkdtempSync(join(tmpdir(), "progressive-layout-"));
const reports = mkdtempSync(join("/tmp", "progressive-layout-reports-"));
try {
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(
    "/usr/local/bin/devcoordinator2-tooling",
    [
      "formal-ui",
      "verify",
      "--config",
      path,
      "--json-out",
      join(reports, "report.json"),
      "--markdown-out",
      join(reports, "report.md"),
      "--fail-on",
      "critical",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
