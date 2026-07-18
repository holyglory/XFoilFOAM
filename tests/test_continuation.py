"""Cross-job URANS continuation (approved design item C).

A URANS transient stopped by the wall-clock budget guard leaves its case dir
intact on the shared volume; a request carrying ``continue_from`` copies that
saved state into the new job, restarts pimpleFoam from latestTime with the
(usually increased) ``budget_override_s`` and merges the coefficient history
across the job boundary — the SAME restart-segment mechanics the in-run
continuation chunks use.

Covers (no real OpenFOAM solves — fake runners shaped like prod output):
  - request contract: continue_from validation, budget_override_s bounds;
  - budget override wiring: urans_budget_seconds, _finalize_outcome,
    run_case, execute_job, celery hard-limit math;
  - staging: state copy (hardlink where safe), skip dirs, honest failures for
    missing/cleaned/unrestartable sources, transient-start recovery;
  - MUST-CATCH resume mechanics: restart from latestTime + merged history
    spanning both segments over a staged fixture case;
  - MUST-CATCH restartability: a timed-out transient leaves a case dir that
    stages successfully for continuation (latestTime fields intact).
"""
import base64
import hashlib
import json
import math
import os
import re
import shutil
import tarfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import evidence_runtime, jobs, pipeline
from airfoilfoam.capabilities import URANS_RECOVERY_VERSION
from airfoilfoam.celery_app import TASK_TIME_LIMIT_MARGIN_S, task_hard_time_limit_s
from airfoilfoam.config import get_settings
from airfoilfoam.evidence_store import RemoteEvidencePointer, create_tar_zst
from airfoilfoam.evidence_runtime import (
    EVIDENCE_ARCHIVE_NAME,
    EVIDENCE_POINTER_NAME,
)
from airfoilfoam.models import (
    URANS_BUDGET_OVERRIDE_MAX_S,
    AirfoilInput,
    AoASpec,
    CaseSpec,
    ContinuationFailureKind,
    ContinueFrom,
    EngineIdentity,
    EngineRuntimeIdentity,
    FailureDisposition,
    FluidProperties,
    JobState,
    MeshParams,
    PolarRequest,
    RoughnessParams,
    SolverParams,
    urans_budget_seconds,
)
from airfoilfoam.openfoam.dialects import (
    OPENCFD_2406_IDENTITY,
    OPENCFD_2606_IDENTITY,
)
from airfoilfoam.openfoam.runner import InfrastructureError, OpenFOAMError
from airfoilfoam.pipeline import (
    CaseOutcome,
    ContinuationPermanentError,
    ContinuationSource,
    ContinuationTransientError,
    TransientResume,
    _finalize_outcome,
    _run_transient_attempt,
    read_transient_start_marker,
    run_case,
    stage_continuation_case,
    write_transient_start_marker,
)
from airfoilfoam.storage import JobStore

FLUID = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
#: Prod campaign class: 0.1 m chord at 25 m/s; shedding at St=0.2 -> 0.02 s
#: period, inside the estimator's Strouhal band (0.05..0.5 -> 0.008..0.08 s).
SPEC = CaseSpec(chord=0.1, speed=25.0, aoa_deg=15.0)
PERIOD_S = 0.02


def _coeff_rows(t_start: float, t_end: float, dt: float = 0.001, cl0: float = 0.7) -> str:
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    t = t_start
    while t <= t_end + 1e-12:
        cl = cl0 + 0.05 * math.sin(2 * math.pi * t / PERIOD_S)
        cd = 0.2 + 0.01 * math.sin(2 * math.pi * t / PERIOD_S + 0.7)
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, -0.1, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
        t += dt
    return "\n".join(lines) + "\n"


def _write_time_dir(case: Path, name: str) -> None:
    d = case / name
    d.mkdir(parents=True, exist_ok=True)
    for field in ("U", "p", "k", "omega", "nut"):
        (d / field).write_text(f"saved {field} at {name}")


def _make_saved_case(
    case_dir: Path,
    *,
    with_marker: bool = True,
    with_init_log: bool = False,
    latest: str = "0.1",
) -> Path:
    """A saved URANS case shaped like a real budget-stopped campaign point:
    steady stage evidence in the case dir, transient/ with mesh, time dirs,
    controlDict and a shedding coefficient segment up to ``latest``."""
    tcase = case_dir / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        'FoamFile { version 2.0; }\nstartFrom       latestTime;\nendTime         0.1;\n'
    )
    (tcase / "constant" / "polyMesh").mkdir(parents=True)
    (tcase / "constant" / "polyMesh" / "points").write_text("mesh points")
    (tcase / "constant" / "transportProperties").write_text(
        "FoamFile { object transportProperties; }\n"
    )
    (tcase / "constant" / "turbulenceProperties").write_text(
        "FoamFile { object turbulenceProperties; }\n"
    )
    _write_time_dir(tcase, "0")
    _write_time_dir(tcase, latest)
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text(_coeff_rows(0.001, float(latest)))
    if with_marker:
        write_transient_start_marker(tcase, 0.0)
    if with_init_log:
        (tcase / "log.simpleFoam.init").write_text("init evidence")
    # Steady-stage evidence in the case dir (copied along, harmless).
    steady_coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    steady_coeff.parent.mkdir(parents=True)
    steady_coeff.write_text(_coeff_rows(0.001, 0.02))
    # Media/evidence bulk a continuation must NOT drag along.
    (case_dir / "evidence").mkdir()
    (case_dir / "evidence" / "engine_evidence.tar.zst").write_text("bundle")
    (case_dir / "images").mkdir()
    (case_dir / "images" / "vorticity.png").write_text("png")
    (tcase / "VTK").mkdir()
    (tcase / "VTK" / "case_0.vtu").write_text("vtu")
    (tcase / "processor0").mkdir()
    (tcase / "processor0" / "junk").write_text("stale decomposition")
    # A stale divergence verdict must never poison the resumed attempt.
    (tcase / "divergence_condemned.json").write_text('{"reason": "old verdict"}')
    return tcase


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _build_continuation_evidence(
    case_dir: Path,
    *,
    archive_kind: str,
    aoa_deg: float = SPEC.aoa_deg,
    engine_identity: EngineIdentity | None = None,
) -> tuple[Path, object]:
    """Archive a restartable trajectory, then strip every mutable/raw source."""

    tcase = case_dir / "transient"
    evidence = case_dir / "evidence"
    shutil.rmtree(evidence)
    (evidence / "openfoam" / "transient").mkdir(parents=True)
    shutil.copytree(
        tcase / "system",
        evidence / "openfoam" / "transient" / "system",
    )
    shutil.copytree(
        tcase / "constant",
        evidence / "openfoam" / "transient" / "constant",
    )
    shutil.copytree(
        tcase / "postProcessing",
        evidence / "openfoam" / "postProcessing",
    )
    init_log = tcase / "log.simpleFoam.init"
    if init_log.is_file():
        archived_log = (
            evidence
            / "openfoam"
            / "logs"
            / tcase.name
            / "log.simpleFoam.init"
        )
        archived_log.parent.mkdir(parents=True)
        shutil.copy2(init_log, archived_log)
    time_root = evidence / "time_directories"
    for child in sorted(tcase.iterdir()):
        if not child.is_dir():
            continue
        try:
            float(child.name)
        except ValueError:
            continue
        shutil.copytree(child, time_root / child.name)

    entries = []
    for path in sorted(p for p in evidence.rglob("*") if p.is_file()):
        entries.append(
            {
                "path": path.relative_to(evidence).as_posix(),
                "byteSize": path.stat().st_size,
                "sha256": _sha256(path),
                "kind": "test_evidence",
            }
        )
    manifest = {
        "schemaVersion": 2,
        "aoaDeg": aoa_deg,
        "bundleExcludes": [],
        "files": entries,
    }
    if engine_identity is not None:
        manifest["engine"] = engine_identity.model_dump(mode="json")
        manifest["engineNamespace"] = engine_identity.compatibility_key
    (evidence / "evidence_manifest.json").write_text(
        json.dumps(manifest, sort_keys=True),
        encoding="utf-8",
    )

    if archive_kind == "legacy":
        archive = evidence / "openfoam_evidence.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for child in sorted(evidence.iterdir()):
                if child != archive:
                    bundle.add(child, arcname=child.name, recursive=True)
        archive_record = None
    elif archive_kind in {"canonical", "remote"}:
        archive = evidence / EVIDENCE_ARCHIVE_NAME
        archive_record = create_tar_zst(evidence, archive)
    else:  # pragma: no cover - helper contract
        raise AssertionError(archive_kind)

    shutil.rmtree(evidence / "openfoam")
    shutil.rmtree(evidence / "time_directories")
    shutil.rmtree(tcase)
    shutil.rmtree(case_dir / "postProcessing")
    return archive, archive_record


