import type {
  EngineCapabilityDescriptor,
  EngineIdentity,
  EngineQueueState,
  EngineRuntimeIdentity,
} from "./types";

export const ENGINE_ADAPTER_CONTRACT_VERSION = 1;

export const LEGACY_OPENCFD_2406_ENGINE: Readonly<EngineIdentity> =
  Object.freeze({
    family: "openfoam",
    distribution: "opencfd",
    version: "2406",
    numerics_revision: "1",
    adapter_contract_version: ENGINE_ADAPTER_CONTRACT_VERSION,
  });

export const OPENCFD_2606_ENGINE: Readonly<EngineIdentity> = Object.freeze({
  family: "openfoam",
  distribution: "opencfd",
  version: "2606",
  numerics_revision: "1",
  adapter_contract_version: ENGINE_ADAPTER_CONTRACT_VERSION,
});

export const FOUNDATION_OPENFOAM_14_ENGINE: Readonly<EngineIdentity> =
  Object.freeze({
    family: "openfoam",
    distribution: "foundation",
    version: "14",
    numerics_revision: "1",
    adapter_contract_version: ENGINE_ADAPTER_CONTRACT_VERSION,
  });

export function isEngineIdentity(value: unknown): value is EngineIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EngineIdentity>;
  return (
    typeof candidate.family === "string" &&
    candidate.family.length > 0 &&
    typeof candidate.distribution === "string" &&
    candidate.distribution.length > 0 &&
    typeof candidate.version === "string" &&
    candidate.version.length > 0 &&
    typeof candidate.numerics_revision === "string" &&
    candidate.numerics_revision.length > 0 &&
    Number.isSafeInteger(candidate.adapter_contract_version) &&
    (candidate.adapter_contract_version ?? 0) > 0
  );
}

