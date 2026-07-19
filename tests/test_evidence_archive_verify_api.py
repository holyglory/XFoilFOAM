from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

import google_crc32c
import pytest
import zstandard
from fastapi.testclient import TestClient

from airfoilfoam.api import main as api_main
from airfoilfoam.config import Settings
from airfoilfoam.evidence_store import (
    ARCHIVE_FORMAT,
    ARCHIVE_MIME_TYPE,
    POINTER_SCHEMA_VERSION,
    EvidenceObjectStore,
    RemoteEvidencePointer,
    manifest_bundle_member_set_sha256,
)


BUCKET = "airfoils-evidence-test"
PREFIX = "solver-evidence/v1"
TOKEN = "archive-verification-control-plane-token"


class NotFound(Exception):
    code = 404


@dataclass
class StoredObject:
    data: bytes
    metadata: dict[str, str]
    content_type: str
    generation: int
    crc32c: str


class Blob:
    def __init__(self, client: "StorageClient", bucket: str, key: str):
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

    def download_to_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        assert checksum == "crc32c"
        assert timeout > 0
        stored = self.client.objects[(self.bucket, self.key)]
        if stored.generation != if_generation_match:
            raise RuntimeError("generation mismatch")
        self.client.downloads += 1
        Path(filename).write_bytes(stored.data)


class Bucket:
    def __init__(self, client: "StorageClient", name: str):
        self.client = client
        self.name = name

    def blob(self, key: str) -> Blob:
        return Blob(self.client, self.name, key)


class StorageClient:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], StoredObject] = {}
        self.downloads = 0

    def bucket(self, name: str) -> Bucket:
        return Bucket(self, name)


@dataclass(frozen=True)
class ArchiveFixture:
    manifest: bytes
    pointer: RemoteEvidencePointer
    store: EvidenceObjectStore
    storage: StorageClient

    def request(self) -> dict[str, object]:
        member_count, member_set_sha256 = manifest_bundle_member_set_sha256(
            self.manifest
        )
        return {
            "remote": self.pointer.to_dict(),
            "manifestBase64": base64.b64encode(self.manifest).decode("ascii"),
            "manifestSha256": hashlib.sha256(self.manifest).hexdigest(),
            "manifestByteSize": len(self.manifest),
            "manifestMemberSetSha256": member_set_sha256,
            "manifestMemberCount": member_count,
        }


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def manifest_bytes(
    content: bytes = b"real OpenFOAM solver output\n",
    *,
    role: str = "solver_log",
) -> bytes:
    return json.dumps(
        {
            "schemaVersion": 2,
            "files": [
                {
                    "path": "logs/log.simpleFoam",
                    "byteSize": len(content),
                    "sha256": sha256(content),
                    "role": role,
                }
            ],
        },
        separators=(",", ":"),
    ).encode("utf-8")


def tar_bytes(
    manifest: bytes,
    *,
    archive_kind: str = "valid",
    content: bytes = b"real OpenFOAM solver output\n",
) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
        manifest_info = tarfile.TarInfo("evidence_manifest.json")
        manifest_info.size = len(manifest)
        manifest_info.mtime = 0
        archive.addfile(manifest_info, io.BytesIO(manifest))

        if archive_kind != "missing_member":
            member_name = (
                "../escaped"
                if archive_kind == "unsafe_path"
                else "logs/log.simpleFoam"
            )
            member = tarfile.TarInfo(member_name)
            member.mtime = 0
            if archive_kind in {"symlink", "hardlink"}:
                member.type = (
                    tarfile.SYMTYPE
                    if archive_kind == "symlink"
                    else tarfile.LNKTYPE
                )
                member.linkname = "/etc/passwd"
                archive.addfile(member)
            elif archive_kind == "fifo":
                member.type = tarfile.FIFOTYPE
                archive.addfile(member)
            else:
                actual_content = (
                    b"tampered OpenFOAM output\n"
                    if archive_kind == "wrong_member"
                    else content
                )
                member.size = len(actual_content)
                archive.addfile(member, io.BytesIO(actual_content))
                if archive_kind == "duplicate":
                    duplicate = tarfile.TarInfo(member_name)
                    duplicate.size = len(content)
                    duplicate.mtime = 0
                    archive.addfile(duplicate, io.BytesIO(content))
            if archive_kind == "extra_member":
                extra_content = b"unmanifested evidence\n"
                extra = tarfile.TarInfo("logs/unmanifested.log")
                extra.size = len(extra_content)
                extra.mtime = 0
                archive.addfile(extra, io.BytesIO(extra_content))
    return stream.getvalue()