def _write_source_job_metadata(
    case_dir: Path,
    *,
    engine_identity: EngineIdentity | None,
    aoa_deg: float = SPEC.aoa_deg,
    include_identity: bool = True,
    quality_warnings: list[str] | None = None,
    frame_track: dict[str, object] | None = None,
    continuation_transient_subdir: str | None = None,
) -> None:
    cases_root = next(parent for parent in case_dir.parents if parent.name == "cases")
    job_root = cases_root.parent
    case_slug = case_dir.relative_to(cases_root).as_posix()
    request: dict[str, object] = {}
    status: dict[str, object] = {}
    result: dict[str, object] = {
        "polars": [
            {
                "points": [],
                "attempts": [
                    {
                        "case_slug": case_slug,
                        "aoa_deg": aoa_deg,
                        "evidence_artifacts": [],
                    }
                ],
            }
        ]
    }
    if include_identity:
        assert engine_identity is not None
        identity = engine_identity.model_dump(mode="json")
        request["expected_engine"] = identity
        status["requested_engine"] = identity
        result["requested_engine"] = identity
        result["polars"][0]["attempts"][0]["engine"] = identity
    source_attempt = result["polars"][0]["attempts"][0]
    if quality_warnings is not None:
        source_attempt["quality_warnings"] = quality_warnings
    if frame_track is not None:
        source_attempt["frame_track"] = frame_track
    if continuation_transient_subdir is not None:
        source_attempt["continuation_transient_subdir"] = (
            continuation_transient_subdir
        )
    job_root.mkdir(parents=True, exist_ok=True)
    (job_root / "request.json").write_text(json.dumps(request), encoding="utf-8")
    (job_root / "status.json").write_text(json.dumps(status), encoding="utf-8")
    (job_root / "result.json").write_text(json.dumps(result), encoding="utf-8")


def _continuation_request(naca0012_selig_text, **overrides) -> PolarRequest:
    kwargs = dict(
        airfoil=AirfoilInput(name="n0012", coordinates=naca0012_selig_text),
        chord_lengths=[SPEC.chord],
        speeds=[SPEC.speed],
        aoa=AoASpec(angles=[SPEC.aoa_deg]),
        solver=SolverParams(force_transient=True, write_images=[]),
        continue_from=ContinueFrom(engine_job_id="a" * 32, case_slug="c0p1_u25_a15"),
        budget_override_s=21600,
        expected_urans_recovery_version=URANS_RECOVERY_VERSION,
    )
    kwargs.update(overrides)
    return PolarRequest(**kwargs)


# --------------------------------------------------------------------------- #
# Request contract
# --------------------------------------------------------------------------- #


def test_continue_from_request_contract(naca0012_selig_text):
    req = _continuation_request(naca0012_selig_text)
    assert req.continue_from is not None
    assert req.budget_override_s == 21600

    # Nested slug (one level) is a real engine layout: <polar>/urans_aN.
    ContinueFrom(engine_job_id="deadbeef" * 4, case_slug="c0p1_u25/urans_a3")

    # Traversal / unsafe slugs and non-uuid-ish job ids are rejected.
    for bad_slug in ("../other", "a/../b", "a/b/c", "", "cases;rm", "/abs"):
        with pytest.raises(ValueError):
            ContinueFrom(engine_job_id="a" * 32, case_slug=bad_slug)
    for bad_job in ("", "short", "x" * 65, "..", "job/../id", "job id"):
        with pytest.raises(ValueError):
            ContinueFrom(engine_job_id=bad_job, case_slug="c1_u10_a5")

    # continue_from requires a URANS (force_transient) request...
    with pytest.raises(ValueError, match="force_transient"):
        _continuation_request(naca0012_selig_text, solver=SolverParams(write_images=[]))
    # ...and exactly one case.
    with pytest.raises(ValueError, match="exactly one"):
        _continuation_request(naca0012_selig_text, aoa=AoASpec(angles=[10.0, 15.0]))
    # ...and a fail-closed exact recovery capability pin.
    with pytest.raises(ValueError, match="expected_urans_recovery_version"):
        _continuation_request(
            naca0012_selig_text,
            expected_urans_recovery_version=None,
        )

    # Budget override bounds: 24 h cap, sane floor.
    with pytest.raises(ValueError):
        _continuation_request(naca0012_selig_text, budget_override_s=URANS_BUDGET_OVERRIDE_MAX_S + 1)
    with pytest.raises(ValueError):
        _continuation_request(naca0012_selig_text, budget_override_s=10)
    assert (
        _continuation_request(
            naca0012_selig_text, budget_override_s=URANS_BUDGET_OVERRIDE_MAX_S
        ).budget_override_s
        == 86_400
    )


def test_urans_budget_seconds_override():
    solver = SolverParams(force_transient=True)
    assert urans_budget_seconds(solver) == 43200  # tier budget untouched
    assert urans_budget_seconds(solver, 21600) == 21600
    assert urans_budget_seconds(SolverParams(urans_fidelity="precalc"), 9000) == 9000
    # Defensive clamp even if a caller bypasses request validation.
    assert urans_budget_seconds(solver, 500_000) == URANS_BUDGET_OVERRIDE_MAX_S
    assert urans_budget_seconds(solver, 1) == 60


def test_task_hard_time_limit_uses_budget_override():
    settings = get_settings()
    base = task_hard_time_limit_s(settings, 1)
    # An override above the tier ceiling raises the celery backstop with it.
    boosted = task_hard_time_limit_s(settings, 1, budget_override_s=86_400)
    assert boosted == int(
        math.ceil(2 * 86_400 + settings.media_budget_seconds() + TASK_TIME_LIMIT_MARGIN_S)
    )
    assert boosted > base
    # A small override never LOWERS the ceiling below the tier maximum.
    assert task_hard_time_limit_s(settings, 1, budget_override_s=7200) == base
    # Defensive clamp mirrors urans_budget_seconds.
    assert task_hard_time_limit_s(settings, 1, budget_override_s=999_999) == boosted


# --------------------------------------------------------------------------- #
# Staging: copy + honest failures + transient-start recovery
# --------------------------------------------------------------------------- #


