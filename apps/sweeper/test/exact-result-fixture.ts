import type {
  EngineEvidenceArtifact,
  JobResult,
  PolarPoint,
} from "@aerodb/engine-client";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function safeCaseKey(point: PolarPoint, index: number): string {
  const raw = point.case_slug?.trim() || `aoa_${point.aoa_deg}_${index}`;
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function exactManifest(
  jobId: string,
  point: PolarPoint,
  index: number,
): EngineEvidenceArtifact {
  const existing = point.evidence_artifacts?.find(
    (artifact) => artifact.kind === "manifest",
  );
  const caseKey = safeCaseKey(point, index);
  const path =
    existing?.path ??
    `/jobs/${jobId}/files/evidence/${caseKey}/evidence_manifest.json`;
  const priorBase = existing?.metadata?.evidenceBase;
  const evidenceBase =
    typeof priorBase === "string" && priorBase.trim()
      ? priorBase
      : `/tmp/evidence/${jobId}/${caseKey}`;
  const sha256 =
    existing?.sha256 && /^[a-f0-9]{64}$/i.test(existing.sha256)
      ? existing.sha256
      : createHash("sha256")
          .update(`${jobId}:${caseKey}:${path}`)
          .digest("hex");

  return {
    ...existing,
    kind: "manifest",
    path,
    url: existing?.url ?? path,
    mime_type: existing?.mime_type || "application/json",
    sha256,
    byte_size:
      Number.isInteger(existing?.byte_size) && (existing?.byte_size ?? 0) > 0
        ? existing!.byte_size
        : 128,
    metadata: { ...(existing?.metadata ?? {}), evidenceBase },
  };
}

function storageKey(jobId: string, urlPath: string): string {
  const clean = urlPath.replace(/^\/+/, "");
  const filePrefix = `jobs/${jobId}/files/`;
  return clean.startsWith(filePrefix)
    ? `jobs/${jobId}/${clean.slice(filePrefix.length)}`
    : clean;
}

function materializeShippedMedia(jobId: string, point: PolarPoint): void {
  const mediaDir = process.env.MEDIA_DIR;
  if (!mediaDir) return;
  for (const entries of [point.images, point.mean_images, point.video]) {
    for (const urlPath of Object.values(entries ?? {})) {
      if (!urlPath) continue;
      const key = storageKey(jobId, urlPath);
      const path = resolve(mediaDir, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(`exact-result-fixture:${key}`, "utf8"));
    }
  }
}

function withManifest(
  jobId: string,
  point: PolarPoint,
  index: number,
): PolarPoint {
  materializeShippedMedia(jobId, point);
  return {
    ...point,
    evidence_artifacts: [
      exactManifest(jobId, point, index),
      ...(point.evidence_artifacts ?? []).filter(
        (artifact) => artifact.kind !== "manifest",
      ),
    ],
  };
}

/**
 * Production solver output always carries one immutable evidence manifest per
 * attempted case. Integration fixtures that exercise successful or rejected
 * solver publication must model that contract too; otherwise the 0053 exact-
 * generation fence correctly keeps the mutable result projection unpublished.
 */
export function withExactManifestEvidence(result: JobResult): JobResult {
  return {
    ...result,
    polars: result.polars.map((polar, polarIndex) => ({
      ...polar,
      points: polar.points.map((point, pointIndex) =>
        withManifest(result.job_id, point, polarIndex * 10_000 + pointIndex),
      ),
      attempts: polar.attempts?.map((point, pointIndex) =>
        withManifest(
          result.job_id,
          point,
          polarIndex * 10_000 + polar.points.length + pointIndex,
        ),
      ),
    })),
  };
}
