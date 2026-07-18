from __future__ import annotations

import json
import shutil
import fcntl
import base64
import hashlib
import io
import tarfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import airfoilfoam.pipeline as pipeline
from airfoilfoam.api.main import app
from airfoilfoam.config import Settings, get_settings
from airfoilfoam.evidence_store import (
    extract_verified_evidence_archive,
    transcode_gzip_tar_to_zst,
)
from airfoilfoam.models import CaseSpec
from airfoilfoam.pipeline import CaseOutcome
from airfoilfoam.retention import JobRetentionRefused, delete_job_dir, strip_job_dir


def _write(path: Path, payload: bytes = b"x" * 17) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def _write_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _write_gzip_evidence_archive(
    path: Path,
    manifest: Path,
    members: dict[str, bytes],
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    archived = {
        "evidence_manifest.json": manifest.read_bytes(),
        **members,
    }
    with tarfile.open(path, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        for name, payload in archived.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mtime = 0
            archive.addfile(info, io.BytesIO(payload))
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
    # Production finalization snapshots this evidence into the canonical
    # engine archive under openfoam/mesh_evidence.  The live case copy is
    # therefore duplicate solver state after a full strip.
    mesh_evidence = _write(
        case / "mesh-evidence" / "system" / "blockMeshDict",
        b"archived-mesh-dictionary",
    )
    _write(case / "images" / "root.png", b"\x89PNG\r\n\x1a\nroot")
    _write(case / "frames" / "vorticity" / "f0000.png", b"\x89PNG\r\n\x1a\nroot-frame")

    segment = case / "a0"
    media_png = _write(segment / "images" / "velocity_magnitude.png", b"\x89PNG\r\n\x1a\nmedia")
    media_video = _write(segment / "images" / "velocity_magnitude.mp4", b"mp4")
    frame_png = _write(segment / "frames" / "vorticity" / "f0000.png", b"\x89PNG\r\n\x1a\nframe")

    evidence = segment / "evidence"
    scaled = _write(evidence / "scaled_media" / "default_v1" / "v1" / "pressure.png", b"\x89PNG scaled")
    custom = _write(evidence / "custom_renders" / "hash" / "pressure.png", b"\x89PNG custom")
    rerender_vtk = _write(evidence / "VTK" / "window.vtu", b"vtk-window")
    rerender_series = _write(evidence / "VTK" / "window.series", b"series")
    archived_frame = _write(evidence / "frames" / "vorticity" / "f0000.png", b"\x89PNG archived-frame")
    redundant_openfoam = _write(evidence / "openfoam" / "system" / "controlDict", b"redundant-control")
    redundant_time = _write(evidence / "time_directories" / "141" / "U", b"redundant-time")
    incomplete_quarantine_controls = [
        _write(evidence / name, f"retained-{name}".encode("utf-8"))
        for name in (
            "incomplete_evidence_quarantine.tar.zst",
            "incomplete_evidence_quarantine.remote.json",
            "incomplete_evidence_quarantine.manifest.json",
            "incomplete_evidence_quarantine.receipt.json",
            "incomplete_evidence_quarantine.database.json",
        )
    ]
    archive_members = {
        "VTK/window.vtu": rerender_vtk.read_bytes(),
        "VTK/window.series": rerender_series.read_bytes(),
        "openfoam/system/controlDict": redundant_openfoam.read_bytes(),
        "time_directories/141/U": redundant_time.read_bytes(),
    }
    manifest = _write_json(
        evidence / "evidence_manifest.json",
        {
            "windowStart": 1.0,
            "windowEnd": 2.0,
            "bundleExcludes": ["frames"],
            "files": [
                {
                    "path": name,
                    "byteSize": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
                for name, payload in archive_members.items()
            ],
        },
    )
    bundle = _write_gzip_evidence_archive(
        evidence / "openfoam_evidence.tar.gz",
        manifest,
        archive_members,
    )

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
        "incomplete_quarantine_controls": incomplete_quarantine_controls,
        "mesh_evidence": mesh_evidence,
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
    # MUST-CATCH (2026-07-17 production canary): a full strip must not leave
    # the archived live mesh-evidence copy as an unknown case entry.
    assert not (case / "mesh-evidence").exists()
    assert report.unknown_entries == []
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
    for control in paths["incomplete_quarantine_controls"]:
        assert control.is_file(), control


def test_finished_urans_archives_immutable_transient_markers_before_full_strip(
    tmp_path: Path,
    monkeypatch,
):
    """MUST-CATCH: guarded OpenCFD 2606 canaries completed physical URANS,
    then retention found immutable transient-root JSON records missing from
    their canonical archives.  Both the trajectory boundary and certified
    early-stop averaging window must be in the real archive before cleanup;
    the mutable watchdog budget must not be mistaken for immutable evidence.
    """

    job_root = tmp_path / "job-forced-urans-retention"
    job_id = job_root.name
    _write_json(job_root / "request.json", {"job_id": job_id})
    _write_json(job_root / "result.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "status.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "runtime.json", {"job_id": job_id, "process_count": 0})

    case = job_root / "cases" / "c0p05_u166_a0"
    transient = case / "transient"
    _write(case / "system" / "controlDict", b"application simpleFoam;\n")
    _write(case / "constant" / "polyMesh" / "points", b"steady mesh\n")
    _write(transient / "system" / "controlDict", b"application pimpleFoam;\n")
    _write(transient / "constant" / "polyMesh" / "points", b"transient mesh\n")
    _write(transient / "0.4" / "U", b"final velocity field\n")
    _write(transient / "0.4" / "p", b"final pressure field\n")

    # Exact bytes and SHA observed in the preserved failed production job.
    transient_start_bytes = b'{\n  "transient_start": 0.0\n}\n'
    transient_start = _write(
        transient / pipeline.TRANSIENT_START_MARKER,
        transient_start_bytes,
    )
    assert hashlib.sha256(transient_start_bytes).hexdigest() == (
        "b50f4dc750325e2969c0c8192e88592d7144f0680651ee69787dce9815b71bcf"
    )
    # Exact bytes and SHA observed in the third failed production canary
    # (job b57cb2d8cee741eaa146b528d6fbdc6f).  This record owns the retained
    # window used to compute the published result; it is not process arming.
    early_stop_bytes = (
        b'{\n'
        b'  "cycles": 2,\n'
        b'  "frame_count": 58,\n'
        b'  "frames_per_cycle": 29.0,\n'
        b'  "mean_drift": 0.014638154531983683,\n'
        b'  "period_s": 0.004088886963848821,\n'
        b'  "reason": "two stable periods with sufficient frames",\n'
        b'  "retain_from": 0.0013769880265579494,\n'
        b'  "similarity": 0.02387152845931142,\n'
        b'  "window_end": 0.0179609,\n'
        b'  "window_start": 0.009783126072302356\n'
        b'}\n'
    )
    early_stop = _write(
        transient / pipeline.URANS_EARLY_STOP_MARKER,
        early_stop_bytes,
    )
    assert hashlib.sha256(early_stop_bytes).hexdigest() == (
        "fb4225b911b1713d05163ced26291eaa0610a1e80b7c2ffdbb37641ecc293fb3"
    )
    march_budget = _write_json(
        transient / pipeline.MARCH_BUDGET_MARKER_FILENAME,
        {"end_t": 0.4, "budget_s": 14400.0, "wall_start": 123.0},
    )

    monkeypatch.setattr(
        pipeline,
        "get_settings",
        lambda: Settings(
            data_dir=tmp_path,
            evidence_bucket=None,
            evidence_remote_only=False,
        ),
    )
    outcome = CaseOutcome(
        spec=CaseSpec(chord=0.05, speed=166.0, aoa_deg=0.0),
        reynolds=568_493,
        unsteady=True,
    )
    pipeline._archive_case_evidence(case, transient, outcome)

    evidence = case / "evidence"
    manifest_path = evidence / "evidence_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    archived_start_path = "openfoam/transient/transient_start.json"
    start_entry = next(
        entry
        for entry in manifest["files"]
        if entry["path"] == archived_start_path
    )
    assert start_entry["role"] == "continuation_state"
    assert start_entry["sha256"] == hashlib.sha256(
        transient_start_bytes
    ).hexdigest()
    assert start_entry["byteSize"] == len(transient_start_bytes)
    archived_early_stop_path = "openfoam/transient/urans_early_stop.json"
    early_stop_entry = next(
        entry
        for entry in manifest["files"]
        if entry["path"] == archived_early_stop_path
    )
    assert early_stop_entry["role"] == "quality_evidence"
    assert early_stop_entry["sha256"] == hashlib.sha256(
        early_stop_bytes
    ).hexdigest()
    assert early_stop_entry["byteSize"] == len(early_stop_bytes)
    assert all(
        entry["path"] != "openfoam/transient/march_budget.json"
        for entry in manifest["files"]
    )
    start_artifact = next(
        artifact
        for artifact in outcome.evidence_artifacts
        if artifact.path == f"evidence/{archived_start_path}"
    )
    assert start_artifact.kind == "dictionary"
    assert start_artifact.role == "continuation_state"
    assert start_artifact.sha256 == start_entry["sha256"]
    early_stop_artifact = next(
        artifact
        for artifact in outcome.evidence_artifacts
        if artifact.path == f"evidence/{archived_early_stop_path}"
    )
    assert early_stop_artifact.kind == "field_data"
    assert early_stop_artifact.role == "quality_evidence"
    assert early_stop_artifact.sha256 == early_stop_entry["sha256"]

    # Inspect the actual canonical tar.zst, not merely the unpacked staging
    # copy or manifest claim.  The verified extractor authenticates all bundled
    # members against the manifest before making the selected evidence visible.
    restored = tmp_path / "restored-forced-urans-evidence"
    extract_verified_evidence_archive(
        evidence / "engine_evidence.tar.zst",
        restored,
        compression="zstd",
        include_prefixes=(archived_start_path, archived_early_stop_path),
        expected_manifest=manifest_path.read_bytes(),
    )
    archived_transient_start = evidence / archived_start_path
    archived_early_stop = evidence / archived_early_stop_path
    assert archived_transient_start.read_bytes() == transient_start_bytes
    assert archived_early_stop.read_bytes() == early_stop_bytes
    assert (restored / archived_start_path).read_bytes() == transient_start_bytes
    assert (restored / archived_early_stop_path).read_bytes() == early_stop_bytes
    archive = evidence / "engine_evidence.tar.zst"
    pointer = _write_remote_pointer(evidence, archive)
    # Production remote-only finalization removes this unpacked duplicate only
    # after a pinned all-member restore, while retaining the canonical archive,
    # manifest and pointer until database acknowledgement.
    shutil.rmtree(evidence / "openfoam")
    assert not archived_transient_start.exists()

    report = strip_job_dir(job_root)

    assert not transient_start.exists()
    assert not early_stop.exists()
    assert not march_budget.exists()
    assert archive.is_file()
    assert manifest_path.is_file()
    assert pointer.is_file()
    assert (restored / archived_start_path).read_bytes() == transient_start_bytes
    assert (restored / archived_early_stop_path).read_bytes() == early_stop_bytes
    assert report.unknown_entries == []


def test_keep_case_state_preserves_continuation_and_packaged_evidence(tmp_path: Path):
    job_root = tmp_path / "job-keep-state"
    paths = _make_realistic_job(job_root)
    case = paths["case"]
    transient_start = _write(
        case / "transient" / pipeline.TRANSIENT_START_MARKER,
        b'{\n  "transient_start": 0.0\n}\n',
    )
    early_stop = _write_json(
        case / "transient" / pipeline.URANS_EARLY_STOP_MARKER,
        {"retain_from": 0.1, "period_s": 0.02, "cycles": 2},
    )
    march_budget = _write_json(
        case / "transient" / pipeline.MARCH_BUDGET_MARKER_FILENAME,
        {"end_t": 0.4, "budget_s": 14400.0, "wall_start": 123.0},
    )

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
    assert paths["mesh_evidence"].is_file()
    assert transient_start.is_file()
    assert early_stop.is_file()
    assert march_budget.is_file()
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
def test_invalid_local_bundle_refuses_full_strip_before_mutation(
    tmp_path: Path,
    bundle_bytes: bytes,
) -> None:
    job_root = tmp_path / "job-corrupt-bundle"
    paths = _make_realistic_job(job_root)
    paths["bundle"].write_bytes(bundle_bytes)

    with pytest.raises(JobRetentionRefused, match="no local evidence archive"):
        strip_job_dir(job_root)

    assert (job_root / "meshes" / "c1" / "constant" / "polyMesh" / "points").is_file()
    assert (paths["case"] / "141" / "U").is_file()
    assert paths["bundle"].is_file()
    assert paths["rerender_vtk"].is_file()
    assert paths["redundant_openfoam"].is_file()
    assert paths["redundant_time"].is_file()
    assert not (job_root / ".stripped.json").exists()


def test_truncated_production_style_gzip_preserves_all_live_and_raw_evidence(
    tmp_path: Path,
) -> None:
    """MUST-CATCH: job 7dcc.../a19 had a present but truncated gzip.

    Retention must authenticate the bundle before its first removal.  Keeping
    only the corrupt archive after deleting the shared mesh and live case would
    make the completed result neither reproducible nor continuable.
    """

    job_root = tmp_path / "7dcc-retention-regression"
    paths = _make_realistic_job(job_root)
    case = paths["case"]
    (case / "a0").rename(case / "a19")
    evidence = case / "a19" / "evidence"
    gzip_archive = evidence / "openfoam_evidence.tar.gz"
    complete_bundle = gzip_archive.read_bytes()
    truncated_bundle = complete_bundle[:-8]
    gzip_archive.write_bytes(truncated_bundle)

    with pytest.raises(JobRetentionRefused, match="no local evidence archive"):
        strip_job_dir(job_root)

    # Shared mesh and the complete live solver state survive the failed proof.
    assert (job_root / "meshes" / "c1" / "constant" / "polyMesh" / "points").is_file()
    for relative in (
        "0/U",
        "141/U",
        "3.5/p",
        "constant/polyMesh/points",
        "system/controlDict",
        "postProcessing/forceCoeffs1/0/coefficient.dat",
        "VTK/case.vtu",
        "processor0/141/U",
        "log.simpleFoam",
    ):
        assert (case / relative).is_file(), relative

    # The corrupt source and every unpacked raw/rerender source also survive.
    assert gzip_archive.read_bytes() == truncated_bundle
    for relative in (
        "VTK/window.vtu",
        "VTK/window.series",
        "openfoam/system/controlDict",
        "time_directories/141/U",
    ):
        assert (evidence / relative).is_file(), relative
    assert not (job_root / ".stripped.json").exists()


def test_one_valid_alternate_archive_allows_full_strip(tmp_path: Path) -> None:
    job_root = tmp_path / "job-valid-alternate-archive"
    paths = _make_realistic_job(job_root)
    evidence = paths["case"] / "a0" / "evidence"
    transcode_gzip_tar_to_zst(
        paths["bundle"],
        evidence / "engine_evidence.tar.zst",
    )
    paths["bundle"].write_bytes(paths["bundle"].read_bytes()[:-8])

    report = strip_job_dir(job_root)

    assert report.unknown_entries == []
    assert not (job_root / "meshes").exists()
    assert (job_root / ".stripped.json").is_file()


def test_every_evidence_directory_passes_before_full_strip_mutates_job(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "job-one-corrupt-segment"
    paths = _make_realistic_job(job_root)
    case = paths["case"]
    shutil.copytree(case / "a0", case / "a1")
    corrupt = case / "a1" / "evidence" / "openfoam_evidence.tar.gz"
    corrupt.write_bytes(corrupt.read_bytes()[:-8])

    with pytest.raises(JobRetentionRefused, match="cases/c1_u25/a1/evidence"):
        strip_job_dir(job_root)

    assert (job_root / "meshes" / "c1" / "constant" / "polyMesh" / "points").is_file()
    assert (case / "141" / "U").is_file()
    assert paths["bundle"].is_file()
    assert corrupt.is_file()
    assert not (job_root / ".stripped.json").exists()


def test_case_state_strip_does_not_require_complete_local_archive(
    tmp_path: Path,
) -> None:
    job_root = tmp_path / "job-keep-state-corrupt-bundle"
    paths = _make_realistic_job(job_root)
    paths["bundle"].write_bytes(paths["bundle"].read_bytes()[:-8])

    report = strip_job_dir(job_root, keep_case_state=True)

    assert report.kept_case_state is True
    assert (job_root / "meshes").is_dir()
    assert (paths["case"] / "141" / "U").is_file()
    assert paths["bundle"].is_file()


def test_strip_idempotency_uses_marker(tmp_path: Path):
    job_root = tmp_path / "job-idempotent"
    _make_realistic_job(job_root)

    first = strip_job_dir(job_root)
    second = strip_job_dir(job_root)

    assert first.no_op is False
    assert (job_root / ".stripped.json").is_file()
    marker = json.loads((job_root / ".stripped.json").read_text())
    assert marker["schemaVersion"] == 2
    assert marker["complete"] is True
    assert second.no_op is True
    assert second.bytes_freed == 0
    assert second.files_removed == 0


def test_unknown_case_entries_are_retained_and_reported(tmp_path: Path):
    job_root = tmp_path / "job-unknown"
    paths = _make_realistic_job(job_root, unknown=True)

    report = strip_job_dir(job_root)

    assert paths["unknown"].is_file()
    assert "cases/c1_u25/operator_notes.dat" in report.unknown_entries
    # An incomplete pass must remain retryable.  A strength-only success marker
    # hid this unknown forever in production, even after a later engine learned
    # how to archive/remove it.
    assert not (job_root / ".stripped.json").exists()

    paths["unknown"].unlink()
    retried = strip_job_dir(job_root)
    assert retried.no_op is False
    assert retried.unknown_entries == []
    assert (job_root / ".stripped.json").is_file()


def test_legacy_strength_marker_is_not_complete_retention_proof(tmp_path: Path):
    """MUST-CATCH: schema-1 wrote a marker despite retained unknown entries.

    A legacy full-strength marker must get one real fail-safe re-evaluation,
    not suppress cleanup solely because its requested mode was already full.
    """

    job_root = tmp_path / "job-legacy-strip-marker"
    paths = _make_realistic_job(job_root)
    _write_json(
        job_root / ".stripped.json",
        {
            "timestamp": "2026-07-17T00:00:00+00:00",
            "mode": "full",
            "keep_case_state": False,
            "bytes_freed": 1,
            "files_removed": 1,
            "dirs_removed": 1,
        },
    )

    report = strip_job_dir(job_root)

    assert report.no_op is False
    assert report.unknown_entries == []
    assert not paths["case"].joinpath("constant").exists()
    marker = json.loads((job_root / ".stripped.json").read_text())
    assert marker["schemaVersion"] == 2
    assert marker["complete"] is True


def test_unrecognized_transient_json_is_not_deleted_by_marker_allowlist(tmp_path: Path):
    job_root = tmp_path / "job-unknown-transient-json"
    paths = _make_realistic_job(job_root)
    unknown = _write_json(
        paths["case"] / "transient" / "operator_diagnostic.json",
        {"must_survive": True},
    )

    report = strip_job_dir(job_root)

    assert unknown.is_file()
    assert (
        "cases/c1_u25/transient/operator_diagnostic.json"
        in report.unknown_entries
    )


def test_full_strip_retains_immutable_markers_without_exact_archive_members(
    tmp_path: Path,
    monkeypatch,
):
    """False-positive guard for the preserved failed production generation.

    Old engines left real trajectory/quality records but their manifest/archive
    did not contain those members.  A filename match alone must never authorize
    deletion; the unrelated mutable watchdog marker remains safe to remove.
    """

    job_root = tmp_path / "job-old-source-unarchived-start"
    job_id = job_root.name
    _write_json(job_root / "request.json", {"job_id": job_id})
    _write_json(job_root / "result.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "status.json", {"job_id": job_id, "state": "completed"})
    _write_json(job_root / "runtime.json", {"job_id": job_id, "process_count": 0})
    case = job_root / "cases" / "c0p05_u166_a0"
    transient = case / "transient"
    _write(case / "system" / "controlDict", b"application simpleFoam;\n")
    _write(case / "constant" / "polyMesh" / "points", b"steady mesh\n")
    _write(transient / "system" / "controlDict", b"application pimpleFoam;\n")
    _write(transient / "constant" / "polyMesh" / "points", b"transient mesh\n")
    _write(transient / "0.4" / "U", b"final velocity field\n")
    _write(transient / "0.4" / "p", b"final pressure field\n")
    monkeypatch.setattr(
        pipeline,
        "get_settings",
        lambda: Settings(
            data_dir=tmp_path,
            evidence_bucket=None,
            evidence_remote_only=False,
        ),
    )
    pipeline._archive_case_evidence(
        case,
        transient,
        CaseOutcome(
            spec=CaseSpec(chord=0.05, speed=166.0, aoa_deg=0.0),
            reynolds=568_493,
            unsteady=True,
        ),
    )
    manifest = json.loads(
        (case / "evidence" / "evidence_manifest.json").read_text(
            encoding="utf-8"
        )
    )
    assert all(
        entry["path"]
        not in {
            "openfoam/transient/transient_start.json",
            "openfoam/transient/urans_early_stop.json",
        }
        for entry in manifest["files"]
    )
    assert (case / "evidence" / "engine_evidence.tar.zst").is_file()

    # Recreate the exact preserved old-engine condition: the live files exist,
    # but the already-finalized immutable generation has no marker member.
    transient_start = _write(
        transient / pipeline.TRANSIENT_START_MARKER,
        b'{\n  "transient_start": 0.0\n}\n',
    )
    early_stop = _write(
        transient / pipeline.URANS_EARLY_STOP_MARKER,
        b'{\n  "retain_from": 0.0,\n  "period_s": 0.01\n}\n',
    )
    march_budget = _write_json(
        transient / pipeline.MARCH_BUDGET_MARKER_FILENAME,
        {"end_t": 0.4, "budget_s": 14400.0, "wall_start": 123.0},
    )

    report = strip_job_dir(job_root)

    assert transient_start.is_file()
    assert early_stop.is_file()
    assert not march_budget.exists()
    assert report.unknown_entries == [
        "cases/c0p05_u166_a0/transient/transient_start.json",
        "cases/c0p05_u166_a0/transient/urans_early_stop.json",
    ]
    assert not (job_root / ".stripped.json").exists()


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