def test_stage_continuation_copies_state_and_locates_restart(tmp_path):
    src = tmp_path / "src_job" / "cases" / "c0p1_u25_a15"
    _make_saved_case(src)
    dst = tmp_path / "new_job" / "cases" / "c0p1_u25_a15"

    source = stage_continuation_case(src, dst)

    assert source.transient_subdir == "transient"
    assert source.transient_start == 0.0
    assert source.resume_from == pytest.approx(0.1)
    # Restartable state copied: latestTime fields, mesh, controlDict, history.
    assert (dst / "transient" / "0.1" / "U").read_text() == "saved U at 0.1"
    assert (dst / "transient" / "constant" / "polyMesh" / "points").is_file()
    assert (dst / "transient" / "system" / "controlDict").is_file()
    assert (dst / "transient" / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat").is_file()
    assert read_transient_start_marker(dst / "transient") == 0.0
    # Bulk field data hardlinks (same volume); mutable files are REAL copies.
    src_u = src / "transient" / "0.1" / "U"
    dst_u = dst / "transient" / "0.1" / "U"
    assert os.stat(src_u).st_ino == os.stat(dst_u).st_ino
    for rel in ("system/controlDict", "postProcessing/forceCoeffs1/0/coefficient.dat"):
        assert (
            os.stat(src / "transient" / rel).st_ino != os.stat(dst / "transient" / rel).st_ino
        ), f"{rel} must be a real copy (rewritten in place by the resumed run)"
    # Derived media/evidence, VTK, stale decompositions and stale divergence
    # verdicts never travel with a continuation.
    assert not (dst / "evidence").exists()
    assert not (dst / "images").exists()
    assert not (dst / "transient" / "VTK").exists()
    assert not (dst / "transient" / "processor0").exists()
    assert not (dst / "transient" / "divergence_condemned.json").exists()


def test_stage_continuation_requires_exact_same_engine_before_live_copy(tmp_path):
    src = tmp_path / "jobs" / ("1" * 32) / "cases" / "same-engine"
    _make_saved_case(src)
    _write_source_job_metadata(
        src,
        engine_identity=OPENCFD_2606_IDENTITY,
    )

    compatible = tmp_path / "jobs" / ("2" * 32) / "cases" / "compatible"
    source = stage_continuation_case(
        src,
        compatible,
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )
    assert source.resume_from == pytest.approx(0.1)
    assert (compatible / "transient" / "0.1" / "U").is_file()

    incompatible = tmp_path / "jobs" / ("3" * 32) / "cases" / "incompatible"
    with pytest.raises(
        ContinuationPermanentError,
        match="cross-engine field/history merging is forbidden",
    ):
        stage_continuation_case(
            src,
            incompatible,
            aoa_deg=SPEC.aoa_deg,
            expected_engine=OPENCFD_2406_IDENTITY,
        )
    assert not incompatible.exists()


def test_historical_missing_identity_is_pinned_to_opencfd_2406(tmp_path):
    src = tmp_path / "jobs" / ("4" * 32) / "cases" / "legacy"
    _make_saved_case(src)
    _write_source_job_metadata(
        src,
        engine_identity=None,
        include_identity=False,
    )

    compatible = tmp_path / "jobs" / ("5" * 32) / "cases" / "compatible"
    source = stage_continuation_case(
        src,
        compatible,
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2406_IDENTITY,
    )
    assert source.resume_from == pytest.approx(0.1)

    incompatible = tmp_path / "jobs" / ("6" * 32) / "cases" / "incompatible"
    with pytest.raises(
        ContinuationPermanentError,
        match="source job uses openfoam:opencfd:2406",
    ):
        stage_continuation_case(
            src,
            incompatible,
            aoa_deg=SPEC.aoa_deg,
            expected_engine=OPENCFD_2606_IDENTITY,
        )
    assert not incompatible.exists()


def test_live_continuation_requires_exact_source_result_aoa(tmp_path):
    src = tmp_path / "jobs" / ("f" * 32) / "cases" / "wrong-point"
    _make_saved_case(src)
    _write_source_job_metadata(
        src,
        engine_identity=OPENCFD_2606_IDENTITY,
        aoa_deg=SPEC.aoa_deg - 1.0,
    )
    dst = tmp_path / "jobs" / ("0" * 32) / "cases" / "wrong-point"

    with pytest.raises(
        ContinuationPermanentError,
        match="has no point at exact AoA",
    ):
        stage_continuation_case(
            src,
            dst,
            aoa_deg=SPEC.aoa_deg,
            expected_engine=OPENCFD_2606_IDENTITY,
        )
    assert not dst.exists()


@pytest.mark.parametrize("archive_kind", ["legacy", "canonical"])
def test_stage_continuation_restores_stripped_case_from_verified_local_archive(
    tmp_path,
    archive_kind,
):
    src = tmp_path / "src_job" / "cases" / "archived"
    _make_saved_case(src)
    _build_continuation_evidence(src, archive_kind=archive_kind)
    assert not (src / "transient").exists()
    assert not (src / "evidence" / "openfoam").exists()

    dst = tmp_path / "new_job" / "cases" / "archived"
    source = stage_continuation_case(src, dst, settings=get_settings())

    assert source.transient_subdir == "transient"
    assert source.transient_start == 0.0
    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "system" / "controlDict").is_file()
    assert (dst / "transient" / "constant" / "polyMesh" / "points").is_file()
    assert (dst / "transient" / "0.1" / "U").read_text() == "saved U at 0.1"
    assert (
        dst
        / "transient"
        / "postProcessing"
        / "forceCoeffs1"
        / "0"
        / "coefficient.dat"
    ).is_file()
    # The immutable source bundle is not copied into the new mutable case.
    assert not (dst / "evidence").exists()


def test_modern_archive_requires_matching_source_engine_and_exact_aoa(tmp_path):
    src = tmp_path / "jobs" / ("7" * 32) / "cases" / "modern"
    _make_saved_case(src)
    _build_continuation_evidence(
        src,
        archive_kind="canonical",
        aoa_deg=SPEC.aoa_deg,
        engine_identity=OPENCFD_2606_IDENTITY,
    )
    _write_source_job_metadata(
        src,
        engine_identity=OPENCFD_2606_IDENTITY,
    )

    dst = tmp_path / "jobs" / ("8" * 32) / "cases" / "modern"
    source = stage_continuation_case(
        src,
        dst,
        settings=get_settings(),
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )
    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "p").is_file()

    wrong_aoa_src = tmp_path / "jobs" / ("9" * 32) / "cases" / "wrong-aoa"
    _make_saved_case(wrong_aoa_src)
    _build_continuation_evidence(
        wrong_aoa_src,
        archive_kind="canonical",
        aoa_deg=SPEC.aoa_deg - 1.0,
        engine_identity=OPENCFD_2606_IDENTITY,
    )
    _write_source_job_metadata(
        wrong_aoa_src,
        engine_identity=OPENCFD_2606_IDENTITY,
    )
    wrong_aoa_dst = tmp_path / "jobs" / ("a" * 32) / "cases" / "wrong-aoa"
    with pytest.raises(
        ContinuationPermanentError,
        match="manifest AoA does not match",
    ):
        stage_continuation_case(
            wrong_aoa_src,
            wrong_aoa_dst,
            settings=get_settings(),
            aoa_deg=SPEC.aoa_deg,
            expected_engine=OPENCFD_2606_IDENTITY,
        )
    assert not wrong_aoa_dst.exists()


def test_continuation_engine_guard_compares_logical_identity_not_build_fingerprint(
    tmp_path,
):
    source_runtime = EngineRuntimeIdentity(
        **OPENCFD_2606_IDENTITY.model_dump(),
        build_id="source-build",
        application_source_sha256="a" * 64,
    )
    archive_runtime = EngineRuntimeIdentity(
        **OPENCFD_2606_IDENTITY.model_dump(),
        build_id="archive-build",
        application_source_sha256="b" * 64,
    )
    src = tmp_path / "jobs" / ("a1" * 16) / "cases" / "runtime-builds"
    _make_saved_case(src)
    _build_continuation_evidence(
        src,
        archive_kind="canonical",
        engine_identity=archive_runtime,
    )
    _write_source_job_metadata(
        src,
        engine_identity=source_runtime,
    )
    dst = tmp_path / "jobs" / ("a2" * 16) / "cases" / "runtime-builds"

    source = stage_continuation_case(
        src,
        dst,
        settings=get_settings(),
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )

    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "U").is_file()


def test_archive_engine_must_match_source_job_before_history_materialization(
    tmp_path,
):
    src = tmp_path / "jobs" / ("b" * 32) / "cases" / "mismatched-archive"
    _make_saved_case(src)
    _build_continuation_evidence(
        src,
        archive_kind="canonical",
        engine_identity=OPENCFD_2406_IDENTITY,
    )
    _write_source_job_metadata(
        src,
        engine_identity=OPENCFD_2606_IDENTITY,
    )
    dst = tmp_path / "jobs" / ("c" * 32) / "cases" / "mismatched-archive"

    with pytest.raises(
        ContinuationPermanentError,
        match="manifest engine disagrees with source job",
    ):
        stage_continuation_case(
            src,
            dst,
            settings=get_settings(),
            aoa_deg=SPEC.aoa_deg,
            expected_engine=OPENCFD_2606_IDENTITY,
        )
    assert not dst.exists()


def test_stage_continuation_restores_stripped_case_from_pinned_remote_archive(
    tmp_path,
    monkeypatch,
):
    src = tmp_path / "src_job" / "cases" / "remote"
    _make_saved_case(src)
    local_archive, archive_record = _build_continuation_evidence(
        src,
        archive_kind="remote",
    )
    assert archive_record is not None
    remote_archive = tmp_path / "remote-object.tar.zst"
    shutil.copy2(local_archive, remote_archive)
    # A stale/corrupt local archive must not outrank the exact pinned
    # generation. The pointer anchors local identity and forces remote fallback.
    local_archive.write_bytes(b"stale local bytes")
    pointer = RemoteEvidencePointer(
        bucket="test-bucket",
        object_key=f"solver-evidence/v1/{archive_record.stored_sha256}.tar.zst",
        generation=7,
        stored_sha256=archive_record.stored_sha256,
        stored_size=archive_record.stored_size,
        tar_sha256=archive_record.tar_sha256,
        tar_size=archive_record.tar_size,
        crc32c=base64.b64encode(b"\0\0\0\0").decode("ascii"),
        zstd_level=archive_record.zstd_level,
        created_at="2026-07-16T00:00:00+00:00",
    )
    (src / "evidence" / EVIDENCE_POINTER_NAME).write_text(
        json.dumps(pointer.to_dict()),
        encoding="utf-8",
    )

    class FakeRemoteStore:
        used = False

        @contextmanager
        def archive_source(self, requested):
            assert requested == pointer
            self.used = True
            yield remote_archive

    fake_store = FakeRemoteStore()
    monkeypatch.setattr(
        "airfoilfoam.evidence_runtime.evidence_object_store",
        lambda _settings: fake_store,
    )

    dst = tmp_path / "new_job" / "cases" / "remote"
    source = stage_continuation_case(src, dst, settings=get_settings())

    assert fake_store.used
    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "p").is_file()
    assert (
        dst
        / "transient"
        / "postProcessing"
        / "forceCoeffs1"
        / "0"
        / "coefficient.dat"
    ).is_file()


