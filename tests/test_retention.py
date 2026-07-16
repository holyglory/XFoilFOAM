from __future__ import annotations

import json
import shutil
import fcntl
import base64
import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam.api.main import app
from airfoilfoam.config import get_settings
from airfoilfoam.retention import JobRetentionRefused, delete_job_dir, strip_job_dir


def _write(path: Path, payload: bytes = b"x" * 17) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def _write_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _make_realistic_job(job_root: Path, *, unknown: bool = False) -> dict[str, Path]:
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = job_root.name
    _write_json(job_root / "request.json", {"job_id": job_id})
    _write_json(job_root / "result.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "status.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "runtime.json", {"job_id": job_id, "process_count": 0})

    _write(job_root / "meshes" / "c1" / "constant" / "polyMesh" / "points", b"mesh-points")

    case = job_root / "cases" / "c1_u25"
    _write(case / "0" / "U", b"U0")
    _write(case / "141" / "U", b"U141")
    _write(case / "3.5" / "p", b"p3.5")
    _write(case / "constant" / "polyMesh" / "points", b"case-mesh")
    _write(case / "system" / "controlDict", b"control")
    _write(case / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat", b"coeffs")
    _write(case / "VTK" / "case.vtu", b"case-vtk")
    _write(case / "dynamicCode" / "code.C", b"code")
    _write(case / "processor0" / "141" / "U", b"decomposed")
    _write(case / "log.simpleFoam", b"log")

    _write(case / "images" / "root.png", b"\x89PNG\r\n\x1a\nroot")
    _write(case / "frames" / "vorticity" / "f0000.png", b"\x89PNG\r\n\x1a\nroot-frame")

    segment = case / "a0"
    media_png = _write(segment / "images" / "velocity_magnitude.png", b"\x89PNG\r\n\x1a\nmedia")
    media_video = _write(segment / "images" / "velocity_magnitude.mp4", b"mp4")
    frame_png = _write(segment / "frames" / "vorticity" / "f0000.png", b"\x89PNG\r\n\x1a\nframe")

    evidence = segment / "evidence"
    manifest = _write_json(
        evidence / "evidence_manifest.json",
        {"windowStart": 1.0, "windowEnd": 2.0, "bundleExcludes": ["frames"]},
    )
    bundle = _write(evidence / "openfoam_evidence.tar.gz", b"bundle")
    scaled = _write(evidence / "scaled_media" / "default_v1" / "v1" / "pressure.png", b"\x89PNG scaled")
    custom = _write(evidence / "custom_renders" / "hash" / "pressure.png", b"\x89PNG custom")
    rerender_vtk = _write(evidence / "VTK" / "window.vtu", b"vtk-window")
    rerender_series = _write(evidence / "VTK" / "window.series", b"series")
    archived_frame = _write(evidence / "frames" / "vorticity" / "f0000.png", b"\x89PNG archived-frame")
    redundant_openfoam = _write(evidence / "openfoam" / "system" / "controlDict", b"redundant-control")
    redundant_time = _write(evidence / "time_directories" / "141" / "U", b"redundant-time")

    unknown_path = None
    if unknown:
        unknown_path = _write(case / "operator_notes.dat", b"must survive")

    return {
        "case": case,
        "media_png": media_png,
        "media_video": media_video,
        "frame_png": frame_png,
        "manifest": manifest,
        "bundle": bundle,
        "scaled": scaled,
        "custom": custom,
        "rerender_vtk": rerender_vtk,
        "rerender_series": rerender_series,
        "archived_frame": archived_frame,
        "redundant_openfoam": redundant_openfoam,
        "redundant_time": redundant_time,
        "unknown": unknown_path,
    }


def _clean_store_job(job_id: str) -> Path:
    root = get_settings().job_dir(job_id)
    if root.exists():
        shutil.rmtree(root)
    return root


def _write_remote_pointer(evidence: Path, archive: Path, *, stored_sha: str | None = None) -> Path:
    payload = archive.read_bytes()
    return _write_json(
        evidence / "engine_evidence.remote.json",
        {
            "schemaVersion": 1,
            "format": "tar+zstd",
            "bucket": "airfoils-pro-storage-bucket",
            "objectKey": "solver-evidence/v1/sha256/aa/archive.tar.zst",
            "generation": 1234567890123456789,
            "storedSha256": stored_sha or hashlib.sha256(payload).hexdigest(),
            "storedSize": len(payload),
            "tarSha256": "b" * 64,
            "tarSize": 123,
            "crc32c": base64.b64encode(b"\0\0\0\0").decode("ascii"),
            "zstdLevel": 10,
            "createdAt": "2026-07-15T00:00:00+00:00",
        },
    )


def test_strip_removes_bulk_and_keeps_consumed_files(tmp_path: Path):
    job_root = tmp_path / "job-strip"
    paths = _make_realistic_job(job_root)
    case = paths["case"]

    report = strip_job_dir(job_root)

    assert report.bytes_freed > 0
    assert report.files_removed > 0
    assert report.kept_case_state is False
    assert not (job_root / "meshes").exists()
    for rel in ("0", "141", "3.5", "constant", "system", "postProcessing", "VTK", "dynamicCode", "processor0"):
        assert not (case / rel).exists()
    assert not (case / "log.simpleFoam").exists()
    assert (case / "a0" / "evidence" / "openfoam").exists()
    assert (case / "a0" / "evidence" / "time_directories").exists()

    for rel in ("request.json", "result.json", "status.json", "runtime.json"):
        assert (job_root / rel).is_file()
    for key in (
        "media_png",
        "media_video",
        "frame_png",
        "manifest",
        "bundle",
        "scaled",
        "custom",
        "rerender_vtk",
        "rerender_series",
        "archived_frame",
    ):
        assert paths[key].is_file(), key


def test_keep_case_state_preserves_continuation_and_packaged_evidence(tmp_path: Path):
    job_root = tmp_path / "job-keep-state"
    paths = _make_realistic_job(job_root)
    case = paths["case"]

    # Prod cases symlink constant/polyMesh into the shared job-root meshes/
    # store (jobs.py mesh_reuse_mode="symlink"); a dangling link makes the
    # saved case not restartable, so this mode MUST keep meshes/ alive.
    poly = case / "constant" / "polyMesh"
    if poly.exists():
        import shutil

        shutil.rmtree(poly)
    poly.symlink_to(job_root / "meshes" / "c1" / "constant" / "polyMesh")

    report = strip_job_dir(job_root, keep_case_state=True)

    assert report.kept_case_state is True
    assert (job_root / "meshes").exists()
    for rel in ("0", "141", "3.5", "constant", "system", "postProcessing", "processor0"):
        assert (case / rel).exists()
    assert not (case / "VTK").exists()
    assert (case / "log.simpleFoam").is_file()
    # MUST-CATCH (continuation restartability): the shared-mesh symlink still
    # resolves to real mesh files after a case-state-preserving strip.
    assert (case / "constant" / "polyMesh" / "points").is_file()
    assert (case / "a0" / "evidence" / "openfoam").exists()
    assert (case / "a0" / "evidence" / "time_directories").exists()
    assert paths["rerender_vtk"].is_file()


def test_remote_pointer_alone_never_authorizes_raw_vtk_or_local_zstd_removal(
    tmp_path: Path,
):
    job_root = tmp_path / "job-remote-backed"
    paths = _make_realistic_job(job_root)
    evidence = paths["case"] / "a0" / "evidence"
    archive = _write(evidence / "engine_evidence.tar.zst", b"verified-zstd")
    pointer = _write_remote_pointer(evidence, archive)

    strip_job_dir(job_root)

    assert pointer.is_file()
    assert paths["manifest"].is_file()
    assert archive.is_file()
    assert (evidence / "VTK").is_dir()
    assert (evidence / "openfoam").exists()
    assert (evidence / "time_directories").exists()
    # The legacy encoding is retained for the dedicated migration to prove
    # tar equivalence before it removes that historical source.
    assert paths["bundle"].is_file()


def test_awaiting_database_registration_prevents_retention_cleanup(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "job-migration-pending"
    paths = _make_realistic_job(job_root)
    evidence = paths["case"] / "a0" / "evidence"
    archive = _write(evidence / "engine_evidence.tar.zst", b"verified-zstd")
    _write_remote_pointer(evidence, archive)
    receipt = _write_json(
        evidence / "storage_migration.json",
        {"schemaVersion": 1, "state": "awaiting_database_registration"},
    )

    report = strip_job_dir(job_root)

    for path in (
        archive,
        paths["bundle"],
        paths["rerender_vtk"],
        paths["redundant_openfoam"],
        paths["redundant_time"],
    ):
        assert path.exists(), path
    assert str(receipt.relative_to(job_root)) in report.unknown_entries


def test_mismatched_remote_pointer_never_authorizes_evidence_deletion(tmp_path: Path):
    job_root = tmp_path / "job-bad-pointer"
    paths = _make_realistic_job(job_root)
    evidence = paths["case"] / "a0" / "evidence"
    archive = _write(evidence / "engine_evidence.tar.zst", b"local-zstd")
    pointer = _write_remote_pointer(evidence, archive, stored_sha="f" * 64)

    report = strip_job_dir(job_root)

    assert archive.is_file()
    assert paths["rerender_vtk"].is_file()
    assert (evidence / "openfoam").exists()
    assert (evidence / "time_directories").exists()
    assert str(pointer.relative_to(job_root)) in report.unknown_entries


@pytest.mark.parametrize("bundle_bytes", [b"", b"truncated-not-a-tar"])
def test_invalid_local_bundle_never_authorizes_packaged_evidence_deletion(
    tmp_path: Path,
    bundle_bytes: bytes,
) -> None:
    job_root = tmp_path / "job-corrupt-bundle"
    paths = _make_realistic_job(job_root)
    paths["bundle"].write_bytes(bundle_bytes)

    strip_job_dir(job_root)

    assert paths["bundle"].is_file()
    assert paths["rerender_vtk"].is_file()
    assert paths["redundant_openfoam"].is_file()
    assert paths["redundant_time"].is_file()


def test_strip_idempotency_uses_marker(tmp_path: Path):
    job_root = tmp_path / "job-idempotent"
    _make_realistic_job(job_root)

    first = strip_job_dir(job_root)
    second = strip_job_dir(job_root)

    assert first.no_op is False
    assert (job_root / ".stripped.json").is_file()
    assert second.no_op is True
    assert second.bytes_freed == 0
    assert second.files_removed == 0


def test_unknown_case_entries_are_retained_and_reported(tmp_path: Path):
    job_root = tmp_path / "job-unknown"
    paths = _make_realistic_job(job_root, unknown=True)

    report = strip_job_dir(job_root)

    assert paths["unknown"].is_file()
    assert "cases/c1_u25/operator_notes.dat" in report.unknown_entries


def test_running_guard_refuses_strip_and_delete(tmp_path: Path):
    job_root = tmp_path / "job-running"
    _make_realistic_job(job_root)
    with (job_root / ".execute.lock").open("w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(JobRetentionRefused):
            strip_job_dir(job_root)
        with pytest.raises(JobRetentionRefused):
            delete_job_dir(job_root)


def test_released_fresh_lock_does_not_delay_terminal_retention(tmp_path: Path):
    job_root = tmp_path / "job-released-lock"
    _make_realistic_job(job_root)
    _write(job_root / ".execute.lock", b"released moments ago")

    report = strip_job_dir(job_root)

    assert report.bytes_freed > 0


def test_api_strip_preserves_served_media_and_reports_maintenance():
    client = TestClient(app)
    job_id = "retention-api-strip"
    job_root = _clean_store_job(job_id)
    _make_realistic_job(job_root)

    response = client.post(f"/jobs/{job_id}/strip", json={"keep_case_state": False})

    assert response.status_code == 200
    body = response.json()
    assert body["bytes_freed"] > 0
    assert body["unknown_entries_count"] == 0

    media = client.get(f"/jobs/{job_id}/files/cases/c1_u25/a0/images/velocity_magnitude.png")
    assert media.status_code == 200
    assert media.content.startswith(b"\x89PNG")

    jobs = client.get("/maintenance/jobs").json()
    # Cross-runtime contract pin: wrapped {"items": [...]}, never a bare list
    # (the node orphan sweep iterates response.items — incident 2026-07-10:
    # a bare list shipped and every prod orphan sweep failed "not iterable").
    assert isinstance(jobs, dict)
    assert any(row["job_id"] == job_id and row["mtime_epoch"] > 0 and row["bytes"] is None for row in jobs["items"])

    disk = client.get("/maintenance/disk").json()
    assert disk["total_bytes"] > 0
    assert disk["free_bytes"] >= 0
    assert 0 <= disk["used_pct"] <= 100


def test_api_running_guard_and_delete_status_codes():
    client = TestClient(app)
    running_id = "retention-api-running"
    running_root = _clean_store_job(running_id)
    _make_realistic_job(running_root)
    with (running_root / ".execute.lock").open("w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert client.post(f"/jobs/{running_id}/strip", json={}).status_code == 409
        assert client.delete(f"/jobs/{running_id}").status_code == 409

    delete_id = "retention-api-delete"
    delete_root = _clean_store_job(delete_id)
    _make_realistic_job(delete_root)

    deleted = client.delete(f"/jobs/{delete_id}")
    assert deleted.status_code == 200
    assert deleted.json()["bytes_freed"] > 0
    assert not delete_root.exists()
    assert client.delete("/jobs/retention-api-missing").status_code == 404
