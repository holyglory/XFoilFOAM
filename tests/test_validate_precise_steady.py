from __future__ import annotations

import io
import json
from pathlib import Path
import tarfile
from types import SimpleNamespace

import pytest

from airfoilfoam.models import AirfoilInput, AoASpec, PolarRequest, SolverParams
from scripts.materials import validate_precise_steady as driver


@pytest.fixture
def representative_source_request(tmp_path, monkeypatch):
    geometry = Path(__file__).parents[1] / "packages/db/seed/selig-database/fx61147.dat"
    request = PolarRequest(
        execution_id=driver.SOURCE_JOB_ID,
        airfoil=AirfoilInput(name="FX 61-147 AIRFOIL", coordinates=geometry.read_text()),
        chord_lengths=[0.05],
        speeds=[30.0],
        aoa=AoASpec(angles=[-5.0, 0.0, 5.0]),
        solver=SolverParams(
            flow_solver_family="pimpleFoam",
            force_transient=True,
            n_iterations=3000,
            convergence_tolerance=1e-5,
            momentum_scheme="linearUpwind",
        ),
    )
    path = tmp_path / "representative-request.json"
    path.write_text(request.model_dump_json())
    monkeypatch.setattr(driver, "SOURCE_REQUEST_SHA256", driver.sha256_file(path))
    return path


@pytest.fixture
def pinned_engine_sources(tmp_path, monkeypatch):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "diagnostic-test"\n')
    engine_file = tmp_path / "src/airfoilfoam/pipeline.py"
    engine_file.parent.mkdir(parents=True)
    engine_file.write_bytes(b"engine source\n")
    monkeypatch.setattr(driver, "EXPECTED_APPLICATION_SOURCE_SHA256", driver.application_source_sha256(tmp_path))
    monkeypatch.setattr(driver.subprocess, "check_output", lambda *args, **kwargs: "a" * 40 + "\n")
    return tmp_path


def test_source_identity_allows_diagnostic_commits_with_identical_engine_bytes(pinned_engine_sources, monkeypatch):
    root = pinned_engine_sources
    original = driver.source_identity(root)
    diagnostic = root / "scripts/materials/validate_precise_steady.py"
    diagnostic.parent.mkdir(parents=True)
    diagnostic.write_text("diagnostic changes\n")
    monkeypatch.setattr(driver.subprocess, "check_output", lambda *args, **kwargs: "b" * 40 + "\n")

    committed = driver.source_identity(root)

    assert original["checkout_revision"] == "a" * 40
    assert committed["checkout_revision"] == "b" * 40
    assert committed["application_source_sha256"] == original["application_source_sha256"]
    assert committed["application_source_sha256"] == committed["expected_application_source_sha256"]
    assert committed["source_files"] == original["source_files"] == {
        "pyproject.toml": driver.file_record(root / "pyproject.toml"),
        "src/airfoilfoam/pipeline.py": driver.file_record(root / "src/airfoilfoam/pipeline.py"),
    }


@pytest.mark.parametrize("change", ("edit", "add", "remove", "metadata"))
def test_source_identity_rejects_engine_byte_changes_at_the_same_revision(pinned_engine_sources, change):
    root = pinned_engine_sources
    driver.source_identity(root)
    engine_file = root / "src/airfoilfoam/pipeline.py"
    if change == "edit":
        engine_file.write_bytes(b"changed engine source\n")
    elif change == "add":
        engine_file.with_name("new.py").write_bytes(b"new engine source\n")
    elif change == "remove":
        engine_file.unlink()
    else:
        (root / "pyproject.toml").write_text('[project]\nname = "changed"\n')

    with pytest.raises(RuntimeError, match="Expected engine source SHA-256"):
        driver.source_identity(root)