def test_legacy_local_archive_remains_valid_with_unavailable_migration_pointer(
    tmp_path,
    monkeypatch,
):
    src = tmp_path / "jobs" / ("d" * 32) / "cases" / "legacy-pointer"
    _make_saved_case(src)
    _build_continuation_evidence(
        src,
        archive_kind="legacy",
        engine_identity=OPENCFD_2406_IDENTITY,
    )
    pointer = RemoteEvidencePointer(
        bucket="unavailable-bucket",
        object_key="solver-evidence/v1/sha256/00/" + ("0" * 64) + ".tar.zst",
        generation=1,
        stored_sha256="0" * 64,
        stored_size=1,
        tar_sha256="1" * 64,
        tar_size=1024,
        crc32c=base64.b64encode(b"\0\0\0\0").decode("ascii"),
        zstd_level=10,
        created_at="2026-07-16T00:00:00+00:00",
    )
    (src / "evidence" / EVIDENCE_POINTER_NAME).write_text(
        json.dumps(pointer.to_dict()),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "airfoilfoam.evidence_runtime.evidence_object_store",
        lambda _settings: None,
    )

    dst = tmp_path / "jobs" / ("e" * 32) / "cases" / "legacy-pointer"
    source = stage_continuation_case(
        src,
        dst,
        settings=get_settings(),
        aoa_deg=SPEC.aoa_deg,
    )

    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "U").is_file()


