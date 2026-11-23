// Retain the reviewed, authenticated preview and the ordinary public VPS
// journey together. Production Google credentials stay in the user's browser.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, request } from "@playwright/test";
import {
  currentSource,
  publishDirectory,
  sha,
  writeJson,
} from "./verify-catalog-web-delivery.mjs";
import {
  progressivePreviewDeployment,
  originFromDeployment,
} from "./progressive-preview-origin.mjs";

const root = process.cwd();
const qa = join(root, ".codex-artifacts");
const input = JSON.parse(
  await readFile(join(qa, "campaign-delivery-input.json"), "utf8"),
);
const before = progressivePreviewDeployment({ name: "campaign-stage-preview" });
const origin = originFromDeployment(before);
const local = await currentSource();
const operator = JSON.parse(await readFile(input.liveRuntime, "utf8"));
const formal = JSON.parse(
  await readFile(join(input.formalDirectory, "formal-receipt.json"), "utf8"),
).formal;
const manualBytes = await readFile(input.manualReview);
const manual = JSON.parse(manualBytes).manual;
const audit = JSON.parse(await readFile(input.designReceipt, "utf8"));
assert(
  formal.result === "passed" &&
    formal.freshComplete &&
    formal.coverage.readinessEligible,
);
assert(
  manual.result === "passed" &&
    manual.formalRunId === formal.runId &&
    manual.cells.length === formal.coverage.requiredCells,
);
assert(
  audit.result === "passed" &&
    audit.formalRunId === formal.runId &&
    audit.manualSha256 === sha(manualBytes),
);
assert.equal(audit.implementation.observedBuild, local.webBuild);
assert.equal(operator.webBuildId, local.webBuild);
assert.equal(operator.manifest.sourceRevision, input.releaseRevision);
assert.equal(operator.health, "passed");
const core = "/admin?campaign=c24047fa-743f-4ae5-bcd6-f3071ff79fb4";
const external = "https://airfoils.pro";
const pair = JSON.parse(
  await readFile(
    join(
      qa,
      "campaign-stage-preview",
      String(before.data.current_generation),
      "fixture.json",
    ),
    "utf8",
  ),
);
const route = origin + "/admin?campaign=" + pair.campaignId;
const api = await request.newContext({ baseURL: origin });
const socket = await mkdtemp("/tmp/airfoils-campaign-handoff-");
const target = "campaign-selected-evidence";
let browser;
try {
  const password = await readFile(
    join(
      qa,
      "catalog-page-auth",
      String(before.data.current_generation),
      "password",
    ),
    "utf8",
  );
  assert.equal(
    (
      await api.post("/api/admin/login", {
        data: { email: "catalog-qa@example.invalid", password },
      })
    ).status(),
    200,
  );
  const sourceBefore = await currentSource(input.releaseWorktree);
  assert.equal(sourceBefore.revision, input.releaseRevision);
  assert.equal(sourceBefore.webBuild, local.webBuild);
  browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    env: { ...process.env, TMPDIR: socket },
  });
  await publishDirectory(
    join(qa, "campaign-evidence-delivery"),
    async (directory) => {
      const evidencePath = "journey/campaign-selected-evidence";
      const evidenceDir = join(directory, evidencePath);
      await mkdir(evidenceDir, { recursive: true });
      const preview = await browser.newPage({
        storageState: await api.storageState(),
        viewport: { width: 1206, height: 954 },
      });
      const document = await preview.goto(route, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(document.status(), 200);
      assert.equal(document.headers()["x-ui-source-revision"], local.webBuild);
      const html = await document.body();
      await writeFile(join(directory, "campaign.html"), html);
      const cell = preview.getByTestId(
        `matrix-cell-${pair.airfoilSlug}-${pair.conditionOrd}`,
      );
      await cell.click();
      const drawer = preview.getByTestId("cell-side-panel");
      const observed = [];
      for (const stage of ["fast", "final"]) {
        const id = pair[stage + "AttemptId"];
        const evidenceUrl =
          origin +
          "/api/admin/point-history/" +
          pair.resultId +
          "/sim?resultAttemptId=" +
          id;
        const received = preview.waitForResponse(
          (r) => r.url() === evidenceUrl && r.status() === 200,
        );
        const trigger = drawer.getByTestId(
          `cell-preliminary-${stage}-${pair.aoaDeg}`,
        );
        await trigger.click();
        const data = await (await received).json();
        assert.equal(data.resultId, pair.resultId);
        assert.equal(data.resultAttemptId, id);
        const modal = preview.getByTestId("sim-modal-dialog");
        await expect(modal.getByTestId("sim-fidelity-chip")).toHaveText(
          "URANS " + stage,
        );
        if (!data.renderTarget)
          await expect(
            modal.getByRole("button", { name: "custom render", exact: true }),
          ).toHaveCount(0);
        const screenshot = stage + "-selected.png";
        const png = await preview.screenshot({
          path: join(evidenceDir, screenshot),
          animations: "disabled",
        });
        observed.push({
          stage,
          screenshot,
          screenshotSha256: sha(png),
          resultId: data.resultId,
          attemptId: data.resultAttemptId,
          cl: data.cl,
          cd: data.cd,
          cm: data.cm,
        });
        await preview.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      }
      assert.notEqual(observed[0].cl, observed[1].cl);
      const live = await browser.newPage({
        viewport: { width: 1206, height: 954 },
      });
      const login = await live.goto(external + core, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(login.status(), 200);
      assert.equal(login.headers()["x-ui-source-revision"], local.webBuild);
      await expect(
        live.getByRole("button", { name: "Continue with Google" }),
      ).toBeVisible();
      await live.screenshot({
        path: join(directory, "live-admin-signin.png"),
        animations: "disabled",
      });
      const denied = await live.request.get(
        external +
          "/api/admin/point-history/" +
          input.publicResultId +
          "/sim?resultAttemptId=" +
          input.publicAttemptId,
      );
      assert.equal(denied.status(), 401);
      const visit = await live.goto(
        external + "/airfoils/" + input.publicSlug,
        { waitUntil: "domcontentloaded" },
      );
      assert.equal(visit.status(), 200);
      assert.equal(visit.headers()["x-ui-source-revision"], local.webBuild);
      const viewer = live.getByTestId("progressive-polar-viewer");
      await viewer
        .getByLabel("Polar condition")
        .selectOption(input.publicTargetId);
      await viewer
        .locator("summary")
        .filter({ hasText: "Why this curve" })
        .click();
      const publicRecord = viewer
        .locator(
          `button[data-result-id="${input.publicResultId}"][data-result-attempt-id="${input.publicAttemptId}"]`,
        )
        .first();
      const payload = live.waitForResponse((r) => {
        const url = new URL(r.url());
        return (
          url.pathname === "/api/airfoils/" + input.publicSlug + "/sim" &&
          url.searchParams.get("resultId") === input.publicResultId &&
          url.searchParams.get("resultAttemptId") === input.publicAttemptId &&
          r.status() === 200
        );
      });
      await publicRecord.click();
      const actual = await (await payload).json();
      assert.equal(actual.resultAttemptId, input.publicAttemptId);
      assert.equal(actual.history.t.length, input.sampleCount);
      await expect(live.getByTestId("sim-modal-dialog")).toBeVisible();
      const coefficients = live.getByTestId(
        actual.observation ? "sim-attempt-evidence" : "sim-accent-stats",
      );
      await expect(coefficients).toBeVisible();
      if (actual.observation) {
        await expect(coefficients).toContainText(actual.cl.toFixed(4));
        await expect(coefficients).toContainText(actual.cd.toFixed(5));
      }
      await live.screenshot({
        path: join(directory, "live-selected-solver-result.png"),
        animations: "disabled",
      });
      await writeJson(join(evidenceDir, "downstream.json"), {
        source_sha256: local.sourceSha256,
        fixture: {
          deployment: before.data.deployment_id,
          generation: before.data.current_generation,
          observed,
        },
        vps: {
          campaign: core,
          authentication: "Google sign-in",
          anonymousPointStatus: denied.status(),
          slug: input.publicSlug,
          resultId: actual.resultId,
          attemptId: actual.resultAttemptId,
          cl: actual.cl,
          cd: actual.cd,
          cm: actual.cm,
          samples: actual.history.t.length,
        },
        checkedAt: new Date().toISOString(),
        compiledWeb: local.webBuild,
        deployedRevision: input.releaseRevision,
      });
      await cp(input.liveRuntime, join(directory, "vps-deployment.json"));
      await cp(
        join(input.formalDirectory, "formal-receipt.json"),
        join(directory, "formal-receipt.json"),
      );
      await cp(
        join(input.formalDirectory, "formal-artifacts.json"),
        join(directory, "formal-artifacts.json"),
      );
      await writeFile(join(directory, "manual-review.json"), manualBytes);
      await cp(input.designReceipt, join(directory, "product-design.json"));
      await writeJson(join(directory, "source.json"), {
        local,
        release: sourceBefore,
      });
      await writeJson(join(directory, "delivery.json"), {
        version: 1,
        kind: "web-deployment",
        target,
        source_sha256: local.sourceSha256,
        file: "campaign.html",
        observed_sha256: sha(html),
        checked_at_ms: Date.now(),
        access: route,
        observation: "web_route_passed",
        deployment: {
          deployment_id: before.data.deployment_id,
          generation_number: before.data.current_generation,
          http_status: 200,
          content_type: document.headers()["content-type"],
        },
      });
      await writeJson(join(directory, "completion.json"), {
        schema_version: 1,
        claim: "preliminary",
        source_sha256: local.sourceSha256,
        capabilities: [
          {
            id: "open-exact-campaign-stage",
            scope: "product",
            state: "real_e2e",
            enabled_control: true,
            expected_result:
              "The authenticated campaign preview reads the chosen fast or final attempt. The public VPS reads an exact stored production history and enforces Google authentication on the administration route.",
            evidence_refs: [
              evidencePath + "/downstream.json",
              "formal-receipt.json",
              "manual-review.json",
              "product-design.json",
              "vps-deployment.json",
              "live-selected-solver-result.png",
            ],
            rendered_evidence_refs: [
              evidencePath + "/downstream.json",
              evidencePath + "/fast-selected.png",
              evidencePath + "/final-selected.png",
              "live-selected-solver-result.png",
            ],
          },
        ],
      });
      await preview.close();
      await live.close();
      const after = progressivePreviewDeployment({
        name: "campaign-stage-preview",
      });
      assert.equal(
        after.data.current_generation,
        before.data.current_generation,
      );
      assert.equal(after.data.deployment_id, before.data.deployment_id);
      assert.deepEqual(await currentSource(), local);
    },
  );
} finally {
  await browser?.close();
  await api.dispose();
  await rm(socket, { recursive: true, force: true });
}
