"""Regression pins for the 2026-07-07 ladder-gate stage-1 failure.

Prod incident (campaign a1802299 ladder-gate-20260707, engine job a2379532,
naca-0012 alpha=15 / 25 m/s / 0.1 m): the single steady RANS point ran 600
iterations, produced real force data (cl=0.5174, cd=0.1032) with an honest
oscillating-steady rejection ("Cl half-window means differ by 29.8%"), yet the
job shipped ``points: []`` and FAILED with "All cases failed" — so the node
side could never escalate. Two engine defects are pinned here:

1. A steady case with real force data must NEVER fail (or vanish from the
   polar) for non-convergence: RANS-tier non-converged, non-oscillating
   outcomes ship the honest point — converged=false, final-window
   coefficients, steady_history attached, loud quality note. Case failure is
   reserved for true crashes (no coefficient data at all).
2. The worker-side ``rans_max_iterations`` cap (default 600) must be scoped to
   URANS-init steady stages: a PRIMARY steady RANS solve honors the profile's
   ``n_iterations`` (the gate job's profile shipped 3000 but controlDict got
   endTime=600).

Fixtures are shaped like the real breakage (600-iteration post-stall SIMPLE
force history with a drifting mean), not like the detector's implementation.
No OpenFOAM needed.
"""
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import pipeline
from airfoilfoam.models import (
    CaseSpec,
    FluidProperties,
    MeshParams,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    _finalize_outcome,
    _steady_rans_params,
    solve_polar_marched,
    steady_outcome_shippable,
)
from airfoilfoam.postprocess.forces import force_is_steady, parse_force_coefficients

HEADER = "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"


