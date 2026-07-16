import { createHash } from "node:crypto";

export const SOLVER_RUNTIME_PROVENANCE_VERSION = 2;

export interface SolverRuntimeProvenanceInput {
  solverImplementationId: string;
  buildId: string;
  sourceRevision?: string | null;
  imageDigest?: string | null;
  applicationSourceSha256?: string | null;
  packageSha256?: string | null;
  binarySha256?: string | null;
  architecture?: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OCI_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function optionalSha256(
  field: string,
  value: string | null | undefined,
): boolean {
  if (value == null) return false;
  if (!SHA256_HEX.test(value)) {
    throw new Error(`${field} must be a lowercase 64-character SHA-256`);
  }
  return true;
}

/**
 * Exact immutable runtime identity. Human-readable buildId is deliberately
 * only one input: reusing a build label with a different OCI digest, source
 * revision, binary checksum, or architecture creates a different row.
 */
export function solverRuntimeProvenanceKey(
  input: SolverRuntimeProvenanceInput,
): string {
  const hasApplicationSource = optionalSha256(
    "applicationSourceSha256",
    input.applicationSourceSha256,
  );
  const hasPackage = optionalSha256("packageSha256", input.packageSha256);
  const hasBinary = optionalSha256("binarySha256", input.binarySha256);
  let hasImage = false;
  if (input.imageDigest != null) {
    if (!OCI_SHA256_DIGEST.test(input.imageDigest)) {
      throw new Error(
        "imageDigest must be a lowercase sha256:<64-character digest>",
      );
    }
    hasImage = true;
  }
  if (!hasApplicationSource && !hasImage && !hasPackage && !hasBinary) {
    throw new Error(
      "solver runtime provenance requires at least one content fingerprint",
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SOLVER_RUNTIME_PROVENANCE_VERSION,
        solverImplementationId: input.solverImplementationId,
        buildId: input.buildId,
        sourceRevision: input.sourceRevision ?? null,
        imageDigest: input.imageDigest ?? null,
        applicationSourceSha256: input.applicationSourceSha256 ?? null,
        packageSha256: input.packageSha256 ?? null,
        binarySha256: input.binarySha256 ?? null,
        architecture: input.architecture ?? null,
      }),
    )
    .digest("hex");
}
