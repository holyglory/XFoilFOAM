from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timezone

import google_crc32c
import pytest
from fastapi import HTTPException

from airfoilfoam.api import main as api_main
from airfoilfoam.evidence_store import EvidenceIntegrityError, EvidenceObjectStore, create_tar_zst
from airfoilfoam.evidence_upload_broker import (
    BrokeredEvidenceIdentity,
    BrokeredEvidenceSessionOwner,
    cancel_brokered_upload_session,
    cancel_brokered_upload_session_by_identity,
    create_brokered_upload_session,
    settle_brokered_upload_session_intent,
    verify_brokered_upload,
)
from urllib.error import HTTPError


identity_key = "solver-evidence/v1/sha256/aa/abc.tar.zst"


class NotFound(Exception):
    code = 404


@dataclass
class Stored:
    data: bytes
    metadata: dict[str, str]
    content_type: str
    generation: int
    crc32c: str


class Blob:
    def __init__(self, client: "Client", bucket: str, key: str):
        self.client = client
        self.bucket = bucket
        self.key = key
        self.metadata: dict[str, str] | None = None
        self.content_type: str | None = None
        self.generation: int | None = None
        self.size: int | None = None
        self.crc32c: str | None = None

    def reload(self, *, timeout: float) -> None:
        assert timeout > 0
        try:
            stored = self.client.objects[(self.bucket, self.key)]
        except KeyError as exc:
            raise NotFound() from exc
        self.metadata = dict(stored.metadata)
        self.content_type = stored.content_type
        self.generation = stored.generation
        self.size = len(stored.data)
        self.crc32c = stored.crc32c

    def create_resumable_upload_session(self, **kwargs):
        self.client.session_count += 1
        self.client.session_kwargs = kwargs
        self.client.session_metadata = dict(self.metadata or {})
        return (
            "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o"
            "?uploadType=resumable&upload_id=session-secret&ifGenerationMatch=0"
        )

    def download_to_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        stored = self.client.objects[(self.bucket, self.key)]
        assert checksum == "crc32c"
        assert timeout > 0
        if stored.generation != if_generation_match:
            raise RuntimeError("generation mismatch")
        Path(filename).write_bytes(stored.data)


class Bucket:
    def __init__(self, client: "Client", name: str):
        self.client = client
        self.name = name

    def blob(self, key: str) -> Blob:
        return Blob(self.client, self.name, key)


class Client:
    def __init__(self):
        self.objects: dict[tuple[str, str], Stored] = {}
        self.session_kwargs: dict | None = None
        self.session_metadata: dict[str, str] | None = None
        self.session_count = 0

    def bucket(self, name: str) -> Bucket:
        return Bucket(self, name)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def owner() -> BrokeredEvidenceSessionOwner:
    return BrokeredEvidenceSessionOwner(
        brokered_upload_id="10000000-0000-4000-8000-000000000001",
        promise_id="10000000-0000-4000-8000-000000000002",
        promise_point_id="10000000-0000-4000-8000-000000000003",
        solver_id="10000000-0000-4000-8000-000000000004",
        source_instance_id="remote-test-instance",
        remote_result_id="10000000-0000-4000-8000-000000000005",
        remote_result_attempt_id="10000000-0000-4000-8000-000000000006",
        aoa_deg=3.0,
        engine_job_id="job-test",
        engine_case_slug="case-test",
    )