def test_stage_continuation_uses_exact_warm_march_evidence_artifact_by_aoa(
    tmp_path,
):
    job_root = tmp_path / "data" / "jobs" / ("b" * 32)
    src = job_root / "cases" / "polar"
    src.mkdir(parents=True)

    target_build = tmp_path / "target-build"
    _make_saved_case(target_build, latest="0.1")
    target_archive, _ = _build_continuation_evidence(
        target_build,
        archive_kind="legacy",
        aoa_deg=15.0,
    )
    target_evidence = src / "a3" / "evidence"
    target_evidence.parent.mkdir(parents=True)
    shutil.move(target_build / "evidence", target_evidence)

    distractor_build = tmp_path / "distractor-build"
    _make_saved_case(distractor_build, latest="0.2")
    distractor_archive, _ = _build_continuation_evidence(
        distractor_build,
        archive_kind="canonical",
        aoa_deg=14.0,
    )
    distractor_evidence = src / "a2" / "evidence"
    distractor_evidence.parent.mkdir(parents=True)
    shutil.move(distractor_build / "evidence", distractor_evidence)

    def point(
        aoa: float,
        evidence_base: str,
        archive: Path,
        kind: str,
    ) -> dict:
        return {
            "case_slug": "polar",
            "aoa_deg": aoa,
            "evidence_artifacts": [
                {
                    "kind": kind,
                    "path": f"{evidence_base}/{archive.name}",
                    "sha256": _sha256(archive),
                    "byte_size": archive.stat().st_size,
                    "metadata": {"evidenceBase": evidence_base},
                }
            ],
        }

    (job_root / "result.json").write_text(
        json.dumps(
            {
                "polars": [
                    {
                        "points": [],
                        "attempts": [
                            point(
                                14.0,
                                "a2/evidence",
                                distractor_evidence / distractor_archive.name,
                                "engine_bundle",
                            ),
                            point(
                                15.0,
                                "a3/evidence",
                                target_evidence / target_archive.name,
                                "openfoam_bundle",
                            ),
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    dst = tmp_path / "new-job" / "cases" / "continued"
    source = stage_continuation_case(
        src,
        dst,
        settings=get_settings(),
        aoa_deg=15.0,
    )

    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "U").is_file()
    assert not (dst / "transient" / "0.2").exists()


@pytest.mark.parametrize(
    ("metadata_key", "invalid_value", "message"),
    [
        ("sha256", "not-a-digest", "invalid evidence archive SHA-256"),
        ("byte_size", -1, "invalid evidence archive byte size"),
    ],
)
def test_stage_continuation_rejects_malformed_recorded_archive_identity(
    tmp_path,
    metadata_key,
    invalid_value,
    message,
):
    job_root = tmp_path / "data" / "jobs" / ("c1" * 16)
    src = job_root / "cases" / "polar"
    src.mkdir(parents=True)
    result = {
        "polars": [
            {
                "points": [],
                "attempts": [
                    {
                        "case_slug": "polar",
                        "aoa_deg": SPEC.aoa_deg,
                        "evidence_artifacts": [
                            {
                                "kind": "engine_bundle",
                                "path": "evidence/engine_evidence.tar.zst",
                                metadata_key: invalid_value,
                            }
                        ],
                    }
                ],
            }
        ]
    }
    (job_root / "result.json").write_text(json.dumps(result), encoding="utf-8")

    with pytest.raises(ContinuationPermanentError, match=message):
        stage_continuation_case(
            src,
            tmp_path / "new-job" / "cases" / "continued",
            settings=get_settings(),
            aoa_deg=SPEC.aoa_deg,
        )


def test_stage_continuation_falls_through_restart_invalid_archive_to_legacy(
    tmp_path,
):
    bad = tmp_path / "bad-build"
    _make_saved_case(bad)
    (bad / "transient" / "0.1" / "U").unlink()
    bad_archive, _ = _build_continuation_evidence(
        bad,
        archive_kind="canonical",
    )

    good = tmp_path / "good-build"
    _make_saved_case(good)
    good_archive, _ = _build_continuation_evidence(
        good,
        archive_kind="legacy",
    )

    src = tmp_path / "src-job" / "cases" / "fallback"
    evidence = src / "evidence"
    evidence.mkdir(parents=True)
    shutil.copy2(bad_archive, evidence / EVIDENCE_ARCHIVE_NAME)
    shutil.copy2(good_archive, evidence / "openfoam_evidence.tar.gz")

    dst = tmp_path / "new-job" / "cases" / "fallback"
    source = stage_continuation_case(src, dst, settings=get_settings())

    assert source.resume_from == pytest.approx(0.1)
    assert (dst / "transient" / "0.1" / "U").is_file()


def test_archived_init_seeded_trajectory_infers_positive_transient_start(tmp_path):
    src = tmp_path / "src-job" / "cases" / "init-seeded"
    tcase = _make_saved_case(
        src,
        with_marker=False,
        with_init_log=True,
        latest="600.05",
    )
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text(_coeff_rows(600.001, 600.05))
    _build_continuation_evidence(src, archive_kind="canonical")

    dst = tmp_path / "new-job" / "cases" / "init-seeded"
    source = stage_continuation_case(src, dst, settings=get_settings())

    assert source.transient_start == pytest.approx(600.0)
    assert source.resume_from == pytest.approx(600.05)
    assert read_transient_start_marker(dst / "transient") == pytest.approx(600.0)


def test_archived_continuation_preserves_exact_transient_start_marker(tmp_path):
    """MUST-CATCH: the immutable archive owns the exact coefficient-history
    boundary.  Inferring it after restore can silently merge an in-case steady
    initialization segment into the continued transient.
    """

    src = tmp_path / "src-job" / "cases" / "exact-marker"
    tcase = _make_saved_case(src)
    write_transient_start_marker(tcase, 0.012345)
    early_stop_bytes = (
        '{"period_s": 0.02, "retain_from": 0.25, "reason": "certified"}\n'
    )
    (tcase / pipeline.URANS_EARLY_STOP_MARKER).write_text(early_stop_bytes)
    failed_pass = (
        tcase
        / pipeline.URANS_NUMERICAL_RECOVERY_DIR
        / "v2"
        / "event_001"
        / "pass_1_numerical"
    )
    failed_pass.mkdir(parents=True)
    (failed_pass / "failure.json").write_text(
        '{"classification":"numerical","uransRecoveryVersion":2}\n'
    )
    (failed_pass / "log.pimpleFoam").write_text("first pass divergence\n")
    recovery_checkpoint = tcase / pipeline.URANS_RECOVERY_CHECKPOINT_DIR
    (recovery_checkpoint / "latest_time").mkdir(parents=True)
    (recovery_checkpoint / "checkpoint.json").write_text(
        '{"uransRecoveryVersion":2,"latestTime":"0"}\n'
    )
    (recovery_checkpoint / "latest_time" / "U").write_text("safe U")
    outcome = CaseOutcome(spec=SPEC, reynolds=166_666, unsteady=True)
    pipeline._archive_case_evidence(src, tcase, outcome)
    manifest = json.loads(
        (src / "evidence" / "evidence_manifest.json").read_text()
    )
    entries = {entry["path"]: entry["role"] for entry in manifest["files"]}
    assert (
        entries["openfoam/transient/transient_start.json"]
        == "continuation_state"
    )
    assert (
        entries["openfoam/transient/urans_early_stop.json"]
        == "quality_evidence"
    )
    assert entries[
        "openfoam/transient/numerical_recovery/v2/event_001/"
        "pass_1_numerical/failure.json"
    ] == "dictionary"
    assert entries[
        "openfoam/transient/numerical_recovery/v2/event_001/"
        "pass_1_numerical/log.pimpleFoam"
    ] == "log"
    assert entries[
        "openfoam/transient/recovery_checkpoint/checkpoint.json"
    ] == "dictionary"
    assert entries[
        "openfoam/transient/recovery_checkpoint/latest_time/U"
    ] == "time_directory"
    marker_artifact = next(
        artifact
        for artifact in outcome.evidence_artifacts
        if artifact.path == "evidence/openfoam/transient/transient_start.json"
    )
    assert marker_artifact.kind == "dictionary"
    assert marker_artifact.role == "continuation_state"
    shutil.rmtree(tcase)
    shutil.rmtree(src / "postProcessing")

    dst = tmp_path / "new-job" / "cases" / "exact-marker"
    source = stage_continuation_case(src, dst, settings=get_settings())

    assert source.transient_start == pytest.approx(0.012345)
    assert read_transient_start_marker(dst / "transient") == pytest.approx(
        0.012345
    )
    assert (
        dst / "transient" / pipeline.URANS_EARLY_STOP_MARKER
    ).read_text() == early_stop_bytes


def test_live_continuation_resumes_exact_selected_refined_trajectory(tmp_path):
    """MUST-CATCH: rejected refined FULL evidence must resume the refined
    latestTime, not the older base transient retained beside it."""

    src = tmp_path / "jobs" / ("ab" * 16) / "cases" / "selected-refined"
    base = _make_saved_case(src, latest="0.1")
    refined = src / "transient_refined"
    shutil.copytree(base, refined)
    (refined / "0.2").mkdir()
    (refined / "0.2" / "U").write_text("selected refined latest state")
    (refined / "0.2" / "p").write_text("selected refined pressure state")
    write_transient_start_marker(refined, 0.012345)
    _write_source_job_metadata(
        src,
        engine_identity=OPENCFD_2606_IDENTITY,
        quality_warnings=[
            f"URANS {pipeline.URANS_CONTINUATION_REQUIRED_MARKER}"
        ],
        continuation_transient_subdir="transient_refined",
    )

    dst = tmp_path / "continued-selected-refined"
    source = stage_continuation_case(
        src,
        dst,
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )

    assert source.transient_subdir == "transient_refined"
    assert source.resume_from == pytest.approx(0.2)
    assert source.transient_start == pytest.approx(0.012345)
    assert (dst / "transient_refined" / "0.2" / "U").read_text() == (
        "selected refined latest state"
    )


def test_refined_trajectory_archive_preserves_exact_start_marker(tmp_path):
    """Archive hydration canonicalises the selected refined child to
    ``transient`` while preserving its exact coefficient merge boundary."""

    src = tmp_path / "jobs" / ("cd" * 16) / "cases" / "archived-refined"
    base = _make_saved_case(src, latest="0.1")
    refined = src / "transient_refined"
    shutil.copytree(base, refined)
    (refined / "0.25").mkdir()
    (refined / "0.25" / "U").write_text("archived refined latest state")
    (refined / "0.25" / "p").write_text("archived refined pressure state")
    write_transient_start_marker(refined, 0.023456)
    runtime = EngineRuntimeIdentity(
        **OPENCFD_2606_IDENTITY.model_dump(),
        build_id="refined-archive-test",
        application_source_sha256="c" * 64,
    )
    outcome = CaseOutcome(
        spec=SPEC,
        reynolds=166_666,
        engine=runtime,
        unsteady=True,
        continuation_transient_subdir="transient_refined",
    )
    pipeline._archive_case_evidence(src, refined, outcome)
    _write_source_job_metadata(
        src,
        engine_identity=runtime,
        quality_warnings=[
            f"URANS {pipeline.URANS_CONTINUATION_REQUIRED_MARKER}"
        ],
        continuation_transient_subdir="transient_refined",
    )
    shutil.rmtree(src / "transient")
    shutil.rmtree(src / "transient_refined")

    dst = tmp_path / "continued-archived-refined"
    source = stage_continuation_case(
        src,
        dst,
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )

    assert source.transient_subdir == "transient"
    assert source.resume_from == pytest.approx(0.25)
    assert source.transient_start == pytest.approx(0.023456)
    assert read_transient_start_marker(dst / "transient") == pytest.approx(
        0.023456
    )


def test_continuation_source_carries_only_evidence_backed_corrective_tail(tmp_path):
    nonstationary = (
        tmp_path / "jobs" / ("c1" * 16) / "cases" / "nonstationary"
    )
    _make_saved_case(nonstationary)
    _write_source_job_metadata(
        nonstationary,
        engine_identity=OPENCFD_2606_IDENTITY,
        quality_warnings=[
            "URANS window not stationary (precalc established-oscillation test)"
        ],
        frame_track={"stationary": False},
    )
    nonstationary_source = stage_continuation_case(
        nonstationary,
        tmp_path / "continued-nonstationary",
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )
    assert nonstationary_source.corrective_tail_periods == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS
    )

    budget_only = tmp_path / "jobs" / ("c2" * 16) / "cases" / "budget-only"
    _make_saved_case(budget_only)
    _write_source_job_metadata(
        budget_only,
        engine_identity=OPENCFD_2606_IDENTITY,
        quality_warnings=[
            "URANS integration stopped by the wall-clock budget guard"
        ],
        frame_track={"periods_retained": 3, "stationary": True},
    )
    budget_source = stage_continuation_case(
        budget_only,
        tmp_path / "continued-budget",
        aoa_deg=SPEC.aoa_deg,
        expected_engine=OPENCFD_2606_IDENTITY,
    )
    assert budget_source.corrective_tail_periods == pytest.approx(1.0)


def test_stage_continuation_rejects_archive_that_disagrees_with_manifest(tmp_path):
    src = tmp_path / "src_job" / "cases" / "corrupt"
    _make_saved_case(src)
    _build_continuation_evidence(src, archive_kind="canonical")
    manifest = src / "evidence" / "evidence_manifest.json"
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["files"][0]["sha256"] = "0" * 64
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    dst = tmp_path / "new_job" / "cases" / "corrupt"
    with pytest.raises(OpenFOAMError, match="manifest"):
        stage_continuation_case(
            src,
            dst,
            settings=get_settings(),
        )
    assert not dst.exists()
    assert not list(dst.parent.glob(f".{dst.name}.continuation-*"))


def test_stage_continuation_bounds_retained_local_manifest(
    tmp_path,
    monkeypatch,
):
    src = tmp_path / "src_job" / "cases" / "oversized-manifest"
    _make_saved_case(src)
    _build_continuation_evidence(src, archive_kind="canonical")
    monkeypatch.setattr(evidence_runtime, "MAX_EVIDENCE_MANIFEST_BYTES", 32)

    with pytest.raises(OpenFOAMError, match="manifest exceeds"):
        stage_continuation_case(
            src,
            tmp_path / "new_job" / "cases" / "oversized-manifest",
            settings=get_settings(),
        )


def test_stage_continuation_missing_or_unrestartable_sources_fail_honestly(tmp_path):
    dst = tmp_path / "dst"

    with pytest.raises(OpenFOAMError, match="not found"):
        stage_continuation_case(tmp_path / "gone" / "cases" / "x", dst)

    empty = tmp_path / "empty_case"
    empty.mkdir()
    with pytest.raises(OpenFOAMError, match="no transient directory"):
        stage_continuation_case(empty, dst)

    no_times = tmp_path / "no_times"
    (no_times / "transient" / "system").mkdir(parents=True)
    with pytest.raises(OpenFOAMError, match="no time directories"):
        stage_continuation_case(no_times, dst)

    no_fields = tmp_path / "no_fields"
    (no_fields / "transient" / "0.2").mkdir(parents=True)
    with pytest.raises(OpenFOAMError, match="missing fields U, p"):
        stage_continuation_case(no_fields, dst)

    no_mesh = tmp_path / "no_mesh"
    _make_saved_case(no_mesh)
    (no_mesh / "transient" / "constant" / "polyMesh" / "points").unlink()
    with pytest.raises(OpenFOAMError, match="mesh is missing"):
        stage_continuation_case(no_mesh, dst)

    no_control = tmp_path / "no_control"
    _make_saved_case(no_control)
    (no_control / "transient" / "system" / "controlDict").unlink()
    with pytest.raises(OpenFOAMError, match="no system/controlDict"):
        stage_continuation_case(no_control, dst)


@pytest.mark.parametrize(
    "missing_dictionary",
    ["transportProperties", "turbulenceProperties"],
)
def test_opencfd_continuation_requires_both_constant_dictionaries_before_solver_launch(
    tmp_path,
    missing_dictionary,
):
    source = (
        tmp_path
        / "jobs"
        / ("d4" * 16)
        / "cases"
        / f"missing-{missing_dictionary}"
    )
    _make_saved_case(source)
    _write_source_job_metadata(
        source,
        engine_identity=OPENCFD_2606_IDENTITY,
    )
    (source / "transient" / "constant" / missing_dictionary).unlink()

    with pytest.raises(
        OpenFOAMError,
        match=rf"missing required constant dictionaries {missing_dictionary}",
    ):
        stage_continuation_case(
            source,
            tmp_path / "never-launched",
            expected_engine=OPENCFD_2606_IDENTITY,
        )


def test_transient_start_recovery_without_marker(tmp_path):
    # Warm-seeded transient (no in-case init log): transient owns segment 0.
    warm = tmp_path / "warm"
    _make_saved_case(warm, with_marker=False)
    src_t = warm / "transient"
    assert read_transient_start_marker(src_t) is None
    source = stage_continuation_case(warm, tmp_path / "warm_dst")
    assert source.transient_start == 0.0
    assert read_transient_start_marker(tmp_path / "warm_dst" / "transient") == 0.0

    # Init-seeded transient: pseudo-time steady segment at 0, transient at the
    # first POSITIVE segment.
    seeded = tmp_path / "seeded"
    tcase = _make_saved_case(seeded, with_marker=False, with_init_log=True, latest="600.05")
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text(_coeff_rows(600.001, 600.05))
    source = stage_continuation_case(seeded, tmp_path / "seeded_dst")
    assert source.transient_start == 600.0
    assert source.resume_from == pytest.approx(600.05)


# --------------------------------------------------------------------------- #
# MUST-CATCH: resume restarts from latestTime and merges history across jobs
# --------------------------------------------------------------------------- #


def test_resume_restarts_from_latest_time_and_merges_both_segments(tmp_path):
    """Real breakage shape: a budget-stopped campaign point (5 shedding periods
    saved, stopped at t=0.1) is continued in a NEW job. The resumed transient
    must restart pimpleFoam from latestTime (restart=True, controlDict
    startTime = saved latest) and grade the history MERGED across the job
    boundary — never re-prepare/wipe the case, never restart physics at 0."""
    case_dir = tmp_path / "case"
    _make_saved_case(case_dir)
    dst = tmp_path / "staged"
    source = stage_continuation_case(case_dir, dst)
    tcase = dst / "transient"

    calls: dict[str, object] = {}

    class FakeRunner:
        def solver(self, cdir, app, n_proc, timeout=None, restart=False, monitor=None):
            calls["app"] = app
            calls["restart"] = restart
            calls["timeout"] = timeout
            calls["n"] = calls.get("n", 0) + 1
            control = (Path(cdir) / "system" / "controlDict").read_text()
            calls["controlDict"] = control
            start = float(re.search(r"startTime\s+([0-9.eE+-]+);", control).group(1))
            end = float(re.search(r"endTime\s+([0-9.eE+-]+);", control).group(1))
            # The continuation segment lands in its OWN forceCoeffs dir named
            # by the restart time (OpenFOAM restart-segment behaviour).
            seg = Path(cdir) / "postProcessing" / "forceCoeffs1" / f"{start:g}" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows(start + 0.001, 0.2))
            _write_time_dir(Path(cdir), "0.15")
            _write_time_dir(Path(cdir), "0.2")
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="Time = 0.2\n")

        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

    # Full-tier period target (7): the retained integer-period window (0.14 s)
    # can only exist if the history MERGES across the 0.1 s job boundary.
    solver = SolverParams(
        force_transient=True,
        write_images=[],
        transient_discard_fraction=0.0,
        urans_min_periods=7,
        transient_auto_refine=False,
    )
    result = pipeline._run_transient(
        dst,
        airfoil=None,
        resolved=MeshParams(),
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=solver,
        runner=FakeRunner(),
        n_proc=1,
        timeout=21600,
        resume=TransientResume(
            transient_start=source.transient_start, resume_from=source.resume_from
        ),
    )

    assert result is not None
    # One resumed solver run with restart mechanics and the overridden budget.
    assert calls["n"] == 1 and calls["app"] == "pimpleFoam"
    assert calls["restart"] is True
    # The resumed solve shares one monotonic tier deadline, so the subprocess
    # receives the real remaining budget (a few scheduling microseconds below
    # the nominal 21600 s), never a freshly reset full timeout per chunk.
    assert calls["timeout"] == pytest.approx(21600, abs=0.1)
    assert "latestTime" in calls["controlDict"]
    assert re.search(r"startTime\s+0\.1;", calls["controlDict"]), calls["controlDict"]
    max_delta_t = float(re.search(r"maxDeltaT\s+([0-9.eE+-]+);", calls["controlDict"]).group(1))
    write_interval = float(re.search(r"writeInterval\s+([0-9.eE+-]+);", calls["controlDict"]).group(1))
    assert max_delta_t == pytest.approx(write_interval)
    assert write_interval == pytest.approx(PERIOD_S / pipeline.URANS_FRAME_WRITE_PER_CYCLE, rel=0.05)
    # The saved state was NOT wiped or re-prepared.
    assert (tcase / "0.1" / "U").read_text() == "saved U at 0.1"
    # Merged history: coefficient segments of BOTH jobs feed the grade, and
    # the retained integer-period window CROSSES the job boundary at t=0.1
    # (7 periods x 0.02 s = 0.14 s > the 0.1 s continuation segment alone).
    assert len(result.coeff_paths) == 2
    history = result.force_history
    assert history is not None
    assert history.t[0] < 0.1 < history.t[-1]
    assert history.t[-1] >= 0.19
    # ...and the result grades the WHOLE merged transient window.
    assert result.start_time == source.transient_start
    assert result.end_time == pytest.approx(0.2)
    assert result.run_time == pytest.approx(0.2)
    avg = result.avg
    assert avg.cl == pytest.approx(0.7, abs=0.02)


def test_resume_first_chunk_uses_evidence_backed_corrective_tail_for_both_tiers(
    tmp_path, monkeypatch
):
    """MUST-CATCH: a non-stationary source needs the same meaningful
    three-period correction as the in-run controller.  An
    insufficient-period-only source keeps the smaller deficit-sized chunk so
    the reliability fix cannot create avoidable wall-budget timeouts.
    """

    case_dir = tmp_path / "case"
    _make_saved_case(case_dir, latest="0.1")
    captured: list[float] = []

    monkeypatch.setattr(
        pipeline,
        "get_mesher",
        lambda _name: SimpleNamespace(patches=lambda _mesh: {}),
    )

    def fake_attempt(tcase, *_args, **kwargs):
        captured.append(float(kwargs["run_time"]))
        return pipeline.TransientResult(
            avg=SimpleNamespace(
                cl=0.7,
                cd=0.2,
                cm=-0.1,
                cl_cd=3.5,
                cl_std=0.0,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=Path(tcase),
            force_history=None,
            quality=pipeline.UransQuality(
                ok=True,
                can_refine=False,
                reason="corrective window accepted",
            ),
            start_time=0.1,
            end_time=0.16,
            run_time=float(kwargs["run_time"]),
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    def run(
        target_case: Path,
        resume_from: float,
        corrective_tail_periods: float,
        fidelity: str = "precalc",
    ):
        return pipeline._run_transient(
            target_case,
            airfoil=None,
            resolved=MeshParams(),
            spec=SPEC,
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(
                force_transient=True,
                urans_fidelity=fidelity,
                urans_min_periods=3 if fidelity == "precalc" else 7,
                transient_discard_fraction=0.4,
                transient_auto_refine=False,
            ),
            runner=None,
            n_proc=1,
            timeout=7200,
            resume=TransientResume(
                transient_start=0.0,
                resume_from=resume_from,
                corrective_tail_periods=corrective_tail_periods,
            ),
        )

    assert run(case_dir, 0.1, 1.0) is not None
    assert captured[-1] == pytest.approx(PERIOD_S, rel=0.05)
    assert (
        run(
            case_dir,
            0.1,
            pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS,
        )
        is not None
    )
    assert captured[-1] == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * PERIOD_S,
        rel=0.05,
    )

    # Full verification owns the same evidence-backed corrective tail.  The
    # source already satisfies its seven-period retention target, so strict
    # mean drift replaces three measured periods instead of the old one-period
    # continuation that repeatedly returned to the final rejection gate.
    full_case = tmp_path / "full-case"
    _make_saved_case(full_case, latest="0.3")
    assert (
        run(
            full_case,
            0.3,
            pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS,
            "full",
        )
        is not None
    )
    assert captured[-1] == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * PERIOD_S,
        rel=0.05,
    )

    # Real short-source shape: K < target also reports stationary=false.  The
    # retained deficit owns sizing until K reaches the target; the corrective
    # three-period tail must not turn this ordinary shortfall into excess work.
    short_case = tmp_path / "short-case"
    short_resume = 0.093333
    _make_saved_case(short_case, latest=f"{short_resume:g}")
    assert (
        run(
            short_case,
            short_resume,
            pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS,
        )
        is not None
    )
    assert captured[-1] == pytest.approx(PERIOD_S, rel=0.08)


# --------------------------------------------------------------------------- #
# Budget override + resume wiring through _finalize_outcome / run_case / jobs
# --------------------------------------------------------------------------- #


def test_finalize_outcome_threads_override_budget_and_resume(tmp_path, monkeypatch):
    captured = {}

    def fake_run_transient(case_dir, airfoil, resolved, spec, fluid, roughness, sp,
                           runner, n_proc, timeout, **kwargs):
        captured["timeout"] = timeout
        captured["resume"] = kwargs.get("resume")
        return None

    monkeypatch.setattr(pipeline, "_run_transient", fake_run_transient)
    outcome = CaseOutcome(spec=SPEC, reynolds=166_666)
    resume = TransientResume(transient_start=0.0, resume_from=0.1)
    with pytest.raises(OpenFOAMError):
        _finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="n0012", contour=[]),
            resolved=MeshParams(),
            spec=SPEC,
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True, write_images=[]),
            runner=SimpleNamespace(),
            n_proc=1,
            render_images=False,
            solver_timeout=7200,
            resume=resume,
            urans_budget_s=21600,
        )
    assert captured["timeout"] == 21600  # override replaces the 43200 tier budget
    assert captured["resume"] is resume