def test_candidate_request_preserves_exact_physics_and_bounds_steady_diagnostic(representative_source_request):
    source, _ = driver.load_authenticated_source(representative_source_request)

    request, overrides = driver.build_steady_request(source)

    driver.verify_request_preservation(source, request)
    assert request.aoa.expand() == [-5.0, 0.0]
    assert request.solver.flow_solver_family == "simpleFoam"
    assert request.solver.force_transient is False
    assert request.solver.transient_fallback is False
    assert request.solver.n_iterations == 3000
    assert request.solver.convergence_tolerance == pytest.approx(1e-5)
    assert request.solver.turbulence.model.value == source["solver"]["turbulence"]["model"]
    assert request.resources.case_solver_budget_seconds == 900.0
    assert request.resources.solver_processes == 1
    assert overrides == sorted(overrides)


def test_source_request_authentication_rejects_changed_bytes(representative_source_request):
    representative_source_request.write_bytes(representative_source_request.read_bytes() + b"\n")

    with pytest.raises(ValueError, match="Retained FX61147 source request changed"):
        driver.load_authenticated_source(representative_source_request)


@pytest.fixture
def accepted_steady_point():
    return SimpleNamespace(
        error=None,
        failure_disposition=SimpleNamespace(value="none"),
        method_key="openfoam.rans",
        fidelity="rans",
        unsteady=False,
        converged=True,
        cl=0.4,
        cd=0.02,
        cm=-0.03,
        rans_hold_certificate=SimpleNamespace(certified=True),
        solver_budget=SimpleNamespace(exhausted=False),
        quality_warnings=[],
    )


def test_steady_acceptance_requires_a_real_rans_hold_and_finite_coefficients(accepted_steady_point):
    accepted = accepted_steady_point
    assert driver.point_is_accepted(accepted)

    for update in (
        {"failure_disposition": SimpleNamespace(value="hard_solver")},
        {"method_key": "openfoam.urans"},
        {"fidelity": "urans"},
        {"unsteady": True},
        {"converged": False},
        {"rans_hold_certificate": None},
        {"rans_hold_certificate": SimpleNamespace(certified=False)},
        {"cl": float("nan")},
        {"cd": float("inf")},
        {"cm": float("nan")},
        {"cl": True},
        {"solver_budget": None},
        {"solver_budget": SimpleNamespace(exhausted=True)},
        {"error": "CommandTimeoutError: bounded timeout"},
        {"quality_warnings": ["Steady RANS STALLED; needs URANS"]},
    ):
        candidate = SimpleNamespace(**accepted.__dict__)
        candidate.__dict__.update(update)
        assert not driver.point_is_accepted(candidate)


def test_exact_mesh_extraction_rejects_path_traversal_and_links(tmp_path, monkeypatch):
    archive_path = tmp_path / "unsafe.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        payload = b"bad"
        info = tarfile.TarInfo("constant/polyMesh/../../escape")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))

    monkeypatch.setattr(driver, "EXACT_MESH_SHA256", driver.sha256_file(archive_path))
    with pytest.raises(ValueError, match="unsafe path"):
        driver.extract_exact_mesh(archive_path, tmp_path / "extract")


def test_generated_mesh_members_must_match_authenticated_hashes(tmp_path):
    mesh_root = tmp_path / "generated"
    member = mesh_root / "constant/polyMesh/points"
    member.parent.mkdir(parents=True)
    member.write_bytes(b"points")
    authenticated = {"constant/polyMesh/points": driver.file_record(member)}

    result = driver.verify_mesh_member_hashes(mesh_root, authenticated)

    assert result["matched"] is True
    assert result["members"]["constant/polyMesh/points"]["generated"] == authenticated["constant/polyMesh/points"]

    member.write_bytes(b"changed")
    with pytest.raises(RuntimeError, match="hashes differ"):
        driver.verify_mesh_member_hashes(mesh_root, authenticated)


