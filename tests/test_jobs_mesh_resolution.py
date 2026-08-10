"""Speed-resolved shared-mesh scheduling regressions.

The mesh cache already keys on resolved parameters.  These tests exercise the
job-level ownership map, which previously bypassed that safety by resolving a
whole multi-speed request at its largest speed and indexing prepared meshes by
chord alone.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import jobs, physics
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
from airfoilfoam.storage import JobStore


class _Mesher:
    name = "test-speed-resolved"
    cache_version = "test-speed-resolved-v1"


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cpu_token_state_path=tmp_path / "cpu-tokens.json",
        worker_cpu_budget=1,
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


def _wire_fake_engine(monkeypatch, prepared, solved):
    mesher = _Mesher()

    def fake_prepare(mesh_dir, _airfoil, resolved, _chord, _mesher, _runner, **_kwargs):
        mesh_dir.mkdir(parents=True, exist_ok=True)
        prepared.append((mesh_dir, resolved))
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
