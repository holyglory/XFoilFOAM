from __future__ import annotations

import copy
import hashlib
import json
import shutil
import uuid
from pathlib import Path

import pytest

import airfoilfoam.canary_evidence_ownership as canary_module

from airfoilfoam.canary_evidence_ownership import (
    APPROVED_INVENTORY_SHA256,
    LOCAL_INTENT_NAME,
    LOCAL_RECEIPT_NAME,
    OperationalCanaryEvidenceError,
    generate_approved_claims,
    load_approved_inventory,
    retain_local_canary_evidence,
    validate_local_claim,
)
from airfoilfoam.evidence_runtime import EVIDENCE_ARCHIVE_NAME
from airfoilfoam.evidence_store import (
    RemoteEvidencePointer,
    _verify_archive_manifest_members,
    create_tar_zst,
    manifest_bundle_member_set_sha256,
)


ROOT = Path(__file__).resolve().parents[1]


def sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class FakeRemoteStore:
    def __init__(self, archive: Path):
        self.archive = archive
        self.calls: list[bool] = []
        self.events: list[str] | None = None

    def verify_all_manifest_members(
        self,
        pointer: RemoteEvidencePointer,
        *,
        expected_manifest: bytes,
        fresh_download: bool,
    ) -> int:
        self.calls.append(fresh_download)
        if self.events is not None:
            self.events.append("fresh-restore" if fresh_download else "cached-restore")
        return _verify_archive_manifest_members(
            self.archive,
            pointer,
            expected_manifest=expected_manifest,
        )


def write_json(path: Path, value: object) -> bytes:
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


