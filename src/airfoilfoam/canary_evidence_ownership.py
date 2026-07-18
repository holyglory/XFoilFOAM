"""Preserve cutover-canary GCS evidence and strip only verified local copies.

This path never creates aerodynamic evidence and never deletes a GCS object.
Dry-run is the default.  The mutating pass requires an immutable database
ownership acknowledgement, then performs a fresh generation-pinned download
and authenticates the tar, embedded manifest, and every bundled member before
removing only local archive/raw evidence paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

from .config import Settings, get_settings
from .evidence_migration import (
    EvidenceMigrationError,
    MigrationTarget,
    _existing_packaged_paths,
    _file_size_sha256,
    _job_guard,
    _remove_path,
    _require_contained_target,
)
from .evidence_runtime import (
    EVIDENCE_ARCHIVE_NAME,
    evidence_object_store,
    evidence_pointer_path,
)
from .evidence_store import (
    EvidenceHydrationError,
    EvidenceStoreError,
    RemoteEvidencePointer,
    _verify_archive_manifest_members,
    inspect_tar_zst,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
)


CLAIM_KIND = "opencfd2606-operational-canary-evidence-registration"
APPROVED_INVENTORY_KIND = "opencfd2606-operational-canary-approved-inventory"
APPROVED_INVENTORY_SHA256 = "1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"
APPROVED_ATTESTATION_ID = "112f52cd-eb8b-4908-bc79-6353daea6e12"
APPROVED_ATTESTATION_DATABASE_RECEIPT_SHA256 = "f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149"
APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE = 2_211_018
APPROVED_ATTESTATION_RETAINED_RECEIPT_SHA256 = "505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8"
APPROVED_ATTESTATION_RETAINED_RECEIPT_BYTE_SIZE = 2_313_736
APPROVED_OBJECT_COUNT = 16
APPROVED_JOB_COUNT = 11
APPROVED_STORED_BYTE_SIZE = 216_240_757
APPROVED_RUNTIME_BUILD_COUNT = 4
APPROVED_ATTESTED_COUNT = 4
APPROVED_UNATTESTED_COUNT = 12
ACK_STATE = "operational_canary_owned"
RETENTION_KIND = "opencfd2606-operational-canary-local-retention-receipt"
LOCAL_RECEIPT_NAME = "operational_canary_retention.receipt.json"
LOCAL_INTENT_NAME = "operational_canary_retention.intent.json"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GENERATION = re.compile(r"^[1-9][0-9]{0,19}$")
CRC32C = re.compile(r"^[A-Za-z0-9+/]{6}==$")
MAX_GCS_GENERATION = 18_446_744_073_709_551_615
OPENCFD_2606 = "2f8bc764-09ae-4ff3-8fd2-260600000001"
UNATTESTED_ALLOWLIST = {
    "prod-20260717-63385777be73-r2": ("queue_probe_same_build_replay", 14),
    "prod-20260717-cd0967a1ba4e-r3": ("retention_retry", 14),
    "prod-20260717-2ab861cb4ce6-r4": ("transient_retention", 137),
}


class OperationalCanaryEvidenceError(RuntimeError):
    """One operational-canary identity or retention proof is unsafe."""


@dataclass(frozen=True)
class LocalTarget:
    claim: dict[str, Any]
    job_root: Path
    evidence_dir: Path
    pointer: RemoteEvidencePointer
    manifest_bytes: bytes
    archive_member_count: int
    verified_member_count: int


@dataclass(frozen=True)
class RetentionResult:
    job_id: str
    evidence_path: str
    status: str
    remote_bytes: int
    bytes_deleted: int = 0
    verification: str | None = None
    receipt: dict[str, Any] | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "evidencePath": self.evidence_path,
            "status": self.status,
            "remoteBytes": self.remote_bytes,
            "bytesDeleted": self.bytes_deleted,
            "verification": self.verification,
            "receipt": self.receipt,
            "message": self.message,
        }


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OperationalCanaryEvidenceError(f"{label} must be an object")
    return value


def _exact_keys(value: Mapping[str, object], expected: Iterable[str], label: str) -> None:
    if set(value) != set(expected):
        raise OperationalCanaryEvidenceError(f"{label} has unexpected or missing fields")


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise OperationalCanaryEvidenceError(f"{label} must be an exact non-empty string")
    return value


def _nullable_text(value: object, label: str) -> str | None:
    return None if value is None else _text(value, label)


def _pattern(value: object, label: str, regex: re.Pattern[str]) -> str:
    parsed = _text(value, label)
    if regex.fullmatch(parsed) is None:
        raise OperationalCanaryEvidenceError(f"{label} has an invalid format")
    return parsed


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > 9_007_199_254_740_991:
        raise OperationalCanaryEvidenceError(f"{label} must be a positive safe integer")
    return value


def _safe_relative(value: object, label: str, *, one_segment: bool = False) -> str:
    parsed = _text(value, label)
    path = PurePosixPath(parsed)
    if (
        path.is_absolute()
        or "\\" in parsed
        or "\0" in parsed
        or any(part in {"", ".", ".."} for part in path.parts)
        or (one_segment and len(path.parts) != 1)
    ):
        raise OperationalCanaryEvidenceError(f"{label} must be a safe relative path")
    return path.as_posix()


def _uuid(value: object, label: str) -> str:
    parsed = _text(value, label)
    try:
        identifier = uuid.UUID(parsed)
    except ValueError as exc:
        raise OperationalCanaryEvidenceError(f"{label} must be a UUID") from exc
    if str(identifier) != parsed:
        raise OperationalCanaryEvidenceError(f"{label} must use canonical UUID spelling")
    return parsed


def _utc(value: object, label: str) -> str:
    parsed = _text(value, label)
    try:
        timestamp = datetime.fromisoformat(parsed[:-1] + "+00:00" if parsed.endswith("Z") else parsed)
    except ValueError as exc:
        raise OperationalCanaryEvidenceError(f"{label} must be an ISO timestamp") from exc
    if "T" not in parsed or timestamp.tzinfo is None or timestamp.utcoffset().total_seconds() != 0:
        raise OperationalCanaryEvidenceError(f"{label} must be an ISO UTC timestamp")
    return parsed


def _canonical(value: object) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _sha_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _parse_claim(value: object) -> dict[str, Any]:
    claim = _object(value, "registration claim")
    _exact_keys(
        claim,
        (
            "schemaVersion", "kind", "approvedInventorySha256", "provenance",
            "runtime", "job", "evidence", "target", "operator", "capturedAt",
        ),
        "registration claim",
    )
    if claim.get("schemaVersion") != 1 or claim.get("kind") != CLAIM_KIND:
        raise OperationalCanaryEvidenceError("unsupported registration claim")
    if claim.get("approvedInventorySha256") != APPROVED_INVENTORY_SHA256:
        raise OperationalCanaryEvidenceError("registration claim is not bound to the sealed approved inventory")
    provenance = _object(claim["provenance"], "provenance")
    runtime = _object(claim["runtime"], "runtime")
    job = _object(claim["job"], "job")
    evidence = _object(claim["evidence"], "evidence")
    target = _object(claim["target"], "target")
    _exact_keys(runtime, (
        "solverImplementationId", "solverRuntimeBuildId", "family", "distribution", "version", "buildId",
        "sourceRevision", "imageDigest", "applicationSourceSha256", "packageSha256", "binarySha256", "architecture",
    ), "runtime")
    if (
        runtime.get("solverImplementationId") != OPENCFD_2606
        or runtime.get("family") != "openfoam"
        or runtime.get("distribution") != "opencfd"
        or runtime.get("version") != "2606"
    ):
        raise OperationalCanaryEvidenceError("runtime must be the exact OpenCFD 2606 implementation")
    _uuid(runtime.get("solverRuntimeBuildId"), "runtime build row id")
    _text(runtime.get("buildId"), "runtime build id")
    for key in ("sourceRevision", "architecture"):
        _nullable_text(runtime.get(key), f"runtime {key}")
    image = _nullable_text(runtime.get("imageDigest"), "runtime image digest")
    if image is not None and re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None:
        raise OperationalCanaryEvidenceError("runtime image digest is malformed")
    for key in ("applicationSourceSha256", "packageSha256", "binarySha256"):
        _pattern(runtime.get(key), f"runtime {key}", SHA256)

    if provenance.get("kind") == "attested_canary":
        _exact_keys(provenance, ("kind", "attestationId"), "attested provenance")
        _uuid(provenance.get("attestationId"), "attestation id")
    elif provenance.get("kind") == "unattested_cutover_canary":
        _exact_keys(provenance, ("kind", "sourceBuild", "sourceJournal", "operatorReceipt", "failure"), "unattested provenance")
        build = _object(provenance["sourceBuild"], "source build")
        journal = _object(provenance["sourceJournal"], "source journal")
        operator = _object(provenance["operatorReceipt"], "operator receipt")
        failure = _object(provenance["failure"], "cutover failure")
        _exact_keys(build, ("buildId", "sha256", "byteSize"), "source build")
        _exact_keys(journal, ("sha256", "byteSize"), "source journal")
        _exact_keys(operator, ("sha256", "byteSize"), "operator receipt")
        _exact_keys(failure, ("phase", "exitCode"), "cutover failure")
        build_id = _text(build.get("buildId"), "source build id")
        expected = UNATTESTED_ALLOWLIST.get(build_id)
        if expected is None or tuple((failure.get("phase"), failure.get("exitCode"))) != expected:
            raise OperationalCanaryEvidenceError("unattested source build/failure is outside the exact recovery allowlist")
        if build_id != runtime.get("buildId"):
            raise OperationalCanaryEvidenceError("source build differs from runtime build")
        for source, label in ((build, "source build"), (journal, "source journal"), (operator, "operator receipt")):
            _pattern(source.get("sha256"), f"{label} SHA-256", SHA256)
            _positive_int(source.get("byteSize"), f"{label} byte size")
    else:
        raise OperationalCanaryEvidenceError("unsupported provenance kind")

    _exact_keys(job, ("id", "state", "statusSha256", "statusByteSize"), "job")
    if job.get("state") != "completed":
        raise OperationalCanaryEvidenceError("operational canary job must be completed")
    _safe_relative(job.get("id"), "job id", one_segment=True)
    _pattern(job.get("statusSha256"), "status SHA-256", SHA256)
    _positive_int(job.get("statusByteSize"), "status byte size")
    _exact_keys(evidence, (
        "path", "pointerSha256", "pointerByteSize", "archiveSha256", "archiveByteSize",
        "manifestSha256", "manifestByteSize", "archiveMemberSetSha256", "archiveMemberCount",
    ), "evidence")
    _safe_relative(evidence.get("path"), "evidence path")
    for key in ("pointerSha256", "archiveSha256", "manifestSha256", "archiveMemberSetSha256"):
        _pattern(evidence.get(key), f"evidence {key}", SHA256)
    for key in ("pointerByteSize", "archiveByteSize", "manifestByteSize", "archiveMemberCount"):
        _positive_int(evidence.get(key), f"evidence {key}")
    _exact_keys(target, (
        "bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c",
        "tarSha256", "tarByteSize", "zstdLevel",
    ), "target")
    _text(target.get("bucket"), "target bucket")
    object_key = _safe_relative(target.get("objectKey"), "target object key")
    generation = _pattern(target.get("generation"), "target generation", GENERATION)
    if int(generation) > MAX_GCS_GENERATION:
        raise OperationalCanaryEvidenceError("target generation exceeds GCS uint64")
    stored_sha = _pattern(target.get("storedSha256"), "target stored SHA-256", SHA256)
    expected_key = f"solver-evidence/v1/sha256/{stored_sha[:2]}/{stored_sha}.tar.zst"
    if object_key != expected_key:
        raise OperationalCanaryEvidenceError("target object key is not the canonical content-addressed key")
    _positive_int(target.get("storedByteSize"), "target stored byte size")
    _pattern(target.get("crc32c"), "target CRC32C", CRC32C)
    _pattern(target.get("tarSha256"), "target tar SHA-256", SHA256)
    _positive_int(target.get("tarByteSize"), "target tar byte size")
    level = _positive_int(target.get("zstdLevel"), "target zstd level")
    if level > 22:
        raise OperationalCanaryEvidenceError("target zstd level exceeds 22")
    if evidence.get("archiveSha256") != stored_sha or evidence.get("archiveByteSize") != target.get("storedByteSize"):
        raise OperationalCanaryEvidenceError("local archive identity differs from GCS target")
    _text(claim.get("operator"), "operator")
    _utc(claim.get("capturedAt"), "capture timestamp")
    return json.loads(_canonical(claim))


def load_approved_inventory(path: Path) -> dict[str, Any]:
    """Load and authenticate the repository-sealed exact 16-object inventory."""

    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise OperationalCanaryEvidenceError(f"cannot read approved inventory: {exc}") from exc
    inventory = _object(value, "approved inventory")
    _exact_keys(
        inventory,
        (
            "schemaVersion", "kind", "approvedCount", "approvedJobCount",
            "approvedStoredByteSize", "operator", "inputs", "runtimeBuilds", "objects",
        ),
        "approved inventory",
    )
    if inventory.get("schemaVersion") != 1 or inventory.get("kind") != APPROVED_INVENTORY_KIND:
        raise OperationalCanaryEvidenceError("unsupported approved inventory")
    canonical = _canonical(inventory)
    if _sha_bytes(canonical.encode("utf-8")) != APPROVED_INVENTORY_SHA256:
        raise OperationalCanaryEvidenceError("approved inventory digest differs from the migration-sealed inventory")
    if (
        inventory.get("approvedCount") != APPROVED_OBJECT_COUNT
        or inventory.get("approvedJobCount") != APPROVED_JOB_COUNT
    ):
        raise OperationalCanaryEvidenceError(
            "approved inventory has the wrong sealed object/job counts"
        )
    if inventory.get("approvedStoredByteSize") != APPROVED_STORED_BYTE_SIZE:
        raise OperationalCanaryEvidenceError("approved inventory byte total is not the protected production total")
    _text(inventory.get("operator"), "approved inventory operator")

    inputs = _object(inventory.get("inputs"), "approved inventory inputs")
    _exact_keys(
        inputs,
        ("localInventory", "gcsInventory", "attestationReceipt"),
        "approved inventory inputs",
    )
    for key in ("localInventory", "gcsInventory"):
        proof = _object(inputs.get(key), f"approved {key}")
        _exact_keys(proof, ("sha256", "byteSize"), f"approved {key}")
        _pattern(proof.get("sha256"), f"approved {key} SHA-256", SHA256)
        _positive_int(proof.get("byteSize"), f"approved {key} byte size")
    attestation_receipt = _object(
        inputs.get("attestationReceipt"), "approved attestation receipt"
    )
    _exact_keys(
        attestation_receipt,
        (
            "attestationId",
            "databaseReceiptSha256",
            "retainedReceiptSha256",
            "retainedReceiptByteSize",
        ),
        "approved attestation receipt",
    )
    if attestation_receipt.get("attestationId") != APPROVED_ATTESTATION_ID:
        raise OperationalCanaryEvidenceError("approved attestation id differs from production")
    if (
        attestation_receipt.get("databaseReceiptSha256")
        != APPROVED_ATTESTATION_DATABASE_RECEIPT_SHA256
    ):
        raise OperationalCanaryEvidenceError(
            "approved database receipt digest differs from production"
        )
    if (
        attestation_receipt.get("retainedReceiptSha256")
        != APPROVED_ATTESTATION_RETAINED_RECEIPT_SHA256
    ):
        raise OperationalCanaryEvidenceError(
            "approved retained receipt digest differs from production"
        )
    if (
        attestation_receipt.get("retainedReceiptByteSize")
        != APPROVED_ATTESTATION_RETAINED_RECEIPT_BYTE_SIZE
    ):
        raise OperationalCanaryEvidenceError("approved attestation receipt byte size differs from production")

    runtime_rows = inventory.get("runtimeBuilds")
    object_rows = inventory.get("objects")
    if (
        not isinstance(runtime_rows, list)
        or len(runtime_rows) != APPROVED_RUNTIME_BUILD_COUNT
    ):
        raise OperationalCanaryEvidenceError(
            "approved inventory has the wrong sealed runtime-build count"
        )
    if not isinstance(object_rows, list) or len(object_rows) != APPROVED_OBJECT_COUNT:
        raise OperationalCanaryEvidenceError(
            "approved inventory has the wrong sealed object count"
        )
    runtime_by_build: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(runtime_rows):
        runtime = _object(raw, f"approved runtime {index}")
        required = {
            "id", "provenanceKey", "buildId", "sourceRevision", "imageDigest",
            "applicationSourceSha256", "packageSha256", "binarySha256", "architecture",
        }
        optional = {"sourceJournal", "failure"}
        if not required.issubset(runtime) or not set(runtime).issubset(required | optional):
            raise OperationalCanaryEvidenceError(f"approved runtime {index} has unexpected or missing fields")
        build_id = _text(runtime.get("buildId"), f"approved runtime {index} build id")
        if build_id in runtime_by_build:
            raise OperationalCanaryEvidenceError("approved inventory repeats a runtime build")
        _uuid(runtime.get("id"), f"approved runtime {index} id")
        _pattern(runtime.get("provenanceKey"), f"approved runtime {index} provenance key", SHA256)
        _nullable_text(runtime.get("sourceRevision"), f"approved runtime {index} source revision")
        image = _nullable_text(runtime.get("imageDigest"), f"approved runtime {index} image digest")
        if image is not None and re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None:
            raise OperationalCanaryEvidenceError("approved runtime image digest is malformed")
        for key in ("applicationSourceSha256", "packageSha256", "binarySha256"):
            _pattern(runtime.get(key), f"approved runtime {index} {key}", SHA256)
        _nullable_text(runtime.get("architecture"), f"approved runtime {index} architecture")
        if build_id.endswith("-r5"):
            if set(runtime) != required:
                raise OperationalCanaryEvidenceError("attested r5 runtime must not carry failed-cutover proof")
        else:
            journal = _object(runtime.get("sourceJournal"), f"approved runtime {index} source journal")
            failure = _object(runtime.get("failure"), f"approved runtime {index} failure")
            _exact_keys(journal, ("fileName", "sha256", "byteSize"), "approved source journal")
            _safe_relative(journal.get("fileName"), "approved source journal file", one_segment=True)
            _pattern(journal.get("sha256"), "approved source journal SHA-256", SHA256)
            _positive_int(journal.get("byteSize"), "approved source journal byte size")
            _exact_keys(failure, ("phase", "exitCode"), "approved cutover failure")
            if tuple((failure.get("phase"), failure.get("exitCode"))) != UNATTESTED_ALLOWLIST.get(build_id):
                raise OperationalCanaryEvidenceError("approved runtime build/failure differs from the closed allowlist")
        runtime_by_build[build_id] = runtime

    job_paths: set[tuple[str, str]] = set()
    targets: set[tuple[str, str, str]] = set()
    jobs: set[str] = set()
    total_bytes = 0
    provenance_counts = {"attested_canary": 0, "unattested_cutover_canary": 0}
    for index, raw in enumerate(object_rows):
        row = _object(raw, f"approved object {index}")
        _exact_keys(
            row,
            ("engineJobId", "evidencePath", "buildId", "provenance", "status", "pointer", "manifest", "target"),
            f"approved object {index}",
        )
        job_id = _safe_relative(row.get("engineJobId"), f"approved object {index} job id", one_segment=True)
        evidence_path = _safe_relative(row.get("evidencePath"), f"approved object {index} evidence path")
        build_id = _text(row.get("buildId"), f"approved object {index} build id")
        if build_id not in runtime_by_build:
            raise OperationalCanaryEvidenceError("approved object references an unknown runtime")
        provenance = _object(row.get("provenance"), f"approved object {index} provenance")
        kind = provenance.get("kind")
        if kind == "attested_canary":
            _exact_keys(provenance, ("kind", "attestationId"), "approved attested provenance")
            _uuid(provenance.get("attestationId"), "approved attestation id")
            if provenance.get("attestationId") != attestation_receipt["attestationId"]:
                raise OperationalCanaryEvidenceError("approved object references a different attestation")
            if not build_id.endswith("-r5"):
                raise OperationalCanaryEvidenceError("only the exact r5 runtime may use attested provenance")
        elif kind == "unattested_cutover_canary":
            _exact_keys(provenance, ("kind",), "approved unattested provenance")
            if build_id.endswith("-r5"):
                raise OperationalCanaryEvidenceError("r5 inventory rows must use durable attestation provenance")
        else:
            raise OperationalCanaryEvidenceError("approved object has unsupported provenance")
        provenance_counts[kind] += 1
        for field in ("status", "pointer"):
            identity = _object(row.get(field), f"approved object {index} {field}")
            _exact_keys(identity, ("sha256", "byteSize"), f"approved object {index} {field}")
            _pattern(identity.get("sha256"), f"approved object {index} {field} SHA-256", SHA256)
            _positive_int(identity.get("byteSize"), f"approved object {index} {field} byte size")
        manifest = _object(row.get("manifest"), f"approved object {index} manifest")
        _exact_keys(manifest, ("sha256", "byteSize", "memberSetSha256", "memberCount"), "approved manifest")
        _pattern(manifest.get("sha256"), "approved manifest SHA-256", SHA256)
        _positive_int(manifest.get("byteSize"), "approved manifest byte size")
        _pattern(manifest.get("memberSetSha256"), "approved member-set SHA-256", SHA256)
        _positive_int(manifest.get("memberCount"), "approved member count")
        target = _object(row.get("target"), f"approved object {index} target")
        _exact_keys(
            target,
            ("bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c", "tarSha256", "tarByteSize", "zstdLevel"),
            "approved target",
        )
        # The normal claim parser supplies the strict target/path checks.
        candidate = _approved_claim(inventory, row, captured_at="2026-07-18T00:00:00Z")
        _parse_claim(candidate)
        job_path = (job_id, evidence_path)
        target_id = (target["bucket"], target["objectKey"], target["generation"])
        if job_path in job_paths or target_id in targets:
            raise OperationalCanaryEvidenceError("approved inventory repeats a job path or exact GCS generation")
        job_paths.add(job_path)
        targets.add(target_id)
        jobs.add(job_id)
        total_bytes += target["storedByteSize"]
    if len(jobs) != APPROVED_JOB_COUNT or total_bytes != APPROVED_STORED_BYTE_SIZE:
        raise OperationalCanaryEvidenceError("approved object set does not conserve the protected job/byte totals")
    if provenance_counts != {
        "attested_canary": APPROVED_ATTESTED_COUNT,
        "unattested_cutover_canary": APPROVED_UNATTESTED_COUNT,
    }:
        raise OperationalCanaryEvidenceError("approved object set does not conserve the 4 attested / 12 unattested split")
    return json.loads(canonical)


def _approved_claim(
    inventory: Mapping[str, Any],
    row: Mapping[str, Any],
    *,
    captured_at: str,
) -> dict[str, Any]:
    runtime_row = next(
        runtime for runtime in inventory["runtimeBuilds"]
        if runtime["buildId"] == row["buildId"]
    )
    runtime = {
        "solverImplementationId": OPENCFD_2606,
        "solverRuntimeBuildId": runtime_row["id"],
        "family": "openfoam",
        "distribution": "opencfd",
        "version": "2606",
        "buildId": runtime_row["buildId"],
        "sourceRevision": runtime_row["sourceRevision"],
        "imageDigest": runtime_row["imageDigest"],
        "applicationSourceSha256": runtime_row["applicationSourceSha256"],
        "packageSha256": runtime_row["packageSha256"],
        "binarySha256": runtime_row["binarySha256"],
        "architecture": runtime_row["architecture"],
    }
    if row["provenance"]["kind"] == "attested_canary":
        provenance = dict(row["provenance"])
    else:
        provenance = {
            "kind": "unattested_cutover_canary",
            # The exact completed status is the independently protected build
            # receipt.  Its engine block pins all executable/runtime content.
            "sourceBuild": {
                "buildId": runtime_row["buildId"],
                "sha256": row["status"]["sha256"],
                "byteSize": row["status"]["byteSize"],
            },
            "sourceJournal": {
                "sha256": runtime_row["sourceJournal"]["sha256"],
                "byteSize": runtime_row["sourceJournal"]["byteSize"],
            },
            # The provider inventory is the operator receipt for the exact
            # 16-generation set; its bytes are pinned globally and per claim.
            "operatorReceipt": dict(inventory["inputs"]["gcsInventory"]),
            "failure": dict(runtime_row["failure"]),
        }
    return {
        "schemaVersion": 1,
        "kind": CLAIM_KIND,
        "approvedInventorySha256": APPROVED_INVENTORY_SHA256,
        "provenance": provenance,
        "runtime": runtime,
        "job": {
            "id": row["engineJobId"],
            "state": "completed",
            "statusSha256": row["status"]["sha256"],
            "statusByteSize": row["status"]["byteSize"],
        },
        "evidence": {
            "path": row["evidencePath"],
            "pointerSha256": row["pointer"]["sha256"],
            "pointerByteSize": row["pointer"]["byteSize"],
            "archiveSha256": row["target"]["storedSha256"],
            "archiveByteSize": row["target"]["storedByteSize"],
            "manifestSha256": row["manifest"]["sha256"],
            "manifestByteSize": row["manifest"]["byteSize"],
            "archiveMemberSetSha256": row["manifest"]["memberSetSha256"],
            "archiveMemberCount": row["manifest"]["memberCount"],
        },
        "target": dict(row["target"]),
        "operator": inventory["operator"],
        "capturedAt": captured_at,
    }


def _assert_claim_approved(claim: Mapping[str, Any], inventory: Mapping[str, Any]) -> None:
    matches = [
        row for row in inventory["objects"]
        if row["engineJobId"] == claim["job"]["id"]
        and row["evidencePath"] == claim["evidence"]["path"]
    ]
    if len(matches) != 1:
        raise OperationalCanaryEvidenceError("claim is not one of the exact 16 approved job/evidence members")
    expected = _approved_claim(inventory, matches[0], captured_at=claim["capturedAt"])
    if expected != claim:
        raise OperationalCanaryEvidenceError("claim widens or changes the sealed exact-16 identity")


def _proof_file(root: Path, sha256: str, size: int, label: str) -> None:
    path = root / sha256
    if not path.is_file() or path.is_symlink():
        raise OperationalCanaryEvidenceError(f"protected {label} file is missing: {sha256}")
    actual_size, actual_sha = _file_size_sha256(path)
    if (actual_size, actual_sha) != (size, sha256):
        raise OperationalCanaryEvidenceError(f"protected {label} digest/size mismatch")


def _runtime_from_status(status: Mapping[str, Any]) -> Mapping[str, Any]:
    engine = status.get("engine")
    if not isinstance(engine, Mapping):
        raise OperationalCanaryEvidenceError("completed status has no runtime engine identity")
    return engine


def _verify_status_runtime(claim: Mapping[str, Any], status: Mapping[str, Any]) -> None:
    if status.get("state") != "completed":
        raise OperationalCanaryEvidenceError("status.json does not record completed state")
    engine = _runtime_from_status(status)
    runtime = _object(claim["runtime"], "claim runtime")
    expected = {
        "family": runtime["family"],
        "distribution": runtime["distribution"],
        "version": runtime["version"],
        "build_id": runtime["buildId"],
        "source_revision": runtime["sourceRevision"],
        "image_digest": runtime["imageDigest"],
        "application_source_sha256": runtime["applicationSourceSha256"],
        "package_sha256": runtime["packageSha256"],
        "binary_sha256": runtime["binarySha256"],
        "architecture": runtime["architecture"],
    }
    for key, value in expected.items():
        if engine.get(key) != value:
            raise OperationalCanaryEvidenceError(f"status runtime differs for {key}")


def validate_local_claim(
    value: object,
    jobs_root: Path,
    *,
    approved_inventory: Mapping[str, Any],
    protected_proof_root: Path | None = None,
    permit_completed_receipt: bool = False,
) -> LocalTarget:
    claim = _parse_claim(value)
    _assert_claim_approved(claim, approved_inventory)
    job = claim["job"]
    evidence = claim["evidence"]
    target = claim["target"]
    job_root = Path(jobs_root) / job["id"]
    evidence_dir = job_root.joinpath(*PurePosixPath(evidence["path"]).parts)
    migration_target = MigrationTarget(job_root, evidence_dir)
    try:
        _require_contained_target(migration_target)
    except EvidenceMigrationError as exc:
        raise OperationalCanaryEvidenceError(str(exc)) from exc
    if not job_root.is_dir() or not evidence_dir.is_dir():
        raise OperationalCanaryEvidenceError("exact job/evidence directory does not exist")
    status_path = job_root / "status.json"
    status_bytes = status_path.read_bytes()
    if (_sha_bytes(status_bytes), len(status_bytes)) != (job["statusSha256"], job["statusByteSize"]):
        raise OperationalCanaryEvidenceError("status.json digest or byte size differs from claim")
    try:
        status = json.loads(status_bytes)
    except json.JSONDecodeError as exc:
        raise OperationalCanaryEvidenceError("status.json is invalid JSON") from exc
    if not isinstance(status, Mapping):
        raise OperationalCanaryEvidenceError("status.json is not an object")
    _verify_status_runtime(claim, status)

    provenance = claim["provenance"]
    if provenance["kind"] == "unattested_cutover_canary":
        if protected_proof_root is None:
            raise OperationalCanaryEvidenceError("unattested cutover canary requires --protected-proof-root")
        for key, label in (("sourceBuild", "source build"), ("sourceJournal", "source journal"), ("operatorReceipt", "operator receipt")):
            proof = provenance[key]
            _proof_file(Path(protected_proof_root), proof["sha256"], proof["byteSize"], label)

    pointer_path = evidence_pointer_path(evidence_dir)
    pointer_bytes = pointer_path.read_bytes()
    if (_sha_bytes(pointer_bytes), len(pointer_bytes)) != (evidence["pointerSha256"], evidence["pointerByteSize"]):
        raise OperationalCanaryEvidenceError("remote pointer digest or byte size differs from claim")
    try:
        pointer = read_remote_pointer(pointer_path)
    except EvidenceStoreError as exc:
        raise OperationalCanaryEvidenceError(str(exc)) from exc
    pointer_expected = {
        "bucket": target["bucket"],
        "object_key": target["objectKey"],
        "generation": int(target["generation"]),
        "stored_sha256": target["storedSha256"],
        "stored_size": target["storedByteSize"],
        "tar_sha256": target["tarSha256"],
        "tar_size": target["tarByteSize"],
        "crc32c": target["crc32c"],
        "zstd_level": target["zstdLevel"],
    }
    for key, expected in pointer_expected.items():
        if getattr(pointer, key) != expected:
            raise OperationalCanaryEvidenceError(f"remote pointer differs from target for {key}")
    manifest_path = evidence_dir / "evidence_manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    if (_sha_bytes(manifest_bytes), len(manifest_bytes)) != (evidence["manifestSha256"], evidence["manifestByteSize"]):
        raise OperationalCanaryEvidenceError("manifest digest or byte size differs from claim")
    archive_member_count, member_digest = manifest_bundle_member_set_sha256(manifest_bytes)
    if (archive_member_count, member_digest) != (evidence["archiveMemberCount"], evidence["archiveMemberSetSha256"]):
        raise OperationalCanaryEvidenceError("manifest member set differs from claim")
    if archive_member_count <= 1:
        raise OperationalCanaryEvidenceError("manifest contains no bundled evidence members")
    verified_member_count = archive_member_count - 1

    archive_path = evidence_dir / EVIDENCE_ARCHIVE_NAME
    local_receipt = evidence_dir / LOCAL_RECEIPT_NAME
    if archive_path.is_file() and not archive_path.is_symlink():
        try:
            record = inspect_tar_zst(archive_path, level=pointer.zstd_level)
            if (
                record.stored_sha256 != pointer.stored_sha256
                or record.stored_size != pointer.stored_size
                or record.tar_sha256 != pointer.tar_sha256
                or record.tar_size != pointer.tar_size
            ):
                raise OperationalCanaryEvidenceError("local archive differs from generation-pinned pointer")
            restored = _verify_archive_manifest_members(
                archive_path, pointer, expected_manifest=manifest_bytes
            )
            if restored != verified_member_count:
                raise OperationalCanaryEvidenceError("local all-member proof count differs from manifest")
        except (EvidenceHydrationError, EvidenceStoreError, OSError, ValueError) as exc:
            if isinstance(exc, OperationalCanaryEvidenceError):
                raise
            raise OperationalCanaryEvidenceError(f"local archive verification failed: {exc}") from exc
    elif not (
        permit_completed_receipt
        and (
            local_receipt.is_file()
            or (evidence_dir / LOCAL_INTENT_NAME).is_file()
        )
    ):
        raise OperationalCanaryEvidenceError("exact local tar.zst is missing before durable ownership")
    return LocalTarget(
        claim, job_root, evidence_dir, pointer, manifest_bytes,
        archive_member_count, verified_member_count,
    )


def _parse_ack(value: object, local: LocalTarget) -> dict[str, Any]:
    ack = _object(value, "database ownership acknowledgement")
    expected_keys = {
        "schemaVersion", "state", "ownershipId", "engineJobId", "evidencePath",
        "target", "registrationReceiptSha256", "registeredAt",
    }
    _exact_keys(ack, expected_keys, "database ownership acknowledgement")
    claim = local.claim
    receipt_sha = _sha_bytes(_canonical(claim).encode("utf-8"))
    if (
        ack.get("schemaVersion") != 1
        or ack.get("state") != ACK_STATE
        or ack.get("engineJobId") != claim["job"]["id"]
        or ack.get("evidencePath") != claim["evidence"]["path"]
        or ack.get("target") != claim["target"]
        or ack.get("registrationReceiptSha256") != receipt_sha
    ):
        raise OperationalCanaryEvidenceError("database acknowledgement differs from exact registration claim")
    _uuid(ack.get("ownershipId"), "ownership id")
    _utc(ack.get("registeredAt"), "registration timestamp")
    return ack


def _load_acknowledgements(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise OperationalCanaryEvidenceError(f"invalid acknowledgement JSON line {line_number}") from exc
        row = _object(value, f"acknowledgement line {line_number}")
        key = (_text(row.get("engineJobId"), "ack engine job id"), _safe_relative(row.get("evidencePath"), "ack evidence path"))
        if key in found:
            raise OperationalCanaryEvidenceError(f"duplicate acknowledgement for {key[0]}/{key[1]}")
        found[key] = row
    return found


def _write_create_only_json(path: Path, value: Mapping[str, Any]) -> None:
    canonical = _canonical(value)
    if path.exists() or path.is_symlink():
        if not path.is_file() or path.is_symlink():
            raise OperationalCanaryEvidenceError("retention receipt path is unsafe")
        existing = json.loads(path.read_text(encoding="utf-8"))
        if _canonical(existing) != canonical:
            raise OperationalCanaryEvidenceError("existing local retention receipt conflicts")
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            output.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _cleanup_path_identity(path: Path, evidence_dir: Path) -> dict[str, Any]:
    relative = path.relative_to(evidence_dir).as_posix()
    if path.is_symlink():
        raise OperationalCanaryEvidenceError(f"cleanup source is a symlink: {relative}")
    if path.is_file():
        size, digest = _file_size_sha256(path)
        return {
            "path": relative,
            "kind": "file",
            "fileCount": 1,
            "byteSize": size,
            "treeSha256": digest,
        }
    if not path.is_dir():
        raise OperationalCanaryEvidenceError(f"cleanup source has an unsupported type: {relative}")
    rows: list[tuple[str, int, str]] = []
    for current, dirnames, filenames in os.walk(path, followlinks=False):
        current_path = Path(current)
        for dirname in dirnames:
            child = current_path / dirname
            if child.is_symlink():
                raise OperationalCanaryEvidenceError(
                    f"cleanup directory contains a symlink: {child.relative_to(evidence_dir)}"
                )
        for filename in filenames:
            child = current_path / filename
            if child.is_symlink() or not child.is_file():
                raise OperationalCanaryEvidenceError(
                    f"cleanup directory contains an unsafe file: {child.relative_to(evidence_dir)}"
                )
            size, digest = _file_size_sha256(child)
            rows.append((child.relative_to(path).as_posix(), size, digest))
    tree = hashlib.sha256()
    for member, size, digest in sorted(rows):
        tree.update(member.encode("utf-8"))
        tree.update(b"\0")
        tree.update(digest.encode("ascii"))
        tree.update(b"\0")
        tree.update(str(size).encode("ascii"))
        tree.update(b"\n")
    return {
        "path": relative,
        "kind": "directory",
        "fileCount": len(rows),
        "byteSize": sum(row[1] for row in rows),
        "treeSha256": tree.hexdigest(),
    }


def _cleanup_intent(
    local: LocalTarget,
    acknowledgement: Mapping[str, Any],
    paths: Sequence[Path],
    *,
    verified_at: str,
) -> dict[str, Any]:
    identities = sorted(
        (_cleanup_path_identity(path, local.evidence_dir) for path in paths),
        key=lambda row: row["path"],
    )
    return {
        "schemaVersion": 1,
        "kind": "opencfd2606-operational-canary-local-cleanup-intent",
        "ownershipId": acknowledgement["ownershipId"],
        "registrationReceiptSha256": acknowledgement["registrationReceiptSha256"],
        "target": {
            key: local.claim["target"][key]
            for key in ("bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c")
        },
        "verificationMode": f"archive+manifest+all-members-restore:{local.verified_member_count}",
        "verifiedMemberCount": local.verified_member_count,
        "freshRestoreVerifiedAt": verified_at,
        "paths": identities,
        "totalByteSize": sum(row["byteSize"] for row in identities),
        "gcsDisposition": "retained_exact_generation",
        "operator": local.claim["operator"],
        "createdAt": verified_at,
    }


def _validate_cleanup_intent(
    value: object,
    local: LocalTarget,
    acknowledgement: Mapping[str, Any],
) -> dict[str, Any]:
    intent = _object(value, "local cleanup intent")
    _exact_keys(intent, (
        "schemaVersion", "kind", "ownershipId", "registrationReceiptSha256",
        "target", "verificationMode", "verifiedMemberCount",
        "freshRestoreVerifiedAt", "paths", "totalByteSize", "gcsDisposition",
        "operator", "createdAt",
    ), "local cleanup intent")
    expected_target = {
        key: local.claim["target"][key]
        for key in ("bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c")
    }
    expected_verification = f"archive+manifest+all-members-restore:{local.verified_member_count}"
    if (
        intent.get("schemaVersion") != 1
        or intent.get("kind") != "opencfd2606-operational-canary-local-cleanup-intent"
        or intent.get("ownershipId") != acknowledgement.get("ownershipId")
        or intent.get("registrationReceiptSha256") != acknowledgement.get("registrationReceiptSha256")
        or intent.get("target") != expected_target
        or intent.get("verificationMode") != expected_verification
        or intent.get("verifiedMemberCount") != local.verified_member_count
        or intent.get("gcsDisposition") != "retained_exact_generation"
        or intent.get("operator") != local.claim["operator"]
    ):
        raise OperationalCanaryEvidenceError("cleanup intent conflicts with immutable ownership")
    _utc(intent.get("freshRestoreVerifiedAt"), "intent fresh restore timestamp")
    if intent.get("createdAt") != intent.get("freshRestoreVerifiedAt"):
        raise OperationalCanaryEvidenceError("cleanup intent timestamps disagree")
    raw_paths = intent.get("paths")
    if not isinstance(raw_paths, list):
        raise OperationalCanaryEvidenceError("cleanup intent paths must be an array")
    allowed = {
        "openfoam", "time_directories", "VTK", EVIDENCE_ARCHIVE_NAME,
        "engine_evidence.tar.gz", "openfoam_evidence.tar.gz",
    }
    parsed_paths: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_paths):
        row = _object(raw, f"cleanup intent path {index}")
        _exact_keys(row, ("path", "kind", "fileCount", "byteSize", "treeSha256"), f"cleanup intent path {index}")
        path = _safe_relative(row.get("path"), f"cleanup intent path {index}")
        if path not in allowed:
            raise OperationalCanaryEvidenceError("cleanup intent names a path outside the packaged/raw allowlist")
        if row.get("kind") not in {"file", "directory"}:
            raise OperationalCanaryEvidenceError("cleanup intent path kind is invalid")
        file_count = row.get("fileCount")
        byte_size = row.get("byteSize")
        if isinstance(file_count, bool) or not isinstance(file_count, int) or file_count < 0:
            raise OperationalCanaryEvidenceError("cleanup intent file count is invalid")
        if isinstance(byte_size, bool) or not isinstance(byte_size, int) or byte_size < 0:
            raise OperationalCanaryEvidenceError("cleanup intent byte size is invalid")
        _pattern(row.get("treeSha256"), "cleanup intent tree SHA-256", SHA256)
        parsed_paths.append(dict(row))
    if [row["path"] for row in parsed_paths] != sorted({row["path"] for row in parsed_paths}):
        raise OperationalCanaryEvidenceError("cleanup intent paths are duplicated or unsorted")
    total = intent.get("totalByteSize")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise OperationalCanaryEvidenceError("cleanup intent total byte size is invalid")
    if total != sum(row["byteSize"] for row in parsed_paths):
        raise OperationalCanaryEvidenceError("cleanup intent total differs from its paths")
    for row in parsed_paths:
        path = local.evidence_dir / row["path"]
        if path.exists() or path.is_symlink():
            if _cleanup_path_identity(path, local.evidence_dir) != row:
                raise OperationalCanaryEvidenceError(
                    f"cleanup source changed after immutable intent: {row['path']}"
                )
    return json.loads(_canonical(intent))


def _validate_local_retention_receipt(
    value: object,
    local: LocalTarget,
    acknowledgement: Mapping[str, Any],
) -> dict[str, Any]:
    receipt = _object(value, "local retention receipt")
    _exact_keys(receipt, (
        "schemaVersion", "kind", "ownershipId", "registrationReceiptSha256",
        "target", "outcome", "verificationMode", "verifiedMemberCount",
        "bytesDeleted", "deletedPaths", "gcsDisposition", "operator", "verifiedAt",
    ), "local retention receipt")
    expected_target = {
        key: local.claim["target"][key]
        for key in ("bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c")
    }
    expected_verification = f"archive+manifest+all-members-restore:{local.verified_member_count}"
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("kind") != RETENTION_KIND
        or receipt.get("ownershipId") != acknowledgement.get("ownershipId")
        or receipt.get("registrationReceiptSha256") != acknowledgement.get("registrationReceiptSha256")
        or receipt.get("target") != expected_target
        or receipt.get("verificationMode") != expected_verification
        or receipt.get("verifiedMemberCount") != local.verified_member_count
        or receipt.get("gcsDisposition") != "retained_exact_generation"
        or receipt.get("operator") != local.claim["operator"]
    ):
        raise OperationalCanaryEvidenceError("existing local retention receipt conflicts with immutable ownership")
    _utc(receipt.get("verifiedAt"), "retention verification timestamp")
    paths = receipt.get("deletedPaths")
    if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
        raise OperationalCanaryEvidenceError("retention deletedPaths must be a string array")
    allowed = {
        "openfoam", "time_directories", "VTK", EVIDENCE_ARCHIVE_NAME,
        "engine_evidence.tar.gz", "openfoam_evidence.tar.gz",
    }
    if len(set(paths)) != len(paths) or any(path not in allowed for path in paths):
        raise OperationalCanaryEvidenceError("retention deletedPaths is duplicated or unsafe")
    bytes_deleted = receipt.get("bytesDeleted")
    if isinstance(bytes_deleted, bool) or not isinstance(bytes_deleted, int) or bytes_deleted < 0:
        raise OperationalCanaryEvidenceError("retention bytesDeleted is invalid")
    outcome = receipt.get("outcome")
    if outcome == "local_evidence_stripped":
        if bytes_deleted <= 0 or not paths:
            raise OperationalCanaryEvidenceError("stripped receipt lacks deleted bytes/paths")
    elif outcome == "already_remote_only":
        if bytes_deleted != 0 or paths:
            raise OperationalCanaryEvidenceError("already-remote-only receipt claims local deletion")
    else:
        raise OperationalCanaryEvidenceError("retention receipt has an invalid outcome")
    return json.loads(_canonical(receipt))


def retain_local_canary_evidence(
    value: object,
    acknowledgement: object,
    settings: Settings,
    *,
    jobs_root: Path,
    approved_inventory: Mapping[str, Any],
    protected_proof_root: Path | None = None,
    store: Any | None = None,
    execute: bool = False,
    crash_after_intent: bool = False,
    crash_after_deletions: int | None = None,
) -> RetentionResult:
    local = validate_local_claim(
        value, jobs_root, approved_inventory=approved_inventory,
        protected_proof_root=protected_proof_root,
        permit_completed_receipt=execute,
    )
    ack = _parse_ack(acknowledgement, local)
    if not execute:
        return RetentionResult(
            local.claim["job"]["id"], local.claim["evidence"]["path"],
            "planned", local.pointer.stored_size,
            verification=f"archive+manifest+all-members-restore:{local.verified_member_count}",
        )
    store = store or evidence_object_store(settings)
    if store is None:
        raise OperationalCanaryEvidenceError("AIRFOILFOAM_EVIDENCE_BUCKET is required")
    with _job_guard(local.job_root):
        local = validate_local_claim(
            value, jobs_root, approved_inventory=approved_inventory,
            protected_proof_root=protected_proof_root,
            permit_completed_receipt=True,
        )
        try:
            member_count = store.verify_all_manifest_members(
                local.pointer,
                expected_manifest=local.manifest_bytes,
                fresh_download=True,
            )
        except (EvidenceHydrationError, EvidenceStoreError, OSError, ValueError) as exc:
            raise OperationalCanaryEvidenceError(f"fresh remote all-member restore failed: {exc}") from exc
        if member_count != local.verified_member_count:
            raise OperationalCanaryEvidenceError("fresh remote restore member count differs from immutable manifest")
        local_receipt_path = local.evidence_dir / LOCAL_RECEIPT_NAME
        if local_receipt_path.is_file() and not local_receipt_path.is_symlink():
            existing_receipt = _validate_local_retention_receipt(
                json.loads(local_receipt_path.read_text(encoding="utf-8")),
                local,
                ack,
            )
            return RetentionResult(
                local.claim["job"]["id"], local.claim["evidence"]["path"],
                "already-retained", local.pointer.stored_size, 0,
                existing_receipt["verificationMode"], existing_receipt,
            )
        verified_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        intent_path = local.evidence_dir / LOCAL_INTENT_NAME
        if intent_path.is_file() and not intent_path.is_symlink():
            intent = _validate_cleanup_intent(
                json.loads(intent_path.read_text(encoding="utf-8")), local, ack
            )
        elif intent_path.exists() or intent_path.is_symlink():
            raise OperationalCanaryEvidenceError("cleanup intent path is unsafe")
        else:
            intent = _cleanup_intent(
                local,
                ack,
                _existing_packaged_paths(local.evidence_dir),
                verified_at=verified_at,
            )
            _write_create_only_json(intent_path, intent)
        if crash_after_intent:
            raise OperationalCanaryEvidenceError("injected crash after durable cleanup intent")
        deleted_this_pass = 0
        for row in intent["paths"]:
            path = local.evidence_dir / row["path"]
            if not path.exists() and not path.is_symlink():
                continue
            if _cleanup_path_identity(path, local.evidence_dir) != row:
                raise OperationalCanaryEvidenceError(
                    f"cleanup source changed after immutable intent: {row['path']}"
                )
            _remove_path(path)
            _fsync_directory(local.evidence_dir)
            deleted_this_pass += 1
            if crash_after_deletions is not None and deleted_this_pass >= crash_after_deletions:
                raise OperationalCanaryEvidenceError("injected crash after partial local deletion")
        if any(
            (local.evidence_dir / row["path"]).exists()
            or (local.evidence_dir / row["path"]).is_symlink()
            for row in intent["paths"]
        ):
            raise OperationalCanaryEvidenceError("cleanup intent did not remove every exact local path")
        deleted_paths = [row["path"] for row in intent["paths"]]
        bytes_deleted = intent["totalByteSize"]
        receipt = {
            "schemaVersion": 1,
            "kind": RETENTION_KIND,
            "ownershipId": ack["ownershipId"],
            "registrationReceiptSha256": ack["registrationReceiptSha256"],
            "target": {
                key: local.claim["target"][key]
                for key in ("bucket", "objectKey", "generation", "storedSha256", "storedByteSize", "crc32c")
            },
            "outcome": "local_evidence_stripped" if bytes_deleted > 0 else "already_remote_only",
            "verificationMode": f"archive+manifest+all-members-restore:{member_count}",
            "verifiedMemberCount": member_count,
            "bytesDeleted": bytes_deleted,
            "deletedPaths": deleted_paths,
            "gcsDisposition": "retained_exact_generation",
            "operator": local.claim["operator"],
            "verifiedAt": intent["freshRestoreVerifiedAt"],
        }
        _write_create_only_json(local_receipt_path, receipt)
        return RetentionResult(
            local.claim["job"]["id"], local.claim["evidence"]["path"],
            "retained", local.pointer.stored_size, bytes_deleted,
            receipt["verificationMode"], receipt,
        )


def _authenticated_json_file(
    path: Path,
    expected: Mapping[str, Any],
    label: str,
) -> tuple[bytes, dict[str, Any]]:
    try:
        payload = Path(path).read_bytes()
    except OSError as exc:
        raise OperationalCanaryEvidenceError(f"cannot read protected {label}: {exc}") from exc
    if (_sha_bytes(payload), len(payload)) != (expected["sha256"], expected["byteSize"]):
        raise OperationalCanaryEvidenceError(f"protected {label} digest/size differs from the sealed inventory")
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise OperationalCanaryEvidenceError(f"protected {label} is invalid JSON") from exc
    return payload, _object(value, f"protected {label}")


def _reject_non_finite_json_number(value: str) -> None:
    raise OperationalCanaryEvidenceError(
        f"protected r5 attestation receipt contains non-finite JSON number {value}"
    )


def _normalize_receipt_numbers(value: object) -> object:
    """Match PostgreSQL jsonb numeric semantics for the retained receipt.

    The production receipt was retained as raw response bytes containing
    integral float spellings such as ``2.0`` and ``-0.0``. PostgreSQL jsonb
    stores those with their numeric value, while the durable database receipt
    digest was computed from canonical JSON where integral numbers are emitted
    as integers. Preserve non-integral finite floats; reject non-finite values
    at every recursion depth.
    """

    if isinstance(value, float):
        if not math.isfinite(value):
            raise OperationalCanaryEvidenceError(
                "protected r5 attestation receipt contains a non-finite number"
            )
        return int(value) if value.is_integer() else value
    if isinstance(value, list):
        return [_normalize_receipt_numbers(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _normalize_receipt_numbers(item) for key, item in value.items()
        }
    return value


def _authenticate_attestation_receipt(
    path: Path,
    approved_inventory: Mapping[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    """Authenticate the exact retained r5 receipt before claims are emitted.

    The attestation UUID is database identity, not a field inside the retained
    pre-attestation receipt.  The sealed inventory binds that UUID to the exact
    retained bytes; this validator additionally proves that those bytes are a
    successful OpenCFD 2606 receipt containing every approved attested bundle.
    """

    expected = _object(
        _object(approved_inventory.get("inputs"), "approved inventory inputs").get(
            "attestationReceipt"
        ),
        "approved attestation receipt",
    )
    try:
        payload = Path(path).read_bytes()
    except OSError as exc:
        raise OperationalCanaryEvidenceError(
            f"cannot read protected r5 attestation receipt: {exc}"
        ) from exc
    if (_sha_bytes(payload), len(payload)) != (
        expected["retainedReceiptSha256"],
        expected["retainedReceiptByteSize"],
    ):
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt digest/size differs from the sealed inventory"
        )
    try:
        receipt = json.loads(
            payload.decode("utf-8"),
            parse_constant=_reject_non_finite_json_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt is not valid UTF-8 JSON"
        ) from exc
    receipt = _normalize_receipt_numbers(receipt)
    try:
        database_receipt_bytes = _canonical(receipt).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt cannot be canonicalized safely"
        ) from exc
    if (
        _sha_bytes(database_receipt_bytes)
        != expected["databaseReceiptSha256"]
        or len(database_receipt_bytes)
        != APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE
    ):
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt semantic database identity differs from production"
        )
    receipt = _object(receipt, "protected r5 attestation receipt")
    engine = _object(receipt.get("engine"), "protected r5 attestation engine")
    if (
        receipt.get("schema_version") != 1
        or receipt.get("status") != "ok"
        or engine.get("family") != "openfoam"
        or engine.get("distribution") != "opencfd"
        or engine.get("version") != "2606"
    ):
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt is not a successful OpenCFD 2606 receipt"
        )
    jobs = receipt.get("jobs")
    if not isinstance(jobs, list):
        raise OperationalCanaryEvidenceError(
            "protected r5 attestation receipt jobs must be an array"
        )
    attested_rows = [
        row
        for row in approved_inventory["objects"]
        if row["provenance"]["kind"] == "attested_canary"
    ]
    if len(attested_rows) != APPROVED_ATTESTED_COUNT or any(
        row["provenance"].get("attestationId") != expected["attestationId"]
        for row in attested_rows
    ):
        raise OperationalCanaryEvidenceError(
            "sealed attested members do not bind the approved attestation id"
        )
    for row in attested_rows:
        target = row["target"]
        matches = 0
        for raw_job in jobs:
            if not isinstance(raw_job, Mapping) or raw_job.get("job_id") != row["engineJobId"]:
                continue
            points = raw_job.get("points")
            if not isinstance(points, list):
                continue
            for point in points:
                if not isinstance(point, Mapping) or not isinstance(point.get("artifacts"), list):
                    continue
                for artifact in point["artifacts"]:
                    if not isinstance(artifact, Mapping) or artifact.get("kind") != "engine_bundle":
                        continue
                    storage = artifact.get("storage")
                    if not isinstance(storage, Mapping):
                        continue
                    if (
                        artifact.get("sha256") == target["storedSha256"]
                        and artifact.get("byte_size") == target["storedByteSize"]
                        and storage.get("bucket") == target["bucket"]
                        and storage.get("object_key") == target["objectKey"]
                        and str(storage.get("generation")) == target["generation"]
                        and storage.get("stored_sha256") == target["storedSha256"]
                        and storage.get("stored_byte_size") == target["storedByteSize"]
                        and storage.get("crc32c") == target["crc32c"]
                    ):
                        matches += 1
        if matches != 1:
            raise OperationalCanaryEvidenceError(
                "protected r5 attestation receipt does not contain one exact approved bundle"
            )
    return payload, receipt


def _write_protected_proof(root: Path, payload: bytes, expected: Mapping[str, Any]) -> None:
    if (_sha_bytes(payload), len(payload)) != (expected["sha256"], expected["byteSize"]):
        raise OperationalCanaryEvidenceError("generated proof differs from its sealed identity")
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise OperationalCanaryEvidenceError("protected proof output root is unsafe")
    path = root / expected["sha256"]
    if path.exists() or path.is_symlink():
        _proof_file(root, expected["sha256"], expected["byteSize"], "existing generated proof")
        return
    temporary = root / f".{expected['sha256']}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
        _fsync_directory(root)
    finally:
        temporary.unlink(missing_ok=True)


def generate_approved_claims(
    *,
    approved_inventory: Mapping[str, Any],
    local_inventory_path: Path,
    gcs_inventory_path: Path,
    attestation_receipt_path: Path,
    jobs_root: Path,
    audit_journal_root: Path,
    protected_proof_root: Path,
) -> list[dict[str, Any]]:
    """Generate the only 16 claims allowed by migration 0081.

    Every input is independently authenticated before any claim is emitted.
    The exact completed status bytes are the source-build proof for r2/r3/r4;
    the matching failed rollout journal and the provider inventory are copied
    under their content hashes.  No prefix discovery or caller-supplied row is
    accepted.
    """

    if (
        _sha_bytes(_canonical(approved_inventory).encode("utf-8"))
        != APPROVED_INVENTORY_SHA256
    ):
        raise OperationalCanaryEvidenceError(
            "claim generator inventory differs from the migration-sealed inventory"
        )
    attestation_bytes, _ = _authenticate_attestation_receipt(
        attestation_receipt_path,
        approved_inventory,
    )
    _write_protected_proof(
        protected_proof_root,
        attestation_bytes,
        {
            "sha256": approved_inventory["inputs"]["attestationReceipt"][
                "retainedReceiptSha256"
            ],
            "byteSize": approved_inventory["inputs"]["attestationReceipt"][
                "retainedReceiptByteSize"
            ],
        },
    )
    local_bytes, local_inventory = _authenticated_json_file(
        local_inventory_path,
        approved_inventory["inputs"]["localInventory"],
        "local canary inventory",
    )
    del local_bytes
    gcs_bytes, gcs_inventory = _authenticated_json_file(
        gcs_inventory_path,
        approved_inventory["inputs"]["gcsInventory"],
        "GCS provider inventory",
    )
    approved_count = _positive_int(
        approved_inventory.get("approvedCount"), "approved inventory object count"
    )
    approved_job_count = _positive_int(
        approved_inventory.get("approvedJobCount"), "approved inventory job count"
    )
    approved_bytes = _positive_int(
        approved_inventory.get("approvedStoredByteSize"),
        "approved inventory stored byte total",
    )
    local_rows = local_inventory.get("rows")
    gcs_rows = gcs_inventory.get("extra")
    if (
        local_inventory.get("count") != approved_count
        or local_inventory.get("bytes") != approved_bytes
        or not isinstance(local_rows, list)
    ):
        raise OperationalCanaryEvidenceError(
            "protected local inventory does not conserve the sealed object total"
        )
    if (
        gcs_inventory.get("extraCount") != approved_count
        or gcs_inventory.get("extraBytes") != approved_bytes
        or not isinstance(gcs_rows, list)
    ):
        raise OperationalCanaryEvidenceError(
            "protected GCS inventory does not conserve the sealed object total"
        )
    approved_local = {
        (
            row["engineJobId"], row["evidencePath"], row["target"]["storedByteSize"],
            True, False, "completed",
        )
        for row in approved_inventory["objects"]
    }
    actual_local = {
        (
            row.get("jobId"), row.get("evidencePath"), row.get("zstdBytes"),
            row.get("hasPointer"), row.get("hasReceipt"), row.get("jobState"),
        )
        for row in local_rows if isinstance(row, Mapping)
    }
    if len(actual_local) != approved_count or actual_local != approved_local:
        raise OperationalCanaryEvidenceError(
            "protected local inventory is not the sealed membership set"
        )
    approved_gcs = {
        (row["target"]["objectKey"], row["target"]["generation"], row["target"]["storedByteSize"])
        for row in approved_inventory["objects"]
    }
    actual_gcs = {
        (row.get("objectKey"), row.get("generation"), row.get("size"))
        for row in gcs_rows if isinstance(row, Mapping)
    }
    if len(actual_gcs) != approved_count or actual_gcs != approved_gcs:
        raise OperationalCanaryEvidenceError(
            "protected GCS inventory is not the sealed generation set"
        )

    _write_protected_proof(
        protected_proof_root,
        gcs_bytes,
        approved_inventory["inputs"]["gcsInventory"],
    )
    for runtime in approved_inventory["runtimeBuilds"]:
        journal = runtime.get("sourceJournal")
        if journal is None:
            continue
        journal_bytes, _ = _authenticated_json_file(
            Path(audit_journal_root) / journal["fileName"],
            journal,
            f"{runtime['buildId']} source journal",
        )
        _write_protected_proof(protected_proof_root, journal_bytes, journal)

    claims: list[dict[str, Any]] = []
    for row in approved_inventory["objects"]:
        job_root = Path(jobs_root) / row["engineJobId"]
        evidence_dir = job_root.joinpath(*PurePosixPath(row["evidencePath"]).parts)
        status_bytes = (job_root / "status.json").read_bytes()
        if row["provenance"]["kind"] == "unattested_cutover_canary":
            _write_protected_proof(protected_proof_root, status_bytes, row["status"])
        try:
            pointer = read_remote_pointer(evidence_pointer_path(evidence_dir))
        except EvidenceStoreError as exc:
            raise OperationalCanaryEvidenceError(str(exc)) from exc
        captured = datetime.fromisoformat(
            pointer.created_at[:-1] + "+00:00"
            if pointer.created_at.endswith("Z") else pointer.created_at
        )
        if captured.tzinfo is None or captured.utcoffset().total_seconds() != 0:
            raise OperationalCanaryEvidenceError("approved pointer createdAt is not UTC")
        captured_at = captured.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        claim = _parse_claim(
            _approved_claim(approved_inventory, row, captured_at=captured_at)
        )
        validate_local_claim(
            claim,
            jobs_root,
            approved_inventory=approved_inventory,
            protected_proof_root=protected_proof_root,
        )
        claims.append(claim)
    if (
        len(claims) != approved_count
        or len({claim["job"]["id"] for claim in claims}) != approved_job_count
    ):
        raise OperationalCanaryEvidenceError(
            "claim generator failed sealed membership conservation"
        )
    return claims


def _jsonl(path: Path) -> list[object]:
    values: list[object] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            values.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise OperationalCanaryEvidenceError(f"invalid JSON on line {index} of {path}") from exc
    if not values:
        raise OperationalCanaryEvidenceError(f"{path} contains no documents")
    return values


def _args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approved-inventory", type=Path, required=True)
    parser.add_argument("--claims", type=Path)
    parser.add_argument("--generate-claims", action="store_true")
    parser.add_argument("--local-inventory", type=Path)
    parser.add_argument("--gcs-inventory", type=Path)
    parser.add_argument("--attestation-receipt", type=Path)
    parser.add_argument("--audit-journal-root", type=Path)
    parser.add_argument("--database-acks", type=Path)
    parser.add_argument("--jobs-root", type=Path)
    parser.add_argument("--protected-proof-root", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args(argv)
    if args.generate_claims:
        required = (
            args.local_inventory,
            args.gcs_inventory,
            args.attestation_receipt,
            args.audit_journal_root,
            args.protected_proof_root,
        )
        if any(value is None for value in required):
            parser.error(
                "--generate-claims requires --local-inventory, --gcs-inventory, "
                "--attestation-receipt, --audit-journal-root, and --protected-proof-root"
            )
        if args.claims is not None or args.execute or args.database_acks is not None:
            parser.error(
                "--generate-claims cannot be combined with --claims, --execute, or --database-acks"
            )
    elif args.claims is None:
        parser.error("--claims is required unless --generate-claims is used")
    if args.execute and args.database_acks is None:
        parser.error("--execute requires --database-acks")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = _args(argv)
    approved_inventory = load_approved_inventory(args.approved_inventory)
    settings = get_settings()
    jobs_root = args.jobs_root or settings.data_dir / "jobs"
    if args.generate_claims:
        claims = generate_approved_claims(
            approved_inventory=approved_inventory,
            local_inventory_path=args.local_inventory,
            gcs_inventory_path=args.gcs_inventory,
            attestation_receipt_path=args.attestation_receipt,
            jobs_root=jobs_root,
            audit_journal_root=args.audit_journal_root,
            protected_proof_root=args.protected_proof_root,
        )
        for claim in claims:
            print(_canonical(claim))
        print(
            json.dumps({"mode": "generate", "generated": len(claims), "failed": 0}),
            file=sys.stderr,
        )
        return 0
    acknowledgements = _load_acknowledgements(args.database_acks) if args.database_acks else {}
    failures = 0
    for value in _jsonl(args.claims):
        try:
            claim = _parse_claim(value)
            key = (claim["job"]["id"], claim["evidence"]["path"])
            if args.execute:
                ack = acknowledgements.get(key)
                if ack is None:
                    raise OperationalCanaryEvidenceError("exact database ownership acknowledgement is missing")
                result = retain_local_canary_evidence(
                    claim, ack, settings, jobs_root=jobs_root,
                    approved_inventory=approved_inventory,
                    protected_proof_root=args.protected_proof_root, execute=True,
                )
            else:
                local = validate_local_claim(
                    claim, jobs_root,
                    approved_inventory=approved_inventory,
                    protected_proof_root=args.protected_proof_root,
                )
                result = RetentionResult(
                    claim["job"]["id"], claim["evidence"]["path"], "planned",
                    local.pointer.stored_size,
                    verification=f"archive+manifest+all-members-restore:{local.verified_member_count}",
                )
            print(json.dumps(result.to_dict(), sort_keys=True))
        except Exception as exc:  # noqa: BLE001 - every failed target is explicit
            failures += 1
            print(json.dumps({"status": "failed", "message": str(exc)}, sort_keys=True))
            if not args.continue_on_error:
                break
    print(json.dumps({"mode": "execute" if args.execute else "dry-run", "failed": failures}), file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "APPROVED_INVENTORY_SHA256",
    "LOCAL_RECEIPT_NAME",
    "OperationalCanaryEvidenceError",
    "RetentionResult",
    "generate_approved_claims",
    "load_approved_inventory",
    "main",
    "retain_local_canary_evidence",
    "validate_local_claim",
]
