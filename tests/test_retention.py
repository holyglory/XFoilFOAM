from __future__ import annotations

import json
import shutil
import fcntl
import base64
import hashlib
import io
import os
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
from airfoilfoam.models import CaseSpec, ForceHistory
from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.openfoam.runner import RunResult
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


@pytest.mark.parametrize("keep_case_state", [False, True])
def test_strip_retains_known_initialization_evidence_without_permanent_unknowns(tmp_path, keep_case_state):
    job_root = tmp_path / "initialization-evidence"
    paths = _make_realistic_job(job_root)
    retained = []
    for directory in (paths["case"], paths["case"] / "transient_a0"):
        for name in ("pressure-initialization.json", "acoustic-startup.json", "material-domain-diagnostic.json"):
            retained.append(_write(directory / name, b'{"fixture":"retained diagnostic"}'))
        retained.append(_write(directory / "pressure_initialization" / "U.potential", b"initialization velocity"))
        retained.append(_write(directory / "steady_initialization" / "postProcessing" / "coefficient.dat", b"iteration-based history"))
    before = {path: path.read_bytes() for path in retained}
    report = strip_job_dir(job_root, keep_case_state=keep_case_state)
    assert report.unknown_entries == []
    assert {path: path.read_bytes() for path in retained} == before
    assert strip_job_dir(job_root, keep_case_state=keep_case_state).no_op


@pytest.mark.parametrize("keep_case_state", [False, True])
def test_strip_preserves_material_failure_logs_without_an_archive(tmp_path, keep_case_state):
    job_root = tmp_path / "failed-material-job"
    _write_json(job_root / "status.json", {"state": "failed"})
    _write_json(job_root / "result.json", {"state": "failed", "polars": []})
    case = job_root / "cases" / "c1_u1021"
    retained = {}
    ordinary_logs = []
    for directory in (case, case / "transient_a13", case / "transient_a13" / "transient_retry"):
        for temperature in (92.4, 89.1):
            stdout = (
                "Time = 14\n"
                "attempt to use janafThermo<EquationOfState> out of temperature range "
                f"100 -> 2000; T = {temperature}\n"
            )
            failure = material_domain_failure(directory, RunResult("rhoCentralFoam", -15, stdout))
            assert failure is not None
            diagnostic = json.loads((directory / "material-domain-diagnostic.json").read_text())
            log_path = directory / diagnostic["solver_log"]
            assert hashlib.sha256(log_path.read_bytes()).hexdigest() == diagnostic["solver_log_sha256"]
            retained[log_path] = stdout.encode()
        diagnostic_path = directory / "material-domain-diagnostic.json"
        retained[diagnostic_path] = diagnostic_path.read_bytes()
        ordinary_logs.append(_write(directory / "log.rhoCentralFoam", b"ordinary solver output"))
        ordinary_logs.append(_write(directory / "log.material-domain-unrelated", b"unrelated log"))
    assert not list(job_root.rglob("evidence_manifest.json"))
    report = strip_job_dir(job_root, keep_case_state=keep_case_state)
    assert report.unknown_entries == []
    assert {path: path.read_bytes() for path in retained} == retained
    assert all(path.exists() == keep_case_state for path in ordinary_logs)
    final_report = strip_job_dir(job_root, keep_case_state=False)
    assert final_report.unknown_entries == []
    assert {path: path.read_bytes() for path in retained} == retained
    assert not any(path.exists() for path in ordinary_logs)
    assert strip_job_dir(job_root).no_op


def test_material_log_preservation_does_not_classify_a_directory_as_a_diagnostic(tmp_path):
    job_root = tmp_path / "material-log-lookalike"
    _write_json(job_root / "status.json", {"state": "failed"})
    case = job_root / "cases" / "c1_u1021"
    lookalike = case / ("log.material-domain-" + "a" * 64)
    payload = _write(lookalike / "unrecognized", b"keep unknown evidence")
    report = strip_job_dir(job_root)
    assert report.unknown_entries == [lookalike.relative_to(job_root).as_posix()]
    assert payload.read_bytes() == b"keep unknown evidence"
    assert not (job_root / ".stripped.json").exists()


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


def test_windowless_evidence_keeps_only_the_latest_real_field_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = tmp_path / "case"
    transient = case / "transient"
    _write(case / "system" / "controlDict", b"application simpleFoam;\n")
    _write(transient / "system" / "controlDict", b"application pimpleFoam;\n")
    for time_name in ("0.1", "0.2", "0.3"):
        _write(transient / time_name / "U", time_name.encode("ascii"))
        _write(transient / time_name / "p", time_name.encode("ascii"))
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
        spec=CaseSpec(chord=0.05, speed=90.0, aoa_deg=14.0),
        reynolds=300_000,
        unsteady=True,
        converged=False,
    )
    pipeline._archive_case_evidence(case, transient, outcome)

    manifest = json.loads(
        (case / "evidence" / "evidence_manifest.json").read_text()
    )
    time_members = sorted(
        entry["path"]
        for entry in manifest["files"]
        if entry["role"] == "time_directory"
    )
    assert time_members == [
        "time_directories/0.3/U",
        "time_directories/0.3/p",
    ]


def test_exact_evidence_window_is_independent_of_media_rendering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = tmp_path / "case"
    transient = case / "transient"
    _write(case / "system" / "controlDict", b"application simpleFoam;\n")
    _write(transient / "system" / "controlDict", b"application pimpleFoam;\n")
    for time_name in ("0.1", "0.2", "0.3", "0.4"):
        _write(transient / time_name / "U", time_name.encode("ascii"))
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
        spec=CaseSpec(chord=0.05, speed=90.0, aoa_deg=14.0),
        reynolds=300_000,
        # Certified no-shedding URANS is displayed as steady-equivalent, but
        # its field evidence still belongs to the real retained URANS window.
        unsteady=False,
        converged=True,
        force_history=ForceHistory(
            t=[0.1, 0.2, 0.3, 0.4],
            cl=[0.1, 0.1, 0.1, 0.1],
            cd=[0.01, 0.01, 0.01, 0.01],
            cm=[0.0, 0.0, 0.0, 0.0],
            window_start=0.2,
            window_end=0.3,
        ),
    )
    start, end = pipeline._retained_field_evidence_window(outcome, None)
    pipeline._archive_case_evidence(
        case,
        transient,
        outcome,
        start_time=start,
        end_time=end,
        requested_fields=[],
    )

    manifest = json.loads(
        (case / "evidence" / "evidence_manifest.json").read_text()
    )
    assert sorted(
        entry["path"]
        for entry in manifest["files"]
        if entry["role"] == "time_directory"
    ) == ["time_directories/0.2/U", "time_directories/0.3/U"]


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


def test_api_running_guard_and_delete_status_codes(tmp_path):
    from airfoilfoam.automatic_retention import direct_request, disposable
    local = tmp_path / "legacy-mirror"
    _write_json(local / "request.json", {"execution_id":None})
    _write_json(local / "status.json", {"job_id":local.name,"state":"cancelled","completed_cases":0})
    _write(local / ".execute.lock", b"")
    record = _write(local / "cases/c0/a0/evidence/historical_raw_custody.database.json", b"registered physical custody")
    original = _write(record.parent / "engine_evidence.tar.zst", b"original stored bytes")
    with pytest.raises(JobRetentionRefused):
        disposable(local, None)
    with pytest.raises(JobRetentionRefused):
        strip_job_dir(local, keep_case_state=False, source_guard=direct_request)
    assert original.read_bytes() == b"original stored bytes" and record.is_file()
    redirected = tmp_path / "direct-case-with-alias"
    _write_json(redirected / "request.json", {"execution_id":None})
    _write_json(redirected / "status.json", {"job_id":redirected.name,"state":"failed","completed_cases":0})
    (redirected/"cases").mkdir()
    (redirected/"cases/other").symlink_to(local/"cases/c0",target_is_directory=True)
    with pytest.raises(JobRetentionRefused, match="unknown linked case"):
        strip_job_dir(redirected, keep_case_state=False, source_guard=direct_request)
    assert original.read_bytes() == b"original stored bytes"

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


