import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import {
  originFromDeployment,
  progressivePreviewDeployment,
} from "./progressive-preview-origin.mjs";

const root = process.cwd();
const name = "catalog-paging";
const before = progressivePreviewDeployment({ name }).data;
const origin = originFromDeployment({ ok: true, data: before });
const source = webSourceIdentity(root);
const directory = join(root, ".codex-artifacts", "catalog-design-audit");
await mkdir(directory, { recursive: true });
// Chromium's process singleton uses an AF_UNIX path with a 108-byte limit.
const socketDirectory = await mkdtemp("/tmp/airfoil-catalog-audit-");
let browser;
const steps = [];

async function open(page, path) {
  const response = await page.goto(origin + path, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["x-ui-source-revision"], source);
  await expect(
    page.locator("[data-testid=browse-surface][data-hydrated=true]"),
  ).toBeVisible();
}
async function observe(control) {
  await expect(control).toHaveCount(1);
  await expect(control).toBeVisible();
  return control.ariaSnapshot();
}
async function capture(page, label, control) {
  const state = await observe(control);
  const file = String(steps.length + 1).padStart(2, "0") + "-" + label + ".png";
  const bytes = await page.screenshot({
    path: join(directory, file),
    animations: "disabled",
  });
  steps.push({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path: new URL(page.url()).pathname,
    viewport: page.viewportSize(),
    theme: await page.locator("html").getAttribute("data-theme"),
    state,
    capturedAt: new Date().toISOString(),
  });
}

try {
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    env: { ...process.env, TMPDIR: socketDirectory },
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await open(page, "/");
  const theme = page.getByRole("button", { name: "Switch to light theme" });
  await observe(theme);
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".browse-preview")).toContainText("NeuralFoil");
  const metrics = page.getByLabel("Metrics for", { exact: true });
  await capture(page, "available-rankings", metrics);
  const choice = await metrics
    .locator("option")
    .evaluateAll(
      (options) =>
        options.filter((o) => o.value && !o.disabled).map((o) => o.value)[0],
    );
  assert(choice);
  await observe(metrics);
  const selected = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/airfoils" &&
      new URL(r.url()).searchParams.get("metricConditionKey") === choice,
  );
  await metrics.selectOption(choice);
  assert.equal((await selected).status(), 200);
  await expect(page.getByTestId("catalog-visible-count")).toContainText(
    "showing 40",
  );
  await capture(page, "selected-condition", metrics);

  const search = page.getByTestId("airfoil-name-filter");
  await observe(search);
  await search.fill("AG24");
  await expect(page.getByTestId("catalog-visible-count")).toHaveText(
    "showing 1 of 1",
  );
  await expect(page.locator(".browse-preview")).toContainText("AG24");
  await expect(page.locator(".browse-preview")).toContainText("NeuralFoil");
  await capture(page, "filtered-matching-polar", search);

  await observe(search);
  await search.fill("");
  await expect(page.getByTestId("catalog-visible-count")).toContainText(
    "showing 40",
  );
  const more = page.getByRole("button", { name: "Load more", exact: true });
  await observe(more);
  await more.focus();
  await more.press("Enter");
  const firstNew = page.locator('[data-testid^="airfoil-row-"]').nth(40);
  await expect(firstNew).toBeFocused();
  await capture(page, "continued-ranking", firstNew);

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await open(mobile, "/?condition=" + encodeURIComponent(choice));
  const mobileSearch = mobile.getByTestId("airfoil-name-filter");
  await observe(mobileSearch);
  await mobileSearch.fill("AG24");
  await expect(mobile.getByTestId("catalog-visible-count")).toHaveText(
    "showing 1 of 1",
  );
  await expect(mobile.getByLabel("Metrics for", { exact: true })).toHaveValue(
    choice,
  );
  await capture(mobile, "mobile-filtered-condition", mobileSearch);
  const after = progressivePreviewDeployment({ name }).data;
  assert.equal(after.deployment_id, before.deployment_id);
  assert.equal(after.current_generation, before.current_generation);
  await writeFile(
    join(directory, "captures.json"),
    JSON.stringify({
      deployment: before.deployment_id,
      generation: before.current_generation,
      source,
      browser: browser.version(),
      steps,
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await rm(socketDirectory, { recursive: true, force: true });
  }
}