def _write_post_stall_600(path: Path) -> None:
    """600-iteration post-stall steady history shaped like the gate failure:
    the Cl mean is still sliding down (separated-flow SIMPLE never settles)
    with a shedding-frequency ripple on top — half-window means differ by
    ~20-30%, so the oscillating-steady detector honestly rejects it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    for i in range(1, 601):
        cl = 0.95 - 0.45 * i / 600.0 + 0.06 * math.sin(2 * math.pi * i / 41.0)
        cd = 0.16 - 0.06 * i / 600.0 + 0.01 * math.sin(2 * math.pi * i / 41.0 + 0.7)
        lines.append(f"{i} {cd:.8g} 0 0 {cl:.8g} 0 0 -0.05 0 0 0 0 0")
    path.write_text("\n".join(lines) + "\n")


def _case_coeff_path(case_dir: Path) -> Path:
    return case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


RANS_TIER = dict(transient_fallback=False, force_transient=False, write_images=[])


def _finalize_rans_tier(case_dir, monkeypatch, solver_params=None):
    monkeypatch.setattr(
        pipeline,
        "_run_transient",
        lambda *a, **k: pytest.fail("RANS-tier case must never run the URANS transient"),
    )
    outcome = CaseOutcome(spec=CaseSpec(chord=0.1, speed=25.0, aoa_deg=15.0), reynolds=171_000)
    _finalize_outcome(
        case_dir,
        outcome,
        airfoil=SimpleNamespace(name="naca-0012", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.46e-5),
        roughness=RoughnessParams(),
        solver_params=solver_params or SolverParams(**RANS_TIER),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    return outcome


# --------------------------------------------------------------------------- #
# 1. Non-converged, non-oscillating RANS-tier steady: point ships, never raises
# --------------------------------------------------------------------------- #


def test_nonconverged_nonoscillating_rans_tier_ships_point_never_raises(tmp_path, monkeypatch):
    """MUST-CATCH (gate incident class): _finalize_outcome on a RANS-tier
    600-iteration post-stall case completes WITHOUT raising and leaves an
    honest, ingestable outcome."""
    case_dir = tmp_path / "case"
    _write_post_stall_600(_case_coeff_path(case_dir))
    assert not force_is_steady(_case_coeff_path(case_dir))  # genuinely unconverged

    outcome = _finalize_rans_tier(case_dir, monkeypatch)

    assert outcome.error is None
    assert not outcome.converged
    assert outcome.fidelity == "rans"
    # Final-window coefficients (parse_force_coefficients tail average — the
    # pre-ladder convention the prod attempt's cl=0.5174/cd=0.1032 came from).
    ref = parse_force_coefficients(_case_coeff_path(case_dir))
    assert outcome.cl == pytest.approx(ref.cl)
    assert outcome.cd == pytest.approx(ref.cd)
    assert outcome.cm == pytest.approx(ref.cm)
    # steady_history evidence ships with the honest rejection verdict.
    sh = outcome.steady_history
    assert sh is not None
    assert not sh.mean_stable
    assert "differ" in sh.note
    assert len(sh.iterations) == 600
    # Loud honest note on the point itself.
    assert any("did not converge" in w for w in outcome.quality_warnings)
    assert any(sh.note in w for w in outcome.quality_warnings)


def test_oscillating_accepted_rans_tier_gets_no_nonconvergence_note(tmp_path, monkeypatch):
    """False-positive guard: a bounded oscillation with a stable mean is still
    ACCEPTED (converged=true, window average) on the RANS tier — no
    'did not converge' note."""
    case_dir = tmp_path / "case"
    coeff = _case_coeff_path(case_dir)
    coeff.parent.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    for i in range(1, 1201):
        cl = 1.1 + 0.4 * math.exp(-i / 150.0) + 0.05 * math.sin(2 * math.pi * i / 37.0)
        cd = 0.045 + 0.02 * math.exp(-i / 150.0) + 0.004 * math.sin(2 * math.pi * i / 37.0 + 1.0)
        lines.append(f"{i} {cd:.8g} 0 0 {cl:.8g} 0 0 -0.02 0 0 0 0 0")
    coeff.write_text("\n".join(lines) + "\n")

    outcome = _finalize_rans_tier(case_dir, monkeypatch)

    assert outcome.converged
    assert outcome.steady_history is not None and outcome.steady_history.mean_stable
    assert not any("did not converge" in w for w in outcome.quality_warnings)


def test_true_crash_no_coefficient_data_still_fails_case(tmp_path, monkeypatch):
    """A steady case with NO coefficient data at all is a true crash and still
    raises (the marched loop converts it into an evidence-only attempt)."""
    from airfoilfoam.openfoam.runner import OpenFOAMError

    case_dir = tmp_path / "case"
    case_dir.mkdir()

    with pytest.raises(OpenFOAMError, match="no coefficient.dat"):
        _finalize_rans_tier(case_dir, monkeypatch)


def test_steady_outcome_shippable_classification():
    spec = CaseSpec(chord=0.1, speed=25.0, aoa_deg=15.0)
    ok = CaseOutcome(spec=spec, reynolds=1.0, cl=0.5174, cd=0.1032)
    assert steady_outcome_shippable(ok)
    assert not steady_outcome_shippable(
        CaseOutcome(spec=spec, reynolds=1.0, cl=0.5, cd=0.1, error="OpenFOAMError: boom")
    )
    assert not steady_outcome_shippable(CaseOutcome(spec=spec, reynolds=1.0))
    assert not steady_outcome_shippable(
        CaseOutcome(spec=spec, reynolds=1.0, cl=float("nan"), cd=0.1)
    )


# --------------------------------------------------------------------------- #
# 2. Gate-shaped end-to-end pin: single-point marched polar ships the point
# --------------------------------------------------------------------------- #


def test_gate_shaped_single_point_marched_polar_ships_honest_point(tmp_path, monkeypatch):
    """MUST-CATCH regression pin shaped like job a2379532: ONE marched steady
    point at alpha=15 that runs 600 iterations without converging (real
    coefficient.dat, REAL _finalize_outcome) must ship as an honest point —
    not points=[] ('All cases failed')."""

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True
        # No 'SIMPLE solution converged' line: parse_convergence stays False.
        stdout = "simpleFoam banner\n" + "".join(f"Time = {i}\n" for i in range(1, 601))

        def check(self):
            return self

    polar_dir = tmp_path / "polar"

    def fake_cold(*_args, **_kwargs):
        _write_post_stall_600(_case_coeff_path(polar_dir))
        return FakeRunResult()

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(
        pipeline,
        "_run_transient",
        lambda *a, **k: pytest.fail("RANS-tier marched point must not run the transient"),
    )

    result = solve_polar_marched(
        polar_dir,
        tmp_path / "mesh",
        airfoil=SimpleNamespace(name="naca-0012", contour=[]),
        chord=0.1,
        speed=25.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.46e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(**RANS_TIER),
        mesher=FakeMesher(),
        runner=_FakeRunner(),
        aoas=[15.0],
        render_images=False,
        rans_max_iterations=600,
    )

    assert not result.promoted_to_urans
    assert len(result.points) == 1  # the job-level 'All cases failed' class is gone
    point = result.points[0].outcome
    assert point.error is None
    assert not point.converged
    assert point.iterations == 600
    assert point.cl is not None and point.cd is not None
    assert point.steady_history is not None
    assert not point.steady_history.mean_stable
    assert any("did not converge" in w for w in point.quality_warnings)
    assert len(result.attempts) == 1  # evidence record kept alongside


# --------------------------------------------------------------------------- #
# 3. rans_max_iterations scoping: primary RANS uncapped, URANS-init capped
# --------------------------------------------------------------------------- #


def test_primary_steady_rans_honors_profile_iterations():
    """MUST-CATCH (gate incident: controlDict endTime 600 vs profile 3000):
    the worker cap must NOT touch a primary steady RANS solve."""
    profile = SolverParams(n_iterations=3000, transient_fallback=False, force_transient=False)
    assert _steady_rans_params(profile, 600).n_iterations == 3000
    assert _steady_rans_params(profile, None).n_iterations == 3000


def test_urans_init_steady_stays_capped():
    urans = SolverParams(n_iterations=3000, transient_fallback=True, force_transient=True)
    assert _steady_rans_params(urans, 600).n_iterations == 600
    # Floor and no-op paths unchanged for the URANS-init stage.
    assert _steady_rans_params(urans, 10).n_iterations == 50
    assert _steady_rans_params(SolverParams(n_iterations=400, force_transient=True,
                                            transient_fallback=True), 600).n_iterations == 400
    assert _steady_rans_params(urans, None).n_iterations == 3000


def test_steady_controldict_endtime_follows_uncapped_profile(tmp_path):
    """The 600 in prod came from CaseBuilder writing endTime=n_iterations off
    the capped params (case/builder.py). With the cap scoped away from primary
    RANS, run_case's steady params keep the full profile budget end to end."""
    from airfoilfoam.case.builder import CaseBuilder  # noqa: F401 (import guards the path)

    profile = SolverParams(n_iterations=3000, transient_fallback=False, force_transient=False)
    steady = _steady_rans_params(profile, 600)
    assert steady.n_iterations == 3000  # -> controlDict endTime 3000