@pytest.mark.parametrize("mode", ["no-media", "rans-images", "urans-images", "urans-empty", "urans-preserve-next", "urans-preserve-linked", "urans-foreign-method", "urans-foreign-solver"])
def test_closed_progressive_exact_duplicates_require_whole_job_proof(tmp_path, monkeypatch, mode):
    keep_media = mode != "no-media"
    urans = mode.startswith("urans-")
    from datetime import datetime, timezone
    import runpy
    peer = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-engine.py"))
    native = (Path(__file__).resolve().parents[1] / "src/airfoilfoam/closed_progressive_retention.py").read_text()

    job = "ddfebc12-aeb9-4d2c-8ef7-794cb27ca0bc"
    settings = get_settings().model_copy(update={"data_dir": tmp_path, "control_plane_token": "fixture-control"})
    root = tmp_path / "jobs" / job
    case = root / "cases" / "foil"
    post = case / "transient_a0"
    archived = b"actual saved field"
    sha = lambda b: hashlib.sha256(b).hexdigest()
    copies = [_write(post / t / "U", archived) for t in ("1", "2")]
    _write(post / "2" / "p", b"last pressure")
    mismatch = _write(post / "1" / "p", b"changed same size")
    force = _write(post / "postProcessing" / "forceCoeffs" / "0" / "coefficient.dat", archived)
    other = _write(post / "postProcessing" / "unknown.dat", b"unique archive-independent record")
    members = [{"path": f"time_directories/{t}/U", "byteSize": len(archived), "sha256": sha(archived)} for t in ("1", "2")]
    members.append({"path": "time_directories/1/p", "byteSize": len(mismatch.read_bytes()), "sha256": sha(b"other")})
    members.append({"path": "openfoam/postProcessing/forceCoeffs/0/coefficient.dat", "byteSize": len(archived), "sha256": sha(archived)})
    members.append({"path": "openfoam/mesh_evidence/log.blockMesh", "byteSize": 3, "sha256": sha(b"log")})
    duplicates = [copies[0], force]
    protected = {}
    if urans:
        for rel, item, deletable in (
            ("log.pimpleFoam", "openfoam/logs/transient_a0/log.pimpleFoam", True),
            ("1/uniform/time", "time_directories/1/uniform/time", False),
            ("1/core.123", "time_directories/1/core.123", False),
            ("1/excluded", "time_directories/1/excluded", False),
            ("processor0/1/U", None, False),
            ("VTK/transient_a0_302766/internal.vtu", None, False),
        ):
            source = _write(post / rel, rel.encode())
            if item:
                members.append({"path": item, "byteSize": len(rel), "sha256": sha(rel.encode())})
            if deletable:
                duplicates.append(source)
            else:
                protected[source] = source.read_bytes()
        link = post / "processor0/1/uniform"
        link.symlink_to("../../1/uniform", target_is_directory=True)
        base_time = _write(case / "3180/uniform/time", b"original case time")
        protected[base_time] = base_time.read_bytes()
        base_link = case / "processor2/3180/uniform"
        base_link.parent.mkdir(parents=True)
        base_link.symlink_to("../../3180/uniform", target_is_directory=True)
    cache_bytes = b"local-only cache data"
    members.append({"path":"openfoam/postProcessing/historical_cache/member.bin","byteSize":len(cache_bytes),
                    "sha256":sha(cache_bytes)})
    proofs, points = [], []
    retained = {}
    for index in (0, 1):
        base = f"a{index}/evidence"
        directory = f"cases/foil/{base}"
        folder = root / directory
        original = case / f"a{index}/images/pressure.png"
        scaled = folder / "scaled_media/default_v1_zoom2/v8/pressure.png"
        has_images = keep_media and mode != "urans-empty" and (not urans or index == 0)
        pictures = [(original, b"engine image"), (scaled, b"scaled image")]
        if urans:
            pictures.append((folder / "scaled_media/default_v1_zoom2/v7/pressure.png", b"previous scale"))
        for picture, data in pictures if has_images else ():
            _write(picture, data + str(index).encode())
            retained[picture] = picture.read_bytes()
        native_images = {"pressure": f"a{index}/images/pressure.png"} if has_images else {}
        solver = case / f"transient_a{index}" if urans else post
        if mode == "urans-foreign-solver" and index == 0:
            solver = case / "transient_a1"
        solver.mkdir(exist_ok=True)
        mf = _write_json(folder / "evidence_manifest.json", {"casePath": str(case), "postPath": str(solver),
                          "methodKey": "openfoam.urans" if urans and mode != "urans-foreign-method" else "openfoam.rans",
                          "unsteady": urans and index == 1, "bundleExcludes": ["frames", "time_directories/1/excluded"],
                          "files": members if not index else [], "media": {"instantaneous": native_images}})
        mf_sha = sha(mf.read_bytes())
        upload = f"upload-{index}"
        proof = {"directory": directory, "manifestSha256": mf_sha, "manifestByteSize": mf.stat().st_size,
                 "brokeredUploadId": upload, "generation": "18446744073709551614", "receiptHmac": "f" * 64}
        auth = {"jobId": job, "caseSlug": "foil", "evidenceBase": base, "receiptHmac": proof["receiptHmac"],
                "receipt": {"brokeredUploadId": upload, "remote": {"generation": proof["generation"], "manifestSha256": mf_sha, "storedSha256": sha(b"gzip"), "storedByteSize": 4}}}
        _write_json(folder / "brokered_hub_binding.database.json", {"authorization": auth, "schemaVersion": 1, "state": "hub_progressive_custody"})
        intent = {"authorization": auth, "schemaVersion": 1, "kind": "brokered-local-evidence-reclaim-intent",
                  "paths": [], "plannedPathCount": 0, "plannedBytes": 0}
        _write_json(folder / "brokered_local_reclaim.intent.json", intent)
        _write_json(folder / "brokered_local_reclaim.json", {"authorization": auth, "state": "complete", "schemaVersion": 1, "bytesDeleted": 0, "deletedPaths": [],
                    "intentSha256": sha(json.dumps(intent, sort_keys=True, separators=(",", ":")).encode())})
        artifacts = [{"path": f"{base}/evidence_manifest.json", "kind": "manifest", "sha256": mf_sha, "byte_size": mf.stat().st_size},
                     {"path": f"{base}/engine_evidence.tar.zst", "kind": "engine_bundle", "sha256": sha(b"gzip"), "byte_size": 4}]
        if not index:
            artifacts.append({"path": f"{base}/{members[0]['path']}", "kind": "time_directory", "sha256": sha(archived), "byte_size": len(archived)})
            artifacts.append({"path": f"{base}/openfoam/mesh_evidence/log.blockMesh", "kind": "mesh_evidence", "sha256": sha(b"log"), "byte_size": 3})
        catalog = sorted(f"{'mesh' if a['kind'] == 'mesh_evidence' else a['kind']}\tjobs/{job}/cases/foil/{a['path']}\t{a['byte_size']}\t{a['sha256']}" for a in artifacts)
        proof["catalogSha256"] = sha("\n".join(catalog).encode())
        points.append({"case_slug": "foil", "evidence_artifacts": artifacts})
        if keep_media:
            if urans:
                proof["regime"] = "urans"
            registered = original if urans else scaled
            proof["keepMedia"] = [{"path": registered.relative_to(root).as_posix(), "sha256": sha(retained[registered]),
                                   "byteSize": len(retained[registered]), "field": "pressure"}] if has_images else []
            points[-1]["images"] = {"pressure": "/jobs/" + job + "/files/" + original.relative_to(root).as_posix()} if has_images else {}
        proofs.append(proof)
    _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
    status = _write_json(root / "status.json", {"job_id": job, "state": "completed"})
    lockpath = _write(root / ".execute.lock", b"")
    scope = {"keepMedia": keep_media, "nonce": "test-session", "id": job, "helper": sha(native.encode()), "jobsInode": peer["inode"](root.parent),
             "jobInode": peer["inode"](root), "lockInode": peer["inode"](lockpath)}
    readbacks = [dict(brokeredUploadId=p["brokeredUploadId"], generation=p["generation"], storedSha256=sha(b"gzip"),
                      storedByteSize=4, verifiedAt=datetime.now(timezone.utc).isoformat()) for p in proofs]
    preserve_directory = "cases/foil/transient_a2" if mode in {"urans-preserve-next", "urans-preserve-linked"} else None
    child_id = "adf10a20-1b23-463c-8027-000000000041"
    linked_owner = child_id + "/foil_a12" if mode == "urans-preserve-linked" else None
    def request(proof_list=proofs, plan=None, objects=readbacks, mode=None, token="fixture-control", peer_scope=None,
                preserve=preserve_directory, continuation=linked_owner):
        mode = mode or ("reclaim" if plan else "proof")
        linked = continuation if preserve is not None else None
        ctx = {**scope, "mode": mode, "plan": plan, "preserveSolver": preserve, "linkedContinuation": linked, **(peer_scope or {})}
        body = json.dumps({"keepMedia":keep_media,"preserveSolver":preserve,"linkedContinuation":linked,"id": job, "step": 2 if plan else 1, "helper": scope["helper"], "mode": mode,
                           "expectedPlan": plan, "manifests": proof_list, "readbacks": objects if plan else []})
        packet = {"body": body, "mac": peer["signature"](token, "request", ctx["nonce"], body)}
        answer = peer["run_engine"](ctx, packet, native, settings)
        assert answer["mac"] == peer["signature"](token, "response", ctx["nonce"], answer["body"])
        return json.loads(answer["body"])["result"]

    def refused(*args, **kwargs):
        with pytest.raises(JobRetentionRefused) as caught:
            request(*args, **kwargs)
        return str(caught.value)

    if preserve_directory:
        next_solver = root / preserve_directory
        coefficient = _write(next_solver / "postProcessing/forceCoeffs/0/coefficient.dat", b"0.1 0.2 0.015 0.001\n")
        original_bytes = coefficient.read_bytes()
        unique = _write(next_solver / "1/U", b"unreported flow field")
        mesh = root / "meshes/recipe/constant/polyMesh"
        faces = _write(mesh / "faces", b"original shared mesh")
        (next_solver / "constant").mkdir()
        (next_solver / "constant/polyMesh").symlink_to(mesh, target_is_directory=True)
        if linked_owner:
            child = root.parent / child_id
            child_case = child / "cases/foil_a12"
            (child_case / "transient_a2/1").mkdir(parents=True)
            clone = child_case / "transient_a2/1/U"
            os.link(unique, clone)
            mesh_clones = []
            for location in ("constant", "transient_a2/constant"):
                copy = child_case / location / "polyMesh/faces"
                copy.parent.mkdir(parents=True)
                os.link(faces,copy)
                mesh_clones.append(copy)
            _write_json(child / "status.json", {"job_id":child_id,"state":"failed"})
            _write_json(child / "result.json", {"job_id":child_id,"state":"failed"})
            child_lock = _write(child / ".execute.lock",b"")
            assert "shared or redirected" in refused(continuation=None) or "retained mesh changed" in refused(continuation=None)
            with pytest.raises(ValueError, match="continuation scope differs"):
                request(peer_scope={"linkedContinuation":child_id+"/another_case"})
            with child_lock.open("rb") as held:
                fcntl.flock(held,fcntl.LOCK_EX)
                assert "active writer" in refused()
            _write_json(child / "status.json", {"job_id":child_id,"state":"running"})
            assert "no exact terminal" in refused()
            _write_json(child / "status.json", {"job_id":child_id,"state":"failed"})
            foreign = child / "other"
            os.link(unique,foreign)
            assert "retained reconstructed time" in refused() or "every other hardlink" in refused()
            foreign.unlink()
            clone.rename(clone.with_name("undeclared"))
            _write(clone,unique.read_bytes())
            assert "does not account for every other hardlink" in refused()
            clone.unlink()
            clone.with_name("undeclared").rename(clone)
            os.link(faces, foreign)
            assert "does not account for every other hardlink" in refused()
            foreign.unlink()
        assert "unarchived case state" in refused(preserve=None)
        assert "next sibling" in refused(preserve="cases/foil/transient_a3")
        with pytest.raises(ValueError, match="scope differs"):
            request(peer_scope={"preserveSolver": None})
        plan = request()
        assert plan["preservedSolver"]["sample"] == {"path": coefficient.relative_to(root).as_posix(),
                                                      "sha256": sha(original_bytes), "byteSize": len(original_bytes)}
        assert {p.relative_to(root).as_posix() for p in duplicates} == set(plan["workingPaths"])
        assert plan["preservedSolver"]["files"] == 2
        if linked_owner:
            link_proof=plan["preservedSolver"]["linkedContinuation"]
            assert (link_proof["jobId"],link_proof["caseSlug"],link_proof["sharedFiles"],link_proof["otherLinks"])==(child_id,"foil_a12",2,3)
            assert not any(path.startswith("cases/foil/transient_a2/") for path in plan["workingPaths"])

        assert plan["preservedSolver"]["sharedMeshInventories"][0]["name"] == mesh.relative_to(root).as_posix()
        faces.write_bytes(b"changed shared mesh")
        refused(plan=plan["plan"])
        faces.write_bytes(b"original shared mesh")
        coefficient.write_bytes(b"changed original")
        refused(plan=plan["plan"])
        assert all(p.exists() for p in duplicates)
        coefficient.write_bytes(original_bytes)
        escape = next_solver / "foreign"
        escape.symlink_to(copies[0])
        assert "symlink" in refused()
        escape.unlink()
        unowned = _write(next_solver / "evidence/evidence_manifest.json", b"unowned manifest")
        assert "unowned evidence" in refused()
        unowned.unlink()
        unowned.parent.rmdir()
        plan = request()
        with monkeypatch.context() as interrupted:
            normal_unlink = Path.unlink
            def lose_process(path, *args, **kwargs):
                if path == force:
                    raise OSError("lost worker after recording the sibling intent")
                return normal_unlink(path, *args, **kwargs)
            interrupted.setattr(Path, "unlink", lose_process)
            refused(plan=plan["plan"])
        assert coefficient.read_bytes() == original_bytes and unique.is_file() and force.is_file()
        assert (root / "closed_progressive_sibling_files.intent.json").is_file()
        assert not (root / "closed_progressive_sibling_files.complete.json").exists()
        done = request(plan=plan["plan"])
        assert done["preservedSolver"] == plan["preservedSolver"] and done["allocation"]["fileAllocatedBytes"] > 0
        assert request()["replayed"] and not any(p.exists() for p in duplicates)
        assert coefficient.read_bytes() == original_bytes and unique.read_bytes() == b"unreported flow field"
        if linked_owner:
            assert clone.read_bytes()==unique.read_bytes() and clone.samefile(unique) and unique.stat().st_nlink==2
            assert all(p.samefile(faces) and p.read_bytes()==b"original shared mesh" for p in mesh_clones)
            assert faces.stat().st_nlink==3

        assert not (root / "closed_progressive_duplicate_files.complete.json").exists()
        assert "unarchived case state" in refused(preserve=None)
        # A later real source for this third point must still enter the ordinary full-job workflow.
        folder = case / "a2/evidence"
        member = {"path": "openfoam/postProcessing/forceCoeffs/0/coefficient.dat", "byteSize": len(original_bytes), "sha256": sha(original_bytes)}
        mf = _write_json(folder / "evidence_manifest.json", {"casePath": str(case), "postPath": str(next_solver),
                         "methodKey": "openfoam.urans", "unsteady": True, "files": [member], "media": {"instantaneous": {}}})
        new_sha, new_size = sha(mf.read_bytes()), mf.stat().st_size
        arts = [{"path": "a2/evidence/evidence_manifest.json", "kind": "manifest", "sha256": new_sha, "byte_size": new_size},
                {"path": "a2/evidence/engine_evidence.tar.zst", "kind": "engine_bundle", "sha256": sha(b"gzip"), "byte_size": 4}]
        catalog = sorted(f"{a['kind']}\tjobs/{job}/cases/foil/{a['path']}\t{a['byte_size']}\t{a['sha256']}" for a in arts)
        third = {**proofs[1], "directory": "cases/foil/a2/evidence", "manifestSha256": new_sha, "manifestByteSize": new_size,
                 "brokeredUploadId": "third-upload", "keepMedia": [], "catalogSha256": sha("\n".join(catalog).encode())}
        authorization = json.loads((case / "a1/evidence/brokered_hub_binding.database.json").read_bytes())["authorization"]
        authorization["evidenceBase"] = "a2/evidence"
        authorization["receipt"]["brokeredUploadId"] = third["brokeredUploadId"]
        authorization["receipt"]["remote"]["manifestSha256"] = new_sha
        _write_json(folder / "brokered_hub_binding.database.json", {"schemaVersion": 1, "state": "hub_progressive_custody", "authorization": authorization})
        intent = {"schemaVersion": 1, "kind": "brokered-local-evidence-reclaim-intent", "authorization": authorization,
                  "paths": [], "plannedPathCount": 0, "plannedBytes": 0}
        _write_json(folder / "brokered_local_reclaim.intent.json", intent)
        _write_json(folder / "brokered_local_reclaim.json", {"schemaVersion": 1, "state": "complete", "authorization": authorization,
                    "bytesDeleted": 0, "deletedPaths": [], "intentSha256": sha(json.dumps(intent, sort_keys=True, separators=(",", ":")).encode())})
        points.append({"case_slug": "foil", "images": {}, "evidence_artifacts": arts})
        _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
        full = request(proof_list=[*proofs, third], preserve=None)
        assert full["workingPaths"] == [coefficient.relative_to(root).as_posix()]
        refused(proof_list=[*proofs,third], plan=full["plan"], preserve=None, objects=readbacks)
        assert coefficient.is_file()
        complete = request(proof_list=[*proofs,third], plan=full["plan"], preserve=None,
                           objects=[*readbacks, {**readbacks[1], "brokeredUploadId": third["brokeredUploadId"]}])
        assert complete["state"] == "reclaimed" and not coefficient.exists() and unique.is_file()
        assert (root / "closed_progressive_sibling_files.complete.json").is_file()
        return
    if mode == "urans-empty":
        plan = request()
        assert plan["mediaFiles"] == [] and set(plan["workingPaths"]) == {p.relative_to(root).as_posix() for p in duplicates}
        unexpected = _write(case / "a0/images/unregistered.png", b"unique unregistered image")
        refused(plan=plan["plan"])
        assert all(p.is_file() for p in duplicates)
        unexpected.unlink()
        points[1].pop("images")
        _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
        assert "no instantaneous image inventory" in refused(plan=plan["plan"])
        points[1]["images"] = {}
        _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
        done = request(plan=plan["plan"])
        assert done["state"] == "reclaimed" and not any(p.exists() for p in duplicates)
        assert request()["replayed"] and all(p.read_bytes() == data for p, data in protected.items())
        return
    if mode in {"urans-foreign-method", "urans-foreign-solver"}:
        assert "does not own this transient solver" in refused()
        assert all(path.exists() for path in duplicates)
        return
    with pytest.raises(ValueError, match="authentication refused"):
        request(token="wrong")
    with pytest.raises(ValueError, match="execution locks differ"):
        request(peer_scope={"lockInode": [0, 0]})
    with pytest.raises(ValueError, match="authorized plan"):
        request(mode="proof", plan="0" * 64)
    if keep_media:
        with pytest.raises(ValueError, match="explicitly named"):
            request(peer_scope={"keepMedia":False})
        bad = [{**proofs[0], "keepMedia": [{**proofs[0]["keepMedia"][0], "path":
                proofs[0]["keepMedia"][0]["path"].replace("pressure.png", "vorticity.png")}]}, proofs[1]]
        assert "owner" in refused(bad)
        symlink = next(iter(retained)).parent / "other.png"
        symlink.symlink_to(next(iter(retained)))
        assert "symlink" in refused() or "unaccounted" in refused()
        symlink.unlink()
        # The previously supported, job-owned polyMesh link is never unlinked.
        mesh = root / "meshes/recipe/constant/polyMesh"
        mesh.mkdir(parents=True)
        (case / "constant").mkdir()
        (case / "constant/polyMesh").symlink_to(mesh, target_is_directory=True)
    if urans:
        link.unlink()
        link.symlink_to("../../2", target_is_directory=True)
        assert "symlink" in refused()
        link.unlink()
        link.symlink_to("../../1/uniform", target_is_directory=True)
        foreign_vtk = post / "VTK/transient_a1_302766"
        foreign_vtk.mkdir()
        assert "unarchived case state" in refused()
        foreign_vtk.rmdir()
        base_link.unlink()
        base_link.symlink_to(post / "1/uniform", target_is_directory=True)
        assert "symlink" in refused()
        base_link.unlink()
        base_link.symlink_to("../../3180/uniform", target_is_directory=True)
        intruder = _write(case / "a0/evidence/scaled_media/default_v1_zoom2/v7/unknown.png", b"foreign image")
        assert "unknown scaled-media field" in refused()
        intruder.unlink()
        points[1].pop("images")
        _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
        assert "no instantaneous image inventory" in refused()
        points[1]["images"] = {}
        _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
    local_archive = _write(case / "a0/evidence/engine_evidence.tar.zst", b"the sole native archive")
    refused()
    assert local_archive.read_bytes()==b"the sole native archive" and copies[0].exists()
    local_archive.unlink()
    cache_only = _write(post / "postProcessing/historical_cache/member.bin", cache_bytes)
    assert "cache, raw, forensic or unsupported" in refused()
    assert cache_only.read_bytes()==cache_bytes and copies[0].exists()
    cache_only.unlink()
    refused(proofs[:1])
    refused([proofs[0], {**proofs[1], "catalogSha256": "0" * 64}])
    stored_result = json.loads((root / "result.json").read_bytes())
    missing_frame = {"path": "a0/evidence/frames/frame.png", "kind": "frame_image", "sha256": sha(b"png"), "byte_size": 3}
    stored_result["polars"][0]["points"][0]["evidence_artifacts"].append(missing_frame)
    _write_json(root / "result.json", stored_result)
    refused()
    assert copies[0].exists()
    all_artifacts = stored_result["polars"][0]["points"][0]["evidence_artifacts"]
    lines = sorted(f"{'mesh' if a['kind'] == 'mesh_evidence' else a['kind']}\tjobs/{job}/cases/foil/{a['path']}\t{a['byte_size']}\t{a['sha256']}" for a in all_artifacts)
    declared_frame = refused([{**proofs[0], "catalogSha256": sha("\n".join(lines).encode())}, proofs[1]])
    assert "outside authenticated bundle" in declared_frame
    _write_json(root / "result.json", {"job_id": job, "state": "completed", "polars": [{"points": points}]})
    plan = request()
    assert plan["state"] == "planned" and plan["files"] == len(duplicates)
    assert plan["bytes"] == sum(p.stat().st_size for p in duplicates)
    assert all(p.is_file() for p in copies)
    if keep_media:
        assert {f["path"] for f in plan["mediaFiles"]} == {p.relative_to(root).as_posix() for p in retained}
        assert set(plan["workingPaths"]) == {p.relative_to(root).as_posix() for p in duplicates}
        assert plan["plannedAllocatedBytes"] == sum(p.stat().st_blocks * 512 for p in duplicates)
        image = next(iter(retained))
        image.write_bytes(b"changed original image")
        refused(plan=plan["plan"])
        image.write_bytes(retained[image])
        assert copies[0].is_file()
    refused(plan=plan["plan"], objects=readbacks[:1])
    refused(plan=plan["plan"], objects=[readbacks[0], {**readbacks[1], "generation": "8"}])
    assert copies[0].is_file()
    for rel in ("cases/foil/a1/evidence/incomplete_evidence_quarantine.receipt.json",
                "cases/foil/a1/images/unregistered.png", "cases/foil/a2/evidence/evidence_manifest.json"):
        blocker = _write(root / rel, b"must retain")
        refused(plan=plan["plan"])
        assert blocker.is_file() and copies[0].is_file()
        blocker.unlink()
        if urans and rel.endswith("a1/images/unregistered.png"):
            blocker.parent.rmdir()
        if rel.endswith("a2/evidence/evidence_manifest.json"):
            blocker.parent.rmdir()
    _write_json(status, {"job_id": job, "state": "running"})
    refused(plan=plan["plan"])
    assert copies[0].exists()
    _write_json(status, {"job_id": job, "state": "completed"})
    with (root / ".execute.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        assert "worker holds" in refused()
        refused(plan=plan["plan"])
        assert copies[0].exists()
    refused(plan="0" * 64)
    assert copies[0].exists()
    with monkeypatch.context() as interrupted:
        unlink = Path.unlink
        def fail_at_force(path, *args, **kwargs):
            if path == force:
                raise OSError("interrupted after first verified duplicate")
            return unlink(path, *args, **kwargs)
        interrupted.setattr(Path, "unlink", fail_at_force)
        refused(plan=plan["plan"])
    assert not copies[0].exists() and force.is_file() and request() == plan
    done = request(plan=plan["plan"])
    measured = done.pop("allocation")
    assert done == {**plan, "state": "reclaimed"}
    assert measured["fileAllocatedBytes"] > 0
    assert measured["netAttributedAllocatedBytes"] == (measured["fileAllocatedBytes"] -
            measured["receiptAllocatedBytes"] - measured["directoryAllocatedDelta"])
    assert not copies[0].exists() and copies[1].read_bytes() == archived
    assert other.is_file() and mismatch.is_file() and (root / "result.json").is_file()
    replay = request()
    assert replay.pop("allocation")["fileAllocatedBytes"] == measured["fileAllocatedBytes"]
    assert replay == {**plan, "replayed": True}
    retry = request(plan=plan["plan"])
    retry.pop("allocation")
    assert retry == {**plan, "state": "reclaimed", "replayed": True}
    if keep_media:
        assert all(p.read_bytes()==data for p,data in retained.items())
        assert (case / "constant/polyMesh").is_symlink()
    if urans:
        assert not (post / "log.pimpleFoam").exists()
        assert all(p.read_bytes() == data for p, data in protected.items())
        assert link.is_symlink() and (link / "time").read_bytes() == b"1/uniform/time"
        assert base_link.is_symlink() and (base_link / "time").read_bytes() == b"original case time"
    _write(copies[0], archived)
    refused(plan=plan["plan"])
    assert copies[0].is_file()


def test_completed_sibling_replay_binds_both_the_original_stop_and_all_continuation_links():
    import runpy
    operator = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-maintenance.py"))
    solver, promise, job, child = [f"00000000-0000-4000-8000-{n:012d}" for n in range(1, 5)]
    witness = {"solverId":solver, "promiseId":promise, "baseUrl":"https://hub.example/api/sync/v1",
               "executionId":job, "assignmentSignature":"a"*64, "localEnvelopeSha256":"b"*64,
               "stoppedReportSignature":"c"*64, "receivedSequence":1024, "promiseState":"cancelled",
               "jobState":"cancelled", "engineState":"cancelled"}
    # canonicalAnalysisJson on the original fixed-shape witness.
    fingerprint = "c29a034fcacc42a7e6e4f17d31746d88463fe44527b29c5a3e4fb7716df60423"
    preserved = {"directory":"cases/c1/transient_a2","linkedContinuation":{"jobId":child,"caseSlug":"c1_a12",
                 "sharedFiles":2,"otherLinks":3,"pathSetSha256":"f"*64}}
    target = {"job":job,"id":job,"plan":"1"*64,"preserveSolver":preserved["directory"],
              "linkedContinuation":child+"/c1_a12","keepMedia":True}
    original = {"registeredTerminalPromise":witness,"preservedSolver":preserved,"scientificSha256":"d"*64,"mediaSha256":"e"*64}
    assert operator["terminal_stop_digest"](original) == fingerprint
    effect = {"status":"already-settled","record":original}
    def restored(check):
        assert check["terminalStop"] == fingerprint and check["linkedContinuation"] == target["linkedContinuation"]
        return {"status":"verified","databaseReadOnly":True,"plan":{"preservedSolver":preserved,"replayed":True},
                "scientificSha256":"d"*64,"mediaSha256":"e"*64,"readbacks":[{}],"points":[{}],
                "registeredTerminalPromise":dict(witness),"registeredTerminalPromiseSha256":fingerprint}
    assert operator["confirm_reclaim"]({},target,effect,restored)["status"] == "verified"
    with pytest.raises(ValueError,match="fingerprint"):
        operator["confirm_reclaim"]({},target,effect,lambda check: {**restored(check),
                                    "registeredTerminalPromise":{**witness,"receivedSequence":1023}})
    with pytest.raises(ValueError,match="unreported working source"):
        operator["confirm_reclaim"]({},target,effect,lambda check: {**restored(check),
                                    "plan":{"preservedSolver":{"directory":preserved["directory"]},"replayed":True}})


def test_closed_storage_inventory_resumes_one_pinned_job_and_preserves_refusals(tmp_path, monkeypatch):
    import runpy
    operator = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-maintenance.py"))
    run = operator["run_inventory"]
    ids = [f"00000000-0000-4000-8000-{n:012d}" for n in range(3)]
    inventory = tmp_path / "private.jsonl"
    inventory.write_text("".join(json.dumps({"id": i, "plan": "a"*64})+"\n" for i in ids))
    digest = hashlib.sha256(inventory.read_bytes()).hexdigest()
    state = tmp_path / "state"
    applied = set()
    calls = []
    scientific = "d"*64
    baseline={"job":ids[0],"status":"verified","databaseReadOnly":True,"helperSha256":"c"*64,
              "plan":{"replayed":True,"plan":"a"*64}, "readbacks":[{}],"dependenciesSha256":"e"*64,"nodePackagesSha256":"f"*64,"nativePackages":{"worker":"1"*64,"gateway":"2"*64},"scientificSha256":scientific,
              "containers":{s:{"image":"old"} for s in ("api","worker","sweeper")}}
    def remote(_, target):
        job, mode = target["id"], target["mode"]
        calls.append((job, mode))
        if job==ids[2] and mode=="verify" and target.get("images",{}).get("api")=="old":
            return {"status":"runtime-changed","observedImages":{s:"new" for s in baseline["containers"]}}
        if job == ids[1]:
            return {"job":job, "status":"refused","reason":"held worker execution lock"}
        allocation={"fileAllocatedBytes":8192,"netAttributedAllocatedBytes":4096}
        if mode=="reclaim" and job in applied:
            return {"status":"already-settled","record":{"scientificSha256":scientific,"allocation":allocation}}
        if mode=="reclaim":
            applied.add(job)
            if job==ids[0]:
                raise RuntimeError("response lost after commit")
        return {"job":job,"status":"settled" if mode=="reclaim" else "verified", "scientificSha256":scientific,
                "settled":mode=="reclaim","databaseReadOnly":mode=="verify","dependenciesSha256":"e"*64,"nodePackagesSha256":"f"*64,"nativePackages":{"worker":"1"*64,"gateway":"2"*64},
                "containers":{s:{"image":"new"} for s in baseline["containers"]},"plan":{"plan":"a"*64,"files":2,"bytes":5000,
                "replayed":mode=="verify"}, "allocation":allocation, "points":[{"attemptId":job}],
                "readbacks":[{"brokeredUploadId":job,"generation":"1","storedSha256":"b"*64,"storedByteSize":120}]}
    monkeypatch.setitem(run.__globals__, "run_remote", remote)
    monkeypatch.setitem(run.__globals__, "validate_sources", lambda _: "c"*64)
    with pytest.raises(RuntimeError, match="lost"):
        run({"revision":"test"},inventory,digest,state,True,baseline)
    assert run({"revision":"test"},inventory,digest,state,True,baseline)==0
    summary=json.loads((state/"status.json").read_bytes())
    assert (summary["verified"], summary["deferred"], summary["fileAllocatedBytes"], summary["netAttributedAllocatedBytes"])==(2,1,16384,8192)
    assert sum(mode=="verify" for _,mode in calls)==4
    assert sum(mode=="reclaim" and job==ids[2] for job,mode in calls)==1
    assert len(list((state/"receipts").glob("*.json")))==3
    count=len(calls)
    assert run({"revision":"test"},inventory,digest,state,True,baseline)==0 and len(calls)==count
    with pytest.raises(ValueError, match="same pinned helper"):
        run({"revision":"different"},inventory,digest,state,True,baseline)



def test_keep_media_pins_the_read_only_api_mount_without_changing_the_original_service_set(monkeypatch):
    import runpy
    module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-maintenance.py"))
    lookup = module["containers"]
    reads = []
    writable_api = False

    def inspect(argv):
        service = argv[-1].removeprefix("hz-solver2-").removesuffix("-1")
        reads.append(service)
        rw = "false" if service == "node-api" and not writable_api else "true"
        return f"{'a'*64}|image|true|start|hz-solver2|{service}|volume|hz-solver2_results|{rw}".encode()

    monkeypatch.setitem(lookup.__globals__, "command", inspect)
    assert set(lookup()) == {"sweeper", "api", "worker"}
    assert set(lookup(True)) == {"sweeper", "api", "worker", "node-api"}
    writable_api = True
    with pytest.raises(ValueError, match="node-api container/volume"):
        lookup(True)


def test_media_queue_uses_the_same_lane_and_recovers_a_real_persisted_effect(tmp_path, monkeypatch):
    import runpy
    operator = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-media-queue.py"))
    process = operator["process"]
    job, result, attempt, img = (f"00000000-0000-4000-8000-{n:012d}" for n in range(4))
    path = "cases/point/evidence/scaled_media/p.png"
    readback = {"brokeredUploadId": "source", "generation": "1", "storedSha256": "a"*64, "storedByteSize": 123}
    plan = {"plan": "b"*64, "files": 1, "bytes": 9, "plannedAllocatedBytes": 4096,
            "workingPaths": ["cases/old/p"], "mediaFiles": [{"path": path}, {"path": "cases/point/images/p.png"}]}
    row = {"id": job, "expectedPointCount": 1, "media": [{"id": img, "attempt": attempt, "result": result, "field": "p",
           "path": f"jobs/{job}/{path}", "sha": "c"*64, "bytes": 20, "hubAttempt": attempt,
           "hubResult": result, "manifest": "d"*64}],
           "objects": [{"upload": "source", "generation": "1", "sha": "a"*64, "bytes": 123}]}
    receipt = {
        "job": job, "helperRevision": "source", "helperSha256": "helper", "dependenciesSha256": "dependencies",
        "nodePackagesSha256": "node", "nativePackages": {"worker": "worker", "gateway": "api"}, "jobsInode": [3, 4],
        "deployLockInode": [5, 6], "lockInode": [7, 8], "jobInode": [9, 10], "containers": {"api": "frozen"},
        "deployedRevision": "release", "readbacks": [readback], "points": [{"attemptId": attempt, "resultId": result,
                                                      "canonicalAttemptId": attempt, "canonicalResultId": result}],
        "scientificSha256": "science", "mediaSha256": "images", "plan": plan,
        "keptMediaRows": [{"id": img, "resultId": result, "attemptId": attempt, "field": "p",
                           "path": path, "sha256": "c"*64, "byteSize": 20, "evidenceSha256": "d"*64}],
    }
    with pytest.raises(ValueError, match="canonical point owners"):
        operator["match_roster"](row, dict(receipt, databaseReadOnly=True, status="proved", settled=False,
                                 points=[{**receipt["points"][0], "canonicalResultId": job}]))
    calls = []

    def invoke(_, mode, jid, expected=None, proof=None):
        assert jid == job
        calls.append(mode)
        if mode == "proof":
            return dict(receipt, databaseReadOnly=True, status="proved", settled=False)
        assert expected == plan["plan"]
        if mode == "reclaim":
            assert json.loads(proof.read_bytes())["plan"] == plan
            assert operator["read"](tmp_path / "pending" / (job + ".json"))["applying"]
            raise RuntimeError("lost reply after native completion")
        assert mode == "verify"
        return dict(receipt, databaseReadOnly=True, status="verified", plan={**plan, "replayed": True})

    monkeypatch.setitem(process.__globals__, "invoke", invoke)
    lock = tmp_path / "operator.lock"
    with operator["exclusive"](lock, create=True):
        with pytest.raises(BlockingIOError), operator["exclusive"](lock):
            pytest.fail("second operator acquired the active lane")
        with pytest.raises(RuntimeError, match="lost reply"):
            process(row, tmp_path, {}, receipt)
        assert process(row, tmp_path, {}, receipt) == "verified"
        assert process(row, tmp_path, {}, receipt) == "verified"
    assert calls == ["proof", "reclaim", "verify"]
    assert not list((tmp_path / "pending").glob("*.json"))
    missing = tmp_path / "prior"
    missing.mkdir()
    operator["publish"](missing / "status.json", {"phase": "attention"})
    assert not operator["predecessor_complete"]({"state": str(missing)}, [])
    operator["publish"](missing / "status.json", {"phase": "complete", "total": 1, "nextOffset": 1,
                                                   "examined": 1, "verified": 1, "deferred": 0})
    with pytest.raises(ValueError, match="missing predecessor receipts"):
        operator["predecessor_complete"]({"state": str(missing)}, [{"id": job, "plan": plan["plan"]}])


@pytest.mark.parametrize("boundary", ["clear", "original-effect", "original-uncertain", "interrupted-read-only-slot"])
def test_media_queue_runs_original_frozen_inventory_before_the_remaining_media(tmp_path, monkeypatch, boundary):
    import runpy
    module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-closed-job-media-queue.py"))
    publish, run = module["publish"], module["run"]
    state, old = tmp_path / "media", tmp_path / "original"
    state.mkdir(mode=0o700)
    old.mkdir()
    (old / "operator.lock").touch()
    lead, other, original, anchor = [f"00000000-0000-4000-8000-{n:012d}" for n in range(4)]
    original_row = {"id": original, "plan": "a"*64}
    previous, selected = tmp_path / "previous.jsonl", tmp_path / "selected.jsonl"
    previous.write_text(json.dumps(original_row)+"\n")
    selected.write_text("\n".join(json.dumps(r) for r in [{"id": lead, "measured": {"plan": "b"*64}}, {"id": other}])+"\n")
    publish(old / "manifest.json", {})
    publish(old / "status.json", {"phase": "checking"})
    proof = tmp_path / "canary.json"
    publish(proof, {"job": anchor})
    if boundary == "original-effect":
        publish(old / "pending" / "work.json", {"effect": {"settled": True}})
    if boundary == "original-uncertain":
        publish(old / "pending" / "work.json", {"startedAt": "before lost response"})
    if boundary == "interrupted-read-only-slot":
        publish(state / "named-slot.json", {"job": lead})
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    old_config = {"repository": str(old), "state": str(old), "inventory": str(previous), "sha256": sha(previous),
                  "manifestSha256": sha(old / "manifest.json"), "runtimeProof": str(proof), "runtimeProofSha256": sha(proof)}
    config = {"state": str(state), "previous": old_config, "operator": {}, "runtimeProof": str(proof),
              "runtimeProofSha256": sha(proof), "inventory": str(selected), "sha256": sha(selected), "lead": lead}
    calls = []
    def one(row, s, installation, runtime):
        calls.append(row["id"])
        with pytest.raises(BlockingIOError), module["exclusive"](old / "operator.lock"):
            pytest.fail("media and raw inventory overlapped")
        publish(s / "receipts" / (row["id"]+".json"), {"job": row["id"], "outcome": "verified"})
        return "verified"
    def prior(argv, cwd, check):
        assert argv[1:] == ["run-inventory", str(previous), "--sha256", sha(previous), "--state", str(old),
                            "--runtime-proof", str(proof), "--apply"]
        with module["exclusive"](old / "operator.lock"):
            calls.append(original)
            (old / "pending" / "work.json").unlink(missing_ok=True)
            publish(old / "receipts" / "00000.json", {"index": 0, "target": original_row, "outcome": "verified"})
            publish(old / "status.json", {"phase": "complete", "verified": 1, "deferred": 0, "total": 1,
                                          "nextOffset": 1, "examined": 1})
    monkeypatch.setitem(run.__globals__, "process", one)
    monkeypatch.setitem(run.__globals__, "command", lambda _: ["frozen"])
    monkeypatch.setitem(run.__globals__, "anchor_read", lambda *_: {})
    monkeypatch.setattr(module["subprocess"], "run", prior)
    run(config, "contract")
    assert calls == ([lead, original, other] if boundary == "clear" else [original, lead, other])
    calls.clear()
    run(config, "contract")
    assert not calls and module["read"](state / "status.json")["verified"] == 2


def test_closed_historical_raw_reclaims_only_after_whole_job_proof_and_restores_original_urls(
    tmp_path, monkeypatch
):
    import runpy
    import threading
    from datetime import datetime, timezone
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlsplit
    import google_crc32c
    from airfoilfoam import historical_raw_restore
    from airfoilfoam.api import main as api_main
    from airfoilfoam.closed_progressive_retention import reclaim_closed_progressive_files
    from airfoilfoam.evidence_store import create_tar_zst

    job = "7fd42905-29e4-44cf-b98b-3cd6588a03c3"
    token = "isolated-local-engine"
    settings = get_settings().model_copy(
        update={"data_dir": tmp_path, "control_plane_token": token, "evidence_bucket": None}
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    client = TestClient(api_main.create_app())
    root = settings.job_dir(job)
    _write(root / ".execute.lock", b"")
    _write_json(root / "status.json", {"job_id": job, "state": "cancelled"})
    sha = lambda b: hashlib.sha256(b).hexdigest()
    proofs, points, cloud, local = [], [], {}, {}
    for n in (1, 2):
        case = root / "cases" / f"c{n}"
        directory = f"cases/c{n}/a0/evidence"
        folder = root / directory
        members = {
            "openfoam/postProcessing/forceCoeffs.dat": (b"0 0.4 0.03 0\n" * 9000) + bytes([n]),
            "time_directories/1/U": (b"isolated stored field fixture\n" * 3200) + bytes([n]),
            "openfoam/logs/transient_a0/source.log": b"isolated stored log" + bytes([n]),
        }
        for name, data in members.items():
            _write(folder / name, data)
        mf = _write_json(
            folder / "evidence_manifest.json",
            {
                "casePath": str(case),
                "postPath": str(case / ("transient_a0" if n == 2 else "transient")),
                **({"methodKey": "openfoam.urans", "unsteady": False} if n == 2 else {}),
                "bundleExcludes": ["frames"],
                "files": [
                    {"path": name, "byteSize": len(data), "sha256": sha(data)}
                    for name, data in members.items()
                ],
            },
        )
        archive = folder / "engine_evidence.tar.zst"
        rec = create_tar_zst(folder, archive, level=10)
        body = archive.read_bytes()
        manifest = mf.read_bytes()
        data = {**members, "evidence_manifest.json": manifest, "engine_evidence.tar.zst": body}
        kinds = {
            "evidence_manifest.json": "manifest",
            "engine_evidence.tar.zst": "engine_bundle",
            "openfoam/postProcessing/forceCoeffs.dat": "force_coefficients",
            "time_directories/1/U": "field_data",
            "openfoam/logs/transient_a0/source.log": "log",
        }
        arts = [
            {"kind": kinds[name], "path": "a0/evidence/" + name, "sha256": sha(buf), "byte_size": len(buf)}
            for name, buf in data.items()
        ]
        point = {"case_slug": case.name, "evidence_artifacts": arts}
        points.append(point)
        sig = sha(json.dumps(point, sort_keys=True).encode())
        receipt = {
            "sim_job_id": job,
            "sequence": n,
            "point_content_signature": sig,
            "report_signature": sha((job + str(n)).encode()),
            "solver_id": job,
            "source_instance_id": "registered-fixture",
            "promise_id": job,
            "assignment_signature": "e" * 64,
            "stop_signature": "f" * 64,
            "stored_sha256": rec.stored_sha256,
            "stored_bytes": rec.stored_size,
            "tar_sha256": rec.tar_sha256,
            "tar_bytes": rec.tar_size,
            "manifest_sha256": sha(manifest),
            "manifest_bytes": len(manifest),
            "manifest_set_sha256": "b" * 64,
            "bundled_file_count": len(members),
            "zstd_level": 10,
            "generation": str(18446744073709551615 - n),
            "bucket": "fixture",
            "object_key": "solver-evidence/v1/sha256/" + sha(body)[:2] + "/" + sha(body) + ".tar.zst",
            "crc32c": base64.b64encode(google_crc32c.value(body).to_bytes(4, "big")).decode(),
            "verified_at": datetime.now(timezone.utc).isoformat(),
        }
        catalog = "\n".join(
            sorted(f"{kinds[k]}\tjobs/{job}/{directory}/{k}\t{len(b)}\t{sha(b)}" for k, b in data.items())
        )
        proofs.append(
            {
                "directory": directory,
                "catalogSha256": sha(catalog.encode()),
                "manifestSha256": sha(manifest),
                "manifestByteSize": len(manifest),
                "generation": receipt["generation"],
                "historicalRaw": receipt,
                **({"regime": "urans"} if n == 2 else {}),
            }
        )
        cloud[sig] = body
        local[sig] = data
    result = {"job_id": job, "state": "cancelled", "polars": [{"points": points}]}
    _write_json(root / "result.json", result)
    core = _write(root / "cases/c1/core.317", b"separate forensic scope")
    work = _write(root / "cases/c1/transient/system/controlDict", b"separate working source")
    vtk_export = _write(root / "cases/c2/transient_a0/VTK/transient_a0_0/internal.vtu", b"working VTK export")
    calls = []

    class Source(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path)
            parts = path.path.split("/")
            sig = parts[-2]
            pin = parts[-1]
            q = parse_qs(path.query)
            receipt = next((p for p in proofs if p["historicalRaw"]["point_content_signature"] == sig), None)
            if (
                not receipt
                or pin != receipt["generation"]
                or self.headers.get("Authorization") != "Bearer " + token
                or q["directory"] != [receipt["directory"]]
            ):
                self.send_error(409)
                return
            body = cloud[sig]
            calls.append((sig, pin))
            self.send_response(200)
            self.send_header("Content-Type", "application/zstd")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Gcs-Generation", pin)
            self.send_header("X-Content-Sha256", receipt["historicalRaw"]["stored_sha256"])
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(historical_raw_restore, "WORKER_GATEWAY", f"http://127.0.0.1:{server.server_port}")

    def read(proof, file="engine_evidence.tar.zst", force=False):
        hdr = (
            {
                "authorization": "Bearer " + token,
                "x-historical-raw-preflight": base64.b64encode(
                    json.dumps(
                        {"version": 1, "directory": proof["directory"], "receipt": proof["historicalRaw"]}
                    ).encode()
                ).decode(),
            }
            if force
            else {}
        )
        return client.get(f"/jobs/{job}/files/{proof['directory']}/{file}", headers=hdr)

    try:
        repo = Path(__file__).resolve().parents[1]
        peer = runpy.run_path(str(repo / "scripts/deploy/hz-closed-job-engine.py"))
        native = (repo / "src/airfoilfoam/closed_progressive_retention.py").read_text()
        scope = {
            "historicalRaw": True,
            "nonce": "historical-read-test",
            "mode": "proof",
            "id": job,
            "helper": sha(native.encode()),
            "jobsInode": peer["inode"](root.parent),
            "jobInode": peer["inode"](root),
            "lockInode": peer["inode"](root / ".execute.lock"),
        }

        def signed_request(expected=None, readbacks=()):
            mode = "proof" if expected is None else "reclaim"
            body = json.dumps(
                {
                    "id": job,
                    "historicalRaw": True,
                    "step": 1 if expected is None else 2,
                    "helper": scope["helper"],
                    "mode": mode,
                    "manifests": proofs,
                    "expectedPlan": expected,
                    "readbacks": list(readbacks),
                }
            )
            packet = {"body": body, "mac": peer["signature"](token, "request", scope["nonce"], body)}
            response = peer["run_engine"]({**scope, "mode": mode, "plan": expected}, packet, native, settings)
            assert response["mac"] == peer["signature"](token, "response", scope["nonce"], response["body"])
            return json.loads(response["body"])["result"]

        plan = signed_request()
        assert plan["files"] == 8 and all(
            not (root / p["directory"] / historical_raw_restore.MARKER).exists() for p in proofs
        )
        readbacks = []
        for p in proofs:
            c = p["historicalRaw"]
            resp = read(p, force=True)
            assert resp.status_code == 200, resp.text
            assert (
                resp.content == cloud[c["point_content_signature"]]
                and resp.headers["x-historical-raw-source"] == "registered-hub"
            )
            sample = plan["historicalSamples"][c["point_content_signature"]]
            member = read(p, sample["path"], force=True)
            assert member.status_code == 200 and member.headers["x-historical-raw-source"] == "registered-hub"
            assert member.headers["x-gcs-generation"] == resp.headers["x-gcs-generation"]
            assert (len(member.content), sha(member.content)) == (sample["byteSize"], sample["sha256"])
            readbacks.append(
                {
                    "historicalPointSignature": c["point_content_signature"],
                    "generation": resp.headers["x-gcs-generation"],
                    "verifiedMember": sample,
                    "storedSha256": sha(resp.content),
                    "storedByteSize": len(resp.content),
                    "verifiedAt": datetime.now(timezone.utc).isoformat(),
                }
            )

        def apply():
            return signed_request(plan["plan"], readbacks)

        # A genuine undeclared point, an unowned folder, or a mismatch in the last source must protect the first.
        points.append({"case_slug": "c2", "evidence_artifacts": []})
        _write_json(root / "result.json", result)
        with pytest.raises(JobRetentionRefused):
            apply()
        points.pop()
        _write_json(root / "result.json", result)
        stray = _write(root / "cases/c2/transient_a9/system/controlDict")
        with pytest.raises(JobRetentionRefused, match="unarchived case state"):
            apply()
        shutil.rmtree(stray.parent.parent)
        unknown = _write(root / "cases/c2/unmatched/evidence/evidence_manifest.json")
        with pytest.raises(JobRetentionRefused):
            apply()
        shutil.rmtree(unknown.parent)
        last = root / proofs[-1]["directory"] / "time_directories/1/U"
        original = last.read_bytes()
        last.write_bytes(b"!" + original[1:])
        with pytest.raises(JobRetentionRefused):
            apply()
        assert all((root / p["directory"] / "engine_evidence.tar.zst").exists() for p in proofs)
        last.write_bytes(original)
        with pytest.raises(JobRetentionRefused):
            reclaim_closed_progressive_files(root, proofs, plan["plan"], readbacks[:-1])
        with pytest.raises(JobRetentionRefused, match="member readback"):
            signed_request(plan["plan"], [*readbacks[:-1], {**readbacks[-1], "verifiedMember": None}])
        real_unlink = Path.unlink
        removed = []

        def fail_after_first_file(path, *args, **kwargs):
            if path in [root / p["directory"] / "engine_evidence.tar.zst" for p in proofs]:
                if removed:
                    raise OSError("fixture interrupted before second archive")
                removed.append(path)
            return real_unlink(path, *args, **kwargs)

        with monkeypatch.context() as mp:
            mp.setattr(Path, "unlink", fail_after_first_file)
            with pytest.raises(JobRetentionRefused, match="interrupted"):
                apply()
        assert (
            removed
            and not removed[0].exists()
            and all((root / p["directory"] / historical_raw_restore.MARKER).is_file() for p in proofs)
        )
        done = apply()
        assert done["state"] == "reclaimed" and done["allocation"]["netAttributedAllocatedBytes"] > 0
        assert (
            apply()["replayed"]
            and core.read_bytes() == b"separate forensic scope"
            and work.read_bytes() == b"separate working source"
            and vtk_export.read_bytes() == b"working VTK export"
        )
        for p in proofs:
            sig = p["historicalRaw"]["point_content_signature"]
            for name in (
                "engine_evidence.tar.zst",
                "openfoam/postProcessing/forceCoeffs.dat",
                "time_directories/1/U",
                "openfoam/logs/transient_a0/source.log",
            ):
                assert not (root / p["directory"] / name).exists()
                response = read(p, name)
                assert response.status_code == 200, response.text
                assert (
                    response.content == local[sig][name]
                    and response.headers["x-gcs-generation"] == p["generation"]
                )
            assert read(p, "openfoam/nonexistent").status_code == 404
            assert (root / p["directory"] / "evidence_manifest.json").read_bytes() == local[sig][
                "evidence_manifest.json"
            ]
        p = proofs[-1]
        sig = p["historicalRaw"]["point_content_signature"]
        cloud[sig] = b"X" + cloud[sig][1:]
        assert read(p).status_code != 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