def test_mesh_evidence_requires_real_blockmesh_and_checkmesh_logs(tmp_path):
    evidence = tmp_path / "mesh-evidence"
    logs = evidence / "logs"
    logs.mkdir(parents=True)
    block_mesh = logs / "log.blockMesh"
    check_mesh = logs / "log.checkMesh"
    block_mesh.write_text("real blockMesh output\n")
    check_mesh.write_text("cells: 30400\n")
    artifacts = {
        "blockMeshLog": {
            "path": "logs/log.blockMesh",
            "byteSize": block_mesh.stat().st_size,
            "sha256": driver.sha256_file(block_mesh),
        },
        "checkMeshLog": {
            "path": "logs/log.checkMesh",
            "byteSize": check_mesh.stat().st_size,
            "sha256": driver.sha256_file(check_mesh),
        },
    }
    manifest = evidence / "manifest.json"
    manifest.write_text(json.dumps({"artifacts": artifacts}) + "\n")
    (evidence / "manifest.sha256").write_text(f"{driver.sha256_file(manifest)}  manifest.json\n")

    report = driver.check_generated_mesh_evidence(tmp_path)

    assert report["artifacts"]["blockMeshLog"]["sha256"] == driver.sha256_file(block_mesh)
    block_mesh.unlink()
    with pytest.raises(RuntimeError, match="blockMeshLog"):
        driver.check_generated_mesh_evidence(tmp_path)


@pytest.fixture
def exact_job_mesh(tmp_path):
    job_root = tmp_path / "jobs/current"
    mesh_root = job_root / "meshes/c0p05/recipe-exact"
    boundary = mesh_root / "constant/polyMesh/boundary"
    boundary.parent.mkdir(parents=True)
    boundary.write_bytes(b"authenticated boundary\n")
    (mesh_root / "log.checkMesh").write_text("Mesh stats\n    cells:            30400\n")
    block_log = mesh_root / "mesh-evidence/logs/log.blockMesh"
    block_log.parent.mkdir(parents=True)
    block_log.write_text("real blockMesh output\n")
    return job_root, mesh_root, driver.file_record(boundary)


def test_mesh_parser_uses_current_job_mesh_and_padded_cells_field(exact_job_mesh):
    job_root, mesh_root, boundary = exact_job_mesh
    archived_logs = (
        mesh_root / "mesh-evidence/logs/log.checkMesh",
        job_root / "cases/c0p05_u30_am5/log.checkMesh",
        job_root / "cases/c0p05_u30_a0/evidence/openfoam/mesh_evidence/logs/log.checkMesh",
        job_root.parent / "previous/meshes/c0p05/recipe-exact/log.checkMesh",
    )
    for path in archived_logs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("cells:            99999\n")

    report = driver.check_mesh_evidence(job_root, boundary)

    assert report["cells_line"] == "cells:            30400"
    assert report["checkMesh_log"] == driver.file_record(mesh_root / "log.checkMesh")
    assert report["blockMesh_log"] == driver.file_record(mesh_root / "mesh-evidence/logs/log.blockMesh")
    assert report["boundary"] == boundary


def test_mesh_parser_rejects_multiple_live_job_mesh_logs(exact_job_mesh):
    job_root, mesh_root, boundary = exact_job_mesh
    other_log = mesh_root.parent / "recipe-other/log.checkMesh"
    other_log.parent.mkdir()
    other_log.write_text("cells:            30400\n")

    with pytest.raises(RuntimeError, match="Expected one exact-mesh checkMesh log, found 2"):
        driver.check_mesh_evidence(job_root, boundary)


def test_mesh_parser_cannot_substitute_archived_checkmesh_log(exact_job_mesh):
    job_root, mesh_root, boundary = exact_job_mesh
    live_log = mesh_root / "log.checkMesh"
    (mesh_root / "mesh-evidence/logs/log.checkMesh").write_bytes(live_log.read_bytes())
    live_log.unlink()

    with pytest.raises(RuntimeError, match="Expected one exact-mesh checkMesh log, found 0"):
        driver.check_mesh_evidence(job_root, boundary)


@pytest.mark.parametrize("cells_line", ("", "    cells:            30399", "cells: 0"))
def test_mesh_parser_rejects_missing_or_wrong_cell_count(exact_job_mesh, cells_line):
    job_root, mesh_root, boundary = exact_job_mesh
    (mesh_root / "log.checkMesh").write_text("Mesh stats\n" + cells_line + "\n")

    with pytest.raises(RuntimeError, match="Exact mesh checkMesh cell count was not 30400"):
        driver.check_mesh_evidence(job_root, boundary)


