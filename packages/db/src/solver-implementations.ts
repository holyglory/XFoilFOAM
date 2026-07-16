/**
 * Stable solver implementation identities shared by schema defaults, request
 * builders, and compatibility hashing. These identify numerical
 * implementations, not a particular container/binary build or execution
 * pool.
 */
export const LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-000000000000";
export const OPENCFD_2406_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-240600000001";
export const OPENCFD_2606_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-260600000001";
export const FOUNDATION_14_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-001400000001";
export const OPENCFD_2406_EXECUTION_POOL_ID =
  "3f8bc764-09ae-4ff3-8fd2-240600000001";
export const OPENCFD_2606_EXECUTION_POOL_ID =
  "3f8bc764-09ae-4ff3-8fd2-260600000001";
export const FOUNDATION_14_EXECUTION_POOL_ID =
  "3f8bc764-09ae-4ff3-8fd2-001400000001";

export const LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_KEY =
  "openfoam:legacy:unknown:adapter-legacy:numerics-unknown";
export const OPENCFD_2406_SOLVER_IMPLEMENTATION_KEY =
  "openfoam:opencfd:2406:adapter-v1:numerics-v1";
export const OPENCFD_2606_SOLVER_IMPLEMENTATION_KEY =
  "openfoam:opencfd:2606:adapter-v1:numerics-v1";
export const FOUNDATION_14_SOLVER_IMPLEMENTATION_KEY =
  "openfoam:foundation:14:adapter-v1:numerics-v1";

export const DEFAULT_SOLVER_IMPLEMENTATION_ID =
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID;

export const METHOD_COMPATIBILITY_HASH_VERSION = 1;

export interface SolverImplementationSnapshot {
  implementationId: string;
  key: string;
  family: string;
  distribution: string;
  releaseVersion: string;
  methodFamily: string;
  adapterContractVersion: number;
  numericsRevision: string;
}

export const LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_SNAPSHOT: Readonly<SolverImplementationSnapshot> =
  Object.freeze({
    implementationId: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
    key: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_KEY,
    family: "openfoam",
    distribution: "legacy",
    releaseVersion: "unknown",
    methodFamily: "finite_volume_rans_urans",
    adapterContractVersion: 0,
    numericsRevision: "unknown",
  });
