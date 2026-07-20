import {
  type DB,
  resultAttempts,
  results,
  simJobs,
  solverEvidenceArtifacts,
  syncApiSettings,
  syncRemoteResultDeliveries,
} from "@aerodb/db";
import type { EngineClient, PolarPoint } from "@aerodb/engine-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import type { ResolvedEngineRuntime } from "./engine-provenance";
import { registerEvidenceArtifacts } from "./ingest";

const LEGACY_ARCHIVE_NAMES = new Set([
  "openfoam_evidence.tar.gz",
  "engine_evidence.tar.gz",
]);

export interface LegacyBrokeredEvidenceBackfillReport {
  deliveryId: string;
  resultId: string;
  resultAttemptId: string;
  engineJobId: string;
  caseSlug: string;
  evidenceBase: string;
  legacyArchiveByteSize: number;
  state: "planned" | "requeued";
}

function exactObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exactRelativeEvidenceBase(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error("legacy archive lacks an exact evidenceBase");
  }
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("legacy archive evidenceBase is unsafe");
  }
  return parts.join("/");
}

export async function backfillLegacyBrokeredEvidence(opts: {
  db: DB;
  engine: EngineClient;
  execute: boolean;
  deliveryIds?: string[];
  limit?: number;
}): Promise<LegacyBrokeredEvidenceBackfillReport[]> {
  const [settings] = await opts.db
    .select({
      remoteSolverEnabled: syncApiSettings.remoteSolverEnabled,
      upstreamBaseUrl: syncApiSettings.upstreamBaseUrl,
    })
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  if (
    !settings?.remoteSolverEnabled ||
    !settings.upstreamBaseUrl
  ) {
    throw new Error(
      "legacy brokered evidence backfill is restricted to an enabled remote-solver instance",
    );
  }

  const selected = await opts.db
    .select({
      delivery: syncRemoteResultDeliveries,
      result: results,
      attempt: resultAttempts,
      job: simJobs,
    })
    .from(syncRemoteResultDeliveries)
    .innerJoin(results, eq(results.id, syncRemoteResultDeliveries.resultId))
    .innerJoin(
      resultAttempts,
      eq(resultAttempts.id, syncRemoteResultDeliveries.resultAttemptId),
    )
    .innerJoin(simJobs, eq(simJobs.id, syncRemoteResultDeliveries.simJobId))
    .where(
      and(
        eq(syncRemoteResultDeliveries.state, "delivered"),
        eq(results.currentResultAttemptId, resultAttempts.id),
        eq(resultAttempts.resultId, results.id),
        eq(resultAttempts.simJobId, simJobs.id),
        eq(resultAttempts.validForPolar, true),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        eq(simJobs.status, "done"),
        opts.deliveryIds?.length
          ? inArray(syncRemoteResultDeliveries.id, opts.deliveryIds)
          : undefined,
      ),
    )
    .orderBy(syncRemoteResultDeliveries.createdAt)
    .limit(opts.limit ?? 100);
  if (opts.deliveryIds?.length && selected.length !== opts.deliveryIds.length) {
    const found = new Set(selected.map(({ delivery }) => delivery.id));
    const missing = opts.deliveryIds.filter((id) => !found.has(id));
    throw new Error(
      `eligible delivered remote result not found: ${missing.join(", ")}`,
    );
  }

  const reports: LegacyBrokeredEvidenceBackfillReport[] = [];
  for (const { delivery, result, attempt, job } of selected) {
    if (
      !delivery.resultId ||
      !delivery.resultAttemptId ||
      delivery.generationKey !== attempt.id ||
      !attempt.engineJobId ||
      !attempt.engineCaseSlug ||
      attempt.engineJobId !== job.engineJobId ||
      attempt.airfoilId !== result.airfoilId ||
      attempt.aoaDeg !== result.aoaDeg
    ) {
      throw new Error(`delivery ${delivery.id} changed exact attempt ownership`);
    }
    const artifacts = await opts.db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, result.id),
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          sql`${solverEvidenceArtifacts.engineJobId} IS NOT DISTINCT FROM ${attempt.engineJobId}`,
          sql`${solverEvidenceArtifacts.engineCaseSlug} IS NOT DISTINCT FROM ${attempt.engineCaseSlug}`,
        ),
      );
    const manifests = artifacts.filter((item) => item.kind === "manifest");
    const legacyBundles = artifacts.filter(
      (item) => item.kind === "openfoam_bundle",
    );
    const engineBundles = artifacts.filter(
      (item) => item.kind === "engine_bundle",
    );
    if (
      manifests.length !== 1 ||
      legacyBundles.length !== 1 ||
      engineBundles.length !== 0
    ) {
      continue;
    }
    const manifest = manifests[0]!;
    const legacy = legacyBundles[0]!;
    const evidenceBase = exactRelativeEvidenceBase(
      exactObject(legacy.metadata).evidenceBase,
    );
    const legacyArchiveName = basename(legacy.storageKey);
    if (!LEGACY_ARCHIVE_NAMES.has(legacyArchiveName)) {
      throw new Error(
        `delivery ${delivery.id} legacy archive name is unsupported`,
      );
    }
    const report: LegacyBrokeredEvidenceBackfillReport = {
      deliveryId: delivery.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      engineJobId: attempt.engineJobId,
      caseSlug: attempt.engineCaseSlug,
      evidenceBase,
      legacyArchiveByteSize: legacy.byteSize,
      state: opts.execute ? "requeued" : "planned",
    };
    if (!opts.execute) {
      reports.push(report);
      continue;
    }

    const prepared = await opts.engine.prepareBrokeredLegacyEvidence(
      attempt.engineJobId,
      {
        caseSlug: attempt.engineCaseSlug,
        evidenceBase,
        legacyArchiveName: legacyArchiveName as
          | "openfoam_evidence.tar.gz"
          | "engine_evidence.tar.gz",
        legacyArchiveSha256: legacy.sha256,
        legacyArchiveByteSize: legacy.byteSize,
        manifestSha256: manifest.sha256,
        manifestByteSize: manifest.byteSize,
      },
    );
    if (prepared.state !== "prepared") {
      throw new Error(`delivery ${delivery.id} engine preparation was not acknowledged`);
    }
    const point = {
      aoa_deg: attempt.aoaDeg,
      case_slug: attempt.engineCaseSlug,
      method_key: attempt.methodKey,
    } as PolarPoint;
    const runtime =
      attempt.solverImplementationId && attempt.solverRuntimeBuildId
        ? ({
            solverImplementationId: attempt.solverImplementationId,
            solverRuntimeBuildId: attempt.solverRuntimeBuildId,
          } satisfies ResolvedEngineRuntime)
        : null;
    await opts.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const cleanup = await registerEvidenceArtifacts({
        db: tx,
        engine: opts.engine,
        resultId: result.id,
        resultAttemptId: attempt.id,
        airfoilId: attempt.airfoilId,
        simJobId: job.id,
        engineJobId: attempt.engineJobId!,
        point,
        artifact: prepared.artifact,
        runtime,
      });
      if (cleanup !== null) {
        throw new Error("local legacy transcode unexpectedly requested GCS cleanup");
      }
      const bundles = await tx
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultId, result.id),
            eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
            eq(solverEvidenceArtifacts.kind, "engine_bundle"),
          ),
        );
      if (
        bundles.length !== 1 ||
        bundles[0]!.sha256 !== prepared.artifact.sha256 ||
        bundles[0]!.byteSize !== prepared.artifact.byte_size
      ) {
        throw new Error(
          `delivery ${delivery.id} did not register one exact Zstandard bundle`,
        );
      }
      const reopened = await tx
        .update(syncRemoteResultDeliveries)
        .set({
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastHttpStatus: null,
          lastError: null,
          remoteConflictIds: [],
          deliveredAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemoteResultDeliveries.id, delivery.id),
            eq(syncRemoteResultDeliveries.state, "delivered"),
            eq(syncRemoteResultDeliveries.generationKey, attempt.id),
            eq(syncRemoteResultDeliveries.resultAttemptId, attempt.id),
          ),
        )
        .returning({ id: syncRemoteResultDeliveries.id });
      if (reopened.length !== 1) {
        throw new Error(
          `delivery ${delivery.id} changed before exact re-delivery was armed`,
        );
      }
    });
    reports.push(report);
  }
  return reports;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const deliveryIds = args.flatMap((arg, index) =>
    arg === "--delivery-id" && args[index + 1] ? [args[index + 1]!] : [],
  );
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  const { db, sql, engine } = makeContext();
  try {
    const reports = await backfillLegacyBrokeredEvidence({
      db,
      engine,
      execute,
      deliveryIds: deliveryIds.length ? deliveryIds : undefined,
      limit,
    });
    for (const report of reports) console.log(JSON.stringify(report));
    console.error(
      JSON.stringify({
        mode: execute ? "execute" : "dry-run",
        eligible: reports.length,
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
