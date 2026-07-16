import {
  type DB,
  simJobs,
  solverImplementations,
  solverRuntimeBuilds,
  solverRuntimeProvenanceKey,
} from "@aerodb/db";
import {
  ENGINE_IDENTITY_MISMATCH_CODE,
  EngineError,
  isEngineRuntimeIdentity,
  type EngineRuntimeIdentity,
} from "@aerodb/engine-client";
import { and, eq } from "drizzle-orm";

export interface ResolvedEngineRuntime {
  solverImplementationId: string;
  solverRuntimeBuildId: string;
}

/** Resolve a worker-authored runtime to the local immutable implementation
 * registry and idempotently preserve its exact build provenance. Unknown
 * implementations fail closed instead of being guessed as either OpenFOAM
 * distribution. */
export async function resolveEngineRuntimeBuild(
  db: DB,
  value: unknown,
): Promise<ResolvedEngineRuntime | null> {
  if (value == null) return null; // legacy response: preserve NULL provenance
  if (!isEngineRuntimeIdentity(value)) {
    throw new EngineError(
      "engine returned malformed runtime provenance",
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  const engine: EngineRuntimeIdentity = value;
  const matches = await db
    .select({ id: solverImplementations.id })
    .from(solverImplementations)
    .where(
      and(
        eq(solverImplementations.family, engine.family),
        eq(solverImplementations.distribution, engine.distribution),
        eq(solverImplementations.releaseVersion, engine.version),
        eq(
          solverImplementations.adapterContractVersion,
          engine.adapter_contract_version,
        ),
        eq(solverImplementations.numericsRevision, engine.numerics_revision),
      ),
    );
  if (matches.length !== 1) {
    throw new EngineError(
      `engine runtime does not resolve to exactly one registered implementation: ${JSON.stringify(engine)}`,
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  const solverImplementationId = matches[0].id;
  const provenance = {
    solverImplementationId,
    buildId: engine.build_id,
    sourceRevision: engine.source_revision ?? null,
    imageDigest: engine.image_digest ?? null,
    applicationSourceSha256: engine.application_source_sha256 ?? null,
    packageSha256: engine.package_sha256 ?? null,
    binarySha256: engine.binary_sha256 ?? null,
    architecture: engine.architecture ?? null,
  };
  const provenanceKey = solverRuntimeProvenanceKey(provenance);
  const [inserted] = await db
    .insert(solverRuntimeBuilds)
    .values({
      ...provenance,
      provenanceKey,
      metadata: {},
    })
    .onConflictDoNothing({ target: solverRuntimeBuilds.provenanceKey })
    .returning({ id: solverRuntimeBuilds.id });
  const runtime =
    inserted ??
    (
      await db
        .select({ id: solverRuntimeBuilds.id })
        .from(solverRuntimeBuilds)
        .where(eq(solverRuntimeBuilds.provenanceKey, provenanceKey))
        .limit(1)
    )[0];
  if (!runtime)
    throw new Error(`failed to persist engine runtime ${provenanceKey}`);
  return { solverImplementationId, solverRuntimeBuildId: runtime.id };
}

export async function persistEngineRuntimeForJob(
  db: DB,
  jobId: string,
  value: unknown,
): Promise<ResolvedEngineRuntime | null> {
  const runtime = await resolveEngineRuntimeBuild(db, value);
  if (!runtime) return null;
  const [job] = await db
    .select({
      solverImplementationId: simJobs.solverImplementationId,
      solverRuntimeBuildId: simJobs.solverRuntimeBuildId,
    })
    .from(simJobs)
    .where(eq(simJobs.id, jobId))
    .limit(1);
  if (!job)
    throw new Error(`sim job ${jobId} disappeared during provenance write`);
  if (
    job.solverImplementationId &&
    job.solverImplementationId !== runtime.solverImplementationId
  ) {
    throw new EngineError(
      `sim job ${jobId} requested implementation ${job.solverImplementationId} but runtime ${runtime.solverImplementationId} answered`,
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  if (
    job.solverRuntimeBuildId &&
    job.solverRuntimeBuildId !== runtime.solverRuntimeBuildId
  ) {
    throw new EngineError(
      `sim job ${jobId} changed immutable runtime build acknowledgement`,
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  await db
    .update(simJobs)
    .set({
      solverImplementationId:
        job.solverImplementationId ?? runtime.solverImplementationId,
      solverRuntimeBuildId: runtime.solverRuntimeBuildId,
    })
    .where(eq(simJobs.id, jobId));
  return runtime;
}
