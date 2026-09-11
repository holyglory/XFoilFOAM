import type { DiskAdmissionConfig, LocalDiskJob } from "./disk-admission";

export const MAX_FORECAST_QUEUE_JOBS = 4096;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteList(value: unknown, positive: boolean): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.every(
      (entry) =>
        typeof entry === "number" &&
        Number.isFinite(entry) &&
        (!positive || entry > 0),
    )
  );
}

export function queuedJobReserve(
  job: LocalDiskJob,
  config: DiskAdmissionConfig,
): number | null {
  const request = object(object(job.requestPayload)?.engineRequest);
  const solver = object(request?.solver);
  const angles = object(request?.aoa)?.angles;
  if (
    !request ||
    !solver ||
    request.continue_from != null ||
    job.completedCases !== 0 ||
    !finiteList(angles, false) ||
    !finiteList(request.chord_lengths, true) ||
    !finiteList(request.speeds, true) ||
    new Set(angles).size !== angles.length ||
    !Number.isSafeInteger(job.totalCases) ||
    job.totalCases !==
      angles.length * request.chord_lengths.length * request.speeds.length ||
    typeof solver.force_transient !== "boolean" ||
    typeof solver.transient_fallback !== "boolean"
  )
    return null;
  let perCase: number | undefined;
  if (solver.transient_fallback) {
    perCase = config.fullCaseReserveBytes;
  } else if (solver.force_transient) {
    if (solver.urans_fidelity === "precalc")
      perCase = config.precalcCaseReserveBytes;
    else if (solver.urans_fidelity === "full")
      perCase = config.fullCaseReserveBytes;
    else return null;
  } else {
    perCase = config.ransCaseReserveBytes;
  }
  if (perCase === undefined) return null;
  const bytes = Math.ceil(job.totalCases * perCase);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Queued disk forecast exceeds finite storage bounds");
  return bytes;
}

export function queuedDiskExposure(
  jobs: readonly LocalDiskJob[],
  idleSlots: number,
  config: DiskAdmissionConfig,
) {
  if (
    !Number.isSafeInteger(idleSlots) ||
    idleSlots < 0 ||
    !Number.isSafeInteger(config.idleSlotReserveBytes) ||
    config.idleSlotReserveBytes <= 0
  )
    throw new Error(
      "Queued disk forecast requires finite storage and capacity bounds",
    );
  const fallback = {
    reservedBytes: idleSlots * config.idleSlotReserveBytes,
    queuedCpuSlots: 0,
  };
  if (jobs.length > MAX_FORECAST_QUEUE_JOBS) return fallback;
  if (
    jobs.some(
      (job) =>
        !Number.isSafeInteger(job.admissionCpuSlots) ||
        (job.admissionCpuSlots ?? 0) < 1,
    )
  )
    throw new Error("Queued disk forecast requires exact planned CPU slots");
  const requests = jobs
    .map((job) => {
      const slots = job.admissionCpuSlots!;
      const known = queuedJobReserve(job, config);
      const bytes =
        known ??
        Math.max(config.jobReserveBytes, slots * config.idleSlotReserveBytes);
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("Queued disk forecast exceeds finite storage bounds");
      return { slots, bytes };
    })
    .sort((left, right) => {
      const order =
        BigInt(right.bytes) * BigInt(left.slots) -
        BigInt(left.bytes) * BigInt(right.slots);
      return order > 0n ? 1 : order < 0n ? -1 : 0;
    });
  let remaining = idleSlots;
  let reservedBytes = 0;
  for (const request of requests) {
    const slots = Math.min(remaining, request.slots);
    reservedBytes += Number(
      (BigInt(request.bytes) * BigInt(slots) + BigInt(request.slots) - 1n) /
        BigInt(request.slots),
    );
    remaining -= slots;
    if (remaining === 0) break;
  }
  reservedBytes += remaining * config.idleSlotReserveBytes;
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0)
    throw new Error("Queued disk forecast exceeds finite storage bounds");
  return { reservedBytes, queuedCpuSlots: idleSlots - remaining };
}
