export function effectiveMaxConcurrentJobs(
  configuredMax: number | null | undefined,
  cpuSlots: number | null | undefined,
  workerBudget = Number(process.env.AIRFOILFOAM_WORKER_CPU_BUDGET ?? 2),
): number {
  if (Number.isInteger(cpuSlots) && (cpuSlots ?? 0) > 0)
    return cpuSlots as number;
  if (Number.isInteger(configuredMax) && (configuredMax ?? 0) > 0)
    return configuredMax as number;
  return Number.isInteger(workerBudget) && workerBudget > 0 ? workerBudget : 2;
}
