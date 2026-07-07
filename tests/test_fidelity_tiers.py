"""URANS fidelity tiers (task #30, contract item 1) — pinned cross-runtime.

Pins the tier constants the node build-request relies on (precalc: 3 periods /
7200 s budget / half-resolution derived mesh; full: 7 periods / 43200 s /
full mesh — budgets retuned 2026-07-07 to measured prod rates: ~14 min/period
half-res, ~2 h/period full mesh at the worst campaign class c/U = 0.1/25), the PolarPoint.fidelity echo ("rans" | "urans_precalc" |
"urans_full"), the derived-mesh cache-key separation, and the wiring: the
transient stage must receive the tier budget + period target, and precalc
URANS jobs must BUILD the derived mesh. No OpenFOAM needed.
"""
import json
from types import SimpleNamespace

import pytest

from airfoilfoam import jobs, pipeline
from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.cache import EngineCache
from airfoilfoam.config import get_settings
from airfoilfoam.jobs import _outcome_to_point
from airfoilfoam.models import (
    URANS_FIDELITY_BUDGET_S,
    URANS_FIDELITY_MIN_PERIODS,
    URANS_PRECALC_MESH_SCALE,
    AirfoilFormat,
    AirfoilInput,
    AoASpec,
    CaseSpec,
    FluidProperties,
    MeshParams,
    PolarPoint,
    PolarRequest,
    RoughnessParams,
    SolverParams,
    UransFidelity,
    apply_urans_fidelity,
    derive_precalc_mesh_params,
    effective_mesh_params,
    urans_budget_seconds,
    urans_point_fidelity,
)
from airfoilfoam.pipeline import CaseOutcome, TransientResult, UransQuality, _finalize_outcome
from airfoilfoam.storage import JobStore


# --------------------------------------------------------------------------- #
# Contract pin: tier constants + request/point field shapes
# --------------------------------------------------------------------------- #


def test_fidelity_tier_contract_pin():
    # Request knob: solver.urans_fidelity, default full (existing behaviour).
    assert SolverParams().urans_fidelity == UransFidelity.full
    assert SolverParams(urans_fidelity="precalc").urans_fidelity == UransFidelity.precalc
    with pytest.raises(ValueError):
        SolverParams(urans_fidelity="turbo")

    # Tier constants pinned by the node build-request.
    assert URANS_FIDELITY_MIN_PERIODS == {UransFidelity.precalc: 3, UransFidelity.full: 7}
    assert URANS_FIDELITY_BUDGET_S == {UransFidelity.precalc: 7200, UransFidelity.full: 43200}
    assert URANS_PRECALC_MESH_SCALE == 0.5

    # Effective per-tier resolution.
    assert apply_urans_fidelity(SolverParams(urans_fidelity="precalc")).urans_min_periods == 3
    assert apply_urans_fidelity(SolverParams()).urans_min_periods == 7
    assert urans_budget_seconds(SolverParams(urans_fidelity="precalc")) == 7200
    assert urans_budget_seconds(SolverParams()) == 43200

    # Point echo literals (node mirror parses exactly these).
    assert urans_point_fidelity(SolverParams(urans_fidelity="precalc")) == "urans_precalc"
    assert urans_point_fidelity(SolverParams()) == "urans_full"
    assert PolarPoint(aoa_deg=1.0).fidelity == "rans"
    assert json.loads(PolarPoint(aoa_deg=1.0).model_dump_json())["fidelity"] == "rans"
    with pytest.raises(ValueError):
        PolarPoint(aoa_deg=1.0, fidelity="urans_turbo")


# --------------------------------------------------------------------------- #
# Derived precalc mesh: halved counts, same y+, separate cache identity
# --------------------------------------------------------------------------- #