def canonical_database_receipt(value: object) -> bytes:
    normalized = canary_module._normalize_receipt_numbers(value)
    return json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def fixture(tmp_path: Path, *, attested: bool = False):
    jobs_root = tmp_path / "jobs"
    job_id = "00795000-aaaa-bbbb-cccc-000000000001"
    evidence_path = "cases/rans-a0/evidence"
    job_root = jobs_root / job_id
    evidence = job_root / evidence_path
    evidence.mkdir(parents=True)
    runtime_id = str(uuid.uuid4())
    runtime = {
        "solverImplementationId": "2f8bc764-09ae-4ff3-8fd2-260600000001",
        "solverRuntimeBuildId": runtime_id,
        "family": "openfoam",
        "distribution": "opencfd",
        "version": "2606",
        "buildId": "prod-20260717-63385777be73-r2",
        "sourceRevision": "481094fdf34f11ed6d0d603ee59a858a0124236d",
        "imageDigest": "sha256:" + "1" * 64,
        "applicationSourceSha256": "2" * 64,
        "packageSha256": "3" * 64,
        "binarySha256": "4" * 64,
        "architecture": "x86_64",
    }
    status_engine = {
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
    status_bytes = write_json(job_root / "status.json", {"state": "completed", "engine": status_engine})
    member = evidence / "openfoam" / "logs" / "solver.log"
    member.parent.mkdir(parents=True)
    member.write_bytes(b"simpleFoam completed\n")
    manifest = {
        "schemaVersion": 2,
        "bundleExcludes": [],
        "files": [
            {
                "path": "openfoam/logs/solver.log",
                "sha256": sha(member.read_bytes()),
                "byteSize": member.stat().st_size,
                "kind": "log",
                "role": "log",
            }
        ],
    }
    manifest_bytes = write_json(evidence / "evidence_manifest.json", manifest)
    archive_path = evidence / EVIDENCE_ARCHIVE_NAME
    record = create_tar_zst(evidence, archive_path, level=10)
    object_key = f"solver-evidence/v1/sha256/{record.stored_sha256[:2]}/{record.stored_sha256}.tar.zst"
    pointer = RemoteEvidencePointer(
        bucket="airfoils-pro-storage-bucket",
        object_key=object_key,
        generation=987654321,
        stored_sha256=record.stored_sha256,
        stored_size=record.stored_size,
        tar_sha256=record.tar_sha256,
        tar_size=record.tar_size,
        crc32c="AAAAAA==",
        zstd_level=10,
        created_at="2026-07-18T18:00:00Z",
    )
    pointer_bytes = write_json(evidence / "engine_evidence.remote.json", pointer.to_dict())
    member_count, member_set = manifest_bundle_member_set_sha256(manifest_bytes)
    proof_root = tmp_path / "protected"
    proof_root.mkdir()

    def proof(payload: bytes) -> dict[str, object]:
        digest = sha(payload)
        (proof_root / digest).write_bytes(payload)
        return {"sha256": digest, "byteSize": len(payload)}

    source_build = proof(status_bytes)
    source_journal = proof(b"queue probe failed with exit 14\n")
    operator_receipt = proof(b"operator captured r2 canary residue\n")
    if attested:
        provenance = {
            "kind": "attested_canary",
            "attestationId": str(uuid.uuid4()),
        }
    else:
        provenance = {
            "kind": "unattested_cutover_canary",
            "sourceBuild": {
                "buildId": runtime["buildId"],
                **source_build,
            },
            "sourceJournal": source_journal,
            "operatorReceipt": operator_receipt,
            "failure": {
                "phase": "queue_probe_same_build_replay",
                "exitCode": 14,
            },
        }
    claim = {
        "schemaVersion": 1,
        "kind": "opencfd2606-operational-canary-evidence-registration",
        "approvedInventorySha256": APPROVED_INVENTORY_SHA256,
        "provenance": provenance,
        "runtime": runtime,
        "job": {
            "id": job_id,
            "state": "completed",
            "statusSha256": sha(status_bytes),
            "statusByteSize": len(status_bytes),
        },
        "evidence": {
            "path": evidence_path,
            "pointerSha256": sha(pointer_bytes),
            "pointerByteSize": len(pointer_bytes),
            "archiveSha256": record.stored_sha256,
            "archiveByteSize": record.stored_size,
            "manifestSha256": sha(manifest_bytes),
            "manifestByteSize": len(manifest_bytes),
            "archiveMemberSetSha256": member_set,
            "archiveMemberCount": member_count,
        },
        "target": {
            "bucket": pointer.bucket,
            "objectKey": pointer.object_key,
            "generation": str(pointer.generation),
            "storedSha256": pointer.stored_sha256,
            "storedByteSize": pointer.stored_size,
            "crc32c": pointer.crc32c,
            "tarSha256": pointer.tar_sha256,
            "tarByteSize": pointer.tar_size,
            "zstdLevel": pointer.zstd_level,
        },
        "operator": "operator@example.test",
        "capturedAt": "2026-07-18T18:10:00Z",
    }
    registration_sha = sha(
        json.dumps(claim, sort_keys=True, separators=(",", ":")).encode()
    )
    ack = {
        "schemaVersion": 1,
        "state": "operational_canary_owned",
        "ownershipId": str(uuid.uuid4()),
        "engineJobId": job_id,
        "evidencePath": evidence_path,
        "target": claim["target"],
        "registrationReceiptSha256": registration_sha,
        "registeredAt": "2026-07-18T18:15:00Z",
    }
    remote = tmp_path / "remote.tar.zst"
    shutil.copy2(archive_path, remote)
    return claim, ack, jobs_root, proof_root, evidence, FakeRemoteStore(remote)


def approved_for(claim: dict[str, object]) -> dict[str, object]:
    runtime = claim["runtime"]
    provenance = claim["provenance"]
    build = {
        "id": runtime["solverRuntimeBuildId"],
        "buildId": runtime["buildId"],
        "sourceRevision": runtime["sourceRevision"],
        "imageDigest": runtime["imageDigest"],
        "applicationSourceSha256": runtime["applicationSourceSha256"],
        "packageSha256": runtime["packageSha256"],
        "binarySha256": runtime["binarySha256"],
        "architecture": runtime["architecture"],
    }
    if provenance["kind"] == "unattested_cutover_canary":
        build["sourceJournal"] = {
            "fileName": "journal.json",
            **provenance["sourceJournal"],
        }
        build["failure"] = provenance["failure"]
        gcs_inventory = provenance["operatorReceipt"]
    else:
        gcs_inventory = {"sha256": "f" * 64, "byteSize": 1}
    return {
        "operator": claim["operator"],
        "inputs": {"gcsInventory": gcs_inventory},
        "runtimeBuilds": [build],
        "objects": [
            {
                "engineJobId": claim["job"]["id"],
                "evidencePath": claim["evidence"]["path"],
                "buildId": runtime["buildId"],
                "provenance": (
                    provenance
                    if provenance["kind"] == "attested_canary"
                    else {"kind": "unattested_cutover_canary"}
                ),
                "status": {
                    "sha256": claim["job"]["statusSha256"],
                    "byteSize": claim["job"]["statusByteSize"],
                },
                "pointer": {
                    "sha256": claim["evidence"]["pointerSha256"],
                    "byteSize": claim["evidence"]["pointerByteSize"],
                },
                "manifest": {
                    "sha256": claim["evidence"]["manifestSha256"],
                    "byteSize": claim["evidence"]["manifestByteSize"],
                    "memberSetSha256": claim["evidence"]["archiveMemberSetSha256"],
                    "memberCount": claim["evidence"]["archiveMemberCount"],
                },
                "target": claim["target"],
            }
        ],
    }


def test_legitimate_unattested_and_attested_claims_are_distinct(tmp_path: Path) -> None:
    claim, _, jobs_root, proofs, _, _ = fixture(tmp_path / "unattested")
    local = validate_local_claim(
        claim, jobs_root, approved_inventory=approved_for(claim),
        protected_proof_root=proofs,
    )
    assert local.pointer.stored_sha256 == claim["target"]["storedSha256"]

    attested, _, attested_jobs, _, _, _ = fixture(tmp_path / "attested", attested=True)
    local_attested = validate_local_claim(
        attested, attested_jobs, approved_inventory=approved_for(attested)
    )
    assert local_attested.claim["provenance"]["kind"] == "attested_canary"


def test_production_receipt_raw_and_database_identities_are_explicit() -> None:
    approved = load_approved_inventory(
        ROOT / "config" / "operational-canary-approved-inventory.json"
    )
    identity = approved["inputs"]["attestationReceipt"]
    assert identity == {
        "attestationId": "112f52cd-eb8b-4908-bc79-6353daea6e12",
        "databaseReceiptSha256": (
            "f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149"
        ),
        "retainedReceiptSha256": (
            "505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8"
        ),
        "retainedReceiptByteSize": 2_313_736,
    }
    assert "receiptSha256" not in identity
    assert canary_module.APPROVED_ATTESTATION_DATABASE_RECEIPT_SHA256 == (
        identity["databaseReceiptSha256"]
    )
    assert canary_module.APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE == (
        2_211_018
    )
    assert canary_module.APPROVED_ATTESTATION_RETAINED_RECEIPT_SHA256 == (
        identity["retainedReceiptSha256"]
    )
    assert canary_module.APPROVED_ATTESTATION_RETAINED_RECEIPT_BYTE_SIZE == (
        identity["retainedReceiptByteSize"]
    )
    assert sha(
        json.dumps(
            approved,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    ) == "1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"


def test_generator_refuses_missing_changed_truncated_or_different_r5_receipt(
    tmp_path: Path,
) -> None:
    approved = load_approved_inventory(
        ROOT / "config" / "operational-canary-approved-inventory.json"
    )
    expected_size = approved["inputs"]["attestationReceipt"][
        "retainedReceiptByteSize"
    ]
    header = b'{"schema_version":1,"status":"ok","padding":"'
    same_size_wrong = header + (b"a" * (expected_size - len(header) - 2)) + b'"}'
    assert len(same_size_wrong) == expected_size
    candidates = {
        "missing": tmp_path / "missing.json",
        "changed": tmp_path / "changed.json",
        "truncated": tmp_path / "truncated.json",
        "different": tmp_path / "different.json",
    }
    candidates["changed"].write_bytes(same_size_wrong)
    candidates["truncated"].write_bytes(same_size_wrong[:-1])
    candidates["different"].write_text(
        '{"schema_version":1,"status":"different","jobs":[]}\n',
        encoding="utf-8",
    )
    for label, receipt_path in candidates.items():
        with pytest.raises(
            OperationalCanaryEvidenceError,
            match="protected r5 attestation receipt",
        ):
            generate_approved_claims(
                approved_inventory=approved,
                local_inventory_path=tmp_path / f"unused-local-{label}.json",
                gcs_inventory_path=tmp_path / f"unused-gcs-{label}.json",
                attestation_receipt_path=receipt_path,
                jobs_root=tmp_path / "unused-jobs",
                audit_journal_root=tmp_path / "unused-journals",
                protected_proof_root=tmp_path / "unused-proofs",
            )


def test_attestation_receipt_shape_is_checked_after_byte_authentication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claim, _, _, _, _, _ = fixture(tmp_path / "claim", attested=True)
    approved = approved_for(claim)
    malformed = (
        b'{"schema_version":1,"status":"different","engine":'
        b'{"family":"openfoam","distribution":"opencfd","version":"2606"},'
        b'"jobs":[]}'
    )
    approved["inputs"]["attestationReceipt"] = {
        "attestationId": claim["provenance"]["attestationId"],
        "databaseReceiptSha256": sha(
            canonical_database_receipt(json.loads(malformed))
        ),
        "retainedReceiptSha256": sha(malformed),
        "retainedReceiptByteSize": len(malformed),
    }
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE",
        len(canonical_database_receipt(json.loads(malformed))),
    )
    path = tmp_path / "shape-authenticated.json"
    path.write_bytes(malformed)
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="not a successful OpenCFD 2606 receipt",
    ):
        canary_module._authenticate_attestation_receipt(path, approved)


