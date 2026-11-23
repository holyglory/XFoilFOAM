// The governed entry point is external-only. The exported browser observation
// is also exercised against a real loopback deployment without issuing a VPS receipt.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium, expect } from "@playwright/test";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import { artifactRoot, httpRecord, inputsPath, publicRoute, publishDirectory, root, sha, verifyRepresentations, writeJson }
  from "./verify-catalog-web-delivery.mjs";

export async function captureCatalogRender(url, expectedBuild, directory) {
  const origin = new URL(url).origin;
  assert(url === publicRoute || /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url));
  const sockets = await mkdtemp("/tmp/catalog-render-");
  let browser;
  try {
    browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true,
      env: { ...process.env, TMPDIR: sockets } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const req = route.request();
      const allowed = new URL(req.url()).origin === origin && ["GET", "HEAD"].includes(req.method()) &&
        (!req.isNavigationRequest() || req.url() === url);
      return allowed ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const started = performance.now();
    const response = await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45_000});
    assert(response && response.url() === url && !response.request().redirectedFrom(), "unexpected final catalog route");
    const headers = response.headers(), httpStatus = response.status(), contentType = headers["content-type"];
    assert.equal(httpStatus, 200);
    assert.equal(contentType?.split(";")[0].trim().toLowerCase(), "text/html");
    assert.equal(headers["x-ui-source-revision"], expectedBuild, "browser observed the wrong compiled catalog");
    const ranking = page.locator('[data-testid="browse-surface"][data-hydrated="true"]');
    await expect(ranking).toBeVisible({timeout: 30_000});
    const rows = ranking.locator('[data-testid^="airfoil-row-"]');
    await expect(rows.first()).toBeVisible();
    const hydratedMs = performance.now() - started;
    await page.waitForFunction(() => performance.getEntriesByType("navigation")[0]?.loadEventEnd > 0);
    const navigation = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { ttfbMs: n.responseStart - n.startTime, domContentLoadedMs: n.domContentLoadedEventEnd - n.startTime,
        fullLoadMs: n.loadEventEnd - n.startTime };
    });
    assert(navigation.fullLoadMs >= navigation.domContentLoadedMs && navigation.ttfbMs >= 0);
    const renderedEvidence = [];
    async function capture(state, actionStart) {
      assert.equal(page.url(), url);
      const visibleCount = await page.getByTestId("catalog-visible-count").innerText();
      const renderedRows = await rows.count();
      assert(visibleCount.startsWith("showing " + renderedRows + " of "), "count disagrees with rendered rows");
      const catalogCount = await page.getByTestId("catalog-profile-count").innerText();
      const rowsInViewport = await rows.evaluateAll((list) => list.filter((el) => {
        const r = el.getBoundingClientRect();
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        return bottom > top && el.contains(document.elementFromPoint(r.left + r.width / 2, (top + bottom) / 2));
      }).length);
      const file = state + ".png";
      const png = await page.screenshot({ animations: "disabled" });
      assert.equal(page.url(), url);
      await writeFile(join(directory, file), png, { mode: 0o600 });
      renderedEvidence.push({ file, sha256: sha(png), url: page.url(), path: new URL(page.url()).pathname, uiBuild: headers["x-ui-source-revision"],
        capturedAt: new Date().toISOString(), httpStatus, contentType, state, catalogCount, visibleCount,
        renderedRows, rowsInViewport, viewport: page.viewportSize(), actionMs: performance.now() - actionStart });
    }
    await capture("catalog", started);
    const filterStart = performance.now();
    const [filtered] = await Promise.all([page.waitForResponse((r) => {
      const u = new URL(r.url());
      return u.origin === origin && u.pathname === "/api/airfoils" && u.searchParams.get("q") === "AG24" &&
        r.request().method() === "GET";
    }), ranking.getByTestId("airfoil-name-filter").fill("AG24")]);
    assert.equal(filtered.status(), 200);
    const {items, total} = await filtered.json();
    await expect(page.getByTestId("catalog-visible-count")).toHaveText("showing " + items.length + " of " + total);
    await expect(rows).toHaveCount(items.length);
    assert.deepEqual(await rows.evaluateAll((list) => list.map(el => el.getAttribute("data-testid"))),
      items.map(item => "airfoil-row-" + item.slug));
    await capture("catalog-ag24", filterStart);
    return { browser: browser.version(), navigation: { ...navigation, hydratedMs }, renderedEvidence };
  } finally {
    try { await browser?.close(); } finally { await rm(sockets, {recursive: true, force: true}); }
  }
}

async function main() {
  const governedRunId = process.env.DEVCOORDINATOR_RUN_ID;
  assert.match(governedRunId ?? "", /^t[0-9]{8}T[0-9]{6}Z-[a-z0-9]+$/, "use the governed external-render check");
  assert.equal(process.env.DEVCOORDINATOR_CHECK_NAME, "external-render");
  const input = JSON.parse(await readFile(inputsPath));
  const httpDir = resolve(dirname(inputsPath), input.vpsHttpDirectory);
  const capture = JSON.parse(await readFile(join(httpDir, "capture.json")));
  const httpBytes = await readFile(join(httpDir, httpRecord));
  const local = JSON.parse(await readFile(join(artifactRoot, "local/reviews.json")));
  for (const key of ["formalRunId", "candidateId", "sourceSha256", "artifactManifestSha256", "manualReceiptId", "productDesignReceiptId"])
    assert.equal(capture[key], local[key], "VPS capture differs from the completed local review at " + key);
  assert.equal(capture.liveRoute, publicRoute);
  assert.equal(capture.httpArtifactSha256, sha(httpBytes));
  const build = webSourceIdentity(root);
  assert.equal(capture.uiBuild, build, "post-deployment HTTP capture is required for this build");
  const receipt = JSON.parse(httpBytes);
  const [identity, gzip] = await Promise.all(["catalog.html", "catalog.html.gz"].map(f => readFile(join(httpDir, f))));
  const observed = verifyRepresentations(publicRoute, build,
    {bytes: identity, evidence: receipt.identity}, {bytes: gzip, evidence: receipt.gzip});
  assert.equal(observed.htmlSha256, capture.htmlSha256);
  assert.equal(observed.gzipSha256, capture.gzipSha256);
  await publishDirectory(join(artifactRoot, "vps-render"), async (dir) => {
    const result = await captureCatalogRender(publicRoute, build, dir);
    await writeJson(join(dir, "rendered-evidence.json"), { ...result, governedRunId, governedCheck: "external-render", httpArtifactSha256: capture.httpArtifactSha256,
      formalRunId: capture.formalRunId, productDesignReceiptId: capture.productDesignReceiptId });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
