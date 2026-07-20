import {
  enqueuePrecalcVerifications,
  hasExactVerifiedRestartableEvidenceArchive,
  onResultIngested,
  registerVerifiedBrokeredEvidenceArchive,
  type DB,
  resultAttempts,
  results,
  simCampaignPoints,
  simCampaigns,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  solverEvidenceArtifacts,
  syncBrokeredEvidenceUploads,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  manifestMemberSetSha256,
  parseEvidenceManifest,
} from "./evidence-manifest";

export interface BrokeredFinalBackfillReport {
  uploadId: string;
  resultId: string;
  resultAttemptId: string;
  archiveId: string | null;
  memberCount: number;
  campaignId: string | null;
  finalQueueId: string | null;
  state: "verified" | "registered";
}

function exactObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function localEvidencePath(mediaRoot: string, storageKey: string): string {
  const root = resolve(mediaRoot);
  const target = resolve(root, storageKey);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("brokered manifest storage key escapes MEDIA_DIR");
  }
  return target;
}

export async function reconcileBoundBrokeredEvidenceArchives(opts: {
  db: DB;
  engine: EngineClient;
  mediaRoot: string;
  uploadIds?: string[];
  limit?: number;
  execute: boolean;
}): Promise<BrokeredFinalBackfillReport[]> {
  const selected = await opts.db
    .select()
    .from(syncBrokeredEvidenceUploads)
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.state, "bound"),
        opts.uploadIds?.length
          ? inArray(syncBrokeredEvidenceUploads.id, opts.uploadIds)
          : undefined,
      ),
    )
    .orderBy(syncBrokeredEvidenceUploads.createdAt)
    .limit(opts.limit ?? 100);
  if (opts.uploadIds?.length && selected.length !== opts.uploadIds.length) {
    const found = new Set(selected.map((row) => row.id));
    const missing = opts.uploadIds.filter((id) => !found.has(id));
    throw new Error(`bound brokered upload not found: ${missing.join(", ")}`);
  }

  const reports: BrokeredFinalBackfillReport[] = [];
  for (const upload of selected) {
    if (
      !upload.canonicalResultId ||
      !upload.canonicalResultAttemptId ||
      !upload.canonicalArtifactId ||
      !upload.generation ||
      !upload.crc32c ||
      !upload.verifiedAt
    ) {
      throw new Error(`bound upload ${upload.id} lacks canonical ownership`);
    }
    const [source] = await opts.db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, upload.canonicalArtifactId))
      .limit(1);
    const [attempt] = await opts.db
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.id, upload.canonicalResultAttemptId),
          eq(resultAttempts.resultId, upload.canonicalResultId),
        ),
      )
      .limit(1);
    const [result] = await opts.db
      .select()
      .from(results)
      .where(eq(results.id, upload.canonicalResultId))
      .limit(1);
    const manifests = await opts.db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, upload.canonicalResultId),
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            upload.canonicalResultAttemptId,
          ),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    if (!source || !attempt || !result || manifests.length !== 1) {
      throw new Error(
        `bound upload ${upload.id} lacks one exact source/attempt/result/manifest owner`,
      );
    }
    if (!result.simulationPresetRevisionId) {
      throw new Error(
        `bound upload ${upload.id} result lacks an immutable preset revision`,
      );
    }
    const [manifest] = manifests;
    if (
      source.resultId !== upload.canonicalResultId ||
      source.resultAttemptId !== upload.canonicalResultAttemptId ||
      source.kind !== "engine_bundle" ||
      source.storageKey !== upload.objectKey ||
      source.sha256 !== upload.storedSha256 ||
      source.byteSize !== upload.storedByteSize ||
      manifest.sha256 !== upload.manifestSha256 ||
      manifest.byteSize !== upload.manifestByteSize ||
      result.currentResultAttemptId !== attempt.id ||
      result.status !== "done" ||
      result.source !== "solved" ||
      attempt.status !== "done" ||
      attempt.source !== "solved" ||
      !attempt.validForPolar ||
      attempt.airfoilId !== result.airfoilId ||
      attempt.bcId !== result.bcId ||
      attempt.simulationPresetRevisionId !==
        result.simulationPresetRevisionId ||
      attempt.aoaDeg !== result.aoaDeg ||
      !attempt.solverImplementationId ||
      source.airfoilId !== attempt.airfoilId ||
      source.simJobId !== attempt.simJobId ||
      source.engineJobId !== attempt.engineJobId ||
      source.engineCaseSlug !== attempt.engineCaseSlug ||
      source.methodKey !== attempt.methodKey ||
      source.solverImplementationId !== attempt.solverImplementationId ||
      source.solverRuntimeBuildId !== attempt.solverRuntimeBuildId ||
      source.aoaDeg !== attempt.aoaDeg ||
      exactObject(attempt.evidencePayload).fidelity !== "urans_precalc"
    ) {
      throw new Error(`bound upload ${upload.id} changed exact PRECALC truth`);
    }
    const manifestBytes = await readFile(
      localEvidencePath(opts.mediaRoot, manifest.storageKey),
    );
    const parsed = parseEvidenceManifest(manifestBytes);
    const manifestEntry = parsed.memberSet.find(
      (entry) => entry.path === "evidence_manifest.json",
    );
    if (
      parsed.bundled.length !== upload.bundledFileCount ||
      parsed.memberSet.length !== upload.bundledFileCount + 1 ||
      manifestEntry?.sha256 !== upload.manifestSha256 ||
      manifestEntry?.byteSize !== upload.manifestByteSize
    ) {
      throw new Error(`bound upload ${upload.id} manifest claim changed`);
    }
    const evidenceBase = exactObject(source.metadata).evidenceBase;
    if (typeof evidenceBase !== "string" || !evidenceBase.trim()) {
      throw new Error(`bound upload ${upload.id} lacks evidenceBase`);
    }
    await opts.engine.verifyRemoteEvidenceManifest({
      remote: {
        schemaVersion: 1,
        format: "tar+zstd",
        bucket: upload.bucket,
        objectKey: upload.objectKey,
        generation: upload.generation,
        storedSha256: upload.storedSha256,
        storedSize: upload.storedByteSize,
        tarSha256: upload.tarSha256,
        tarSize: upload.tarByteSize,
        crc32c: upload.crc32c,
        zstdLevel: upload.zstdLevel,
        createdAt: upload.verifiedAt.toISOString(),
      },
      manifestBase64: manifestBytes.toString("base64"),
      manifestSha256: upload.manifestSha256,
      manifestByteSize: upload.manifestByteSize,
      manifestMemberSetSha256: manifestMemberSetSha256(parsed.memberSet),
      manifestMemberCount: parsed.memberSet.length,
    });

    if (!opts.execute) {
      reports.push({
        uploadId: upload.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        archiveId: null,
        memberCount: parsed.memberSet.length,
        campaignId: null,
        finalQueueId: null,
        state: "verified",
      });
      continue;
    }

    const registration = await opts.db.transaction(async (rawTx) =>
      registerVerifiedBrokeredEvidenceArchive(rawTx as unknown as DB, {
        resultId: result.id,
        resultAttemptId: attempt.id,
        sourceArtifactId: source.id,
        manifestArtifactId: manifest.id,
        evidenceBase,
        identity: {
          bucket: upload.bucket,
          objectKey: upload.objectKey,
          generation: upload.generation!,
          crc32c: upload.crc32c!,
          storedSha256: upload.storedSha256,
          storedByteSize: upload.storedByteSize,
          tarSha256: upload.tarSha256,
          tarByteSize: upload.tarByteSize,
          manifestSha256: upload.manifestSha256,
          manifestByteSize: upload.manifestByteSize,
          zstdLevel: upload.zstdLevel,
          bundledFileCount: upload.bundledFileCount,
          verifiedAt: upload.verifiedAt!,
        },
        memberSet: parsed.memberSet,
      }),
    );
    if (
      !(await hasExactVerifiedRestartableEvidenceArchive(
        opts.db,
        result.id,
        attempt.id,
      ))
    ) {
      throw new Error(
        `bound upload ${upload.id} did not become restartable after registration`,
      );
    }
    await onResultIngested(opts.db, {
      airfoilId: result.airfoilId,
      revisionId: result.simulationPresetRevisionId,
      aoaDeg: result.aoaDeg,
      resultId: result.id,
      resultAttemptId: attempt.id,
      status: result.status,
      regime: result.regime,
    });
    const [campaignOwner] = await opts.db
      .select({ campaignId: simCampaignPoints.campaignId })
      .from(simCampaignPoints)
      .innerJoin(
        simCampaigns,
        eq(simCampaigns.id, simCampaignPoints.campaignId),
      )
      .where(
        and(
          eq(simCampaignPoints.resultId, result.id),
          eq(simCampaignPoints.resultAttemptId, attempt.id),
          eq(simCampaignPoints.derivedBySymmetry, false),
          inArray(simCampaigns.status, ["active", "attention", "paused"]),
        ),
      )
      .orderBy(simCampaignPoints.campaignId)
      .limit(1);
    await enqueuePrecalcVerifications(opts.db, {
      airfoilId: result.airfoilId,
      revisionId: result.simulationPresetRevisionId,
      campaignId: campaignOwner?.campaignId ?? null,
      aoaDeg: result.aoaDeg,
    });
    const [queue] = await opts.db
      .select({
        id: simUransVerifyQueue.id,
        backgroundOwner: simUransVerifyQueue.backgroundOwner,
      })
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.precalcResultAttemptId, attempt.id),
          inArray(simUransVerifyQueue.state, [
            "pending",
            "running",
            "done",
            "disagreed",
          ]),
        ),
      )
      .orderBy(simUransVerifyQueue.createdAt)
      .limit(1);
    if (!queue) {
      throw new Error(`bound upload ${upload.id} has no durable FINAL owner`);
    }
    if (campaignOwner) {
      const [association] = await opts.db
        .select({ queueId: simUransVerifyQueueCampaigns.queueId })
        .from(simUransVerifyQueueCampaigns)
        .where(
          and(
            eq(simUransVerifyQueueCampaigns.queueId, queue.id),
            eq(
              simUransVerifyQueueCampaigns.campaignId,
              campaignOwner.campaignId,
            ),
            eq(simUransVerifyQueueCampaigns.state, "active"),
          ),
        )
        .limit(1);
      if (!association) {
        throw new Error(
          `bound upload ${upload.id} FINAL queue lost campaign ownership`,
        );
      }
    } else if (!queue.backgroundOwner) {
      throw new Error(
        `bound upload ${upload.id} FINAL queue has no live background owner`,
      );
    }
    reports.push({
      uploadId: upload.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      archiveId: registration.archiveId,
      memberCount: registration.memberCount,
      campaignId: campaignOwner?.campaignId ?? null,
      finalQueueId: queue.id,
      state: "registered",
    });
  }
  return reports;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const uploadIds = args.flatMap((arg, index) =>
    arg === "--upload-id" && args[index + 1] ? [args[index + 1]!] : [],
  );
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  const { db, sql, engine } = makeContext();
  try {
    const reports = await reconcileBoundBrokeredEvidenceArchives({
      db,
      engine,
      mediaRoot: process.env.MEDIA_DIR ?? "/data/airfoilfoam",
      uploadIds: uploadIds.length ? uploadIds : undefined,
      limit,
      execute,
    });
    for (const report of reports) console.log(JSON.stringify(report));
    console.error(
      JSON.stringify({
        mode: execute ? "execute" : "dry-run",
        processed: reports.length,
      }),
    );
    return 0;
  } finally {
    await sql.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
