import {
  solverImplementations,
  solverRuntimeBuilds,
  solverRuntimeProvenanceKey,
  type DB,
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

/** Sync-import counterpart of the sweeper provenance resolver. It accepts only
 * registered logical implementations and preserves exact runtime digests;
 * missing legacy identity remains NULL. */
export async function resolveEngineRuntimeBuild(
  db: DB,
  value: unknown,
  metadataSource: "sync" | "canary_attestation" = "sync",
): Promise<ResolvedEngineRuntime | null> {
  if (value == null) return null;
  if (!isEngineRuntimeIdentity(value)) {
    throw new EngineError(
      "remote evidence contains malformed engine runtime provenance",
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  const engine: EngineRuntimeIdentity = value;
  const implementations = await db
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
  if (implementations.length !== 1) {
    throw new EngineError(
      `remote evidence engine does not resolve to one registered implementation: ${JSON.stringify(engine)}`,
      undefined,
      ENGINE_IDENTITY_MISMATCH_CODE,
    );
  }
  const provenance = {
    solverImplementationId: implementations[0].id,
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
      metadata: { source: metadataSource },
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
    throw new Error(`failed to persist remote runtime ${provenanceKey}`);
  return {
    solverImplementationId: provenance.solverImplementationId,
    solverRuntimeBuildId: runtime.id,
  };
}