def archive_fixture(
    tmp_path: Path,
    *,
    archive_kind: str = "valid",
) -> ArchiveFixture:
    manifest = manifest_bytes()
    raw_tar = tar_bytes(manifest, archive_kind=archive_kind)
    if archive_kind == "malformed_zstd":
        stored = b"not a Zstandard stream"
    else:
        stored = zstandard.ZstdCompressor(level=7).compress(raw_tar)
        if archive_kind == "truncated_zstd":
            stored = stored[:-8]
    stored_sha256 = sha256(stored)
    key = (
        f"{PREFIX}/sha256/{stored_sha256[:2]}/{stored_sha256}.tar.zst"
    )
    generation = 41
    crc32c = base64.b64encode(
        google_crc32c.Checksum(stored).digest()
    ).decode("ascii")
    pointer = RemoteEvidencePointer(
        bucket=BUCKET,
        object_key=key,
        generation=generation,
        stored_sha256=stored_sha256,
        stored_size=len(stored),
        tar_sha256=(
            "f" * 64 if archive_kind == "wrong_tar_identity" else sha256(raw_tar)
        ),
        tar_size=len(raw_tar),
        crc32c=crc32c,
        zstd_level=7,
        created_at="2026-07-18T22:45:00+00:00",
    )
    storage = StorageClient()
    storage.objects[(BUCKET, key)] = StoredObject(
        data=stored,
        metadata={
            "airfoilfoam-schema-version": str(POINTER_SCHEMA_VERSION),
            "format": ARCHIVE_FORMAT,
            "stored-sha256": pointer.stored_sha256,
            "stored-size": str(pointer.stored_size),
            "tar-sha256": pointer.tar_sha256,
            "tar-size": str(pointer.tar_size),
            "zstd-level": str(pointer.zstd_level),
        },
        content_type=ARCHIVE_MIME_TYPE,
        generation=generation,
        crc32c=crc32c,
    )
    store = EvidenceObjectStore(
        BUCKET,
        tmp_path / "hydration-cache",
        client=storage,
        object_prefix=PREFIX,
        timeout_seconds=30,
    )
    return ArchiveFixture(manifest, pointer, store, storage)


def api_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fixture: ArchiveFixture,
) -> TestClient:
    settings = Settings(
        data_dir=tmp_path / "data",
        evidence_bucket=BUCKET,
        evidence_object_prefix=PREFIX,
        evidence_hydration_cache_dir=tmp_path / "hydration-cache",
        evidence_gcs_timeout_seconds=30,
        control_plane_token=TOKEN,
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(
        api_main,
        "evidence_object_store",
        lambda _settings: fixture.store,
    )
    return TestClient(api_main.create_app())


def post(
    client: TestClient,
    payload: dict[str, object],
    *,
    token: str | None = TOKEN,
):
    headers = {"authorization": f"Bearer {token}"} if token is not None else {}
    return client.post(
        "/internal/evidence-archives/verify-manifest",
        json=payload,
        headers=headers,
    )


def test_internal_archive_verification_returns_only_exact_authenticated_proof(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = archive_fixture(tmp_path)
    client = api_client(tmp_path, monkeypatch, fixture)
    request = fixture.request()

    response = post(client, request)

    assert response.status_code == 200
    assert response.json() == {
        "state": "verified",
        "remote": request["remote"],
        "manifestSha256": request["manifestSha256"],
        "manifestByteSize": request["manifestByteSize"],
        "manifestMemberSetSha256": request["manifestMemberSetSha256"],
        "manifestMemberCount": request["manifestMemberCount"],
    }
    assert fixture.storage.downloads == 1


@pytest.mark.parametrize("token", [None, "wrong-control-plane-token"])
def test_internal_archive_verification_requires_exact_control_plane_bearer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    token: str | None,
) -> None:
    fixture = archive_fixture(tmp_path)
    response = post(
        api_client(tmp_path, monkeypatch, fixture),
        fixture.request(),
        token=token,
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert fixture.storage.downloads == 0


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("manifestSha256", "f" * 64, "manifest SHA-256"),
        ("manifestByteSize", 1, "manifest byte size"),
        ("manifestMemberSetSha256", "f" * 64, "member-set SHA-256"),
        ("manifestMemberCount", 1, "member count"),
    ],
)
def test_declared_manifest_identity_must_match_supplied_bytes_before_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: object,
    message: str,
) -> None:
    fixture = archive_fixture(tmp_path)
    request = fixture.request()
    request[field] = value

    response = post(api_client(tmp_path, monkeypatch, fixture), request)

    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert fixture.storage.downloads == 0