export function isEngineRuntimeIdentity(
  value: unknown,
): value is EngineRuntimeIdentity {
  return (
    isEngineIdentity(value) &&
    typeof (value as Partial<EngineRuntimeIdentity>).build_id === "string" &&
    (value as Partial<EngineRuntimeIdentity>).build_id!.length > 0 &&
    hasEngineRuntimeContentFingerprint(value as Partial<EngineRuntimeIdentity>)
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OCI_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A build label or mutable source-revision label is not content provenance.
 * At least one actual content digest must accompany every new runtime
 * acknowledgement. Historical jobs keep their truthful `engine: null`. */
export function hasEngineRuntimeContentFingerprint(
  value: Partial<EngineRuntimeIdentity>,
): boolean {
  if (
    (value.application_source_sha256 != null &&
      (typeof value.application_source_sha256 !== "string" ||
        !SHA256_HEX.test(value.application_source_sha256))) ||
    (value.image_digest != null &&
      (typeof value.image_digest !== "string" ||
        !OCI_SHA256_DIGEST.test(value.image_digest))) ||
    (value.package_sha256 != null &&
      (typeof value.package_sha256 !== "string" ||
        !SHA256_HEX.test(value.package_sha256))) ||
    (value.binary_sha256 != null &&
      (typeof value.binary_sha256 !== "string" ||
        !SHA256_HEX.test(value.binary_sha256)))
  ) {
    return false;
  }
  return (
    (typeof value.application_source_sha256 === "string" &&
      SHA256_HEX.test(value.application_source_sha256)) ||
    (typeof value.image_digest === "string" &&
      OCI_SHA256_DIGEST.test(value.image_digest)) ||
    (typeof value.package_sha256 === "string" &&
      SHA256_HEX.test(value.package_sha256)) ||
    (typeof value.binary_sha256 === "string" &&
      SHA256_HEX.test(value.binary_sha256))
  );
}

export function isEngineCapabilityDescriptor(
  value: unknown,
): value is EngineCapabilityDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EngineCapabilityDescriptor>;
  return (
    isEngineIdentity(candidate.engine) &&
    typeof candidate.routing_key === "string" &&
    candidate.routing_key.length > 0 &&
    Array.isArray(candidate.analysis_methods) &&
    candidate.analysis_methods.every((item) => typeof item === "string") &&
    typeof candidate.steady === "boolean" &&
    typeof candidate.transient === "boolean" &&
    typeof candidate.volume_fields === "boolean" &&
    typeof candidate.mesh_evidence === "boolean" &&
    typeof candidate.stored_media === "boolean" &&
    typeof candidate.custom_field_rendering === "boolean" &&
    typeof candidate.multi_element_geometry === "boolean" &&
    Array.isArray(candidate.supported_turbulence_models) &&
    candidate.supported_turbulence_models.every(
      (item) => typeof item === "string",
    ) &&
    Array.isArray(candidate.supported_image_fields) &&
    candidate.supported_image_fields.every((item) => typeof item === "string")
  );
}

/** Exact logical handshake/routing key. Adapter contract is included because
 * client and worker must speak the same wire protocol. Use
 * engineNumericalCompatibilityKey for public polar identity. */
export function engineIdentityKey(engine: EngineIdentity): string {
  return [
    engine.family,
    engine.distribution,
    engine.version,
    `numerics-${engine.numerics_revision}`,
    `adapter-${engine.adapter_contract_version}`,
  ].join(":");
}

/** Numerical/public-series identity. Adapter protocol and runtime build fields
 * are deliberately absent: wire-only or packaging changes do not split a
 * physically/numerically compatible polar. */
export function engineNumericalCompatibilityKey(
  engine: EngineIdentity,
): string {
  return [
    engine.family,
    engine.distribution,
    engine.version,
    `numerics-${engine.numerics_revision}`,
  ].join(":");
}

export function sameEngineIdentity(
  left: EngineIdentity,
  right: EngineIdentity,
): boolean {
  return engineIdentityKey(left) === engineIdentityKey(right);
}

/** Select the exact runtime acknowledgement for one logical engine from a
 * single-runtime response or a gateway inventory. */
export function runtimeIdentityForExpected(
  response:
    | {
        engine?: unknown;
        engines?: unknown;
        supported_engines?: unknown;
      }
    | null
    | undefined,
  expected: EngineIdentity,
): EngineRuntimeIdentity | null {
  if (!response) return null;
  const inventory = response.engines ?? response.supported_engines;
  if (Array.isArray(inventory)) {
    const matched = inventory.find(
      (candidate) =>
        isEngineRuntimeIdentity(candidate) &&
        sameEngineIdentity(candidate, expected),
    );
    if (isEngineRuntimeIdentity(matched)) return matched;
  }
  return isEngineRuntimeIdentity(response.engine) &&
    sameEngineIdentity(response.engine, expected)
    ? response.engine
    : null;
}

/** Select a logical gateway adapter capability. This must never be used as
 * runtime/build evidence; it proves only that the gateway currently advertises
 * the implementation on the stated route. */
export function engineCapabilityForExpected(
  response:
    | {
        engine?: unknown;
        routing_key?: unknown;
        engines?: unknown;
      }
    | null
    | undefined,
  expected: EngineIdentity,
): EngineCapabilityDescriptor | null {
  if (!response) return null;
  if (Array.isArray(response.engines)) {
    const matched = response.engines.find(
      (candidate) =>
        isEngineCapabilityDescriptor(candidate) &&
        sameEngineIdentity(candidate.engine, expected),
    );
    if (isEngineCapabilityDescriptor(matched)) return matched;
  }
  if (
    isEngineIdentity(response.engine) &&
    sameEngineIdentity(response.engine, expected) &&
    typeof response.routing_key === "string" &&
    response.routing_key.length > 0
  ) {
    // A legacy single-adapter capability response cannot truthfully supply the
    // richer feature inventory. Normalize only the route/identity fields used
    // by the activation gate and keep all unsupported claims false/empty.
    return {
      engine: response.engine,
      routing_key: response.routing_key,
      analysis_methods: [],
      steady: false,
      transient: false,
      volume_fields: false,
      mesh_evidence: false,
      stored_media: false,
      custom_field_rendering: false,
      multi_element_geometry: false,
      supported_turbulence_models: [],
      supported_image_fields: [],
    };
  }
  return null;
}

/** Return true only for a fresh, structurally valid Celery inspector snapshot
 * proving at least one live worker is isolated to the exact execution-pool
 * route. A worker that also consumes a legacy or different engine route can
 * execute work outside the attested pool boundary and must not activate it. */
export function liveWorkerConsumesExecutionPool(
  queue: EngineQueueState | null | undefined,
  routingKey: string,
  expectedEngine: EngineIdentity,
): boolean {
  if (
    !queue ||
    queue.worker_queues_error != null ||
    queue.worker_runtime_error != null ||
    !Array.isArray(queue.worker_queues)
  ) {
    return false;
  }
  return queue.worker_queues.some(
    (binding) =>
      binding != null &&
      typeof binding === "object" &&
      typeof binding.worker === "string" &&
      binding.worker.length > 0 &&
      Array.isArray(binding.queues) &&
      binding.queues.every((route) => typeof route === "string") &&
      binding.queues.length === 1 &&
      binding.queues[0] === routingKey &&
      binding.execution_pool === routingKey &&
      isEngineRuntimeIdentity(binding.engine) &&
      sameEngineIdentity(binding.engine, expectedEngine),
  );
}

export function openFoamEngineIdentity(
  distribution: "opencfd" | "foundation",
  options: {
    version?: string;
    numericsRevision?: string;
    adapterContractVersion?: number;
  } = {},
): EngineIdentity {
  return {
    family: "openfoam",
    distribution,
    version: options.version ?? (distribution === "foundation" ? "14" : "2606"),
    numerics_revision: options.numericsRevision ?? "1",
    adapter_contract_version:
      options.adapterContractVersion ?? ENGINE_ADAPTER_CONTRACT_VERSION,
  };
}

/** Parse deployment configuration without allowing an ambiguous combination
 * (for example Foundation with an implicit OpenCFD version). */
export function openFoamEngineIdentityFromConfig(config: {
  distribution?: string | null;
  version?: string | null;
  numericsRevision?: string | null;
  adapterContractVersion?: string | number | null;
}): EngineIdentity {
  const distribution = config.distribution ?? "opencfd";
  if (distribution !== "opencfd" && distribution !== "foundation") {
    throw new Error(
      `Unsupported OpenFOAM distribution ${JSON.stringify(distribution)}; expected "opencfd" or "foundation"`,
    );
  }
  const parsedContractVersion =
    config.adapterContractVersion == null
      ? ENGINE_ADAPTER_CONTRACT_VERSION
      : Number(config.adapterContractVersion);
  if (
    !Number.isSafeInteger(parsedContractVersion) ||
    parsedContractVersion <= 0
  ) {
    throw new Error(
      "ENGINE_ADAPTER_CONTRACT_VERSION must be a positive integer",
    );
  }
  return openFoamEngineIdentity(distribution, {
    version: config.version ?? undefined,
    numericsRevision: config.numericsRevision ?? undefined,
    adapterContractVersion: parsedContractVersion,
  });
}
