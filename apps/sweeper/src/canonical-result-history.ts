import type { DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import type { AttemptEvidenceArchiveReader } from "@aerodb/db/attempt-evidence-reader";
import {
  bindCanonicalSubtree,
  canonicalSubtreeCandidates,
  confirmCanonicalSubtree,
  readCanonicalSubtree,
  restoreCanonicalSubtree,
  type CanonicalFieldProof,
  type CanonicalHistoryCandidate,
} from "@aerodb/db/result-history-subtrees";
import type { AttemptEvidenceArchiveStore } from "./attempt-evidence-store";
import type { AttemptRelay } from "./hz-attempt-migration";
import { sameArchive } from "./hz-attempt-custody";
import { retainHzAttemptVolume } from "./hz-attempt-volume";
import {
  withActiveHzTransfer,
  type HzWorkerOwner,
} from "./hz-attempt-transfer-fence";
import type { AttemptEvidenceArchiveIdentity } from "@aerodb/db/attempt-evidence-catalog";
import { requireConfiguredAttemptHubRole } from "@aerodb/db/attempt-evidence-verified-policy";

export async function canonicalFieldReadback(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  input: Pick<CanonicalFieldProof, "kind" | "resultId" | "reference">,
) {
  return readCanonicalSubtree(
    db,
    reader,
    input.resultId,
    input.kind,
    input.reference,
  );
}

async function confirmOrRestore(
  proof: CanonicalFieldProof,
  read: () => Promise<CanonicalFieldProof | null>,
  confirm: (p: CanonicalFieldProof) => Promise<boolean>,
  restore: (p: CanonicalFieldProof) => Promise<boolean>,
) {
  try {
    const actual = await read();
    if (!actual) return false; // A newer publisher already removed/replaced the binding.
    if (
      actual.reference !== proof.reference ||
      actual.archiveId !== proof.archiveId ||
      actual.generation !== proof.generation ||
      actual.fieldText !== proof.fieldText
    )
      throw Error("Canonical result field differs after read-through");
    return await confirm(actual);
  } catch (e) {
    // CAS restores only the same reference and never retargets a replacement.
    await restore(proof);
    throw e;
  }
}

export async function settleHubCanonicalFields(
  db: DB,
  store: AttemptEvidenceArchiveStore,
  attemptId: string,
  reader?: AttemptEvidenceArchiveReader,
) {
  const installed: CanonicalFieldProof[] = [];
  requireConfiguredAttemptHubRole();
  const appReader =
    reader ??
    (await import("../../api/src/attempt-evidence-reader"))
      .apiAttemptEvidenceReader;
  for (const candidate of await canonicalSubtreeCandidates(db, attemptId)) {
    const ar = await getAttemptEvidenceArchive(db, candidate.archive);
    if (ar.bucket !== process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim())
      throw new Error("Canonical history original is outside the configured hub bucket");
    const source = await store.read(ar, AbortSignal.timeout(30000));
    const proof = await bindCanonicalSubtree(
      db,
      candidate,
      ar,
      source,
      new Date(),
    );
    if (
      proof &&
      (await confirmOrRestore(
        proof,
        () => canonicalFieldReadback(db, appReader, proof),
        (p) => confirmCanonicalSubtree(db, p),
        (p) => restoreCanonicalSubtree(db, p),
      ))
    )
      installed.push(proof);
  }
  return installed.map(({ fieldText, ...fields }) => ({
    ...fields,
    originalFieldBytes: Buffer.byteLength(fieldText),
  }));
}

export async function bindWorkerCanonicalField(
  db: DB,
  candidate: CanonicalHistoryCandidate,
  supplied: AttemptEvidenceArchiveIdentity,
  packed: Buffer,
  owner?: HzWorkerOwner,
) {
  const archive = await getAttemptEvidenceArchive(db, candidate.archive);
  sameArchive(archive, supplied);
  // The credentialed hub has just read this exact generation to EOF. The
  // existing worker volume verifies the same compressed object independently.
  const original = await retainHzAttemptVolume(db, archive, packed);
  return withActiveHzTransfer(db, owner, (tx) =>
    bindCanonicalSubtree(tx, candidate, archive, original, supplied.verifiedAt),
  );
}

export async function settleWorkerCanonicalFields(
  relay: AttemptRelay,
  attemptId: string,
) {
  const candidates: CanonicalHistoryCandidate[] = await relay.worker({
    operation: "canonical-candidates",
    attemptId,
  });
  const installed = [];
  for (const candidate of candidates) {
    const ar = await relay.worker({
      operation: "catalog",
      archiveId: candidate.archive,
    });
    const registration = await relay.worker({ operation: "bound" });
    const fresh = await relay.hub({
      operation: "read-canonical-source",
      identity: ar,
      instance: registration.instance,
      solver: registration.solver,
    });
    sameArchive(ar, fresh.identity);
    // Bound both RPCs to the same actual immutable generation as 'read'.
    const proof: CanonicalFieldProof | null = await relay.worker(
      { operation: "canonical-bind", candidate, ...fresh },
      true,
    );
    if (!proof) continue;
    const ok = await confirmOrRestore(
      proof,
      () =>
        relay.api({
          operation: "canonical-read",
          resultId: proof.resultId,
          kind: proof.kind,
          reference: proof.reference,
        }),
      async (p) =>
        (await relay.worker({ operation: "canonical-confirm", proof: p }, true))
          .confirmed,
      async (p) =>
        (await relay.worker({ operation: "canonical-restore", proof: p }, true))
          .restored,
    );
    if (ok)
      installed.push({
        resultId: proof.resultId,
        kind: proof.kind,
        reference: proof.reference,
        archiveId: ar.id,
        generation: proof.generation,
        originalFieldBytes: Buffer.byteLength(proof.fieldText),
      });
  }
  return installed;
}