def test_manifest_base64_must_be_canonical_and_size_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = archive_fixture(tmp_path)
    client = api_client(tmp_path, monkeypatch, fixture)
    malformed = fixture.request()
    malformed["manifestBase64"] = "!!!!"
    oversized = fixture.request()
    oversized["manifestByteSize"] = 64 * 1024**2 + 1

    malformed_response = post(client, malformed)
    oversized_response = post(client, oversized)

    assert malformed_response.status_code == 422
    assert "canonical base64" in malformed_response.json()["detail"]
    assert oversized_response.status_code == 422
    assert fixture.storage.downloads == 0


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda remote: remote.update(generation="42"),
            "generation",
        ),
        (
            lambda remote: remote.update(objectKey=f"{PREFIX}/wrong.tar.zst"),
            "content-addressed",
        ),
        (
            lambda remote: remote.update(bucket="other-bucket"),
            "store bucket",
        ),
    ],
)
def test_archive_verification_rejects_wrong_pointer_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutate,
    message: str,
) -> None:
    fixture = archive_fixture(tmp_path)
    request = fixture.request()
    remote = deepcopy(request["remote"])
    assert isinstance(remote, dict)
    mutate(remote)
    request["remote"] = remote

    response = post(api_client(tmp_path, monkeypatch, fixture), request)

    assert response.status_code == 409
    assert message in response.json()["detail"]
    assert fixture.storage.downloads == 0


def test_archive_manifest_must_match_the_supplied_exact_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = archive_fixture(tmp_path)
    request = fixture.request()
    alternate = manifest_bytes(role="diagnostic_log")
    count, member_set = manifest_bundle_member_set_sha256(alternate)
    request.update(
        manifestBase64=base64.b64encode(alternate).decode("ascii"),
        manifestSha256=sha256(alternate),
        manifestByteSize=len(alternate),
        manifestMemberSetSha256=member_set,
        manifestMemberCount=count,
    )

    response = post(api_client(tmp_path, monkeypatch, fixture), request)

    assert response.status_code == 409
    assert "restored evidence manifest does not match" in response.json()["detail"]
    assert fixture.storage.downloads == 1


@pytest.mark.parametrize(
    ("archive_kind", "message"),
    [
        ("malformed_zstd", "cannot read Zstandard evidence archive"),
        ("truncated_zstd", "cannot read Zstandard evidence archive"),
        ("wrong_tar_identity", "uncompressed tar size or SHA-256"),
        ("duplicate", "duplicate archive member"),
        ("unsafe_path", "unsafe archive path"),
        ("symlink", "unsafe archive member type"),
        ("hardlink", "unsafe archive member type"),
        ("fifo", "unsafe archive member type"),
        ("wrong_member", "archive member failed manifest verification"),
        ("missing_member", "manifest member missing from archive"),
        ("extra_member", "archive member is missing from manifest"),
    ],
)
def test_archive_verification_fails_closed_on_malformed_or_unsafe_archives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    archive_kind: str,
    message: str,
) -> None:
    fixture = archive_fixture(tmp_path, archive_kind=archive_kind)

    response = post(
        api_client(tmp_path, monkeypatch, fixture), fixture.request()
    )

    assert response.status_code == 409
    assert message in response.json()["detail"]
    assert fixture.storage.downloads == 1


def test_remote_pointer_must_be_complete_canonical_shape(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = archive_fixture(tmp_path)
    request = fixture.request()
    remote = deepcopy(request["remote"])
    assert isinstance(remote, dict)
    remote["generation"] = int(str(remote["generation"]))
    request["remote"] = remote

    response = post(api_client(tmp_path, monkeypatch, fixture), request)

    assert response.status_code == 422
    assert "canonical complete evidence pointer" in response.json()["detail"]
    assert fixture.storage.downloads == 0