def test_precalc_mesh_derivation_halves_counts_same_yplus():
    full = MeshParams()  # 130 / 80 / 60
    derived = derive_precalc_mesh_params(full)
    assert (derived.n_surface, derived.n_radial, derived.n_wake) == (65, 40, 30)
    # Same wall treatment and domain extents — ONLY the resolution halves.
    assert derived.target_y_plus == full.target_y_plus
    assert derived.first_cell_height_chords == full.first_cell_height_chords
    assert derived.farfield_radius_chords == full.farfield_radius_chords
    assert derived.wake_length_chords == full.wake_length_chords
    assert derived.span_chords == full.span_chords

    # Field minimums are respected (never an invalid MeshParams).
    tiny = derive_precalc_mesh_params(MeshParams(n_surface=25, n_radial=21, n_wake=11))
    assert (tiny.n_surface, tiny.n_radial, tiny.n_wake) == (20, 20, 10)


def test_effective_mesh_params_only_derives_for_precalc_urans():
    mesh = MeshParams()
    rans = SolverParams(urans_fidelity="precalc")  # not force_transient
    full_urans = SolverParams(force_transient=True)
    precalc_urans = SolverParams(force_transient=True, urans_fidelity="precalc")
    assert effective_mesh_params(mesh, rans) == mesh
    assert effective_mesh_params(mesh, full_urans) == mesh
    assert effective_mesh_params(mesh, precalc_urans) == derive_precalc_mesh_params(mesh)


def test_precalc_mesh_caches_under_its_own_key(naca2412_points):
    airfoil = load_airfoil("n2412", None, naca2412_points, AirfoilFormat.auto)
    full = MeshParams(first_cell_height_chords=1e-5)
    derived = derive_precalc_mesh_params(full)
    assert EngineCache.mesh_key(airfoil, 1.0, full) != EngineCache.mesh_key(airfoil, 1.0, derived)
    # Deterministic: the same derivation re-keys identically (cache hits work).
    assert EngineCache.mesh_key(airfoil, 1.0, derived) == EngineCache.mesh_key(
        airfoil, 1.0, derive_precalc_mesh_params(full)
    )


# --------------------------------------------------------------------------- #
# Wiring: the transient stage gets the tier budget + period target
# --------------------------------------------------------------------------- #


def _finalize_force_transient(tmp_path, monkeypatch, solver_params, transient="none"):
    captured = {}

    def fake_run_transient(case_dir, airfoil, resolved, spec, fluid, roughness, sp,
                           runner, n_proc, timeout, **_kwargs):
        captured["solver_params"] = sp
        captured["timeout"] = timeout
        return None if transient == "none" else transient

    monkeypatch.setattr(pipeline, "_run_transient", fake_run_transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0), reynolds=666_666)

    def run():
        _finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
            resolved=MeshParams(),
            spec=outcome.spec,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            solver_params=solver_params,
            runner=SimpleNamespace(application=lambda *a, **k: SimpleNamespace(ok=True, check=lambda: None)),
            n_proc=1,
            render_images=False,
            solver_timeout=7200,
        )

    return outcome, captured, run


@pytest.mark.parametrize(
    "fidelity,budget,periods",
    [("precalc", 7200, 3), ("full", 43200, 7)],
)
def test_transient_stage_receives_tier_budget_and_period_target(
    tmp_path, monkeypatch, fidelity, budget, periods
):
    solver = SolverParams(force_transient=True, write_images=[], urans_fidelity=fidelity)
    outcome, captured, run = _finalize_force_transient(tmp_path, monkeypatch, solver)

    with pytest.raises(Exception, match="URANS transient produced no coefficient.dat"):
        run()

    assert captured["timeout"] == budget
    assert captured["solver_params"].urans_min_periods == periods
    # The tier must not silently mutate anything else on the profile.
    assert captured["solver_params"].transient_discard_fraction == solver.transient_discard_fraction
    assert captured["solver_params"].urans_drift_tolerance == solver.urans_drift_tolerance


