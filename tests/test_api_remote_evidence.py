"""API regressions for verified remote-only solver evidence."""

from __future__ import annotations

import json
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from airfoilfoam.api import main as api_main
from airfoilfoam.config import Settings
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


def test_cleanup_request_rejects_conflicting_duplicate_database_identity() -> None:
    association = {
        "result_id": "11111111-1111-4111-8111-111111111111",
        "result_attempt_id": "22222222-2222-4222-8222-222222222222",
        "source_artifact_id": "33333333-3333-4333-8333-333333333333",
        "archive_id": "44444444-4444-4444-8444-444444444444",
        "member_association_count": 5,
        "member_associations_sha256": "a" * 64,
        "manifest_member_set_sha256": "b" * 64,
    }

    with pytest.raises(ValueError, match="stable evidence cleanup association"):
        api_main.FinalizeRemoteEvidenceRequest.model_validate(
            {
                "case_slug": "case-1",
                "evidence_base": "evidence",
                "remote": {},
                "database_associations": [
                    association,
                    {**association, "member_associations_sha256": "c" * 64},
                ],
            }
        )


def test_cleanup_request_rejects_conflicting_duplicate_canary_point_identity() -> None:
    registration = {
        "registration_id": "55555555-5555-4555-8555-555555555555",
        "receipt_sha256": "d" * 64,
        "scenario": "serial-rans",
        "aoa_deg": 2,
        "member_association_count": 5,
        "member_associations_sha256": "e" * 64,
        "manifest_member_set_sha256": "f" * 64,
    }

    with pytest.raises(ValueError, match="stable evidence cleanup association"):
        api_main.FinalizeRemoteEvidenceRequest.model_validate(
            {
                "case_slug": "case-1",
                "evidence_base": "evidence",
                "remote": {},
                "canary_evidence_registrations": [
                    registration,
                    {
                        **registration,
                        "receipt_sha256": "0" * 64,
                        "member_associations_sha256": "0" * 64,
                    },
                ],
            }
        )


def test_finalize_remote_endpoint_requires_bearer_and_one_association_kind(
    tmp_path: Path, monkeypatch
) -> None:
    token = "endpoint-control-plane-token-at-least-32-bytes"
    settings = Settings(data_dir=tmp_path, control_plane_token=token)
    job_id = "api-finalize-remote-auth-job"
    store = JobStore(settings)
    job_root = store.job_dir(job_id)
    evidence = job_root / "cases" / "case-1" / "evidence"
    evidence.mkdir(parents=True)
    (job_root / "status.json").write_text(
        json.dumps({"job_id": job_id, "state": "completed"}), encoding="utf-8"
    )
    (job_root / "result.json").write_text(
        json.dumps({"job_id": job_id, "state": "completed"}), encoding="utf-8"
    )
    calls = []

    class FakeCleanupResult:
        def to_dict(self):
            return {
                "state": "complete",
                "evidence_base": "evidence",
                "bytes_freed": 123,
                "verification": "archive+manifest+all-members-restore:4",
                "association_count": 1,
            }

    def fake_finalize(job_root_arg, evidence_arg, authorization, settings_arg):
        calls.append((job_root_arg, evidence_arg, authorization, settings_arg))
        return FakeCleanupResult()

    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(api_main, "finalize_remote_evidence_cleanup", fake_finalize)
    app = api_main.create_app()
    endpoint = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None)
        == "/jobs/{job_id}/evidence/finalize-remote"
    )
    remote = {
        "schemaVersion": 1,
        "format": "tar+zstd",
        "bucket": "test-bucket",
        "objectKey": "solver-evidence/v1/sha256/aa/archive.tar.zst",
        "generation": "123456789",
        "storedSha256": "a" * 64,
        "storedSize": 10,
        "tarSha256": "b" * 64,
        "tarSize": 20,
        "crc32c": "AAAAAA==",
        "zstdLevel": 10,
        "createdAt": "2026-07-17T00:00:00+00:00",
    }
    canary = {
        "registration_id": "55555555-5555-4555-8555-555555555555",
        "receipt_sha256": "d" * 64,
        "scenario": "serial-rans",
        "aoa_deg": 2,
        "member_association_count": 5,
        "member_associations_sha256": "e" * 64,
        "manifest_member_set_sha256": "f" * 64,
    }
    database = {
        "result_id": "11111111-1111-4111-8111-111111111111",
        "result_attempt_id": "22222222-2222-4222-8222-222222222222",
        "source_artifact_id": "33333333-3333-4333-8333-333333333333",
        "archive_id": "44444444-4444-4444-8444-444444444444",
        "member_association_count": 5,
        "member_associations_sha256": "a" * 64,
        "manifest_member_set_sha256": "b" * 64,
    }
    payload = {
        "case_slug": "case-1",
        "evidence_base": "evidence",
        "remote": remote,
        "canary_evidence_registrations": [canary],
    }

    request = api_main.FinalizeRemoteEvidenceRequest.model_validate(payload)
    for authorization in (None, "Bearer wrong-token"):
        with pytest.raises(HTTPException) as refused:
            endpoint(job_id, request, authorization)
        assert refused.value.status_code == 401
    for invalid in (
        {"case_slug": "case-1", "evidence_base": "evidence", "remote": remote},
        {**payload, "database_associations": [database]},
    ):
        with pytest.raises(ValueError, match="exactly one cleanup association kind"):
            api_main.FinalizeRemoteEvidenceRequest.model_validate(invalid)
    assert calls == []
    assert not (evidence / "storage_finalization.database.json").exists()

    accepted = endpoint(job_id, request, f"Bearer {token}")

    assert accepted["association_count"] == 1
    assert len(calls) == 1
    assert calls[0][0] == job_root
    assert calls[0][1] == evidence


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


