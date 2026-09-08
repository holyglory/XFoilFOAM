import { randomUUID } from "node:crypto";
import {
  reconcileProgressiveGenerationRequest,
  initializeProgressiveCfdWork,
  advanceProgressiveCfdStages,
  recoverUnboundProgressiveCfdLeases,
  invalidateProgressiveFitPolicy,
  type DB,
  type Sql,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { runProgressiveBaselineBatch } from "./progressive-baselines";
import {
  PROGRESSIVE_FIT_POLICY_ID,
  runProgressiveFitBatch,
} from "./progressive-fitting";

export async function runProgressiveBaselineService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  engine: Pick<EngineClient, "predictNeuralFoil" | "fitProgressivePolar">,
  signal: AbortSignal,
  report: (receipt: Record<string, unknown>) => void = (receipt) =>
    console.log(JSON.stringify(receipt)),
): Promise<void> {
  const owner = `neuralfoil-${randomUUID()}`;
  let pending = true;
  let policyReconciled = false;
  let wake: (() => void) | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    pending = true;
    wake?.();
  };
  signal.addEventListener("abort", notify);
  let unlisten: (() => Promise<void>) | null = null;
  try {
    const subscription = await notifications.listen(
      "progressive_work_changed",
      notify,
      notify,
    );
    unlisten = () => subscription.unlisten();
    while (!signal.aborted) {
      if (!pending)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (pending || signal.aborted) resolve();
        });
      wake = null;
      pending = false;
      if (deadline) clearTimeout(deadline);
      deadline = null;
      if (signal.aborted) break;
      try {
        const [settings] = (await db.execute(sql`
          SELECT state.enabled, coalesce((SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1), false) AS remote
          FROM sweeper_state state WHERE state.id = 1
        `)) as unknown as Array<{ enabled: boolean; remote: boolean }>;
        if (settings?.remote) continue;
        const scope = await reconcileProgressiveGenerationRequest(db);
        if (scope) {
          pending = true;
          report({ component: "progressive-scope", ...scope });
        }
        const cfdUnits = await initializeProgressiveCfdWork(db);
        if (cfdUnits) {
          pending = true;
          report({ component: "progressive-cfd-scope", units: cfdUnits });
        }
        const recovery = await recoverUnboundProgressiveCfdLeases(db);
        if (recovery.retried || recovery.gaps) {
          pending = true;
          report({
            component: "progressive-cfd-unbound-recovery",
            ...recovery,
          });
        }
        if (!settings?.enabled || signal.aborted) continue;
        if (!policyReconciled) {
          const invalidated = await invalidateProgressiveFitPolicy(
            db,
            PROGRESSIVE_FIT_POLICY_ID,
          );
          policyReconciled = true;
          if (invalidated)
            report({ component: "progressive-fit-policy", invalidated });
        }
        const batch = await runProgressiveBaselineBatch(db, engine, owner, {
          requireSweeperEnabled: true,
        });
        if (batch.claimed) {
          pending = true;
          report({ component: "progressive-baseline", ...batch });
        }
        if (signal.aborted) break;
        const fitting = await runProgressiveFitBatch(db, engine, owner);
        if (fitting.claimed) {
          pending = true;
          report({ component: "progressive-fitting", ...fitting });
        }
        const stages = await advanceProgressiveCfdStages(db);
        if (stages.admitted || stages.closed || stages.campaignsCompleted) {
          pending = true;
          report({ component: "progressive-cfd-stages", ...stages });
        }
        if (!pending) {
          const [expiry] = (await db.execute(sql`
            SELECT min(expiry.at) AS at FROM (
            SELECT work.lease_until AS at FROM progressive_work work
            JOIN progressive_generations generation ON generation.id = work.generation_id
            JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
            JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
            WHERE work.stage = 1 AND work.state = 'leased' AND generation.stage = 1
              AND generation.status = 'active' AND campaign.status IN ('active', 'attention')
            UNION ALL SELECT fit.lease_until AS at FROM progressive_polar_fit_work fit
              JOIN neuralfoil_predictions prediction ON prediction.id = fit.prediction_id
              JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
              WHERE fit.state = 'leased'
            UNION ALL SELECT unit.lease_until AS at FROM progressive_cfd_units unit
              JOIN progressive_work work ON work.id = unit.work_id
              JOIN progressive_generations generation ON generation.id = work.generation_id
              JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
              JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
              JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
              WHERE unit.state = 'leased' AND attempt.outcome = 'running' AND attempt.sim_job_id IS NULL
                AND generation.status = 'active' AND generation.stage = work.stage AND work.state = 'pending'
                AND generation.plan_revision_id = campaign.current_plan_revision_id
                AND campaign.status IN ('active', 'attention', 'paused')
            ) expiry
          `)) as unknown as Array<{ at: Date | null }>;
          if (expiry?.at)
            deadline = setTimeout(
              notify,
              Math.max(0, new Date(expiry.at).getTime() - Date.now()),
            );
        }
      } catch (error) {
        report({ component: "progressive-baseline", error: String(error) });
      }
    }
  } finally {
    signal.removeEventListener("abort", notify);
    if (deadline) clearTimeout(deadline);
    await unlisten?.();
  }
}