def test_run_case_resume_skips_mesh_and_steady_stages(tmp_path, monkeypatch):
    captured = {}

    def fake_finalize(case_dir, outcome, *args, **kwargs):
        captured["resume"] = kwargs.get("resume")
        captured["urans_budget_s"] = kwargs.get("urans_budget_s")
        outcome.converged = True

    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)

    class ForbiddenRunner:
        def solver(self, *_args, **_kwargs):
            raise AssertionError("continuation must never run the steady stage")

        def application(self, *_args, **_kwargs):
            raise AssertionError("continuation must never run mesh/init applications")

    class ForbiddenMesher:
        def patches(self, _resolved):
            return {}

        def cell_count(self, _resolved):
            return 4242

        def write_inputs(self, *_args, **_kwargs):
            raise AssertionError("continuation must never write mesh inputs")

        def run_mesh(self, *_args, **_kwargs):
            raise AssertionError("continuation must never build a mesh")

    resume = TransientResume(transient_start=0.0, resume_from=0.1)
    outcome = run_case(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="n0012", contour=[]),
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        mesh_params=MeshParams(),
        solver_params=SolverParams(force_transient=True, write_images=[]),
        mesher=ForbiddenMesher(),
        runner=ForbiddenRunner(),
        resume=resume,
        urans_budget_s=13337,
    )

    assert outcome.error is None
    assert outcome.converged
    assert outcome.n_cells == 4242
    assert captured["resume"] is resume
    assert captured["urans_budget_s"] == 13337