def test_archive_source_mode_forces_volume_hydration_for_every_render_endpoint(
    client, remote_case, tmp_path, monkeypatch
):
    job_id, _case_dir, evidence_dir = remote_case
    (evidence_dir / EVIDENCE_POINTER_NAME).unlink()
    (evidence_dir / "VTK").mkdir()
    hydrated = tmp_path / "volume-hydrated"
    (hydrated / "VTK").mkdir(parents=True)
    lease = {"active": False, "enters": 0, "exits": 0}

    @contextmanager
    def exact_volume(actual_evidence_dir, _settings):
        assert actual_evidence_dir == evidence_dir
        assert lease["active"] is False
        lease["active"] = True
        lease["enters"] += 1
        try:
            yield hydrated
        finally:
            lease["active"] = False
            lease["exits"] += 1

    @contextmanager
    def forbidden_remote(*_args, **_kwargs):
        raise AssertionError("volume-backed evidence must not use GCS hydration")
        yield  # pragma: no cover

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

    monkeypatch.setattr(api_main, "hydrated_volume_render_source", exact_volume)
    monkeypatch.setattr(api_main, "hydrated_render_source", forbidden_remote)
    monkeypatch.setattr(api_main, "render_custom_field", fake_custom)
    monkeypatch.setattr(api_main, "compute_field_extents", fake_extents)
    monkeypatch.setattr(api_main, "render_contours", fake_contours)

    common = {
        "case_slug": "case-1",
        "airfoil_points": [[0.0, 0.0], [1.0, 0.0]],
        "chord": 1.0,
        "speed": 20.0,
        "source_mode": "archive",
    }
    rendered = client.post(
        f"/jobs/{job_id}/render-field",
        json={**common, "field": "pressure"},
    )
    assert rendered.status_code == 200, rendered.text

    extents = client.post(
        f"/jobs/{job_id}/field-extents",
        json={**common, "fields": ["pressure"]},
    )
    assert extents.status_code == 200, extents.text

    defaults = client.post(
        f"/jobs/{job_id}/render-default-media",
        json={
            **common,
            "fields": ["pressure"],
            "scales": {"pressure": {"vmin": -1.0, "vmax": 1.0}},
        },
    )
    assert defaults.status_code == 200, defaults.text
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
