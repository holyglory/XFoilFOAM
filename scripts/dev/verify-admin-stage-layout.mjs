import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import {
  originFromDeployment,
  progressivePreviewDeployment,
} from "./progressive-preview-origin.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const deployment = progressivePreviewDeployment({
  name: "campaign-stage-preview",
});
const origin = originFromDeployment(deployment);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const generation = String(deployment.data.current_generation);
const privateDir = join(
  root,
  ".codex-artifacts",
  "catalog-page-auth",
  generation,
);
const fixture = JSON.parse(
  await readFile(
    join(
      root,
      ".codex-artifacts",
      "campaign-stage-preview",
      generation,
      "fixture.json",
    ),
    "utf8",
  ),
);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
for (const key of ["campaignId", "resultId", "fastAttemptId", "finalAttemptId"])
  assert.match(fixture[key], uuid);
assert.notEqual(fixture.fastAttemptId, fixture.finalAttemptId);
assert.match(fixture.airfoilSlug, /^[a-z0-9][a-z0-9-]*$/);
assert(
  Number.isFinite(fixture.aoaDeg) && Number.isInteger(fixture.conditionOrd),
);
const api = await request.newContext({ baseURL: origin });
const scratch = await mkdtemp(join(tmpdir(), "campaign-stage-layout-"));
try {
  const password = await readFile(join(privateDir, "password"), "utf8");
  const login = await api.post("/api/admin/login", {
    data: { email: "catalog-qa@example.invalid", password },
  });
  assert.equal(login.status(), 200);
  const state = await api.storageState();
  const testId = (name) => `[data-testid='${name}']`;
  const campaign = testId("campaign-detail");
  const drawer = testId("cell-side-panel");
  const dialog = testId("sim-modal-dialog");
  const trigger = testId(
    `matrix-cell-${fixture.airfoilSlug}-${fixture.conditionOrd}`,
  );
  const route = "/admin?campaign=" + fixture.campaignId;
  const lightToggle = "button[aria-label='Switch to light theme']";
  const journey = "inspect-stored-generation";
  const click = (selector) => ({ action: "click", selector });
  const geometry = (region, heading) => [
    {
      id: "width",
      kind: "primary-content-width",
      selector: region,
      minWidth: 280,
    },
    { id: "heading", kind: "readable-heading", selector: heading },
    {
      id: "identity",
      kind: "readable-canonical-identifier",
      selector: heading,
    },
    { id: "wrapping", kind: "no-character-wrapping", selector: heading },
    { id: "document", kind: "document-horizontal-overflow", selector: "html" },
    { id: "placement", kind: "initial-viewport-placement", selector: region },
    { id: "clipping", kind: "clipping", selector: heading },
  ];
  const regions = (selector) => [
    { name: "Current view", selector, role: "primary-content", journey },
  ];
  const modes = [
    {
      stage: "fast",
      attempt: fixture.fastAttemptId,
      fidelity: "urans_precalc",
    },
    { stage: "final", attempt: fixture.finalAttemptId, fidelity: "urans_full" },
  ];
  for (const { attempt, fidelity } of modes) {
    const response = await api.get(
      `/api/admin/point-history/${fixture.resultId}/sim?resultAttemptId=${attempt}`,
    );
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.resultId, fixture.resultId);
    assert.equal(body.resultAttemptId, attempt);
    assert.equal(body.fidelity, fidelity);
  }
  const heading = campaign + " h2.campaign-instrument-title";
  const opened = "#cell-side-panel-title";
  const pointName = dialog + " [role='heading']";
  const group = testId("cell-preliminary-track-" + fixture.aoaDeg);
  const states = [
    {
      name: "light",
      theme: "light",
      actions: [click(lightToggle)],
      continuation: {
        kind: "in-page",
        anchor: heading,
        focusWithin: "button[aria-label='Switch to dark theme']",
      },
    },
  ];
  for (const theme of ["dark", "light"]) {
    const opening = [
      ...(theme === "light" ? [click(lightToggle)] : []),
      { action: "focus", selector: trigger },
      click(trigger),
    ];
    states.push({
      name: "cell-" + theme,
      theme,
      actions: opening,
      waitFor: { selector: group },
      regions: regions(drawer),
      geometryAssertions: geometry(drawer, opened),
      continuation: { kind: "in-page", anchor: opened, focusWithin: drawer },
    });
    for (const { stage, attempt } of modes) {
      const button = testId(`cell-preliminary-${stage}-${fixture.aoaDeg}`);
      states.push({
        name: stage + "-" + theme,
        theme,
        actions: [
          ...opening,
          { action: "focus", selector: button },
          { action: "press", selector: button, value: "Enter" },
        ],
        waitFor: {
          selector: dialog + " " + testId("sim-fidelity-chip"),
          responseUrl:
            origin +
            `/api/admin/point-history/${fixture.resultId}/sim?resultAttemptId=${attempt}`,
          responseStatus: 200,
        },
        regions: regions(dialog),
        geometryAssertions: geometry(dialog, pointName),
        continuation: {
          kind: "in-page",
          anchor: pointName,
          focusWithin: dialog,
        },
      });
    }
  }
  const viewports = [
    { name: "mobile", width: 390, height: 844 },
    { name: "reported", width: 671, height: 907 },
    { name: "desktop", width: 1440, height: 1000 },
  ];
  for (const boundary of [500, 600, 700, 760, 900])
    for (const width of [boundary - 1, boundary, boundary + 1])
      viewports.push({ name: "width-" + width, width, height: 900 });
  const allStates = ["base", ...states.map((s) => s.name)];
  const target = "campaign-attempt";
  const branches = (name) =>
    name.startsWith("cell-")
      ? [drawer, group]
      : /^(fast|final)-/.test(name)
        ? [dialog, pointName, testId("sim-fidelity-chip")]
        : [campaign, trigger];
  const config = {
    repoRoot: root,
    sourceBinding: { expected: webSourceIdentity(root) },
    cookies: state.cookies.map(({ name, value }) => ({
      name,
      value,
      url: origin,
    })),
    targets: [
      {
        name: target,
        url: origin + route,
        theme: "dark",
        waitFor: { selector: trigger },
        primaryJourney: journey,
        journeys: [
          {
            id: journey,
            name: "Inspect the stored result for the selected solver stage",
            frequencyPercent: 100,
            risk: "high",
            rationale:
              "A single polar result may contain two independently stored solver attempts.",
          },
        ],
        regions: regions(campaign),
        geometryAssertions: geometry(campaign, heading),
        states,
        reviewInputs: [
          "apps/web/components/admin/campaigns/CampaignDetail.tsx",
          "apps/web/components/admin/campaigns/PreliminaryOutcomePanel.tsx",
          "apps/web/components/admin/campaigns/CellSidePanel.tsx",
          "apps/web/components/detail/SimModal.tsx",
          "apps/web/lib/tokens.ts",
          "apps/web/app/globals.css",
        ].map((path) => ({ path, kind: "ui-code" })),
      },
    ],
    viewports,
    fixtureDataShapes: allStates.map((name) => ({
      id: "stored-pair-" + name,
      revision: "paired-attempt-v1",
      route,
      target,
      state: name,
      conditionalDom: branches(name),
      layoutEffect:
        "The selected stage opens its stored attempt in a nested evidence dialog.",
    })),
    requiredCoverage: allStates.flatMap((s) =>
      viewports.map((v) => ({
        target,
        state: s,
        viewport: v.name,
        width: v.width,
      })),
    ),
    execution: { maxConcurrency: 1 },
    maxPageCount: viewports.length * allStates.length,
  };
  const path = join(scratch, "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const result = spawnSync(
    "devcoordinator2-tooling",
    ["formal-ui", "verify", "--config", path, "--fail-on", "critical"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await api.dispose();
  await rm(scratch, { recursive: true, force: true });
}
