import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const campaignId = "c24047fa-743f-4ae5-bcd6-f3071ff79fb4";
const cookieProducer = [
  'import { signSession } from "./apps/api/src/admin-auth.ts";',
  'process.stdout.write(signSession("coverage-audit@airfoils.pro", Number(process.env.MAINTENANCE_COOKIE_TTL_MS), "password"));',
].join(" ");
const cookie = execFileSync("ssh", ["airfoils.pro", "bash", "-s"], {
  input: `set -e\ndocker exec -e MAINTENANCE_COOKIE_TTL_MS=300000 -w /app app-node-api-1 pnpm exec tsx -e '${cookieProducer}'\n`,
  encoding: "utf8",
  timeout: 30000,
}).trim();
assert.match(cookie, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL: "https://airfoils.pro" });
  await context.addCookies([
    { name: "aero_admin", value: cookie, domain: "airfoils.pro", path: "/", secure: true },
  ]);
  const request = context.request;
  const summaryResponse = await request.get(`/api/admin/campaigns/${campaignId}`);
  assert.equal(summaryResponse.status(), 200);
  const summary = await summaryResponse.json();
  const [healthResponse, syncResponse] = await Promise.all([
    request.get("/api/admin/health"),
    request.get("/api/admin/sync"),
  ]);
  assert.equal(healthResponse.status(), 200);
  assert.equal(syncResponse.status(), 200);
  const health = await healthResponse.json();
  const sync = await syncResponse.json();
  let cursor = null;
  const items = [];
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await request.get(
      `/api/admin/campaigns/${campaignId}/airfoils?${query.toString()}`,
    );
    assert.equal(response.status(), 200);
    const page = await response.json();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const missing = [];
  let conditions = 0;
  let preciseRequested = 0;
  let preciseComplete = 0;
  for (const item of items) {
    for (const cell of item.perCondition ?? []) {
      const progressive = cell.progressive ?? null;
      if (!progressive) continue;
      conditions += 1;
      preciseRequested += Number(progressive.requested ?? 0);
      preciseComplete += Number(progressive.preciseComplete ?? 0);
      if (Number(progressive.preciseComplete ?? 0) < Number(progressive.requested ?? 0)) {
        missing.push({
          profile: item.slug,
          conditionId: cell.conditionId,
          requested: Number(progressive.requested ?? 0),
          preciseComplete: Number(progressive.preciseComplete ?? 0),
          fastComplete: Number(progressive.fastComplete ?? 0),
          cfdEvidence: Number(progressive.cfdEvidence ?? 0),
        });
      }
    }
  }
  console.log(JSON.stringify({
    campaignId,
    profiles: items.length,
    expectedProfiles: Number(summary.airfoilCount ?? 0),
    progressiveCells: conditions,
    preciseRequested,
    preciseComplete,
    preciseRemaining: preciseRequested - preciseComplete,
    missingCells: missing.length,
    firstMissing: missing.slice(0, 20),
    campaignTotals: summary.totals,
    completionSources: summary.completionSources,
    fleet: {
      healthKeys: Object.keys(health).sort(),
      syncSettings: {
        remoteSolverEnabled: sync.settings?.remoteSolverEnabled ?? null,
        remoteSolverCpuBudget: sync.settings?.remoteSolverCpuBudget ?? null,
        remoteSolverLastStatus: sync.settings?.remoteSolverLastStatus ?? null,
        remoteSolverLastError: sync.settings?.remoteSolverLastError ?? null,
      },
      registeredSolvers: (sync.registeredSolvers ?? []).map((solver) => ({
        instanceName: solver.instanceName,
        cpuCapacity: solver.cpuCapacity,
        cpuBudget: solver.cpuBudget,
        maxActivePolarPromises: solver.maxActivePolarPromises,
        activePromiseCount: solver.activePromiseCount,
        status: solver.status,
        lastHeartbeatAt: solver.lastHeartbeatAt,
        activeAoaCount: solver.activeAoaCount,
        solvedCount: solver.solvedCount,
        pushedCount: solver.pushedCount,
        health: solver.health,
      })),
      performance: health.performance ?? null,
      fleet: health.fleet ?? null,
    },
  }));
  assert.equal(items.length, Number(summary.airfoilCount ?? items.length));
  assert(conditions > 0, "No progressive condition cells were returned");
} finally {
  await browser.close();
}