def test_receipt_raw_bytes_and_semantic_database_identity_are_independent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claim, _, _, _, _, _ = fixture(tmp_path / "claim", attested=True)
    receipt = {
        "schema_version": 1,
        "status": "ok",
        "engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
        },
        "normalization_probe": {"two": 2.0, "zero": 0.0, "negative_zero": -0.0},
        "jobs": [],
    }
    raw = (json.dumps(receipt, indent=2, sort_keys=False) + "\n").encode("utf-8")
    canonical = canonical_database_receipt(receipt)
    assert raw != canonical
    approved = approved_for(claim)
    approved["inputs"]["attestationReceipt"] = {
        "attestationId": claim["provenance"]["attestationId"],
        "databaseReceiptSha256": sha(canonical),
        "retainedReceiptSha256": sha(raw),
        "retainedReceiptByteSize": len(raw),
    }
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE",
        len(canonical),
    )

    whitespace_changed = tmp_path / "whitespace-changed.json"
    whitespace_changed.write_bytes(raw + b" ")
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="digest/size differs from the sealed inventory",
    ):
        canary_module._authenticate_attestation_receipt(
            whitespace_changed, approved
        )

    exact_raw = tmp_path / "exact-raw.json"
    exact_raw.write_bytes(raw)
    wrong_semantic = copy.deepcopy(approved)
    wrong_semantic["inputs"]["attestationReceipt"][
        "databaseReceiptSha256"
    ] = "0" * 64
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="semantic database identity differs",
    ):
        canary_module._authenticate_attestation_receipt(exact_raw, wrong_semantic)

    swapped = copy.deepcopy(approved)
    swapped["inputs"]["attestationReceipt"].update(
        {
            "databaseReceiptSha256": sha(raw),
            "retainedReceiptSha256": sha(canonical),
        }
    )
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="digest/size differs from the sealed inventory",
    ):
        canary_module._authenticate_attestation_receipt(exact_raw, swapped)


