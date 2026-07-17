"""API regressions for verified remote-only solver evidence."""

from __future__ import annotations

import json
import hashlib
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam.api import main as api_main
from airfoilfoam.evidence_runtime import EVIDENCE_POINTER_NAME
from airfoilfoam.evidence_store import EvidenceHydrationError
from airfoilfoam.storage import JobStore


@pytest.fixture
def client() -> TestClient:
    return TestClient(api_main.app)


@pytest.fixture
def remote_case() -> tuple[str, Path, Path]:
    store = JobStore()
    job_id = f"api-remote-evidence-{uuid.uuid4().hex}"
    case_dir = store.case_dir(job_id, "case-1")
    evidence_dir = case_dir / "evidence"
    evidence_dir.mkdir(parents=True)
    (evidence_dir / EVIDENCE_POINTER_NAME).write_text("{}", encoding="utf-8")
    try:
        yield job_id, case_dir, evidence_dir
    finally:
        shutil.rmtree(store.job_dir(job_id), ignore_errors=True)


def _write_manifest(evidence_dir: Path, members: list[str], *, start=1.0, end=2.0) -> None:
    (evidence_dir / "evidence_manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "windowStart": start,
                "windowEnd": end,
                "files": [
                    {"path": path, "byteSize": 1, "sha256": "0" * 64}
                    for path in members
                ],
            }
        ),
        encoding="utf-8",
    )


def _write_pointer(evidence_dir: Path, archive: bytes) -> dict[str, object]:
    stored_sha256 = hashlib.sha256(archive).hexdigest()
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "format": "tar+zstd",
        "bucket": "airfoils-pro-storage-bucket",
        "objectKey": f"sha256/{stored_sha256[:2]}/{stored_sha256}.tar.zst",
        "generation": "18446744073709551615",
        "storedSha256": stored_sha256,
        "storedSize": len(archive),
        "tarSha256": hashlib.sha256(b"tar stream").hexdigest(),
        "tarSize": 128,
        "crc32c": "AAAAAA==",
        "zstdLevel": 10,
        "createdAt": "2026-07-17T08:00:00.000Z",
    }
    (evidence_dir / EVIDENCE_POINTER_NAME).write_text(
        json.dumps(payload), encoding="utf-8"
    )
    return payload


def _expected_pointer_params(pointer: dict[str, object]) -> dict[str, object]:
    return {
        "expected_bucket": pointer["bucket"],
        "expected_object_key": pointer["objectKey"],
        "expected_generation": pointer["generation"],
        "expected_stored_sha256": pointer["storedSha256"],
        "expected_stored_size": pointer["storedSize"],
    }


def test_remote_only_render_endpoints_hold_hydration_lease(
    client, remote_case, tmp_path, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    _write_manifest(evidence_dir, ["VTK/frame.vtu"])
    hydrated = tmp_path / "hydrated"
    (hydrated / "VTK").mkdir(parents=True)
    (hydrated / "evidence_manifest.json").write_text(
        json.dumps({"windowStart": 3.0, "windowEnd": 4.0}), encoding="utf-8"
    )
    lease = {"active": False, "enters": 0, "exits": 0}

    @contextmanager
    def fake_hydrated_render_source(actual_evidence_dir, _settings):
        assert actual_evidence_dir == evidence_dir
        assert lease["active"] is False
        lease["active"] = True
        lease["enters"] += 1
        try:
            yield hydrated
        finally:
            lease["active"] = False
            lease["exits"] += 1

    def fake_custom(source_dir, out_dir, *_args, **_kwargs):
        assert lease["active"] is True
        assert source_dir == hydrated
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "custom.png").write_bytes(b"custom-image")
        return "custom.png"

    def fake_extents(source_dir, *_args, **_kwargs):
        assert lease["active"] is True
        assert source_dir == hydrated
        return {"pressure": {"vmin": -1.0, "vmax": 1.0}}

    def fake_contours(source_dir, out_dir, *_args, **_kwargs):
        assert lease["active"] is True
        assert source_dir == hydrated
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "pressure.png").write_bytes(b"default-image")
        return {"pressure": "pressure.png"}

    monkeypatch.setattr(api_main, "hydrated_render_source", fake_hydrated_render_source)
    monkeypatch.setattr(api_main, "render_custom_field", fake_custom)
    monkeypatch.setattr(api_main, "compute_field_extents", fake_extents)
    monkeypatch.setattr(api_main, "render_contours", fake_contours)

    common = {
        "case_slug": "case-1",
        "airfoil_points": [[0.0, 0.0], [1.0, 0.0]],
        "chord": 1.0,
        "speed": 20.0,
    }
    rendered = client.post(
        f"/jobs/{job_id}/render-field",
        json={**common, "field": "pressure"},
    )
    assert rendered.status_code == 200, rendered.text
    assert lease["active"] is False

    extents = client.post(
        f"/jobs/{job_id}/field-extents",
        json={**common, "fields": ["pressure"]},
    )
    assert extents.status_code == 200, extents.text
    assert extents.json()["window_start"] == 1.0
    assert extents.json()["window_end"] == 2.0
    assert lease["active"] is False

    defaults = client.post(
        f"/jobs/{job_id}/render-default-media",
        json={
            **common,
            "fields": ["pressure"],
            "scales": {"pressure": {"vmin": -1.0, "vmax": 1.0}},
        },
    )
    assert defaults.status_code == 200, defaults.text
    assert defaults.json()["images"][0]["field"] == "pressure"
    assert lease == {"active": False, "enters": 3, "exits": 3}


