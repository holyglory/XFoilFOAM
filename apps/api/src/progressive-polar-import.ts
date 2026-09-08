import {
  assertProgressiveCfdEvidenceJob,
  progressiveRemotePointProjection,
  ProgressiveRemoteEvidenceConflict,
  ProgressiveCfdEvidenceScopeClosed,
  readProgressiveRemoteEvidenceReceipt,
  resolveProgressiveRemoteEvidence,
  type DB,
  type ProgressiveRemoteEvidenceDelivery,
  type ProgressiveRemoteEvidenceReference,
} from "@aerodb/db";

interface IncomingPoint {
  aoaDeg: number;
  engineJobId?: string | null;
  engineCaseSlug?: string | null;
  remoteResultId?: string;
  remoteResultAttemptId?: string;
  progressiveEvidence?: ProgressiveRemoteEvidenceReference;
}

export async function prepareProgressivePolarImport(
  db: DB,
  payload: {
    promiseId?: string;
    results: IncomingPoint[];
  },
  solverId: string | null,
) {
  const prepared = new Map<
    number,
    {
      source: NonNullable<
        Awaited<ReturnType<typeof resolveProgressiveRemoteEvidence>>
      >;
      delivery: ProgressiveRemoteEvidenceDelivery;
      receipt: Awaited<ReturnType<typeof readProgressiveRemoteEvidenceReceipt>>;
      projection: ReturnType<typeof progressiveRemotePointProjection>;
    }
  >();
  if (
    (payload.promiseId ||
      payload.results.some((point) => point.progressiveEvidence)) &&
    new Set(payload.results.map((point) => point.aoaDeg)).size !==
      payload.results.length
  )
    throw new ProgressiveRemoteEvidenceConflict("Polar push repeats an AoA");
  for (const point of payload.results) {
    if (!payload.promiseId) {
      if (point.progressiveEvidence)
        throw new ProgressiveRemoteEvidenceConflict(
          "Progressive evidence requires its exact promise",
        );
      continue;
    }
    const source = await resolveProgressiveRemoteEvidence(db, {
      solverId: solverId ?? "",
      promiseId: payload.promiseId,
      engineJobId: point.engineJobId ?? "",
      aoaDeg: point.aoaDeg,
      engineCaseSlug: point.engineCaseSlug ?? null,
      progressiveEvidence: point.progressiveEvidence,
    });
    if (!source) continue;
    if (
      !solverId ||
      !point.remoteResultId ||
      !point.remoteResultAttemptId ||
      !point.progressiveEvidence
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Progressive delivery requires exact remote result and attempt identities",
      );
    const delivery: ProgressiveRemoteEvidenceDelivery = {
      solverId,
      promiseId: payload.promiseId,
      engineJobId: source.report.executionId,
      aoaDeg: point.aoaDeg,
      engineCaseSlug: point.engineCaseSlug ?? null,
      progressiveEvidence: point.progressiveEvidence,
      remoteResultId: point.remoteResultId,
      remoteResultAttemptId: point.remoteResultAttemptId,
    };
    prepared.set(point.aoaDeg, {
      source,
      delivery,
      receipt: await readProgressiveRemoteEvidenceReceipt(db, delivery),
      projection: progressiveRemotePointProjection(source),
    });
  }
  if (prepared.size && prepared.size !== payload.results.length)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive delivery cannot mix execution contracts",
    );
  return prepared;
}

export async function assertProgressivePolarImportScope(
  db: DB,
  prepared: Awaited<ReturnType<typeof prepareProgressivePolarImport>>,
) {
  const publishable = new Set<number>();
  for (const { source, receipt } of prepared.values()) {
    let owned: boolean;
    try {
      owned = await assertProgressiveCfdEvidenceJob(
        db,
        source.report.executionId,
        source.report.executionId,
        [
          {
            alpha: source.point.aoa_deg,
            speed: source.polar.speed,
            chord: source.polar.chord,
            solverActiveSeconds: source.point.solver_active_seconds,
          },
        ],
      );
    } catch (error) {
      if (receipt && error instanceof ProgressiveCfdEvidenceScopeClosed)
        continue;
      throw error;
    }
    if (!owned)
      throw new ProgressiveRemoteEvidenceConflict(
        "Progressive polar has no canonical execution owner",
      );
    publishable.add(source.point.aoa_deg);
  }
  return publishable;
}
