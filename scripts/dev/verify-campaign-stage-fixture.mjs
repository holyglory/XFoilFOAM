import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "@playwright/test";
import { originFromDeployment, progressivePreviewDeployment } from "./progressive-preview-origin.mjs";

const deployment = progressivePreviewDeployment({ name: "campaign-stage-preview" });
const origin = originFromDeployment(deployment);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const generation = deployment.data.current_generation;
const path = `.codex-artifacts/campaign-stage-preview/${generation}/fixture.json`;
const pair = JSON.parse(await readFile(path, "utf8"));
const api = await request.newContext({ baseURL: origin });
try {
  const campaign = `/api/admin/campaigns/${pair.campaignId}`;
  const exact = `/api/admin/point-history/${pair.resultId}/sim?resultAttemptId=`;
  assert.equal((await api.get(exact + pair.fastAttemptId)).status(), 401);
  const url = `/admin?campaign=${pair.campaignId}`;
  const anonShell = await api.get(url, { headers: { accept: "text/html" } });
  assert.equal(anonShell.status(), 200);
  const html = await anonShell.text();
  assert(!html.includes(pair.fastAttemptId) && !html.includes("catalog-qa@example.invalid"));
  const password = await readFile(`.codex-artifacts/catalog-page-auth/${generation}/password`, "utf8");
  assert.equal((await api.post("/api/admin/login", { data: { email: "catalog-qa@example.invalid", password } })).status(), 200);
  const authenticatedShell = await api.get(url, { headers: { accept: "text/html" } });
  assert.equal(authenticatedShell.status(), 200);
  assert.equal(await authenticatedShell.text(), html);
  assert.match(authenticatedShell.headers()["cache-control"], /no-store/);
  async function get(route) {
    const res = await api.get(route);
    assert.equal(res.status(), 200, route);
    return res.json();
  }
  const { conditions } = await get(campaign);
  const { items: rows } = await get(`${campaign}/airfoils?q=${encodeURIComponent(pair.airfoilSlug)}`);
  const condition = conditions.find(row => row.ord === pair.conditionOrd);
  const row = rows.find(row => row.slug === pair.airfoilSlug);
  assert(condition && row);
  const { items } = await get(`${campaign}/preliminary-outcomes?conditionId=${condition.id}&airfoilId=${row.airfoilId}`);
  assert.equal(items.length, 1);
  const [point] = items;
  assert.equal(point.aoaDeg, pair.aoaDeg);
  assert.notEqual(pair.fastAttemptId, pair.finalAttemptId);
  for (const [stage, fidelity, cl, cd, cm] of [
    ["fast", "urans_precalc", 0.44, 0.017, -0.02], ["final", "urans_full", 0.45, 0.018, -0.021],
  ]) {
    assert.equal(point[stage+"State"], "accepted");
    assert.equal(point[stage+"ResultId"], pair.resultId);
    const id = pair[stage+"AttemptId"];
    assert.equal(point[stage+"ResultAttemptId"], id);
    const sim = await get(exact + id);
    assert.deepEqual([sim.resultId, sim.alpha, sim.fidelity, sim.cl, sim.cd, sim.cm],
      [pair.resultId, pair.aoaDeg, fidelity, cl, cd, cm]);
    assert.equal(sim.resultAttemptId, id);
    assert.equal(sim.numericalConvergence, true);
    assert.equal(sim.uransFlowOutcome, null);
    console.log(JSON.stringify({ stage, route: exact + id, status: 200, resultId: sim.resultId,
      responseAttemptId: sim.resultAttemptId, fidelity: sim.fidelity, cl: sim.cl, cd: sim.cd, cm: sim.cm }));
  }
  assert.equal((await api.get(exact + pair.campaignId)).status(), 404);
} finally {
  await api.dispose();
}
