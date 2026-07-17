import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { CampaignError } from "./campaigns";
import type { DB } from "./client";
import {
  solverCutoverContinuationChecks,
  solverEngineCanaryEvidenceCleanupProofs,
  solverEngineCanaryEvidenceRegistrations,
  solverEngineCanaryAttestations,
  solverExecutionPools,
  solverRuntimeBuilds,
  simCampaignSolverCutovers,
} from "./schema";
import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalReceiptSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertCanonicalReceiptDigest(
  receiptSha256: string,
  receipt: Record<string, unknown>,
  label: string,
): void {
  if (canonicalReceiptSha256(receipt) !== receiptSha256) {
    throw new CampaignError(
      "conflict",
      `${label} digest does not match its exact canonical receipt content`,
    );
  }
}

/** Prove that a final successful receipt is exactly the registered preliminary
 * receipt plus its registration binding and the four supplied cleanup proofs.
 * This guard lives in the database package so direct callers cannot bypass the
 * API receipt validator and attest unrelated evidence. */
function assertFinalReceiptRegistrationBinding(
  receiptSha256: string,
  receipt: Record<string, unknown>,
  registration: OpenCfd2606CanaryEvidenceRegistration,
  cleanupProofs: ReadonlyArray<
    PersistOpenCfd2606CanaryEvidenceCleanupProofInput & { id: string }
  >,
): void {
  assertCanonicalReceiptDigest(receiptSha256, receipt, "canary attestation");
  assertCanonicalReceiptDigest(
    registration.receiptSha256,
    registration.receipt,
    "canary evidence registration",
  );
  const binding = recordValue(receipt.evidence_registration);
  const expectedBinding = {
    id: registration.id,
    preliminary_receipt_sha256: registration.receiptSha256,
  };
  if (!binding || canonicalJson(binding) !== canonicalJson(expectedBinding)) {
    throw new CampaignError(
      "conflict",
      "canary attestation receipt does not identify its exact preliminary evidence registration",
    );
  }
  if (!Array.isArray(receipt.jobs)) {
    throw new CampaignError(
      "conflict",
      "canary attestation receipt has no registered job evidence",
    );
  }
  const receiptCleanupProofs: unknown[] = [];
  const preliminaryJobs = receipt.jobs.map((rawJob) => {
    const job = recordValue(rawJob);
    if (!job || !Array.isArray(job.points)) {
      throw new CampaignError(
        "conflict",
        "canary attestation receipt contains an invalid job evidence shape",
      );
    }
    const preliminaryPoints = job.points.map((rawPoint) => {
      const point = recordValue(rawPoint);
      const cleanup = point ? recordValue(point.cleanup) : null;
      if (!point || !cleanup) {
        throw new CampaignError(
          "conflict",
          "canary attestation receipt is missing a point cleanup proof",
        );
      }
      const bundledMemberCount = point.bundled_member_count;
      const memberAssociationCount = point.manifest_member_association_count;
      const manifestMemberSetSha256 = point.manifest_member_set_sha256;
      const jobId = job.job_id;
      const scenario = job.scenario;
      const aoaDeg = point.aoa_deg;
      const caseSlug = point.case_slug;
      const evidenceBase = point.evidence_base;
      if (
        typeof bundledMemberCount !== "number" ||
        !Number.isInteger(bundledMemberCount) ||
        bundledMemberCount <= 0 ||
        memberAssociationCount !== bundledMemberCount + 1 ||
        typeof manifestMemberSetSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(manifestMemberSetSha256) ||
        !Array.isArray(point.artifacts) ||
        typeof jobId !== "string" ||
        typeof scenario !== "string" ||
        typeof aoaDeg !== "number" ||
        typeof caseSlug !== "string" ||
        typeof evidenceBase !== "string"
      ) {
        throw new CampaignError(
          "conflict",
          "registered canary point has invalid bundled/member evidence semantics",
        );
      }
      const expectedMemberAssociationsSha256 = createHash("sha256")
        .update(
          canonicalJson({
            registrationId: registration.id,
            preliminaryReceiptSha256: registration.receiptSha256,
            jobId,
            scenario,
            aoaDeg,
            caseSlug,
            evidenceBase,
            bundledMemberCount,
            manifestMemberAssociationCount: memberAssociationCount,
            manifestMemberSetSha256,
            artifacts: point.artifacts,
          }),
        )
        .digest("hex");
      if (
        cleanup.registration_id !== registration.id ||
        cleanup.preliminary_receipt_sha256 !== registration.receiptSha256 ||
        cleanup.job_id !== jobId ||
        cleanup.scenario !== scenario ||
        cleanup.aoa_deg !== aoaDeg ||
        cleanup.case_slug !== caseSlug ||
        cleanup.evidence_base !== evidenceBase ||
        cleanup.member_association_count !== memberAssociationCount ||
        cleanup.manifest_member_set_sha256 !== manifestMemberSetSha256 ||
        cleanup.member_associations_sha256 !==
          expectedMemberAssociationsSha256 ||
        cleanup.verification !==
          `archive+manifest+all-members-restore:${bundledMemberCount}`
      ) {
        throw new CampaignError(
          "conflict",
          "canary cleanup proof does not match its exact registered point evidence semantics",
        );
      }
      receiptCleanupProofs.push(cleanup);
      const { cleanup: _cleanup, ...preliminaryPoint } = point;
      return preliminaryPoint;
    });
    return { ...job, points: preliminaryPoints };
  });
  const { evidence_registration: _registration, ...preliminaryTop } = receipt;
  const reconstructedPreliminary = {
    ...preliminaryTop,
    jobs: preliminaryJobs,
  };
  if (
    canonicalJson(reconstructedPreliminary) !==
    canonicalJson(registration.receipt)
  ) {
    throw new CampaignError(
      "conflict",
      "canary attestation receipt is not an exact cleanup extension of its registered preliminary receipt",
    );
  }
  const expectedCleanupProofs = cleanupProofs.map((proof) => ({
    proof_id: proof.id,
    registration_id: registration.id,
    preliminary_receipt_sha256: registration.receiptSha256,
    job_id: proof.jobId,
    scenario: proof.scenario,
    aoa_deg: proof.aoaDeg,
    case_slug: proof.caseSlug,
    evidence_base: proof.evidenceBase,
    member_association_count: proof.memberAssociationCount,
    member_associations_sha256: proof.memberAssociationsSha256,
    manifest_member_set_sha256: proof.manifestMemberSetSha256,
    verification: proof.verification,
    local_archive_disposition: "removed-after-database-ack",
  }));
  const actualProofSet = receiptCleanupProofs.map(canonicalJson).sort();
  const expectedProofSet = expectedCleanupProofs.map(canonicalJson).sort();
  if (canonicalJson(actualProofSet) !== canonicalJson(expectedProofSet)) {
    throw new CampaignError(
      "conflict",
      "canary attestation receipt cleanup proofs differ from the durable database proof rows",
    );
  }
}