def test_render_prefers_existing_local_finalized_vtk(
    client, remote_case, monkeypatch
):
    job_id, case_dir, evidence_dir = remote_case
    expected = evidence_dir
    (expected / "VTK").mkdir(parents=True)
    # Even if a mutable live case is also present, finalized exact evidence
    # has priority.
    (case_dir / "VTK").mkdir(parents=True)

    @contextmanager
    def forbidden_remote(*_args, **_kwargs):
        raise AssertionError("local VTK must not hydrate remote evidence")
        yield  # pragma: no cover

    def fake_extents(source_dir, *_args, **_kwargs):
        assert source_dir == expected
        return {}

    monkeypatch.setattr(api_main, "hydrated_render_source", forbidden_remote)
    monkeypatch.setattr(api_main, "compute_field_extents", fake_extents)
    response = client.post(
        f"/jobs/{job_id}/field-extents",
        json={
            "case_slug": "case-1",
            "airfoil_points": [[0.0, 0.0], [1.0, 0.0]],
            "chord": 1.0,
            "speed": 20.0,
            "fields": ["pressure"],
        },
    )
    assert response.status_code == 200, response.text


def test_render_uses_remote_exact_generation_over_mutable_live_case(
    client, remote_case, tmp_path, monkeypatch
):
    job_id, case_dir, evidence_dir = remote_case
    (case_dir / "VTK").mkdir(parents=True)
    hydrated = tmp_path / "hydrated"
    (hydrated / "VTK").mkdir(parents=True)
    calls = 0

    @contextmanager
    def exact_remote(actual_evidence_dir, _settings):
        nonlocal calls
        assert actual_evidence_dir == evidence_dir
        calls += 1
        yield hydrated

    def fake_extents(source_dir, *_args, **_kwargs):
        assert source_dir == hydrated
        return {}

    monkeypatch.setattr(api_main, "hydrated_render_source", exact_remote)
    monkeypatch.setattr(api_main, "compute_field_extents", fake_extents)
    response = client.post(
        f"/jobs/{job_id}/field-extents",
        json={
            "case_slug": "case-1",
            "airfoil_points": [[0.0, 0.0], [1.0, 0.0]],
            "chord": 1.0,
            "speed": 20.0,
            "fields": ["pressure"],
        },
    )
    assert response.status_code == 200, response.text
    assert calls == 1


def test_job_archive_expected_identity_verifies_remote_bytes_and_generation(
    client, remote_case, tmp_path, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    archive = b"verified-generation-pinned-zstandard"
    pointer = _write_pointer(evidence_dir, archive)
    cached = tmp_path / "verified-archive.tar.zst"
    cached.write_bytes(archive)
    seen = []

    class ExactRemoteStore:
        @contextmanager
        def archive_source(self, exact_pointer):
            seen.append(exact_pointer)
            assert exact_pointer.bucket == pointer["bucket"]
            assert exact_pointer.object_key == pointer["objectKey"]
            assert str(exact_pointer.generation) == pointer["generation"]
            yield cached

    monkeypatch.setattr(
        api_main, "evidence_object_store", lambda _settings: ExactRemoteStore()
    )
    response = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/engine_evidence.tar.zst",
        params=_expected_pointer_params(pointer),
    )
    assert response.status_code == 200, response.text
    assert response.content == archive
    assert response.headers["x-content-sha256"] == pointer["storedSha256"]
    assert response.headers["x-gcs-generation"] == pointer["generation"]
    assert len(seen) == 1

    mismatched = _expected_pointer_params(pointer)
    mismatched["expected_generation"] = "18446744073709551614"
    response = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/engine_evidence.tar.zst",
        params=mismatched,
    )
    assert response.status_code == 409
    assert "expected immutable generation" in response.json()["detail"]
    assert len(seen) == 1