def test_receipt_non_finite_numbers_fail_after_exact_raw_authentication(
    tmp_path: Path,
) -> None:
    claim, _, _, _, _, _ = fixture(tmp_path / "claim", attested=True)
    raw = (
        b'{"schema_version":1,"status":"ok","engine":'
        b'{"family":"openfoam","distribution":"opencfd","version":"2606"},'
        b'"normalization_probe":NaN,"jobs":[]}'
    )
    approved = approved_for(claim)
    approved["inputs"]["attestationReceipt"] = {
        "attestationId": claim["provenance"]["attestationId"],
        "databaseReceiptSha256": "0" * 64,
        "retainedReceiptSha256": sha(raw),
        "retainedReceiptByteSize": len(raw),
    }
    path = tmp_path / "non-finite.json"
    path.write_bytes(raw)
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="contains non-finite JSON number NaN",
    ):
        canary_module._authenticate_attestation_receipt(path, approved)


def test_generator_accepts_an_authenticated_synthetic_sealed_receipt_and_inventory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unattested, _, unattested_jobs, _, _, _ = fixture(tmp_path / "unattested-base")
    attested, _, attested_jobs, _, _, _ = fixture(
        tmp_path / "attested-base", attested=True
    )

    # Give the attested fixture its own r5 runtime identity and bind the exact
    # completed status bytes to that identity before cloning any jobs.
    attested["runtime"]["buildId"] = "prod-synthetic-generator-r5"
    attested_status_path = attested_jobs / attested["job"]["id"] / "status.json"
    attested_status = json.loads(attested_status_path.read_text(encoding="utf-8"))
    attested_status["engine"]["build_id"] = attested["runtime"]["buildId"]
    attested_status_bytes = write_json(attested_status_path, attested_status)
    attested["job"]["statusSha256"] = sha(attested_status_bytes)
    attested["job"]["statusByteSize"] = len(attested_status_bytes)

    jobs_root = tmp_path / "synthetic-jobs"
    jobs_root.mkdir()
    claims: list[dict[str, object]] = []
    objects: list[dict[str, object]] = []
    for index in range(16):
        source_claim = attested if index < 4 else unattested
        source_jobs = attested_jobs if index < 4 else unattested_jobs
        claim = copy.deepcopy(source_claim)
        source_job_id = claim["job"]["id"]
        job_id = f"synthetic-generator-job-{index:02d}"
        claim["job"]["id"] = job_id
        shutil.copytree(source_jobs / source_job_id, jobs_root / job_id)

        evidence_dir = jobs_root / job_id / claim["evidence"]["path"]
        pointer_path = evidence_dir / "engine_evidence.remote.json"
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
        pointer["generation"] = 9_000_000_000_000_000_000 + index
        pointer_bytes = write_json(pointer_path, pointer)
        claim["target"]["generation"] = str(pointer["generation"])
        claim["evidence"]["pointerSha256"] = sha(pointer_bytes)
        claim["evidence"]["pointerByteSize"] = len(pointer_bytes)
        claims.append(claim)
        objects.append(approved_for(claim)["objects"][0])

    attested_runtime = approved_for(attested)["runtimeBuilds"][0]
    unattested_runtime = approved_for(unattested)["runtimeBuilds"][0]
    attested_runtime["provenanceKey"] = "a" * 64
    unattested_runtime["provenanceKey"] = "b" * 64
    audit_journal_root = tmp_path / "audit-journals"
    journal_bytes = write_json(
        audit_journal_root / "synthetic-r2-journal.json",
        {"schemaVersion": 1, "event": "synthetic cutover failure"},
    )
    unattested_runtime["sourceJournal"] = {
        "fileName": "synthetic-r2-journal.json",
        "sha256": sha(journal_bytes),
        "byteSize": len(journal_bytes),
    }

    stored_bytes = sum(row["target"]["storedByteSize"] for row in objects)
    local_inventory = {
        "count": len(objects),
        "bytes": stored_bytes,
        "rows": [
            {
                "jobId": row["engineJobId"],
                "evidencePath": row["evidencePath"],
                "zstdBytes": row["target"]["storedByteSize"],
                "hasPointer": True,
                "hasReceipt": False,
                "jobState": "completed",
            }
            for row in objects
        ],
    }
    local_inventory_path = tmp_path / "local-inventory.json"
    local_inventory_bytes = write_json(local_inventory_path, local_inventory)
    gcs_inventory = {
        "extraCount": len(objects),
        "extraBytes": stored_bytes,
        "extra": [
            {
                "objectKey": row["target"]["objectKey"],
                "generation": row["target"]["generation"],
                "size": row["target"]["storedByteSize"],
            }
            for row in objects
        ],
    }
    gcs_inventory_path = tmp_path / "gcs-inventory.json"
    gcs_inventory_bytes = write_json(gcs_inventory_path, gcs_inventory)

    attestation_id = attested["provenance"]["attestationId"]
    attestation_receipt = {
        "schema_version": 1,
        "status": "ok",
        "engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
        },
        "normalization_probe": {
            "positive_integral": 2.0,
            "zero": 0.0,
            "negative_zero": -0.0,
        },
        "jobs": [
            {
                "job_id": row["engineJobId"],
                "points": [
                    {
                        "artifacts": [
                            {
                                "kind": "engine_bundle",
                                "sha256": row["target"]["storedSha256"],
                                "byte_size": row["target"]["storedByteSize"],
                                "storage": {
                                    "bucket": row["target"]["bucket"],
                                    "object_key": row["target"]["objectKey"],
                                    "generation": row["target"]["generation"],
                                    "stored_sha256": row["target"]["storedSha256"],
                                    "stored_byte_size": row["target"]["storedByteSize"],
                                    "crc32c": row["target"]["crc32c"],
                                },
                            }
                        ]
                    }
                ],
            }
            for row in objects[:4]
        ],
    }
    attestation_receipt_path = tmp_path / "attestation-receipt.json"
    attestation_receipt_bytes = write_json(
        attestation_receipt_path, attestation_receipt
    )
    database_receipt_bytes = canonical_database_receipt(attestation_receipt)
    assert b"2.0" in attestation_receipt_bytes
    assert b"-0.0" in attestation_receipt_bytes
    assert b'"positive_integral":2' in database_receipt_bytes
    assert b'"negative_zero":0' in database_receipt_bytes
    approved_inventory = {
        "schemaVersion": 1,
        "kind": "opencfd2606-operational-canary-approved-inventory",
        "approvedCount": len(objects),
        "approvedJobCount": len(objects),
        "approvedStoredByteSize": stored_bytes,
        "operator": unattested["operator"],
        "inputs": {
            "localInventory": {
                "sha256": sha(local_inventory_bytes),
                "byteSize": len(local_inventory_bytes),
            },
            "gcsInventory": {
                "sha256": sha(gcs_inventory_bytes),
                "byteSize": len(gcs_inventory_bytes),
            },
            "attestationReceipt": {
                "attestationId": attestation_id,
                "databaseReceiptSha256": sha(database_receipt_bytes),
                "retainedReceiptSha256": sha(attestation_receipt_bytes),
                "retainedReceiptByteSize": len(attestation_receipt_bytes),
            },
        },
        "runtimeBuilds": [attested_runtime, unattested_runtime],
        "objects": objects,
    }
    approved_inventory_path = tmp_path / "approved-inventory.json"
    write_json(approved_inventory_path, approved_inventory)
    approved_inventory_sha = sha(
        json.dumps(
            approved_inventory,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    )

    monkeypatch.setattr(
        canary_module, "APPROVED_INVENTORY_SHA256", approved_inventory_sha
    )
    monkeypatch.setattr(canary_module, "APPROVED_JOB_COUNT", len(objects))
    monkeypatch.setattr(canary_module, "APPROVED_STORED_BYTE_SIZE", stored_bytes)
    monkeypatch.setattr(canary_module, "APPROVED_RUNTIME_BUILD_COUNT", 2)
    monkeypatch.setattr(canary_module, "APPROVED_ATTESTATION_ID", attestation_id)
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_DATABASE_RECEIPT_SHA256",
        sha(database_receipt_bytes),
    )
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_DATABASE_RECEIPT_CANONICAL_BYTE_SIZE",
        len(database_receipt_bytes),
    )
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_RETAINED_RECEIPT_SHA256",
        sha(attestation_receipt_bytes),
    )
    monkeypatch.setattr(
        canary_module,
        "APPROVED_ATTESTATION_RETAINED_RECEIPT_BYTE_SIZE",
        len(attestation_receipt_bytes),
    )
    authenticated_inventory = load_approved_inventory(approved_inventory_path)
    protected_proof_root = tmp_path / "protected-generator-proofs"
    generated = generate_approved_claims(
        approved_inventory=authenticated_inventory,
        local_inventory_path=local_inventory_path,
        gcs_inventory_path=gcs_inventory_path,
        attestation_receipt_path=attestation_receipt_path,
        jobs_root=jobs_root,
        audit_journal_root=audit_journal_root,
        protected_proof_root=protected_proof_root,
    )
    _, normalized_receipt = canary_module._authenticate_attestation_receipt(
        attestation_receipt_path, authenticated_inventory
    )

    assert len(generated) == 16
    assert normalized_receipt["normalization_probe"] == {
        "positive_integral": 2,
        "zero": 0,
        "negative_zero": 0,
    }
    assert {claim["approvedInventorySha256"] for claim in generated} == {
        approved_inventory_sha
    }
    assert {claim["provenance"]["kind"] for claim in generated} == {
        "attested_canary",
        "unattested_cutover_canary",
    }
    assert (
        protected_proof_root / sha(attestation_receipt_bytes)
    ).read_bytes() == attestation_receipt_bytes