def test_mesh_parser_rejects_boundary_changes(exact_job_mesh):
    job_root, mesh_root, boundary = exact_job_mesh
    (mesh_root / "constant/polyMesh/boundary").write_bytes(b"different boundary\n")

    with pytest.raises(RuntimeError, match="Candidate mesh boundary differs"):
        driver.check_mesh_evidence(job_root, boundary)


@pytest.mark.parametrize(
    ("present_angles", "expected_status", "missing_angles"),
    (
        ((), "inconclusive", [-5.0, 0.0]),
        ((-5.0,), "inconclusive", [0.0]),
        ((0.0,), "inconclusive", [-5.0]),
        ((-5.0, 0.0), "accepted", []),
    ),
)
def test_result_summary_requires_evidence_for_every_requested_angle(
    accepted_steady_point, present_angles, expected_status, missing_angles
):
    points = [
        SimpleNamespace(
            **accepted_steady_point.__dict__,
            aoa_deg=angle,
            model_dump=lambda mode, angle=angle: {
                "aoa_deg": angle,
                "failure_disposition": "none",
                "quality_warnings": [],
            },
        )
        for angle in present_angles
    ]
    result = SimpleNamespace(
        polars=[SimpleNamespace(points=points, attempts=[])],
        state=SimpleNamespace(value="completed"),
    )

    summary = driver.summarize_result(result, (-5.0, 0.0))

    assert summary["status"] == expected_status
    assert summary["accepted_angles"] == list(present_angles)
    assert summary["rejected_angles"] == []
    assert summary["inconclusive_angles"] == missing_angles
    assert [point["aoa_deg"] for point in summary["points"]] == list(present_angles)


@pytest.mark.parametrize("requested_angles", ((-5.0,), (-5.0, 0.0)))
@pytest.mark.parametrize("rejection", ("hard_solver", "stalled"))
@pytest.mark.parametrize("collection", ("points", "attempts"))
def test_result_summary_retains_rejected_evidence_without_accepting_it(rejection, collection, requested_angles):
    stalled = rejection == "stalled"
    error = None if stalled else "steady RANS did not converge"
    failure_disposition = "none" if stalled else "hard_solver"
    warnings = ["steady RANS stalled"] if stalled else ["steady RANS did not converge"]
    point = SimpleNamespace(
        aoa_deg=-5.0,
        error=error,
        failure_disposition=SimpleNamespace(value=failure_disposition),
        method_key="openfoam.rans",
        fidelity="rans",
        unsteady=False,
        converged=stalled,
        cl=0.1,
        cd=0.03,
        cm=-0.01,
        rans_hold_certificate=SimpleNamespace(certified=True) if stalled else None,
        solver_budget=SimpleNamespace(exhausted=False),
        quality_warnings=warnings,
        model_dump=lambda mode: {
            "aoa_deg": -5.0,
            "error": error,
            "failure_disposition": failure_disposition,
            "quality_warnings": warnings,
        },
    )
    result = SimpleNamespace(
        polars=[
            SimpleNamespace(
                points=[point] if collection == "points" else [],
                attempts=[point] if collection == "attempts" else [],
            )
        ],
        state=SimpleNamespace(value="completed"),
    )

    summary = driver.summarize_result(result, requested_angles)

    assert summary["status"] == ("inconclusive" if 0.0 in requested_angles else "rejected")
    assert summary["accepted_angles"] == []
    assert summary["rejected_angles"] == [-5.0]
    assert summary["inconclusive_angles"] == ([0.0] if 0.0 in requested_angles else [])
    assert len(summary["points"]) == 1
    assert summary["points"][0]["collection"] == collection
    assert summary["points"][0]["quality_warnings"] == warnings
    assert summary["points"][0]["native_steady_accepted"] is False