export interface PersistOpenCfd2606CanaryEvidenceRegistrationInput {
  solverRuntimeBuildId: string;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  actor?: string | null;
}

export interface OpenCfd2606CanaryEvidenceRegistration {
  id: string;
  solverImplementationId: string;
  solverRuntimeBuildId: string;
  solverExecutionPoolId: string;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  registeredBy: string | null;
  createdAt: Date;
}

export interface PersistOpenCfd2606CanaryEvidenceCleanupProofInput {
  registrationId: string;
  jobId: string;
  scenario: "serial-rans" | "mpi-2-rans" | "forced-urans-precalc-no-shedding";
  aoaDeg: number;
  caseSlug: string;
  evidenceBase: string;
  memberAssociationCount: number;
  memberAssociationsSha256: string;
  manifestMemberSetSha256: string;
  verification: string;
}

export interface OpenCfd2606CanaryEvidenceCleanupProof extends PersistOpenCfd2606CanaryEvidenceCleanupProofInput {
  id: string;
  createdAt: Date;
}

export interface PersistOpenCfd2606CanaryAttestationInput {
  solverRuntimeBuildId: string;
  evidenceRegistrationId: string;
  cleanupProofs: ReadonlyArray<
    PersistOpenCfd2606CanaryEvidenceCleanupProofInput & { id: string }
  >;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  actor?: string | null;
}

export interface OpenCfd2606CanaryAttestation {
  id: string;
  solverImplementationId: string;
  solverRuntimeBuildId: string;
  solverExecutionPoolId: string;
  evidenceRegistrationId: string;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  attestedBy: string | null;
  createdAt: Date;
  runtime: {
    buildId: string;
    sourceRevision: string | null;
    imageDigest: string | null;
    applicationSourceSha256: string | null;
    packageSha256: string | null;
    binarySha256: string | null;
    architecture: string | null;
  };
}

export interface OpenCfd2606ContinuationStatus {
  canaryAttestationId: string;
  status: "pending" | "routed" | "evidence" | "not_required";
  simJobId: string | null;
  evidenceResultId: string | null;
  checkedAt: string;
  lastError: string | null;
  requiredCampaigns: number;
  campaigns: Array<{
    campaignId: string;
    cutoverId: string;
    status: "pending" | "routed" | "evidence";
    simJobId: string | null;
    evidenceResultId: string | null;
    lastError: string | null;
  }>;
}

/** Persist the exact direct-engine receipt before authorizing cleanup.
 *
 * This row is intentionally distinct from a successful canary attestation:
 * its existence proves only that the remote archive pointers and artifact
 * identities are durably registered.  Cutover finalization never accepts a
 * registration id as an attestation id. */