def fixture(tmp_path: Path):
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    log = b"real OpenFOAM output\n"
    (evidence / "log.simpleFoam").write_bytes(log)
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "files": [
                {
                    "path": "log.simpleFoam",
                    "byteSize": len(log),
                    "sha256": sha(log),
                    "role": "log",
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    (evidence / "evidence_manifest.json").write_bytes(manifest)
    archive = create_tar_zst(evidence, evidence / "engine_evidence.tar.zst", level=7)
    client = Client()
    store = EvidenceObjectStore("evidence-bucket", tmp_path / "cache", client=client)
    key = store.object_key(archive)
    identity = BrokeredEvidenceIdentity(
        bucket="evidence-bucket",
        object_key=key,
        stored_sha256=archive.stored_sha256,
        stored_size=archive.stored_size,
        tar_sha256=archive.tar_sha256,
        tar_size=archive.tar_size,
        manifest_sha256=sha(manifest),
        manifest_size=len(manifest),
        zstd_level=7,
        bundled_file_count=1,
    )
    return store, client, archive, identity


def publish(client: Client, archive, identity, *, generation: int = 41) -> None:
    data = archive.path.read_bytes()
    crc32c = base64.b64encode(google_crc32c.Checksum(data).digest()).decode()
    client.objects[(identity.bucket, identity.object_key)] = Stored(
        data=data,
        metadata=identity.metadata,
        content_type="application/zstd",
        generation=generation,
        crc32c=crc32c,
    )


def test_session_is_create_only_and_pins_content_length(tmp_path: Path) -> None:
    store, client, _archive, identity = fixture(tmp_path)
    session = create_brokered_upload_session(
        store,
        identity,
        owner=owner(),
        ledger_dir=tmp_path / "broker-ledger",
    )

    assert session.upload_url == (
        "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o"
        "?uploadType=resumable&upload_id=session-secret&ifGenerationMatch=0"
    )
    lifetime_hours = (
        datetime.fromisoformat(session.expires_at) - datetime.now(timezone.utc)
    ).total_seconds() / 3600
    assert 7.9 <= lifetime_hours <= 8.0
    assert client.session_kwargs == {
        "content_type": "application/zstd",
        "size": identity.stored_size,
        "checksum": "crc32c",
        "if_generation_match": 0,
        "timeout": store.timeout_seconds,
    }
    assert client.session_metadata == identity.metadata


def test_session_accepts_the_real_gcs_location_shape_with_create_only_precondition(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GCS 3.13 omits ``name`` from Location and retains ifGenerationMatch.

    This is the exact redacted query shape observed from a live create-only
    session against the production bucket.  The upload id below is synthetic;
    no provider bearer is stored in the fixture.
    """

    store, _client, _archive, identity = fixture(tmp_path)
    session_url = (
        "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o"
        "?uploadType=resumable&upload_id=session-secret&ifGenerationMatch=0"
    )

    monkeypatch.setattr(
        Blob,
        "create_resumable_upload_session",
        lambda _self, **_kwargs: session_url,
    )

    session = create_brokered_upload_session(
        store,
        identity,
        owner=owner(),
        ledger_dir=tmp_path / "broker-ledger",
    )

    assert session.upload_url == session_url


def test_existing_object_is_fully_verified_without_issuing_a_bearer_url(tmp_path: Path) -> None:
    store, client, archive, identity = fixture(tmp_path)
    publish(client, archive, identity)

    session = create_brokered_upload_session(
        store,
        identity,
        owner=owner(),
        ledger_dir=tmp_path / "broker-ledger",
    )

    assert session.upload_url is None
    assert session.verified_pointer is not None
    assert session.verified_pointer.generation == 41
    assert client.session_kwargs is None
    repeated = create_brokered_upload_session(
        store,
        identity,
        owner=owner(),
        ledger_dir=tmp_path / "broker-ledger",
    )
    assert repeated.verified_pointer is not None
    assert repeated.verified_pointer.generation == 41


def test_session_intent_is_durable_idempotent_and_cancelled_by_exact_owner(
    tmp_path: Path,
) -> None:
    store, client, _archive, identity = fixture(tmp_path)
    ledger_dir = tmp_path / "broker-ledger"
    exact_owner = owner()
    first = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )
    repeated = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )
    assert repeated == first
    assert client.session_count == 1
    durable = json.loads(
        (ledger_dir / f"{exact_owner.brokered_upload_id}.json").read_text()
    )
    assert durable["state"] == "issued"
    assert durable["uploadUrl"] == first.upload_url

    settle_brokered_upload_session_intent(
        ledger_dir,
        exact_owner,
        identity,
        final=False,
    )
    registered = json.loads(
        (ledger_dir / f"{exact_owner.brokered_upload_id}.json").read_text()
    )
    assert registered["state"] == "registered"
    assert registered["uploadUrl"] == first.upload_url
    assert (ledger_dir / f"{exact_owner.brokered_upload_id}.json").stat().st_mode & 0o777 == 0o600

    def cancelled(request, *, timeout):
        assert request.full_url == first.upload_url
        assert timeout == 15.0
        raise HTTPError(request.full_url, 499, "cancelled", {}, None)

    result = cancel_brokered_upload_session_by_identity(
        ledger_dir,
        exact_owner,
        identity,
        supplied_upload_url=first.upload_url,
        opener=cancelled,
    )
    assert result.status_code == 499
    terminal = json.loads(
        (ledger_dir / f"{exact_owner.brokered_upload_id}.json").read_text()
    )
    assert terminal["state"] == "cancelled"
    assert "uploadUrl" not in terminal

    replacement = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )
    assert replacement.upload_url == first.upload_url
    assert client.session_count == 2


def test_lost_final_upload_response_recovers_the_exact_committed_generation(
    tmp_path: Path,
) -> None:
    store, client, archive, identity = fixture(tmp_path)
    ledger_dir = tmp_path / "broker-ledger"
    exact_owner = owner()
    issued = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )
    assert issued.upload_url is not None
    assert client.session_count == 1

    # Model GCS committing the final resumable PUT while the remote solver
    # loses the response and therefore never learns the generation.
    publish(client, archive, identity, generation=73)
    recovered = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )

    assert recovered.upload_url is None
    assert recovered.verified_pointer is not None
    assert recovered.verified_pointer.generation == 73
    assert client.session_count == 1
    settled = json.loads(
        (ledger_dir / f"{exact_owner.brokered_upload_id}.json").read_text()
    )
    assert settled["state"] == "settled"
    assert settled["verifiedGeneration"] == "73"
    assert "uploadUrl" not in settled


def test_session_intent_survives_lost_hub_settlement_and_cancels_without_url(
    tmp_path: Path,
) -> None:
    store, _client, _archive, identity = fixture(tmp_path)
    ledger_dir = tmp_path / "broker-ledger"
    exact_owner = owner()
    session = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )

    def cancelled(request, *, timeout):
        assert request.full_url == session.upload_url
        raise HTTPError(request.full_url, 499, "cancelled", {}, None)

    result = cancel_brokered_upload_session_by_identity(
        ledger_dir,
        exact_owner,
        identity,
        opener=cancelled,
    )
    assert result.status_code == 499


def test_pre_provider_failure_is_retryable_without_creating_a_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, client, _archive, identity = fixture(tmp_path)
    ledger_dir = tmp_path / "broker-ledger"
    exact_owner = owner()
    original_reload = Blob.reload

    def unavailable(_self, *, timeout):
        raise RuntimeError("inspection unavailable")

    monkeypatch.setattr(Blob, "reload", unavailable)
    with pytest.raises(Exception, match="could not inspect"):
        create_brokered_upload_session(
            store,
            identity,
            owner=exact_owner,
            ledger_dir=ledger_dir,
        )
    assert client.session_count == 0
    retryable = json.loads(
        (ledger_dir / f"{exact_owner.brokered_upload_id}.json").read_text()
    )
    assert retryable["state"] == "retryable"

    monkeypatch.setattr(Blob, "reload", original_reload)
    session = create_brokered_upload_session(
        store,
        identity,
        owner=exact_owner,
        ledger_dir=ledger_dir,
    )
    assert session.upload_url is not None
    assert client.session_count == 1


def test_provider_creation_exception_retains_an_uncertain_incident(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, client, _archive, identity = fixture(tmp_path)
    ledger_dir = tmp_path / "broker-ledger"
    exact_owner = owner()
    attempts = 0

    def uncertain(_self, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise RuntimeError("provider response lost")

    monkeypatch.setattr(Blob, "create_resumable_upload_session", uncertain)
    with pytest.raises(Exception, match="could not create"):
        create_brokered_upload_session(
            store,
            identity,
            owner=exact_owner,
            ledger_dir=ledger_dir,
        )
    incident_path = ledger_dir / f"{exact_owner.brokered_upload_id}.json"
    incident = json.loads(incident_path.read_text())
    assert incident["state"] == "creation-uncertain"
    assert "provider response lost" not in incident_path.read_text()

    with pytest.raises(Exception, match="already creation-uncertain"):
        create_brokered_upload_session(
            store,
            identity,
            owner=exact_owner,
            ledger_dir=ledger_dir,
        )
    with pytest.raises(Exception, match="operator incident retained"):
        cancel_brokered_upload_session_by_identity(
            ledger_dir,
            exact_owner,
            identity,
        )
    assert attempts == 1
    assert client.session_count == 0


def test_verification_fails_closed_on_manifest_identity_and_generation(tmp_path: Path) -> None:
    store, client, archive, identity = fixture(tmp_path)
    publish(client, archive, identity)

    with pytest.raises(EvidenceIntegrityError, match="generation"):
        verify_brokered_upload(store, identity, 42)
    with pytest.raises(ValueError, match="uint64"):
        verify_brokered_upload(store, identity, 18_446_744_073_709_551_616)

    wrong = BrokeredEvidenceIdentity(
        **{
            **identity.__dict__,
            "manifest_sha256": "f" * 64,
        }
    )
    # GCS custom metadata is immutable evidence identity too, so a dishonest
    # manifest claim is rejected before any canonical association is possible.
    with pytest.raises(EvidenceIntegrityError, match="metadata"):
        verify_brokered_upload(store, wrong, 41)


def test_internal_broker_endpoint_requires_the_control_plane_bearer() -> None:
    token = "broker-control-plane-token-at-least-32-bytes"
    for supplied in (None, "", "Bearer wrong", token):
        with pytest.raises(HTTPException) as rejected:
            api_main._require_control_plane_bearer(token, supplied)
        assert rejected.value.status_code == 401
        assert rejected.value.headers == {"WWW-Authenticate": "Bearer"}
    api_main._require_control_plane_bearer(token, f"Bearer {token}")


def test_resumable_session_cancellation_is_bounded_and_redacted() -> None:
    seen: dict[str, object] = {}

    def cancelled(request, *, timeout):
        seen["method"] = request.get_method()
        seen["timeout"] = timeout
        raise HTTPError(request.full_url, 499, "cancelled", {}, None)

    result = cancel_brokered_upload_session(
        "https://storage.googleapis.com/upload/storage/v1/b/evidence/o"
        "?uploadType=resumable&upload_id=opaque-secret&ifGenerationMatch=0",
        "evidence",
        identity_key,
        timeout_seconds=600,
        opener=cancelled,
    )
    assert result.status_code == 499
    assert seen == {"method": "DELETE", "timeout": 30.0}

    with pytest.raises(ValueError, match="invalid GCS") as rejected:
        cancel_brokered_upload_session(
            "https://attacker.invalid/upload?uploadType=resumable&name=x&upload_id=opaque-secret",
            "evidence",
            identity_key,
            opener=cancelled,
        )
    assert "opaque-secret" not in str(rejected.value)


@pytest.mark.parametrize(
    "capability",
    [
        "https://user:pass@storage.googleapis.com/upload/storage/v1/b/b/o?upload_id=x",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o?upload_id=x#fragment",
        "https://storage.googleapis.com:444/upload/storage/v1/b/b/o?upload_id=x",
        "https://evil.example/upload/storage/v1/b/b/o?upload_id=x",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o?upload_id=x&upload_id=y",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=resumable&upload_id=x&ifGenerationMatch=1",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=resumable&upload_id=x&ifGenerationMatch=0&unexpected=y",
        "https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=resumable&upload_id=x&ifGenerationMatch=0&name=wrong",
    ],
)
def test_resumable_session_cancellation_rejects_ambiguous_targets(
    capability: str,
) -> None:
    with pytest.raises(ValueError, match="invalid GCS"):
        cancel_brokered_upload_session(
            capability,
            "evidence-bucket",
            "solver-evidence/v1/sha256/aa/abc.tar.zst",
            opener=lambda *_args, **_kwargs: None,
        )


def test_resumable_session_cancellation_does_not_follow_redirects() -> None:
    def redirect(request, *, timeout):
        raise HTTPError(
            request.full_url,
            302,
            "redirect",
            {"location": "https://evil.example/exfiltrate"},
            None,
        )

    with pytest.raises(Exception, match=r"cancellation failed \(302\)"):
        cancel_brokered_upload_session(
            "https://storage.googleapis.com/upload/storage/v1/b/evidence/o"
            "?uploadType=resumable&upload_id=opaque-secret&ifGenerationMatch=0",
            "evidence",
            identity_key,
            opener=redirect,
        )
