import {
  assertProgressiveCfdEvidenceJob,
  assertStoppedProgressiveStorage,
  progressiveRemotePointProjection,
  ProgressiveRemoteEvidenceConflict,
  ProgressiveCfdEvidenceScopeClosed,
  readProgressiveRemoteEvidenceReceipt,
  resolveProgressiveRemoteEvidence,
  type DB,
  type ProgressiveRemoteEvidenceDelivery,
  type ProgressiveRemoteEvidenceReference,
} from "@aerodb/db";
import { prepareProgressiveRemoteEvidence } from "@aerodb/db/progressive-remote-evidence";
import {
  prepareProgressiveRemoteReceiptReplay,
  recheckPreparedProgressiveRemoteReceipt,
} from "@aerodb/db/progressive-remote-evidence-receipts";
import { apiAttemptEvidenceReader } from "./attempt-evidence-reader";
import { prepareStoppedProgressiveStorage } from "@aerodb/db/progressive-stopped-storage";

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
  options: { storageOnly?: boolean } = {},
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
      storageOnly: boolean;
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
    const reference = point.progressiveEvidence && {
      ...point.progressiveEvidence,
    };
    const source = await prepareProgressiveRemoteEvidence(db, {
      solverId: solverId ?? "",
      promiseId: payload.promiseId,
      engineJobId: point.engineJobId ?? "",
      aoaDeg: point.aoaDeg,
      engineCaseSlug: point.engineCaseSlug ?? null,
      progressiveEvidence: reference,
    });
    if (!source) {
      if (point.progressiveEvidence)
        throw new ProgressiveRemoteEvidenceConflict(
          "Progressive evidence source is not retained yet",
        );
      continue;
    }
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
      progressiveEvidence: reference!,
      remoteResultId: point.remoteResultId,
      remoteResultAttemptId: point.remoteResultAttemptId,
    };
    const receipt = await prepareProgressiveRemoteReceiptReplay(
      db,
      delivery,
      apiAttemptEvidenceReader,
    );
    if (options.storageOnly && !receipt?.storageOnly)
      await prepareStoppedProgressiveStorage(db, delivery);
    prepared.set(point.aoaDeg, {
      source,
      delivery,
      receipt,
      projection: progressiveRemotePointProjection(source),
      storageOnly: options.storageOnly === true,
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
  for (const { source, receipt, delivery, storageOnly } of prepared.values()) {
    if (receipt) await recheckPreparedProgressiveRemoteReceipt(db, delivery);
    if (storageOnly || receipt?.storageOnly) {
      await assertStoppedProgressiveStorage(db, delivery);
      continue;
    }
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