export async function persistOpenCfd2606CanaryEvidenceRegistration(
  db: DB,
  input: PersistOpenCfd2606CanaryEvidenceRegistrationInput,
): Promise<OpenCfd2606CanaryEvidenceRegistration & { replayed: boolean }> {
  assertCanonicalReceiptDigest(
    input.receiptSha256,
    input.receipt,
    "canary evidence registration",
  );
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [pool] = await tx
      .select({
        id: solverExecutionPools.id,
        enabled: solverExecutionPools.enabled,
        solverImplementationId: solverExecutionPools.solverImplementationId,
      })
      .from(solverExecutionPools)
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
      .for("update")
      .limit(1);
    const [runtime] = await tx
      .select({ id: solverRuntimeBuilds.id })
      .from(solverRuntimeBuilds)
      .where(
        and(
          eq(solverRuntimeBuilds.id, input.solverRuntimeBuildId),
          eq(
            solverRuntimeBuilds.solverImplementationId,
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          ),
        ),
      )
      .limit(1);
    if (
      !pool ||
      !pool.enabled ||
      pool.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
    ) {
      throw new CampaignError(
        "invalid_state",
        "the exact OpenCFD 2606 execution pool must remain enabled while registering canary evidence",
      );
    }
    if (!runtime) {
      throw new CampaignError(
        "validation",
        "canary evidence runtime is not registered to OpenCFD 2606",
      );
    }
    const [inserted] = await tx
      .insert(solverEngineCanaryEvidenceRegistrations)
      .values({
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: input.solverRuntimeBuildId,
        solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
        receiptSha256: input.receiptSha256,
        receipt: input.receipt,
        registeredBy: input.actor?.trim() || null,
      })
      .onConflictDoNothing({
        target: solverEngineCanaryEvidenceRegistrations.receiptSha256,
      })
      .returning({ id: solverEngineCanaryEvidenceRegistrations.id });
    const [row] = inserted
      ? await tx
          .select()
          .from(solverEngineCanaryEvidenceRegistrations)
          .where(eq(solverEngineCanaryEvidenceRegistrations.id, inserted.id))
          .limit(1)
      : await tx
          .select()
          .from(solverEngineCanaryEvidenceRegistrations)
          .where(
            eq(
              solverEngineCanaryEvidenceRegistrations.receiptSha256,
              input.receiptSha256,
            ),
          )
          .limit(1);
    if (!row) {
      throw new Error(
        "failed to persist OpenCFD 2606 canary evidence registration",
      );
    }
    if (
      row.solverRuntimeBuildId !== input.solverRuntimeBuildId ||
      row.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
      row.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID ||
      canonicalJson(row.receipt) !== canonicalJson(input.receipt)
    ) {
      throw new CampaignError(
        "conflict",
        "canary evidence registration replay resolved to different receipt content, runtime, or pool",
      );
    }
    return { ...row, replayed: !inserted };
  });
}

/** Persist one successful engine cleanup acknowledgement per exact canary
 * evidence base. Conflicting replays never relabel the immutable proof. */
export async function persistOpenCfd2606CanaryEvidenceCleanupProof(
  db: DB,
  input: PersistOpenCfd2606CanaryEvidenceCleanupProofInput,
): Promise<OpenCfd2606CanaryEvidenceCleanupProof & { replayed: boolean }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [registration] = await tx
      .select({ id: solverEngineCanaryEvidenceRegistrations.id })
      .from(solverEngineCanaryEvidenceRegistrations)
      .where(
        eq(solverEngineCanaryEvidenceRegistrations.id, input.registrationId),
      )
      .for("key share")
      .limit(1);
    if (!registration) {
      throw new CampaignError(
        "validation",
        "a durable canary evidence registration is required before cleanup proof persistence",
      );
    }
    const values = {
      registrationId: input.registrationId,
      jobId: input.jobId,
      scenario: input.scenario,
      aoaDeg: input.aoaDeg,
      caseSlug: input.caseSlug,
      evidenceBase: input.evidenceBase,
      memberAssociationCount: input.memberAssociationCount,
      memberAssociationsSha256: input.memberAssociationsSha256,
      manifestMemberSetSha256: input.manifestMemberSetSha256,
      verification: input.verification,
    };
    const [inserted] = await tx
      .insert(solverEngineCanaryEvidenceCleanupProofs)
      .values(values)
      .onConflictDoNothing({
        target: [
          solverEngineCanaryEvidenceCleanupProofs.registrationId,
          solverEngineCanaryEvidenceCleanupProofs.jobId,
          solverEngineCanaryEvidenceCleanupProofs.caseSlug,
          solverEngineCanaryEvidenceCleanupProofs.evidenceBase,
        ],
      })
      .returning({ id: solverEngineCanaryEvidenceCleanupProofs.id });
    const [row] = inserted
      ? await tx
          .select()
          .from(solverEngineCanaryEvidenceCleanupProofs)
          .where(eq(solverEngineCanaryEvidenceCleanupProofs.id, inserted.id))
          .limit(1)
      : await tx
          .select()
          .from(solverEngineCanaryEvidenceCleanupProofs)
          .where(
            and(
              eq(
                solverEngineCanaryEvidenceCleanupProofs.registrationId,
                input.registrationId,
              ),
              eq(solverEngineCanaryEvidenceCleanupProofs.jobId, input.jobId),
              eq(
                solverEngineCanaryEvidenceCleanupProofs.caseSlug,
                input.caseSlug,
              ),
              eq(
                solverEngineCanaryEvidenceCleanupProofs.evidenceBase,
                input.evidenceBase,
              ),
            ),
          )
          .limit(1);
    if (!row) {
      throw new Error("failed to persist canary evidence cleanup proof");
    }
    const exact =
      row.registrationId === values.registrationId &&
      row.jobId === values.jobId &&
      row.scenario === values.scenario &&
      row.aoaDeg === values.aoaDeg &&
      row.caseSlug === values.caseSlug &&
      row.evidenceBase === values.evidenceBase &&
      row.memberAssociationCount === values.memberAssociationCount &&
      row.memberAssociationsSha256 === values.memberAssociationsSha256 &&
      row.manifestMemberSetSha256 === values.manifestMemberSetSha256 &&
      row.verification === values.verification;
    if (!exact) {
      throw new CampaignError(
        "conflict",
        "canary evidence cleanup proof replay changed immutable evidence identity",
      );
    }
    return {
      ...row,
      scenario: input.scenario,
      replayed: !inserted,
    };
  });
}