def test_execute_job_continuation_wiring(monkeypatch, naca0012_selig_text):
    captured = {}
    completed_count_observations: list[bool] = []
    source = ContinuationSource(
        transient_subdir="transient",
        transient_start=0.42,
        resume_from=1.1,
        corrective_tail_periods=pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS,
    )

    def fake_stage(
        src_case,
        dst_case,
        *,
        settings=None,
        aoa_deg=None,
        expected_engine=None,
    ):
        captured["src_case"] = src_case
        captured["dst_case"] = dst_case
        captured["settings"] = settings
        captured["aoa_deg"] = aoa_deg
        captured["expected_engine"] = expected_engine
        return source

    def fake_run_case(case_dir, airfoil, spec, fluid, roughness, mesh_params, solver_params,
                      mesher, runner, **kwargs):
        captured["case_dir"] = case_dir
        captured["resume"] = kwargs.get("resume")
        captured["urans_budget_s"] = kwargs.get("urans_budget_s")
        return CaseOutcome(
            spec=spec, reynolds=166_666, cl=0.9, cd=0.11, cm=-0.05,
            converged=True, unsteady=True, fidelity="urans_full",
            continuation_transient_subdir="transient_refined",
        )

    def forbid_mesh(*_args, **_kwargs):
        raise AssertionError("continuation jobs must not mesh")

    monkeypatch.setattr(jobs, "stage_continuation_case", fake_stage)
    monkeypatch.setattr(jobs, "run_case", fake_run_case)
    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", forbid_mesh)

    class ObservingStore(JobStore):
        def write_status(self, status):
            if (
                status.state is JobState.running
                and status.completed_cases == 1
            ):
                partial = self.read_result(status.job_id)
                completed_count_observations.append(
                    partial is not None
                    and partial.state is JobState.running
                    and sum(
                        len(polar.points) for polar in partial.polars
                    )
                    == 1
                )
            super().write_status(status)

    request = _continuation_request(naca0012_selig_text)
    settings = get_settings()
    store = ObservingStore(settings)
    result = jobs.execute_job("continuation-wiring-test", request, store=store, settings=settings)

    assert result.state.value == "completed"
    cf = request.continue_from
    assert captured["src_case"] == store.cases_dir(cf.engine_job_id) / cf.case_slug
    assert captured["dst_case"] == store.case_dir("continuation-wiring-test", SPEC.slug)
    assert captured["settings"] is settings
    assert captured["aoa_deg"] == SPEC.aoa_deg
    assert captured["expected_engine"] == OPENCFD_2606_IDENTITY
    assert captured["case_dir"] == captured["dst_case"]
    resume = captured["resume"]
    assert isinstance(resume, TransientResume)
    assert resume.transient_start == 0.42 and resume.resume_from == 1.1
    assert resume.corrective_tail_periods == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS
    )
    assert captured["urans_budget_s"] == 21600
    # The continuation point ingests as a NORMAL polar point (same cell).
    assert len(result.polars) == 1
    points = result.polars[0].points
    assert len(points) == 1
    assert points[0].aoa_deg == SPEC.aoa_deg
    assert points[0].case_slug == SPEC.slug
    assert points[0].fidelity == "urans_full"
    assert points[0].continuation_transient_subdir == "transient_refined"
    assert completed_count_observations == [True]


