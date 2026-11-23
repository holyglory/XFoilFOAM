import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, request } from "@playwright/test";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import {
  originFromDeployment,
  progressivePreviewDeployment,
} from "./progressive-preview-origin.mjs";

const name = "campaign-stage-preview";
const before = progressivePreviewDeployment({ name });
const origin = originFromDeployment(before);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const generation = String(before.data.current_generation);
const root = process.cwd();
const pageSource = webSourceIdentity(root);
const qa = join(root, ".codex-artifacts");
const pair = JSON.parse(
  await readFile(join(qa, name, generation, "fixture.json"), "utf8"),
);
const storage = join(qa, "campaign-attempt-audit");
await mkdir(storage, { recursive: true });
const socketDir = await mkdtemp("/tmp/campaign-attempt-audit-");
const api = await request.newContext({ baseURL: origin });
const images = [];
let browser;

async function capture(page, step, subject, data = {}) {
  await expect(subject).toBeVisible();
  const file = String(images.length + 1).padStart(2, "0") + "-" + step + ".png";
  const bytes = await page.screenshot({
    path: join(storage, file),
    animations: "disabled",
  });
  images.push({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    at: new Date().toISOString(),
    viewport: page.viewportSize(),
    theme: await page.locator("html").getAttribute("data-theme"),
    subject: await subject.ariaSnapshot(),
    ...data,
  });
}
async function openCampaign(page) {
  const response = await page.goto(
    origin + "/admin?campaign=" + pair.campaignId,
    { waitUntil: "domcontentloaded" },
  );
  assert.equal(response?.status(), 200);
  assert.equal(response.headers()["x-ui-source-revision"], pageSource);
  await expect(page.getByTestId("campaign-detail")).toBeVisible();
  return page.getByTestId(
    `matrix-cell-${pair.airfoilSlug}-${pair.conditionOrd}`,
  );
}
try {
  const password = await readFile(
    join(qa, "catalog-page-auth", generation, "password"),
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
  browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    env: { ...process.env, TMPDIR: socketDir },
  });
  const session = await api.storageState();
  const page = await browser.newPage({
    viewport: { width: 1296, height: 1180 },
    storageState: session,
  });
  const cell = await openCampaign(page);
  await expect(cell).toHaveCount(1);
  await capture(
    page,
    "campaign-overview",
    page.getByTestId("campaign-completion-sources"),
  );
  await cell.click();
  const drawer = page.getByTestId("cell-side-panel");
  await expect(drawer.getByText("stage evidence available")).toBeVisible();
  await capture(
    page,
    "recorded-point",
    drawer.getByTestId("cell-preliminary-outcomes"),
  );
  for (const stage of ["fast", "final"]) {
    const attempt = pair[stage + "AttemptId"];
    const url =
      origin +
      `/api/admin/point-history/${pair.resultId}/sim?resultAttemptId=${attempt}`;
    const loaded = page.waitForResponse(
      (event) => event.url() === url && event.status() === 200,
    );
    const open = drawer.getByTestId(`cell-preliminary-${stage}-${pair.aoaDeg}`);
    await open.click();
    const result = await (await loaded).json();
    assert.equal(result.resultAttemptId, attempt);
    assert.equal(result.resultId, pair.resultId);
    const modal = page.getByTestId("sim-modal-dialog");
    await expect(modal.getByTestId("sim-fidelity-chip")).toHaveText(
      "URANS " + stage,
    );
    await capture(
      page,
      stage + "-evidence",
      modal.getByTestId("sim-accent-stats"),
      {
        returnedAttempt: result.resultAttemptId,
        returnedResult: result.resultId,
        fidelity: result.fidelity,
        cl: result.cl,
        cd: result.cd,
        cm: result.cm,
        converged: result.numericalConvergence,
        flow: result.uransFlowOutcome,
      },
    );
    await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
  }
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    storageState: session,
  });
  const mobileCell = await openCampaign(mobile);
  await mobile.getByRole("button", { name: "Switch to light theme" }).click();
  await capture(
    mobile,
    "narrow-overview",
    mobile.getByTestId("campaign-completion-sources"),
  );
  await mobileCell.click();
  const mobileDrawer = mobile.getByTestId("cell-side-panel");
  await expect(
    mobileDrawer.getByText("stage evidence available"),
  ).toBeVisible();
  await capture(
    mobile,
    "narrow-recorded-point",
    mobileDrawer.getByTestId("cell-preliminary-outcomes"),
  );
  const after = progressivePreviewDeployment({ name });
  assert.equal(String(after.data.current_generation), generation);
  assert.equal(after.data.deployment_id, before.data.deployment_id);
  await writeFile(
    join(storage, "captures.json"),
    JSON.stringify({
      deployment: after.data.deployment_id,
      generation,
      source: pageSource,
      browser: browser.version(),
      images,
    }),
  );
  console.log(
    "Verified six authenticated campaign and selected-attempt captures.",
  );
} finally {
  await browser?.close();
  await api.dispose();
  await rm(socketDir, { recursive: true, force: true });
}