export async function requireCompleteOpenCfd2606CanaryCleanupProofSet(
  db: DB,
  registrationId: string,
  expectedProofs: ReadonlyArray<
    PersistOpenCfd2606CanaryEvidenceCleanupProofInput & { id: string }
  >,
): Promise<void> {
  const proofIds = expectedProofs.map((proof) => proof.id);
  if (
    proofIds.length !== 4 ||
    new Set(proofIds).size !== 4 ||
    expectedProofs.some((proof) => proof.registrationId !== registrationId)
  ) {
    throw new CampaignError(
      "invalid_state",
      "all four distinct canary point cleanup proofs must belong to the exact evidence registration",
    );
  }
  const requiredCells = [
    "forced-urans-precalc-no-shedding:0",
    "mpi-2-rans:5",
    "serial-rans:2",
    "serial-rans:5",
  ];
  const actualCells = expectedProofs
    .map((proof) => `${proof.scenario}:${proof.aoaDeg}`)
    .sort();
  const jobIdsByScenario = new Map<string, Set<string>>();
  for (const proof of expectedProofs) {
    const jobIds = jobIdsByScenario.get(proof.scenario) ?? new Set<string>();
    jobIds.add(proof.jobId);
    jobIdsByScenario.set(proof.scenario, jobIds);
  }
  const scenarioJobIds = [...jobIdsByScenario.values()].flatMap((ids) => [
    ...ids,
  ]);
  if (
    canonicalJson(actualCells) !== canonicalJson(requiredCells) ||
    [...jobIdsByScenario.values()].some((ids) => ids.size !== 1) ||
    new Set(scenarioJobIds).size !== 3
  ) {
    throw new CampaignError(
      "invalid_state",
      "canary cleanup proofs must cover serial RANS 2°/5° in one job, MPI-2 RANS 5°, and forced URANS 0° in distinct scenario jobs",
    );
  }
  const rows = await db
    .select()
    .from(solverEngineCanaryEvidenceCleanupProofs)
    .where(
      eq(
        solverEngineCanaryEvidenceCleanupProofs.registrationId,
        registrationId,
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const exact = expectedProofs.every((expected) => {
    const row = byId.get(expected.id);
    return (
      row?.registrationId === registrationId &&
      row.jobId === expected.jobId &&
      row.scenario === expected.scenario &&
      row.aoaDeg === expected.aoaDeg &&
      row.caseSlug === expected.caseSlug &&
      row.evidenceBase === expected.evidenceBase &&
      row.memberAssociationCount === expected.memberAssociationCount &&
      row.memberAssociationsSha256 === expected.memberAssociationsSha256 &&
      row.manifestMemberSetSha256 === expected.manifestMemberSetSha256 &&
      row.verification === expected.verification
    );
  });
  if (rows.length !== 4 || !exact) {
    throw new CampaignError(
      "invalid_state",
      "successful canary attestation requires exactly four durable per-evidence-base cleanup proofs",
    );
  }
}

/** Fetches and validates the relational ownership of an attestation. This is
 * also the direct-DB guard used by cutover finalization; an API caller cannot
 * bypass the canary endpoint by supplying an arbitrary UUID. */
export async function getOpenCfd2606CanaryAttestation(
  db: DB,
  id: string,
  options: { requireEnabledPool?: boolean } = {},
): Promise<OpenCfd2606CanaryAttestation> {
  const [row] = await db
    .select({
      id: solverEngineCanaryAttestations.id,
      solverImplementationId:
        solverEngineCanaryAttestations.solverImplementationId,
      solverRuntimeBuildId: solverEngineCanaryAttestations.solverRuntimeBuildId,
      solverExecutionPoolId:
        solverEngineCanaryAttestations.solverExecutionPoolId,
      receiptSha256: solverEngineCanaryAttestations.receiptSha256,
      evidenceRegistrationId:
        solverEngineCanaryAttestations.evidenceRegistrationId,
      receipt: solverEngineCanaryAttestations.receipt,
      attestedBy: solverEngineCanaryAttestations.attestedBy,
      createdAt: solverEngineCanaryAttestations.createdAt,
      poolEnabled: solverExecutionPools.enabled,
      poolImplementationId: solverExecutionPools.solverImplementationId,
      runtimeImplementationId: solverRuntimeBuilds.solverImplementationId,
      buildId: solverRuntimeBuilds.buildId,
      sourceRevision: solverRuntimeBuilds.sourceRevision,
      imageDigest: solverRuntimeBuilds.imageDigest,
      applicationSourceSha256: solverRuntimeBuilds.applicationSourceSha256,
      packageSha256: solverRuntimeBuilds.packageSha256,
      binarySha256: solverRuntimeBuilds.binarySha256,
      architecture: solverRuntimeBuilds.architecture,
    })
    .from(solverEngineCanaryAttestations)
    .innerJoin(
      solverExecutionPools,
      eq(
        solverExecutionPools.id,
        solverEngineCanaryAttestations.solverExecutionPoolId,
      ),
    )
    .innerJoin(
      solverRuntimeBuilds,
      eq(
        solverRuntimeBuilds.id,
        solverEngineCanaryAttestations.solverRuntimeBuildId,
      ),
    )
    .where(eq(solverEngineCanaryAttestations.id, id))
    .limit(1);
  if (!row) {
    throw new CampaignError(
      "validation",
      "a successful OpenCFD 2606 canary attestation is required",
    );
  }
  if (
    row.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.runtimeImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.poolImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID ||
    !row.evidenceRegistrationId
  ) {
    throw new CampaignError(
      "conflict",
      "canary attestation does not belong to the exact OpenCFD 2606 implementation and pool",
    );
  }
  if (options.requireEnabledPool && !row.poolEnabled) {
    throw new CampaignError(
      "invalid_state",
      "the attested OpenCFD 2606 execution pool is no longer enabled",
    );
  }
  const [registration] = await db
    .select()
    .from(solverEngineCanaryEvidenceRegistrations)
    .where(
      eq(
        solverEngineCanaryEvidenceRegistrations.id,
        row.evidenceRegistrationId,
      ),
    )
    .limit(1);
  if (
    !registration ||
    registration.solverImplementationId !== row.solverImplementationId ||
    registration.solverRuntimeBuildId !== row.solverRuntimeBuildId ||
    registration.solverExecutionPoolId !== row.solverExecutionPoolId
  ) {
    throw new CampaignError(
      "conflict",
      "canary attestation evidence registration ownership differs from its runtime or execution pool",
    );
  }
  const cleanupProofRows = await db
    .select()
    .from(solverEngineCanaryEvidenceCleanupProofs)
    .where(
      eq(
        solverEngineCanaryEvidenceCleanupProofs.registrationId,
        registration.id,
      ),
    );
  const cleanupProofInputs = cleanupProofRows.map((proof) => ({
    id: proof.id,
    registrationId: proof.registrationId,
    jobId: proof.jobId,
    scenario:
      proof.scenario as PersistOpenCfd2606CanaryEvidenceCleanupProofInput["scenario"],
    aoaDeg: proof.aoaDeg,
    caseSlug: proof.caseSlug,
    evidenceBase: proof.evidenceBase,
    memberAssociationCount: proof.memberAssociationCount,
    memberAssociationsSha256: proof.memberAssociationsSha256,
    manifestMemberSetSha256: proof.manifestMemberSetSha256,
    verification: proof.verification,
  }));
  await requireCompleteOpenCfd2606CanaryCleanupProofSet(
    db,
    registration.id,
    cleanupProofInputs,
  );
  assertFinalReceiptRegistrationBinding(
    row.receiptSha256,
    row.receipt,
    registration as OpenCfd2606CanaryEvidenceRegistration,
    cleanupProofInputs,
  );
  return {
    id: row.id,
    solverImplementationId: row.solverImplementationId,
    solverRuntimeBuildId: row.solverRuntimeBuildId,
    solverExecutionPoolId: row.solverExecutionPoolId,
    evidenceRegistrationId: row.evidenceRegistrationId,
    receiptSha256: row.receiptSha256,
    receipt: row.receipt,
    attestedBy: row.attestedBy,
    createdAt: row.createdAt,
    runtime: {
      buildId: row.buildId,
      sourceRevision: row.sourceRevision,
      imageDigest: row.imageDigest,
      applicationSourceSha256: row.applicationSourceSha256,
      packageSha256: row.packageSha256,
      binarySha256: row.binarySha256,
      architecture: row.architecture,
    },
  };
}

/** Inserts one immutable attestation, or returns the exact prior row for a
 * replay of the same canonical receipt. Runtime/pool ownership is checked
 * before and after conflict handling. */
export async function persistOpenCfd2606CanaryAttestation(
  db: DB,
  input: PersistOpenCfd2606CanaryAttestationInput,
): Promise<OpenCfd2606CanaryAttestation & { replayed: boolean }> {
  assertCanonicalReceiptDigest(
    input.receiptSha256,
    input.receipt,
    "canary attestation",
  );
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [pool] = await tx
      .select({
        id: solverExecutionPools.id,
        enabled: solverExecutionPools.enabled,
        solverImplementationId: solverExecutionPools.solverImplementationId,
      })
      .from(solverExecutionPools)
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
      .for("update")
      .limit(1);
    const [runtime] = await tx
      .select({ id: solverRuntimeBuilds.id })
      .from(solverRuntimeBuilds)
      .where(
        and(
          eq(solverRuntimeBuilds.id, input.solverRuntimeBuildId),
          eq(
            solverRuntimeBuilds.solverImplementationId,
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          ),
        ),
      )
      .limit(1);
    if (
      !pool ||
      !pool.enabled ||
      pool.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
    ) {
      throw new CampaignError(
        "invalid_state",
        "the exact OpenCFD 2606 execution pool must remain enabled while attesting",
      );
    }
    if (!runtime) {
      throw new CampaignError(
        "validation",
        "canary runtime is not registered to OpenCFD 2606",
      );
    }
    const [registration] = await tx
      .select()
      .from(solverEngineCanaryEvidenceRegistrations)
      .where(
        eq(
          solverEngineCanaryEvidenceRegistrations.id,
          input.evidenceRegistrationId,
        ),
      )
      .for("key share")
      .limit(1);
    if (
      !registration ||
      registration.solverRuntimeBuildId !== input.solverRuntimeBuildId ||
      registration.solverImplementationId !==
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
      registration.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID
    ) {
      throw new CampaignError(
        "validation",
        "successful canary attestation requires the exact durable evidence registration for its runtime and pool",
      );
    }
    assertFinalReceiptRegistrationBinding(
      input.receiptSha256,
      input.receipt,
      registration as OpenCfd2606CanaryEvidenceRegistration,
      input.cleanupProofs,
    );
    await requireCompleteOpenCfd2606CanaryCleanupProofSet(
      tx,
      registration.id,
      input.cleanupProofs,
    );
    const [inserted] = await tx
      .insert(solverEngineCanaryAttestations)
      .values({
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: input.solverRuntimeBuildId,
        solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
        evidenceRegistrationId: registration.id,
        receiptSha256: input.receiptSha256,
        receipt: input.receipt,
        attestedBy: input.actor?.trim() || null,
      })
      .onConflictDoNothing({
        target: solverEngineCanaryAttestations.receiptSha256,
      })
      .returning({ id: solverEngineCanaryAttestations.id });
    const [existing] = inserted
      ? [inserted]
      : await tx
          .select({ id: solverEngineCanaryAttestations.id })
          .from(solverEngineCanaryAttestations)
          .where(
            eq(
              solverEngineCanaryAttestations.receiptSha256,
              input.receiptSha256,
            ),
          )
          .limit(1);
    if (!existing) {
      throw new Error("failed to persist OpenCFD 2606 canary attestation");
    }
    const attestation = await getOpenCfd2606CanaryAttestation(tx, existing.id, {
      requireEnabledPool: true,
    });
    if (
      attestation.solverRuntimeBuildId !== input.solverRuntimeBuildId ||
      attestation.evidenceRegistrationId !== input.evidenceRegistrationId ||
      attestation.receiptSha256 !== input.receiptSha256 ||
      canonicalJson(attestation.receipt) !== canonicalJson(input.receipt)
    ) {
      throw new CampaignError(
        "conflict",
        "canary receipt replay resolved to different receipt content, runtime, or evidence registration",
      );
    }
    return { ...attestation, replayed: !inserted };
  });
}