def test_execute_job_continuation_missing_source_fails_honestly(monkeypatch, naca0012_selig_text):
    """A cleaned/missing saved case must fail the job with a truthful message
    BEFORE any solving — never mesh, never solve, never invent a point."""

    def forbid(*_args, **_kwargs):
        raise AssertionError("must not solve when the continuation source is missing")

    monkeypatch.setattr(jobs, "run_case", forbid)
    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", forbid)

    request = _continuation_request(
        naca0012_selig_text,
        continue_from=ContinueFrom(engine_job_id="f" * 32, case_slug="never_existed"),
    )
    settings = get_settings()
    store = JobStore(settings)
    result = jobs.execute_job("continuation-missing-src", request, store=store, settings=settings)

    assert result.state.value == "failed"
    assert result.failure_disposition is None
    assert result.continuation_failure_kind == ContinuationFailureKind.permanent
    assert "continuation failed" in (result.message or "")
    assert "not found" in (result.message or "")
    assert result.polars == [] or all(not p.points for p in result.polars)
    status = store.read_status("continuation-missing-src")
    assert status is not None and status.state.value == "failed"
    assert status.failure_disposition is None
    assert status.continuation_failure_kind == ContinuationFailureKind.permanent
    assert "continuation failed" in (status.message or "")


def test_execute_job_continuation_transient_storage_failure_is_typed(
    monkeypatch,
    naca0012_selig_text,
):
    def transient_stage(*_args, **_kwargs):
        raise ContinuationTransientError(
            "continuation_source_transient: insufficient safe free space"
        )

    def forbid(*_args, **_kwargs):
        raise AssertionError("must not solve after continuation staging fails")

    monkeypatch.setattr(jobs, "stage_continuation_case", transient_stage)
    monkeypatch.setattr(jobs, "run_case", forbid)
    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", forbid)

    request = _continuation_request(naca0012_selig_text)
    settings = get_settings()
    store = JobStore(settings)
    result = jobs.execute_job(
        "continuation-transient-storage",
        request,
        store=store,
        settings=settings,
    )

    assert result.state.value == "failed"
    assert result.failure_disposition == FailureDisposition.infrastructure
    assert result.continuation_failure_kind == ContinuationFailureKind.transient
    assert "insufficient safe free space" in (result.message or "")


# --------------------------------------------------------------------------- #
# MUST-CATCH: a timed-out transient leaves restartable state (continuable)
# --------------------------------------------------------------------------- #


def test_timed_out_transient_leaves_restartable_state_for_continuation(tmp_path, monkeypatch):
    """Real breakage shape: pimpleFoam killed by the wall-clock budget after
    writing fields at t=0.05. The budget-stop path must leave the case dir
    intact (latestTime fields written, controlDict/mesh present) so the SAME
    case stages successfully for a cross-job continuation."""

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs) -> None:
            pass

    class TimeoutRunner:
        def solver(self, cdir, *_args, monitor=None, **_kwargs):
            seg = Path(cdir) / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows(0.001, 0.05))
            _write_time_dir(Path(cdir), "0.05")  # last complete write before SIGTERM
            return SimpleNamespace(
                ok=False, returncode=124, timed_out=True,
                stdout="deltaT = 1e-06\nTime = 0.05\nCommand timed out after 7200s",
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)

    case_dir = tmp_path / "case"
    tcase = case_dir / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text("startFrom latestTime;\n")
    (tcase / "constant" / "polyMesh").mkdir(parents=True)
    (tcase / "constant" / "polyMesh" / "points").write_text("mesh points")
    (tcase / "constant" / "transportProperties").write_text(
        "FoamFile { object transportProperties; }\n"
    )
    (tcase / "constant" / "turbulenceProperties").write_text(
        "FoamFile { object turbulenceProperties; }\n"
    )
    _write_time_dir(tcase, "0")
    write_transient_start_marker(tcase, 0.0)
    dirs_before = {d.name for d in tcase.iterdir()}

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, urans_min_periods=7),
        runner=TimeoutRunner(),
        n_proc=1,
        timeout=7200,
        run_time=0.3,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )

    # Honest partial grade — and NOTHING deleted by the budget-stop path.
    assert result is not None
    assert not result.quality.ok and not result.quality.can_refine
    assert "timed out" in result.quality.reason
    # MUST-CATCH (cross-runtime recall): the timed-out grade carries the pinned
    # continuable marker, so the node predicate offers CONTINUE — not only a
    # from-scratch requeue — for a solve killed mid-chunk by the wall clock.
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason
    assert dirs_before <= {d.name for d in tcase.iterdir()}
    latest = tcase / "0.05"
    assert (latest / "U").is_file() and (latest / "p").is_file()

    # The timed-out case IS continuable: staging succeeds and resumes from the
    # fields the killed run left at latestTime.
    source = stage_continuation_case(case_dir, tmp_path / "staged")
    assert source.transient_subdir == "transient"
    assert source.transient_start == 0.0
    assert source.resume_from == pytest.approx(0.05)
    assert (tmp_path / "staged" / "transient" / "0.05" / "U").is_file()


@pytest.mark.parametrize("with_coefficients", [True, False])
@pytest.mark.parametrize("timeout_attr", [True, False])
def test_mpi_reconstruction_timeout_fails_without_false_continuation_marker(
    tmp_path, monkeypatch, with_coefficients, timeout_attr
):
    """The common tier deadline covers MPI reconstruction too.

    Real MPI writes live under ``processor*`` until reconstruction succeeds.
    The continuation copier deliberately excludes those directories and can
    resume only reconstructed root fields, so a reconstruction timeout is not
    safely continuable.  It must fail truthfully without the wall-budget
    continuation marker, even when real coefficients were already written.
    """

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs) -> None:
            pass

    class ReconstructionTimeoutRunner:
        def solver(self, cdir, *_args, **_kwargs):
            if with_coefficients:
                seg = (
                    Path(cdir)
                    / "postProcessing"
                    / "forceCoeffs1"
                    / "0"
                    / "coefficient.dat"
                )
                seg.parent.mkdir(parents=True, exist_ok=True)
                seg.write_text(_coeff_rows(0.0, 0.3, dt=0.0005))
                # Real parallel-output shape: fields exist only in processor
                # directories until reconstructPar publishes root times.
                for i in range(601):
                    time_dir = Path(cdir) / "processor0" / f"{i * 0.0005:.8g}"
                    time_dir.mkdir(parents=True, exist_ok=True)
                    (time_dir / "U").write_text("decomposed U")
                    (time_dir / "p").write_text("decomposed p")
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout="pimpleFoam completed",
            )

        def application(self, _cdir, app, timeout=None):
            assert app == "reconstructPar -newTimes"
            assert timeout is not None and timeout > 0
            return SimpleNamespace(
                ok=False,
                returncode=124,
                timed_out=timeout_attr,
                stdout="Command timed out during reconstruction",
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    def call():
        return _run_transient_attempt(
            tcase,
            airfoil=None,
            tmesh=None,
            patches={},
            spec=SPEC,
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(
                force_transient=True,
                urans_fidelity="full",
                urans_min_periods=7,
                transient_discard_fraction=0.0,
            ),
            runner=ReconstructionTimeoutRunner(),
            n_proc=2,
            timeout=120,
            run_time=0.3,
            delta_t=1e-5,
            coeff_start_time=0.0,
        )

    with pytest.raises(OpenFOAMError, match="reconstruct") as caught:
        call()
    message = str(caught.value)
    assert "not safely continuable" in message
    assert pipeline.URANS_BUDGET_STOP_MARKER not in message


def test_mpi_reconstruction_non_timeout_failure_remains_a_real_failure(
    tmp_path, monkeypatch
):
    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs) -> None:
            pass

    class ReconstructionFailureRunner:
        def solver(self, *_args, **_kwargs):
            return SimpleNamespace(
                ok=False,
                returncode=124,
                timed_out=True,
                stdout="pimpleFoam timed out",
            )

        def application(self, *_args, **_kwargs):
            return SimpleNamespace(
                ok=False,
                returncode=1,
                timed_out=False,
                stdout="reconstructPar parse failure",
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    with pytest.raises(InfrastructureError, match="MPI reconstruction failed"):
        _run_transient_attempt(
            tcase,
            airfoil=None,
            tmesh=None,
            patches={},
            spec=SPEC,
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True),
            runner=ReconstructionFailureRunner(),
            n_proc=2,
            timeout=120,
            run_time=0.3,
            delta_t=1e-5,
            coeff_start_time=0.0,
        )


# --------------------------------------------------------------------------- #
# Cross-runtime marker pin: the continuable-grade phrase is a contract
# --------------------------------------------------------------------------- #


def test_budget_stop_marker_literal_is_pinned_on_the_engine_side():
    """packages/core/src/urans-quality.ts URANS_BUDGET_STOP_MARKER matches the
    engine's quality warnings by SUBSTRING. Both sides pin the identical
    literal: rewording the engine phrasing must fail HERE, loudly, instead of
    silently zeroing the node continuable predicate (recall guardrail)."""
    assert pipeline.URANS_BUDGET_STOP_MARKER == "stopped by the wall-clock budget guard"