@pytest.mark.parametrize("fidelity,echo", [("precalc", "urans_precalc"), ("full", "urans_full")])
def test_urans_point_echoes_tier_fidelity(tmp_path, monkeypatch, fidelity, echo):
    """A URANS-produced point (here the no-shedding steady-equivalent mean —
    still URANS-produced values) echoes the tier on PolarPoint.fidelity."""
    tcase = tmp_path / "transient"
    tcase.mkdir(parents=True, exist_ok=True)
    transient = TransientResult(
        avg=SimpleNamespace(cl=0.02, cd=0.011, cm=0.0, cl_cd=1.8, cl_std=0.0, cd_std=0.0, cm_std=0.0),
        case_dir=tcase,
        force_history=None,
        quality=UransQuality(ok=True, can_refine=False, no_shedding=True, reason="no vortex shedding"),
        start_time=0.0,
        end_time=1.0,
        run_time=1.0,
    )
    solver = SolverParams(force_transient=True, write_images=[], urans_fidelity=fidelity)
    outcome, _captured, run = _finalize_force_transient(
        tmp_path, monkeypatch, solver, transient=transient
    )
    run()

    assert outcome.converged
    assert outcome.fidelity == echo
    point = _outcome_to_point("job", "slug", outcome)
    assert json.loads(point.model_dump_json())["fidelity"] == echo


def test_steady_rans_point_echoes_rans_fidelity():
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=4.0), reynolds=666_666, converged=True
    )
    assert outcome.fidelity == "rans"
    assert json.loads(_outcome_to_point("job", "slug", outcome).model_dump_json())["fidelity"] == "rans"


# --------------------------------------------------------------------------- #
# Wiring: a precalc URANS JOB builds the derived half-resolution mesh
# --------------------------------------------------------------------------- #


def _run_job_capturing_mesh(monkeypatch, naca0012_selig_text, solver: SolverParams):
    captured = {}

    def fake_prepare_mesh(mesh_dir, airfoil, resolved, chord, mesher, runner, **_kwargs):
        captured["resolved"] = resolved
        mesh_dir.mkdir(parents=True, exist_ok=True)
        return SimpleNamespace(n_cells=1000, patches=[], span_chords=0.1)

    def fake_run_case(case_dir, airfoil, spec, fluid, roughness, mesh_params, solver_params,
                      mesher, runner, **_kwargs):
        captured.setdefault("case_mesh", mesh_params)
        return CaseOutcome(spec=spec, reynolds=1e6, cl=0.5, cd=0.01, cm=0.0, converged=True)

    monkeypatch.setattr(jobs, "prepare_mesh", fake_prepare_mesh)
    monkeypatch.setattr(jobs, "run_case", fake_run_case)

    request = PolarRequest(
        airfoil=AirfoilInput(name="n0012", coordinates=naca0012_selig_text),
        aoa=AoASpec(angles=[2.0]),
        solver=solver,
    )
    settings = get_settings()
    jobs.execute_job("fidelity-mesh-test", request, store=JobStore(settings), settings=settings)
    return captured


def test_precalc_urans_job_builds_derived_half_mesh(monkeypatch, naca0012_selig_text):
    captured = _run_job_capturing_mesh(
        monkeypatch,
        naca0012_selig_text,
        SolverParams(force_transient=True, urans_fidelity="precalc", write_images=[]),
    )
    resolved = captured["resolved"]
    assert (resolved.n_surface, resolved.n_radial, resolved.n_wake) == (65, 40, 30)
    assert resolved.target_y_plus == MeshParams().target_y_plus
    # run_case receives the derived params too (cache keys match the mesh built).
    assert (captured["case_mesh"].n_surface, captured["case_mesh"].n_radial) == (65, 40)


def test_full_urans_and_rans_jobs_build_the_full_mesh(monkeypatch, naca0012_selig_text):
    for solver in (
        SolverParams(force_transient=True, urans_fidelity="full", write_images=[]),
        SolverParams(write_images=[]),
    ):
        captured = _run_job_capturing_mesh(monkeypatch, naca0012_selig_text, solver)
        resolved = captured["resolved"]
        assert (resolved.n_surface, resolved.n_radial, resolved.n_wake) == (130, 80, 60)
