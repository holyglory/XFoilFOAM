import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import {
  progressivePreviewDeployment,
  originFromDeployment,
} from "./progressive-preview-origin.mjs";

const deployment = progressivePreviewDeployment({ name: "catalog-paging" });
const origin = originFromDeployment(deployment);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const root = fileURLToPath(new URL("../../", import.meta.url));
const browser = await chromium.launch({ headless: true });
const proof = {};
const params = {
  sort: "ldmax",
  dir: "desc",
  includeSubcategories: "true",
  includeTotal: "true",
};
async function query(page, values) {
  const result = await page.request.get(
    origin + "/api/airfoils?" + new URLSearchParams({ ...params, ...values }),
  );
  assert.equal(result.status(), 200);
  return result.json();
}
const rows = (page) => page.locator('[data-testid^="airfoil-row-"]');
async function renderedTextContrast(page, locator) {
  const png = (await locator.screenshot({ animations: "disabled" })).toString(
    "base64",
  );
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      colors.set(rgb, (colors.get(rgb) ?? 0) + 1);
    }
    // These spans contain only count text. The most frequent pixel is the
    // actual composited page background, including the shell's gradient.
    const background = [...colors].sort((a, b) => b[1] - a[1])[0][0];
    const luminance = (rgb) =>
      [16, 8, 0]
        .map((shift) => {
          const channel = ((rgb >> shift) & 255) / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bg = luminance(background);
    return Math.max(
      ...[...colors.keys()].map((color) => {
        const ink = luminance(color);
        return (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05);
      }),
    );
  }, png);
}
async function waitRows(page, expected) {
  await expect(rows(page)).toHaveCount(expected.length);
  assert.deepEqual(
    await rows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.testid),
    ),
    expected.map((item) => "airfoil-row-" + item.slug),
  );
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/airfoils")
      requests.push(Object.fromEntries(url.searchParams));
  });
  const first = await query(page, { limit: "40" });
  assert.equal(
    (await (await page.request.get(origin + "/api/admin/me")).json()).authed,
    false,
  );
  const expanded = await query(page, { limit: "340" });
  assert(first.total > 340 && first.rankingId === expanded.rankingId);
  const document = await page.goto(origin, { waitUntil: "domcontentloaded" });
  assert.equal(document.status(), 200);
  assert.equal(
    document.headers()["x-ui-source-revision"],
    webSourceIdentity(root),
  );
  await expect(
    page.locator("[data-testid=browse-surface][data-hydrated=true]"),
  ).toBeVisible();
  await waitRows(page, first.items);
  const html = await document.text();
  assert(
    !html.includes(expanded.items[40].id),
    "An unloaded profile was serialized into the initial document",
  );
  proof.firstPage = {
    total: first.total,
    rendered: first.items.length,
    documentBytes: Buffer.byteLength(html),
  };
  const identity = await page.request.get(origin + "/", {
    headers: { accept: "text/html", "accept-encoding": "identity" },
  });
  const compressed = await page.request.get(origin + "/", {
    headers: { accept: "text/html", "accept-encoding": "gzip" },
  });
  assert.equal(identity.status(), 200);
  assert.equal(compressed.status(), 200);
  const etag = identity.headers().etag;
  assert.match(etag, /^W\/"[a-f0-9]{64}"$/);
  assert.equal(compressed.headers().etag, etag);
  assert.equal(compressed.headers()["content-encoding"], "gzip");
  assert.deepEqual(await compressed.body(), await identity.body());
  const conditional = await page.request.get(origin + "/", {
    headers: { accept: "text/html", "if-none-match": etag },
  });
  assert.equal(conditional.status(), 304);
  const flight = await page.request.get(origin + "/", {
    headers: { rsc: "1" },
  });
  assert.match(flight.headers()["content-type"], /text\/x-component/);
  proof.document = {
    cached: true,
    representationsMatch: true,
    conditionalStatus: 304,
    flight: true,
  };
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await waitRows(page, expanded.items);
  await expect(
    page.getByText("showing 340 of " + first.total, { exact: true }),
  ).toBeVisible();
  assert.equal(
    requests.length,
    1,
    "The browser refetched the SSR page or sent overlapping page requests",
  );
  assert.equal(requests[0].offset, "40");
  assert.equal(requests[0].limit, "300");
  proof.expansion = { rendered: 340, firstOffset: requests[0].offset };

  const byName = await query(page, { sort: "name", dir: "asc", limit: "40" });
  const inFirst = new Set(byName.items.map((item) => item.id));
  const retained = expanded.items
    .slice(40)
    .find((item) => !inFirst.has(item.id));
  assert(
    retained,
    "The real catalog must include a preview outside the reordered page",
  );
  await page.getByTestId("airfoil-row-" + retained.slug).hover();
  await expect(page.locator(".browse-preview")).toContainText(
    retained.name.trim(),
  );
  await page.getByRole("button", { name: /^NAME(?: [↑↓])?$/i }).click();
  await waitRows(page, byName.items);
  await expect(page.locator(".browse-preview")).toContainText(
    retained.name.trim(),
  );

  let start, unblock;
  const held = new Promise((resolve) => {
    start = resolve;
  });
  const allow = new Promise((resolve) => {
    unblock = resolve;
  });
  await page.route("**/api/airfoils?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("offset") !== "40") return route.continue();
    start();
    await allow;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await held;
    const filtered = await query(page, {
      sort: "name",
      dir: "asc",
      q: "AG24",
      limit: "40",
    });
    assert(filtered.items.some((item) => item.slug === "ag24"));
    await page.getByTestId("airfoil-name-filter").fill("AG24");
    await waitRows(page, filtered.items);
    unblock();
    await page.unroute("**/api/airfoils?**");
    const conditions = await (
      await page.request.get(origin + "/api/polar-conditions")
    ).json();
    assert(
      conditions.items.length >= 2,
      "The real NeuralFoil fixture must supply available conditions",
    );
    const condition = conditions.items[1].key;
    const match = await query(page, {
      q: "AG24",
      sort: "name",
      dir: "asc",
      metricConditionKey: condition,
      limit: "40",
    });
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).searchParams.get("metricConditionKey") === condition &&
        new URL(r.url()).pathname === "/api/airfoils",
    );
    await page
      .getByLabel("Metrics for", { exact: true })
      .selectOption(condition);
    await response;
    await waitRows(page, match.items);
    proof.countContrast = {};
    for (const theme of ["dark", "light"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Switch to " + theme + " theme" })
          .click();
      for (const id of ["catalog-profile-count", "catalog-visible-count"]) {
        const contrast = await renderedTextContrast(page, page.getByTestId(id));
        assert(
          contrast >= 4.5,
          id + " contrast in " + theme + " was " + contrast.toFixed(2),
        );
        proof.countContrast[theme + "/" + id] = contrast;
      }
    }
    await expect(page).toHaveURL(new RegExp("condition=" + condition));
    const direct = await query(page, {
      metricConditionKey: condition,
      limit: "40",
    });
    const selectedDocument = await page.reload({
      waitUntil: "domcontentloaded",
    });
    assert.equal(selectedDocument.status(), 200);
    await expect(page.getByLabel("Metrics for", { exact: true })).toHaveValue(
      condition,
    );
    await waitRows(page, direct.items);
    proof.filtered = {
      rows: match.items.length,
      condition: true,
      staleAppendIgnored: true,
      retainedPreview: true,
      selectedConditionReload: true,
    };
  } finally {
    unblock();
  }

  const password = await readFile(
    root +
      "/.codex-artifacts/catalog-page-auth/" +
      deployment.data.current_generation +
      "/password",
    "utf8",
  );
  const login = await page.request.post(origin + "/api/admin/login", {
    data: { email: "catalog-qa@example.invalid", password },
  });
  assert.equal(login.status(), 200);
  assert.equal(
    (await (await page.request.get(origin + "/api/admin/me")).json()).authed,
    true,
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await waitRows(page, first.items);
  await page.getByTestId("airfoil-row-" + first.items[0].slug).hover();
  await page.getByTestId("select-airfoil-" + first.items[0].slug).click();
  const membership = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get("keysOnly") === "true",
  );
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await membership;
  await expect(
    page.getByText(first.total + " selected", { exact: true }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(40);
  await page.getByRole("button", { name: "Select none", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select none", exact: true }),
  ).toHaveCount(0);
  proof.selection = { allMatching: first.total, rendered: 40, cleared: true };
  assert.deepEqual(errors, []);
  await mkdir(".codex-artifacts/catalog-page-journey", { recursive: true });
  await writeFile(
    ".codex-artifacts/catalog-page-journey/report.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} finally {
  await browser.close();
}
