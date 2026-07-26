import { z } from "zod";

const finiteNonNegative = z.number().finite().min(0);
const byteCount = z.number().int().nonnegative();

export const remoteSolverHealthSchema = z.object({
  schemaVersion: z.literal(1),
  sampledAt: z.string().datetime(),
  cpu: z.object({
    load1: finiteNonNegative,
    load5: finiteNonNegative,
    load15: finiteNonNegative,
    availableCpus: z.number().int().positive(),
    loadPct: finiteNonNegative,
  }),
  memory: z.object({
    totalBytes: byteCount,
    freeBytes: byteCount,
    usedBytes: byteCount,
    usedPct: finiteNonNegative,
  }),
  storage: z
    .object({
      usedPct: finiteNonNegative.nullable(),
      freeBytes: byteCount.nullable(),
      requiredFreeBytes: byteCount.nullable(),
      admissionBlocked: z.boolean(),
      reason: z.string().nullable(),
      checkedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  execution: z.object({
    activeJobs: z.number().int().nonnegative(),
    reservedCpuSlots: z.number().int().nonnegative(),
    capacityCpuSlots: z.number().int().nonnegative(),
    activeAoaCount: z.number().int().nonnegative(),
  }),
});

export type RemoteSolverHealth = z.infer<typeof remoteSolverHealthSchema>;

export function parseRemoteSolverHealth(
  metadata: Record<string, unknown> | null | undefined,
): RemoteSolverHealth | null {
  const parsed = remoteSolverHealthSchema.safeParse(metadata?.health);
  return parsed.success ? parsed.data : null;
}