def test_job_archive_expected_identity_rejects_corrupt_local_bytes(
    client, remote_case, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    pointer = _write_pointer(evidence_dir, b"genuine-zstandard-archive")
    (evidence_dir / "engine_evidence.tar.zst").write_bytes(
        b"corrupt-local-archive-bytes"
    )

    class ForbiddenRemoteStore:
        def archive_source(self, *_args):  # pragma: no cover - defensive
            raise AssertionError("a present local archive must be verified locally")

    monkeypatch.setattr(
        api_main, "evidence_object_store", lambda _settings: ForbiddenRemoteStore()
    )
    response = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/engine_evidence.tar.zst",
        params=_expected_pointer_params(pointer),
    )
    assert response.status_code == 502
    assert "does not match the immutable generation" in response.json()["detail"]


def test_job_files_stream_archive_and_every_packaged_artifact_from_remote_cache(
    client, remote_case, tmp_path, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    members = [
        "openfoam/logs/log.simpleFoam",
        "openfoam/steady/system/controlDict",
        "openfoam/steady/constant/polyMesh/points",
        "time_directories/1/U",
        "VTK/frame.vtu",
    ]
    _write_manifest(evidence_dir, members)
    live_leases: set[str] = set()

    class FakeRemoteStore:
        @contextmanager
        def archive_source(self, pointer_path):
            assert pointer_path == evidence_dir / EVIDENCE_POINTER_NAME
            path = tmp_path / "cached-archive.tar.zst"
            path.write_bytes(b"verified-zstandard")
            live_leases.add("archive")
            try:
                yield path
            finally:
                live_leases.remove("archive")
                path.unlink(missing_ok=True)

        @contextmanager
        def member_source(self, pointer_path, member_path):
            assert pointer_path == evidence_dir / EVIDENCE_POINTER_NAME
            assert member_path in members
            path = tmp_path / f"member-{members.index(member_path)}"
            path.write_bytes(f"verified:{member_path}".encode())
            live_leases.add(member_path)
            try:
                yield path
            finally:
                live_leases.remove(member_path)
                path.unlink(missing_ok=True)

    monkeypatch.setattr(api_main, "evidence_object_store", lambda _settings: FakeRemoteStore())

    archive = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/engine_evidence.tar.zst"
    )
    assert archive.status_code == 200, archive.text
    assert archive.headers["content-type"].startswith("application/zstd")
    assert archive.content == b"verified-zstandard"
    assert live_leases == set()
    assert not (tmp_path / "cached-archive.tar.zst").exists()

    for member in members:
        response = client.get(
            f"/jobs/{job_id}/files/cases/case-1/evidence/{member}"
        )
        assert response.status_code == 200, response.text
        assert response.content == f"verified:{member}".encode()
        assert live_leases == set()


def test_job_file_does_not_hydrate_unlisted_or_excluded_members(
    client, remote_case, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    _write_manifest(evidence_dir, [])

    class ForbiddenRemoteStore:
        def archive_source(self, *_args):  # pragma: no cover - defensive
            raise AssertionError("archive source should not be used")

        def member_source(self, *_args):  # pragma: no cover - defensive
            raise AssertionError("member source should not be used")

    monkeypatch.setattr(api_main, "evidence_object_store", lambda _settings: ForbiddenRemoteStore())
    unlisted = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/VTK/missing.vtu"
    )
    assert unlisted.status_code == 404
    missing_frame = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/frames/pressure/f0000.png"
    )
    assert missing_frame.status_code == 404


def test_job_file_reports_remote_integrity_failure(
    client, remote_case, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    member = "VTK/bad.vtu"
    _write_manifest(evidence_dir, [member])

    class CorruptRemoteStore:
        @contextmanager
        def member_source(self, *_args):
            raise EvidenceHydrationError("downloaded archive SHA-256 does not match pointer")
            yield  # pragma: no cover

    monkeypatch.setattr(api_main, "evidence_object_store", lambda _settings: CorruptRemoteStore())
    response = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/{member}"
    )
    assert response.status_code == 502
    assert "could not be verified" in response.json()["detail"]


def test_remote_pointer_without_configured_store_is_service_unavailable(
    client, remote_case, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    member = "openfoam/logs/log.simpleFoam"
    _write_manifest(evidence_dir, [member])
    monkeypatch.setattr(api_main, "evidence_object_store", lambda _settings: None)
    response = client.get(
        f"/jobs/{job_id}/files/cases/case-1/evidence/{member}"
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "Remote evidence storage is not configured"
