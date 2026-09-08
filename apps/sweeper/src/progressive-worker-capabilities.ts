import type { DB } from "@aerodb/db";
import { canonicalAnalysisJson } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import {
  isEngineIdentity,
  isEngineCapabilityDescriptor,
} from "@aerodb/engine-client";
import {
  parseProgressiveRemoteCapabilities,
  type ProgressiveRemoteCapabilities,
} from "./progressive-remote-admission";

interface Observation {
  checkedAt: number;
  sampledAt: string;
  capabilities: ProgressiveRemoteCapabilities | null;
}

const observations = new WeakMap<DB, Observation>();
const pending = new WeakMap<DB, Promise<void>>();

export function progressiveWorkerCapabilityMetadata(
  db: DB,
  now = performance.now(),
) {
  const observation = observations.get(db);
  const fresh =
    observation &&
    now >= observation.checkedAt &&
    now - observation.checkedAt < 60000;
  return {
    progressiveExecution: fresh ? observation.capabilities : null,
    progressiveExecutionObservedAt: fresh ? observation.sampledAt : null,
  };
}

export async function refreshProgressiveWorkerCapabilities(
  db: DB,
  engine: EngineClient,
): Promise<void> {
  const previous = observations.get(db);
  if (previous && performance.now() - previous.checkedAt < 30000) return;
  const running = pending.get(db);
  if (running) return running;
  const refresh = async () => {
    const checkedAt = performance.now();
    const sampledAt = new Date().toISOString();
    let capabilities: ProgressiveRemoteCapabilities | null = null;
    try {
      const [health, inventory] = await Promise.all([
        engine.healthDetails({ timeoutMs: 5000 }),
        engine.capabilities({ timeoutMs: 5000 }),
      ]);
      const identity = inventory.default_engine;
      if (
        health.status === "ok" &&
        health.solver_budget_version === 2 &&
        inventory.solver_budget_version === 2 &&
        isEngineIdentity(identity) &&
        health.supported_engines?.some(
          (supported) =>
            canonicalAnalysisJson(supported) ===
            canonicalAnalysisJson(identity),
        )
      ) {
        const routes =
          inventory.engines?.filter(
            (route) =>
              isEngineCapabilityDescriptor(route) &&
              canonicalAnalysisJson(route.engine) ===
                canonicalAnalysisJson(identity) &&
              route.steady &&
              route.mesh_evidence,
          ) ?? [];
        capabilities = parseProgressiveRemoteCapabilities({
          version: 1,
          solverBudgetVersion: 2,
          meshRecoveryVersion: health.mesh_recovery_version,
          uransRecoveryVersion: routes.every((route) => route.transient)
            ? (health.urans_recovery_version ?? null)
            : null,
          engine: identity,
          executionPools: routes.map((route) => route.routing_key),
        });
      }
    } catch {
      capabilities = null;
    }
    observations.set(db, { checkedAt, sampledAt, capabilities });
  };
  const operation = refresh();
  pending.set(db, operation);
  try {
    await operation;
  } finally {
    if (pending.get(db) === operation) pending.delete(db);
  }
}