def test_unattested_claim_requires_every_protected_source_digest(tmp_path: Path) -> None:
    claim, _, jobs_root, proofs, _, _ = fixture(tmp_path)
    journal = claim["provenance"]["sourceJournal"]
    (proofs / journal["sha256"]).unlink()
    with pytest.raises(OperationalCanaryEvidenceError, match="source journal file is missing"):
        validate_local_claim(
            claim, jobs_root, approved_inventory=approved_for(claim),
            protected_proof_root=proofs,
        )


def test_self_consistent_extra_job_cannot_widen_the_sealed_membership(tmp_path: Path) -> None:
    claim, _, jobs_root, proofs, _, _ = fixture(tmp_path)
    approved = approved_for(claim)
    widened = copy.deepcopy(claim)
    widened["job"]["id"] = "widened-production-canary"
    with pytest.raises(OperationalCanaryEvidenceError, match="exact 16 approved"):
        validate_local_claim(
            widened,
            jobs_root,
            approved_inventory=approved,
            protected_proof_root=proofs,
        )


def test_contradictory_identity_and_corrupt_archive_fail_closed(tmp_path: Path) -> None:
    claim, _, jobs_root, proofs, evidence, _ = fixture(tmp_path)
    contradictory = copy.deepcopy(claim)
    contradictory["target"]["objectKey"] = "solver-evidence/v1/sha256/00/" + "0" * 64 + ".tar.zst"
    with pytest.raises(OperationalCanaryEvidenceError, match="canonical content-addressed"):
        validate_local_claim(
            contradictory, jobs_root, approved_inventory=approved_for(claim),
            protected_proof_root=proofs,
        )

    archive = evidence / EVIDENCE_ARCHIVE_NAME
    payload = bytearray(archive.read_bytes())
    payload[len(payload) // 2] ^= 0xFF
    archive.write_bytes(payload)
    with pytest.raises(
        OperationalCanaryEvidenceError,
        match="local archive differs from generation-pinned pointer",
    ):
        validate_local_claim(
            claim, jobs_root, approved_inventory=approved_for(claim),
            protected_proof_root=proofs,
        )


def test_manifest_member_corruption_is_caught_even_when_archive_pointer_matches(tmp_path: Path) -> None:
    claim, _, jobs_root, proofs, evidence, _ = fixture(tmp_path)
    (evidence / EVIDENCE_ARCHIVE_NAME).unlink()
    (evidence / "openfoam/logs/solver.log").write_bytes(b"dishonest changed member\n")
    record = create_tar_zst(evidence, evidence / EVIDENCE_ARCHIVE_NAME, level=10, exclude_names=("engine_evidence.remote.json",))
    target = claim["target"]
    target.update({
        "objectKey": f"solver-evidence/v1/sha256/{record.stored_sha256[:2]}/{record.stored_sha256}.tar.zst",
        "storedSha256": record.stored_sha256,
        "storedByteSize": record.stored_size,
        "tarSha256": record.tar_sha256,
        "tarByteSize": record.tar_size,
    })
    claim["evidence"]["archiveSha256"] = record.stored_sha256
    claim["evidence"]["archiveByteSize"] = record.stored_size
    pointer = RemoteEvidencePointer(
        bucket=target["bucket"], object_key=target["objectKey"], generation=int(target["generation"]),
        stored_sha256=target["storedSha256"], stored_size=target["storedByteSize"],
        tar_sha256=target["tarSha256"], tar_size=target["tarByteSize"], crc32c=target["crc32c"],
        zstd_level=target["zstdLevel"], created_at="2026-07-18T18:00:00Z",
    )
    pointer_bytes = write_json(evidence / "engine_evidence.remote.json", pointer.to_dict())
    claim["evidence"]["pointerSha256"] = sha(pointer_bytes)
    claim["evidence"]["pointerByteSize"] = len(pointer_bytes)
    with pytest.raises(OperationalCanaryEvidenceError, match="manifest verification"):
        validate_local_claim(
            claim, jobs_root, approved_inventory=approved_for(claim),
            protected_proof_root=proofs,
        )


def test_wrong_registration_digest_never_reaches_local_deletion(tmp_path: Path) -> None:
    claim, ack, jobs_root, proofs, evidence, store = fixture(tmp_path)
    ack["registrationReceiptSha256"] = "f" * 64
    with pytest.raises(OperationalCanaryEvidenceError, match="acknowledgement differs"):
        retain_local_canary_evidence(
            claim, ack, object(), jobs_root=jobs_root,
            approved_inventory=approved_for(claim),
            protected_proof_root=proofs, store=store, execute=True,
        )
    assert (evidence / EVIDENCE_ARCHIVE_NAME).is_file()
    assert (evidence / "openfoam").is_dir()


def test_fresh_restore_precedes_local_strip_and_execute_is_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claim, ack, jobs_root, proofs, evidence, store = fixture(tmp_path)
    events: list[str] = []
    store.events = events
    real_remove = canary_module._remove_path

    def observed_remove(path: Path) -> None:
        events.append(f"delete:{path.name}")
        real_remove(path)

    monkeypatch.setattr(canary_module, "_remove_path", observed_remove)
    first = retain_local_canary_evidence(
        claim, ack, object(), jobs_root=jobs_root,
        approved_inventory=approved_for(claim),
        protected_proof_root=proofs, store=store, execute=True,
    )
    assert first.status == "retained"
    assert first.bytes_deleted > 0
    assert store.calls == [True]
    assert events[0] == "fresh-restore"
    assert all(event.startswith("delete:") for event in events[1:])
    assert not (evidence / EVIDENCE_ARCHIVE_NAME).exists()
    assert not (evidence / "openfoam").exists()
    assert (evidence / "engine_evidence.remote.json").is_file()
    assert (evidence / "evidence_manifest.json").is_file()
    assert (evidence / LOCAL_INTENT_NAME).is_file()
    original_receipt = (evidence / LOCAL_RECEIPT_NAME).read_bytes()

    second = retain_local_canary_evidence(
        claim, ack, object(), jobs_root=jobs_root,
        approved_inventory=approved_for(claim),
        protected_proof_root=proofs, store=store, execute=True,
    )
    assert second.status == "already-retained"
    assert store.calls == [True, True]
    assert events[-1] == "fresh-restore"
    assert sum(event == "fresh-restore" for event in events) == 2
    assert (evidence / LOCAL_RECEIPT_NAME).read_bytes() == original_receipt


def test_crash_after_intent_reconciles_without_losing_audit(tmp_path: Path) -> None:
    claim, ack, jobs_root, proofs, evidence, store = fixture(tmp_path)
    with pytest.raises(OperationalCanaryEvidenceError, match="after durable cleanup intent"):
        retain_local_canary_evidence(
            claim, ack, object(), jobs_root=jobs_root,
            approved_inventory=approved_for(claim),
            protected_proof_root=proofs, store=store, execute=True,
            crash_after_intent=True,
        )
    assert (evidence / LOCAL_INTENT_NAME).is_file()
    assert (evidence / EVIDENCE_ARCHIVE_NAME).is_file()
    assert not (evidence / LOCAL_RECEIPT_NAME).exists()
    completed = retain_local_canary_evidence(
        claim, ack, object(), jobs_root=jobs_root,
        approved_inventory=approved_for(claim),
        protected_proof_root=proofs, store=store, execute=True,
    )
    assert completed.status == "retained"
    assert (evidence / LOCAL_RECEIPT_NAME).is_file()


def test_crash_after_partial_deletion_reconciles_exact_intent(tmp_path: Path) -> None:
    claim, ack, jobs_root, proofs, evidence, store = fixture(tmp_path)
    with pytest.raises(OperationalCanaryEvidenceError, match="partial local deletion"):
        retain_local_canary_evidence(
            claim, ack, object(), jobs_root=jobs_root,
            approved_inventory=approved_for(claim),
            protected_proof_root=proofs, store=store, execute=True,
            crash_after_deletions=1,
        )
    intent = json.loads((evidence / LOCAL_INTENT_NAME).read_text())
    assert any(not (evidence / row["path"]).exists() for row in intent["paths"])
    assert any((evidence / row["path"]).exists() for row in intent["paths"])
    completed = retain_local_canary_evidence(
        claim, ack, object(), jobs_root=jobs_root,
        approved_inventory=approved_for(claim),
        protected_proof_root=proofs, store=store, execute=True,
    )
    assert completed.status == "retained"
    assert all(not (evidence / row["path"]).exists() for row in intent["paths"])
