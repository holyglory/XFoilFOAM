"""Speed-resolved shared-mesh scheduling regressions.

The mesh cache already keys on resolved parameters.  These tests exercise the
job-level ownership map, which previously bypassed that safety by resolving a
whole multi-speed request at its largest speed and indexing prepared meshes by
chord alone.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import json

import pytest

from airfoilfoam import jobs, physics
from airfoilfoam.cancellation import JobCancelled
from airfoilfoam.config import Settings
from airfoilfoam.models import (
    AirfoilInput,
    AoASpec,
    CaseSpec,
    MeshParams,
    PolarRequest,
    ResourceParams,
    SolverParams,
)
from airfoilfoam.pipeline import CaseOutcome
from airfoilfoam.resources import CpuTokenPool as RealCpuTokenPool
from airfoilfoam.storage import JobStore


class _Mesher:
    def __init__(self, name="test-speed-resolved"):
        self.name = name
        self.cache_version = f"{name}-v1"


def _settings(tmp_path: Path, *, worker_cpu_budget: int = 1) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cpu_token_state_path=tmp_path / "cpu-tokens.json",
        worker_cpu_budget=worker_cpu_budget,
        case_concurrency=1,
        solver_processes=1,
    )


def _request(naca0012_selig_text: str, *, mesh: MeshParams) -> PolarRequest:
    return PolarRequest(
        airfoil=AirfoilInput(name="naca0012", coordinates=naca0012_selig_text),
        chord_lengths=[1.0],
        speeds=[30.0, 90.0],
        aoa=AoASpec(angles=[0.0, 2.0]),
        mesh=mesh,
        solver=SolverParams(write_images=[]),
        resources=ResourceParams(
            policy="case_parallel",
            cpu_budget=1,
            case_concurrency=1,
            solver_processes=1,
        ),
    )


def _wire_fake_engine(
    monkeypatch,
    prepared,
    solved,
    observed_progress=None,
    mesher_name="test-speed-resolved",
):
    mesher = _Mesher(mesher_name)

    def fake_prepare(mesh_dir, _airfoil, resolved, _chord, _mesher, _runner, **_kwargs):
        mesh_dir.mkdir(parents=True, exist_ok=True)
        prepared.append((mesh_dir, resolved))
        if observed_progress is not None:
            observed_progress.append(_runner.progress("budget-prep").cases)
        return SimpleNamespace(n_cells=321), resolved, False

    def fake_run_case(
        _case_dir,
        _airfoil,
        spec,
        fluid,
        _roughness,
        mesh_params,
        _solver_params,
        _mesher,
        _runner,
        *,
        mesh_dir=None,
        **_kwargs,
    ):
        solved.append((spec, mesh_params, mesh_dir))
        return CaseOutcome(
            spec=spec,
            reynolds=physics.reynolds(spec.speed, spec.chord, fluid.nu),
            cl=0.1,
            cd=0.02,
            cm=0.0,
            cl_cd=5.0,
            converged=True,
            n_cells=321,
        )

    monkeypatch.setattr(jobs, "get_mesher", lambda _name: mesher)
    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", fake_prepare)
    monkeypatch.setattr(jobs, "run_case", fake_run_case)


def test_budget_progress_covers_all_cases_before_shared_mesh_preparation(
    tmp_path, monkeypatch, naca0012_selig_text
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    observed_progress = []
    _wire_fake_engine(monkeypatch, prepared, solved, observed_progress)
    request = _request(naca0012_selig_text, mesh=MeshParams()).model_copy(
        update={
            "resources": ResourceParams(
                policy="case_parallel",
                cpu_budget=1,
                case_concurrency=1,
                solver_processes=1,
                case_solver_budget_seconds=900,
            ),
            "expected_solver_budget_version": 2,
        }
    )

    jobs.execute_job(
        "budget-heartbeat-before-mesh",
        request,
        store=JobStore(_settings(tmp_path)),
        settings=_settings(tmp_path),
    )

    assert len(observed_progress) == 2
    for cases in observed_progress:
        assert {(case.chord, case.speed, case.aoa_deg) for case in cases} == {
            (1.0, 30.0, 0.0),
            (1.0, 30.0, 2.0),
            (1.0, 90.0, 0.0),
            (1.0, 90.0, 2.0),
        }
        assert all(case.solver_active_seconds == 0.0 for case in cases)
        assert all(case.solver_running is False for case in cases)


def test_multi_speed_job_builds_one_mesh_per_distinct_speed_resolved_recipe(
    tmp_path, monkeypatch, naca0012_selig_text
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    _wire_fake_engine(monkeypatch, prepared, solved)
    request = _request(naca0012_selig_text, mesh=MeshParams())
    settings = _settings(tmp_path)

    result = jobs.execute_job(
        "speed-resolved-recipes",
        request,
        store=JobStore(settings),
        settings=settings,
    )

    assert result.scheduling is not None
    assert result.scheduling.mesh_build_count == 2
    assert len(prepared) == 2
    assert len({resolved.first_cell_height_chords for _, resolved in prepared}) == 2

    by_speed: dict[float, list[tuple[MeshParams, Path]]] = {}
    for spec, resolved, mesh_dir in solved:
        by_speed.setdefault(spec.speed, []).append((resolved, mesh_dir))
    assert set(by_speed) == {30.0, 90.0}
    # Every AoA at a physical cell receives the same exact shared mesh.
    assert all(len({item[1] for item in entries}) == 1 for entries in by_speed.values())
    assert all(len({item[0].first_cell_height_chords for item in entries}) == 1 for entries in by_speed.values())
    # Different speed-resolved recipes cannot inherit the same mesh directory.
    assert by_speed[30.0][0][1] != by_speed[90.0][0][1]
    assert (
        by_speed[30.0][0][0].first_cell_height_chords
        != by_speed[90.0][0][0].first_cell_height_chords
    )


def test_mesh_builds_reserve_the_bounded_mesh_budget(tmp_path, monkeypatch, naca0012_selig_text):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    _wire_fake_engine(monkeypatch, prepared, solved)
    requests: list[int] = []

    class _RecordingCpuTokenPool(RealCpuTokenPool):
        def acquire(self, tokens, *args, **kwargs):
            requests.append(tokens)
            return super().acquire(tokens, *args, **kwargs)

    monkeypatch.setattr(jobs, "CpuTokenPool", _RecordingCpuTokenPool)
    settings = _settings(tmp_path, worker_cpu_budget=4)
    settings.mesh_cpu_budget = 2

    jobs.execute_job(
        "full-mesh-budget",
        _request(naca0012_selig_text, mesh=MeshParams()),
        store=JobStore(settings),
        settings=settings,
    )

    assert requests[:2] == [2, 2]
    assert set(requests[2:]) == {1}


@pytest.mark.parametrize(
    "mesher_name",
    [
        "blockmesh-cgrid",
        "blockmesh-cgrid-finite-edge",
        "blockmesh-cgrid-segmented-normal-20",
        "blockmesh-cgrid-segmented-te-normal-20",
        "blockmesh-cgrid-segmented-camber-c150-a200-s5",
    ],
)
def test_blockmesh_variants_use_one_mesh_token_independent_of_global_mesh_budget(
    tmp_path, monkeypatch, naca0012_selig_text, mesher_name
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    requests: list[int] = []
    _wire_fake_engine(
        monkeypatch,
        prepared,
        solved,
        mesher_name=mesher_name,
    )

    class _RecordingCpuTokenPool(RealCpuTokenPool):
        def acquire(self, tokens, *args, **kwargs):
            requests.append(tokens)
            return super().acquire(tokens, *args, **kwargs)

    monkeypatch.setattr(jobs, "CpuTokenPool", _RecordingCpuTokenPool)
    settings = _settings(tmp_path, worker_cpu_budget=8)
    settings.mesh_cpu_budget = 8

    jobs.execute_job(
        f"serial-mesh-{mesher_name}",
        _request(naca0012_selig_text, mesh=MeshParams()),
        store=JobStore(settings),
        settings=settings,
    )

    assert requests[:2] == [1, 1]


def test_cartesian_mesh_keeps_explicit_thread_budget(
    tmp_path, monkeypatch, naca0012_selig_text
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    requests: list[int] = []
    _wire_fake_engine(
        monkeypatch,
        prepared,
        solved,
        mesher_name="cartesian2d-external-boundary-layer",
    )

    class _RecordingCpuTokenPool(RealCpuTokenPool):
        def acquire(self, tokens, *args, **kwargs):
            requests.append(tokens)
            return super().acquire(tokens, *args, **kwargs)

    monkeypatch.setattr(jobs, "CpuTokenPool", _RecordingCpuTokenPool)
    settings = _settings(tmp_path, worker_cpu_budget=8)
    settings.mesh_cpu_budget = 8

    jobs.execute_job(
        "cartesian-thread-budget",
        _request(naca0012_selig_text, mesh=MeshParams()),
        store=JobStore(settings),
        settings=settings,
    )

    assert requests[:2] == [8, 8]


@pytest.mark.parametrize("solver_processes", [1, 2])
def test_serial_mesh_coexists_with_one_busy_token(
    tmp_path, monkeypatch, naca0012_selig_text, solver_processes
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    statuses = []
    _wire_fake_engine(
        monkeypatch,
        prepared,
        solved,
        mesher_name="blockmesh-cgrid",
    )
    settings = _settings(tmp_path, worker_cpu_budget=8)
    request = _request(naca0012_selig_text, mesh=MeshParams()).model_copy(
        update={
            "resources": ResourceParams(
                policy="case_parallel",
                cpu_budget=solver_processes,
                case_concurrency=1,
                solver_processes=solver_processes,
            )
        }
    )
    busy = RealCpuTokenPool(settings.cpu_token_state_path, budget=8)

    with busy.acquire(1):
        result = jobs.execute_job(
            f"serial-mesh-busy-{solver_processes}",
            request,
            store=JobStore(settings),
            settings=settings,
            progress=lambda status: statuses.append(
                (status.phase, status.cpu_tokens_waiting, status.cpu_tokens_held)
            ),
        )

    assert result.state.value == "completed"
    assert any(waiting == 1 and held == 0 for _, waiting, held in statuses)
    assert any(held == 1 for _, _, held in statuses)
    assert json.loads(settings.cpu_token_state_path.read_text())["leases"] == []


@pytest.mark.parametrize(
    "failure",
    [RuntimeError("mesh failed"), JobCancelled("cancelled")],
)
def test_serial_mesh_releases_token_on_failure_or_cancel(
    tmp_path, monkeypatch, naca0012_selig_text, failure
):
    mesher = _Mesher("blockmesh-cgrid")
    monkeypatch.setattr(jobs, "get_mesher", lambda _name: mesher)

    def fail_prepare(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", fail_prepare)
    settings = _settings(tmp_path, worker_cpu_budget=8)

    with pytest.raises(type(failure)):
        jobs.execute_job(
            "serial-mesh-release",
            _request(naca0012_selig_text, mesh=MeshParams()),
            store=JobStore(settings),
            settings=settings,
        )

    assert json.loads(settings.cpu_token_state_path.read_text())["leases"] == []


def test_multi_speed_job_deduplicates_only_an_exactly_equal_resolved_recipe(
    tmp_path, monkeypatch, naca0012_selig_text
):
    prepared: list[tuple[Path, MeshParams]] = []
    solved: list[tuple[CaseSpec, MeshParams, Path]] = []
    _wire_fake_engine(monkeypatch, prepared, solved)
    # Explicit wall height makes the full resolved recipe identical for both
    # speeds. Sharing here is intentional and does not depend on list order.
    request = _request(
        naca0012_selig_text,
        mesh=MeshParams(first_cell_height_chords=0.002),
    )
    settings = _settings(tmp_path)

    result = jobs.execute_job(
        "equal-speed-recipes",
        request,
        store=JobStore(settings),
        settings=settings,
    )

    assert result.scheduling is not None
    assert result.scheduling.mesh_build_count == 1
    assert len(prepared) == 1
    assert {resolved.first_cell_height_chords for _, resolved in prepared} == {0.002}
    assert len({mesh_dir for _, _, mesh_dir in solved}) == 1
    assert {resolved.first_cell_height_chords for _, resolved, _ in solved} == {0.002}
