import { isEngineIdentity, type EngineIdentity } from "@aerodb/engine-client";

export interface ProgressiveRemoteCapabilities {
  localTimeStepVersion?: number | null;
  version: 1;
  solverBudgetVersion: 2;
  meshRecoveryVersion: number;
  uransRecoveryVersion: number | null;
  engine: EngineIdentity;
  executionPools: string[];
}

export function parseProgressiveRemoteCapabilities(
  value: unknown,
): ProgressiveRemoteCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    raw.solverBudgetVersion !== 2 ||
    (raw.localTimeStepVersion != null &&
      (!Number.isSafeInteger(raw.localTimeStepVersion) ||
        Number(raw.localTimeStepVersion) < 0)) ||
    !Number.isSafeInteger(raw.meshRecoveryVersion) ||
    Number(raw.meshRecoveryVersion) < 0 ||
    !(
      raw.uransRecoveryVersion === null ||
      (Number.isSafeInteger(raw.uransRecoveryVersion) &&
        Number(raw.uransRecoveryVersion) >= 0)
    ) ||
    !isEngineIdentity(raw.engine) ||
    !Array.isArray(raw.executionPools) ||
    raw.executionPools.length < 1 ||
    raw.executionPools.length > 16 ||
    raw.executionPools.some(
      (pool) => typeof pool !== "string" || !pool.trim() || pool.length > 128,
    ) ||
    new Set(raw.executionPools).size !== raw.executionPools.length
  )
    return null;
  return {
    version: 1,
    solverBudgetVersion: 2,
    ...(raw.localTimeStepVersion != null
      ? { localTimeStepVersion: Number(raw.localTimeStepVersion) }
      : {}),
    meshRecoveryVersion: Number(raw.meshRecoveryVersion),
    uransRecoveryVersion: raw.uransRecoveryVersion as number | null,
    engine: { ...raw.engine },
    executionPools: [...raw.executionPools] as string[],
  };
}

export function observedProgressiveRemoteCapabilities(
  metadata: unknown,
  checkedAt: Date,
) {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("progressiveExecutionObservedAt" in metadata) ||
    typeof metadata.progressiveExecutionObservedAt !== "string" ||
    !("progressiveExecution" in metadata)
  )
    return null;
  const age =
    checkedAt.getTime() - Date.parse(metadata.progressiveExecutionObservedAt);
  if (!Number.isFinite(age) || age < -30_000 || age >= 60_000) return null;
  return parseProgressiveRemoteCapabilities(metadata.progressiveExecution);
}