export async function ensureOpenCfd2606ContinuationCheck(
  db: DB,
  canaryAttestationId: string,
): Promise<void> {
  await db
    .insert(solverCutoverContinuationChecks)
    .values({ canaryAttestationId })
    .onConflictDoNothing({
      target: solverCutoverContinuationChecks.canaryAttestationId,
    });
}

/** Re-reads the database execution path after campaigns resume. A wrong
 * successor route never advances the durable record. Every campaign that was
 * runnable before the cutover must independently submit through the attested
 * route, and evidence is recognized only when a real target-generation point
 * owns a done result/current attempt plus a checksummed manifest artifact. */
export async function inspectOpenCfd2606Continuation(
  db: DB,
  canaryAttestationId: string,
): Promise<OpenCfd2606ContinuationStatus> {
  const attestation = await getOpenCfd2606CanaryAttestation(
    db,
    canaryAttestationId,
  );
  await ensureOpenCfd2606ContinuationCheck(db, canaryAttestationId);
  const [current] = await db
    .select()
    .from(solverCutoverContinuationChecks)
    .where(
      eq(
        solverCutoverContinuationChecks.canaryAttestationId,
        canaryAttestationId,
      ),
    )
    .limit(1);
  if (!current) throw new Error("continuation check disappeared after insert");
  const checkedAt = new Date();
  const completedCutovers = await db
    .select({
      id: simCampaignSolverCutovers.id,
      campaignId: simCampaignSolverCutovers.campaignId,
      targetGeneration: simCampaignSolverCutovers.targetGeneration,
      targetPointCount: simCampaignSolverCutovers.targetPointCount,
      completedAt: simCampaignSolverCutovers.completedAt,
      priorCampaignStatus: simCampaignSolverCutovers.priorCampaignStatus,
    })
    .from(simCampaignSolverCutovers)
    .where(
      and(
        eq(simCampaignSolverCutovers.canaryAttestationId, canaryAttestationId),
        eq(simCampaignSolverCutovers.status, "completed"),
      ),
    );
  const requiredCutovers = completedCutovers.filter(
    (cutover) =>
      cutover.priorCampaignStatus === "active" ||
      cutover.priorCampaignStatus === "attention",
  );
  requiredCutovers.sort((left, right) =>
    left.campaignId.localeCompare(right.campaignId),
  );

  if (completedCutovers.length === 0) {
    await db
      .update(solverCutoverContinuationChecks)
      .set({ checkedAt, lastError: null })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
    return {
      canaryAttestationId,
      status: current.status as OpenCfd2606ContinuationStatus["status"],
      simJobId: current.simJobId,
      evidenceResultId: current.evidenceResultId,
      checkedAt: checkedAt.toISOString(),
      lastError: null,
      requiredCampaigns: 0,
      campaigns: [],
    };
  }

  if (requiredCutovers.length === 0) {
    if (current.status !== "pending" && current.status !== "not_required") {
      throw new CampaignError(
        "conflict",
        "continuation already recorded runnable campaign work and cannot become not-required",
      );
    }
    await db
      .update(solverCutoverContinuationChecks)
      .set({ status: "not_required", checkedAt, lastError: null })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
    return {
      canaryAttestationId,
      status: "not_required",
      simJobId: null,
      evidenceResultId: null,
      checkedAt: checkedAt.toISOString(),
      lastError: null,
      requiredCampaigns: 0,
      campaigns: [],
    };
  }

  type Candidate = {
    id: string;
    evidence_result_id: string | null;
    submitted_at: Date;
  };
  const campaignProofs: OpenCfd2606ContinuationStatus["campaigns"] = [];
  const candidatesByCampaign = new Map<string, Candidate[]>();

  for (const cutover of requiredCutovers) {
    if (!cutover.completedAt) {
      throw new Error(`completed cutover ${cutover.id} lacks completedAt`);
    }
    const completedAtIso = cutover.completedAt.toISOString();
    const [coverage] = (await db.execute(sql`
      WITH expected_cells AS (
        SELECT source_condition_id, target_condition_id, airfoil_id, aoa_deg,
               target_revision_id
          FROM sim_campaign_solver_cutover_points
         WHERE cutover_id = ${cutover.id}
           AND campaign_id = ${cutover.campaignId}
      ), target_cells AS (
        SELECT condition.supersedes_condition_id AS source_condition_id,
               condition.id AS target_condition_id,
               point.airfoil_id, point.aoa_deg, point.revision_id
          FROM sim_campaign_points point
          JOIN sim_campaign_conditions condition
            ON condition.id = point.condition_id
           AND condition.campaign_id = ${cutover.campaignId}
           AND condition.generation = ${cutover.targetGeneration}
           AND condition.simulation_preset_revision_id = point.revision_id
           AND condition.supersedes_condition_id IS NOT NULL
          JOIN simulation_preset_revisions revision
            ON revision.id = point.revision_id
           AND revision.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
         WHERE point.campaign_id = ${cutover.campaignId}
           AND point.state <> 'released'
      )
      SELECT
        (SELECT count(*)::int FROM expected_cells) AS expected_count,
        (SELECT count(*)::int FROM target_cells) AS target_count,
        (SELECT count(*)::int
           FROM (
             SELECT * FROM expected_cells
             EXCEPT
             SELECT * FROM target_cells
           ) missing
        ) AS missing_count,
        (SELECT count(*)::int
           FROM (
             SELECT * FROM target_cells
             EXCEPT
             SELECT * FROM expected_cells
           ) unexpected
        ) AS unexpected_count
    `)) as unknown as Array<{
      expected_count: number;
      target_count: number;
      missing_count: number;
      unexpected_count: number;
    }>;
    const coverageError =
      !coverage ||
      coverage.expected_count !== cutover.targetPointCount ||
      coverage.target_count !== cutover.targetPointCount ||
      coverage.missing_count !== 0 ||
      coverage.unexpected_count !== 0
        ? `target-generation point coverage is not an exact immutable replay (recorded ${cutover.targetPointCount}, snapshot ${coverage?.expected_count ?? 0}, found ${coverage?.target_count ?? 0}, missing ${coverage?.missing_count ?? 0}, unexpected ${coverage?.unexpected_count ?? 0})`
        : null;
    const candidates = (await db.execute(sql`
      WITH evidence_candidates AS (
        SELECT DISTINCT job.id, result.id AS evidence_result_id,
               job."submittedAt" AS submitted_at, job."createdAt" AS created_at
          FROM sim_campaign_points point
          JOIN sim_campaign_conditions point_condition
            ON point_condition.id = point.condition_id
           AND point_condition.campaign_id = ${cutover.campaignId}
           AND point_condition.generation = ${cutover.targetGeneration}
           AND point_condition.simulation_preset_revision_id = point.revision_id
          JOIN results result
            ON result.id = point.result_id
           AND result.airfoil_id = point.airfoil_id
           AND result.aoa_deg = point.aoa_deg
           AND result.simulation_preset_revision_id = point.revision_id
          JOIN result_attempts attempt
            ON attempt.id = result.current_result_attempt_id
           AND attempt.result_id = result.id
          JOIN sim_jobs job
            ON job.id = result.sim_job_id
           AND job.id = attempt.sim_job_id
           AND job.airfoil_id = result.airfoil_id
           AND job.engine_job_id = result.engine_job_id
           AND job.engine_job_id = attempt.engine_job_id
          JOIN solver_evidence_artifacts artifact
            ON artifact.result_id = result.id
           AND artifact.result_attempt_id = attempt.id
           AND artifact.sim_job_id = job.id
           AND artifact.engine_job_id = job.engine_job_id
           AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
           AND result.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
           AND artifact.airfoil_id = result.airfoil_id
           AND artifact.aoa_deg = result.aoa_deg
           AND artifact.kind = 'manifest'
           AND artifact.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND artifact.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND btrim(artifact.storage_key) <> ''
           AND btrim(artifact.mime_type) <> ''
           AND artifact.sha256 ~ '^[0-9a-f]{64}$'
           AND artifact.byte_size > 0
         WHERE point.campaign_id = ${cutover.campaignId}
           AND point.state = 'terminal'
           AND NOT point.derived_by_symmetry
           AND result.status = 'done'
           AND attempt.status = 'done'
           AND result.source = 'solved'
           AND attempt.source = 'solved'
           AND attempt.airfoil_id = result.airfoil_id
           AND attempt.bc_id = result.bc_id
           AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
           AND attempt.aoa_deg = result.aoa_deg
           AND result.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND result.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND attempt.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND attempt.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job."createdAt" >= ${completedAtIso}::timestamptz
           AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
           AND job.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job.engine_job_id IS NOT NULL
           AND job."submittedAt" IS NOT NULL
      ), routed_candidates AS (
        SELECT job.id, NULL::uuid AS evidence_result_id,
               job."submittedAt" AS submitted_at, job."createdAt" AS created_at
          FROM sim_jobs job
         WHERE job.campaign_id = ${cutover.campaignId}
           AND job."createdAt" >= ${completedAtIso}::timestamptz
           AND EXISTS (
             SELECT 1
               FROM sim_campaign_conditions condition
              WHERE condition.campaign_id = ${cutover.campaignId}
                AND condition.generation = ${cutover.targetGeneration}
                AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
           )
           AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
           AND job.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job.engine_job_id IS NOT NULL
           AND job."submittedAt" IS NOT NULL
      )
      SELECT id, evidence_result_id, submitted_at
        FROM (
          SELECT * FROM evidence_candidates
          UNION ALL
          SELECT * FROM routed_candidates
        ) candidate
       ORDER BY evidence_result_id DESC NULLS LAST, submitted_at, created_at, id
    `)) as unknown as Candidate[];

    // A cancelled/failed shell with no submission acknowledgement provably
    // never reached the engine (for example a transient pre-acceptance 5xx).
    // Pending/submitted rows can still execute later and therefore poison
    // continuation immediately if their route stamp is absent or wrong.
    const wrongRoutes = (await db.execute(sql`
      SELECT job.id
        FROM sim_jobs job
       WHERE job.campaign_id = ${cutover.campaignId}
         AND job."createdAt" >= ${completedAtIso}::timestamptz
         AND EXISTS (
           SELECT 1
             FROM sim_campaign_conditions condition
            WHERE condition.campaign_id = ${cutover.campaignId}
              AND condition.generation = ${cutover.targetGeneration}
              AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
         )
         AND NOT (
           job.status IN ('cancelled', 'failed')
           AND job.engine_job_id IS NULL
           AND job."submittedAt" IS NULL
         )
         AND (
           job.solver_implementation_id IS DISTINCT FROM ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           OR job.solver_execution_pool_id IS DISTINCT FROM ${OPENCFD_2606_EXECUTION_POOL_ID}
         )
       ORDER BY job.id
    `)) as unknown as Array<{ id: string }>;
    const runtimeDefects = (await db.execute(sql`
      SELECT job.id
        FROM sim_jobs job
       WHERE job.campaign_id = ${cutover.campaignId}
         AND job."createdAt" >= ${completedAtIso}::timestamptz
         AND EXISTS (
           SELECT 1
             FROM sim_campaign_conditions condition
            WHERE condition.campaign_id = ${cutover.campaignId}
              AND condition.generation = ${cutover.targetGeneration}
              AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
         )
         AND NOT (
           job.status IN ('cancelled', 'failed')
           AND job.engine_job_id IS NULL
           AND job."submittedAt" IS NULL
         )
         AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
         AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
         AND job.solver_runtime_build_id IS DISTINCT FROM ${attestation.solverRuntimeBuildId}
       ORDER BY job.id
    `)) as unknown as Array<{ id: string }>;

    candidatesByCampaign.set(cutover.campaignId, candidates);
    const selected = candidates[0];
    const routeIds = wrongRoutes.map((row) => row.id);
    const runtimeIds = runtimeDefects.map((row) => row.id);
    const lastError =
      [
        coverageError,
        routeIds.length
          ? `successor-generation jobs used a non-attested route: ${routeIds.join(", ")}`
          : null,
        runtimeIds.length
          ? `successor-generation jobs used a non-attested runtime: ${runtimeIds.join(", ")}`
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join("; ") || null;
    campaignProofs.push({
      campaignId: cutover.campaignId,
      cutoverId: cutover.id,
      status: selected?.evidence_result_id
        ? "evidence"
        : selected
          ? "routed"
          : "pending",
      simJobId: selected?.id ?? null,
      evidenceResultId: selected?.evidence_result_id ?? null,
      lastError,
    });
  }

  const aggregateStatus: "pending" | "routed" | "evidence" =
    campaignProofs.every((proof) => proof.status === "evidence")
      ? "evidence"
      : campaignProofs.every(
            (proof) => proof.status === "routed" || proof.status === "evidence",
          )
        ? "routed"
        : "pending";
  let lastError =
    campaignProofs
      .filter((proof) => proof.lastError)
      .map((proof) => `campaign ${proof.campaignId}: ${proof.lastError}`)
      .join("; ") || null;
  let status = current.status as OpenCfd2606ContinuationStatus["status"];
  let simJobId = current.simJobId;
  let evidenceResultId = current.evidenceResultId;
  const rank = { pending: 0, routed: 1, evidence: 2, not_required: 2 } as const;

  if (status === "not_required") {
    lastError =
      "continuation was previously certified as not required, but runnable completed cutovers now exist";
  } else if (rank[status] > rank[aggregateStatus]) {
    lastError =
      lastError ??
      "successor continuation proof disappeared after the durable status advanced";
  } else if (!lastError) {
    status = aggregateStatus;
    const allCandidates = campaignProofs.flatMap(
      (proof) => candidatesByCampaign.get(proof.campaignId) ?? [],
    );
    if (status === "pending") {
      simJobId = null;
      evidenceResultId = null;
    } else if (status === "routed") {
      const selected =
        allCandidates.find((candidate) => candidate.id === current.simJobId) ??
        allCandidates[0];
      simJobId = selected?.id ?? null;
      evidenceResultId = null;
    } else {
      const selected =
        (current.status === "evidence"
          ? allCandidates.find(
              (candidate) =>
                candidate.id === current.simJobId &&
                candidate.evidence_result_id === current.evidenceResultId,
            )
          : null) ??
        allCandidates.find((candidate) => candidate.evidence_result_id);
      simJobId = selected?.id ?? null;
      evidenceResultId = selected?.evidence_result_id ?? null;
    }
  }

  if (lastError) {
    await db
      .update(solverCutoverContinuationChecks)
      .set({ checkedAt, lastError })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
  } else {
    await db
      .update(solverCutoverContinuationChecks)
      .set({
        status,
        simJobId,
        evidenceResultId,
        checkedAt,
        lastError: null,
        routedAt: status === "pending" ? null : (current.routedAt ?? checkedAt),
        evidenceAt:
          status === "evidence" ? (current.evidenceAt ?? checkedAt) : null,
      })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
  }

  return {
    canaryAttestationId,
    status,
    simJobId,
    evidenceResultId,
    checkedAt: checkedAt.toISOString(),
    lastError,
    requiredCampaigns: requiredCutovers.length,
    campaigns: campaignProofs,
  };
}
