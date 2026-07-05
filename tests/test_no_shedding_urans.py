"""No-shedding URANS resolution (production failure validation-campaign-20260705).

Near-zero-lift cases (symmetric airfoils at alpha~0, or weakly-loaded points)
whose steady RANS does not converge are legitimately escalated to URANS. But at
alpha~0 there is essentially no vortex shedding, so the transient force history
is flat. The degenerate paths seen in production were:

  (a) FileExistsError copying the refined transient case when the retained
      start_time resolved to 0.0 (auto-refining a non-shedding case).
  (b) OpenFOAMError "URANS transient produced no coefficient.dat" (naca-0012
      alpha=0) — no periodic shedding to analyze.

The proper fix: detect no-shedding from the fluctuation amplitude BEFORE
auto-refine, skip refinement, and return a VALID steady-equivalent result whose
mean cl/cd/cm are the time-average of the transient window. Only genuinely
absent force data is an honest failure.
"""
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.models import CaseSpec, FluidProperties, RoughnessParams, SolverParams
from airfoilfoam.postprocess.unsteady import ForceHistory, is_no_shedding
from airfoilfoam import pipeline
from airfoilfoam.pipeline import (
    CaseOutcome,
    _run_transient_attempt,
    evaluate_urans_quality,
)


def _flat_history(cl_mean, cd_mean, *, t0=0.0, t1=1.0, n=400, noise_rms=0.0):
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    return ForceHistory(
        t=ts,
        cl=[cl_mean] * n,
        cd=[cd_mean] * n,
        cm=[0.0] * n,
        cl_mean=cl_mean,
        cl_rms=noise_rms,
        cd_mean=cd_mean,
        cd_rms=noise_rms,
        cm_mean=0.0,
        cm_rms=0.0,
        shedding_freq_hz=0.0,
        strouhal=0.0,
        samples=n,
        period_s=None,
        retained_cycles=None,
        window_start=t0,
        window_end=t1,
    )


def _shedding_history(cl_mean, cd_mean, cl_rms, cd_rms, st=0.2, *, t0=0.0, t1=1.0, n=400):
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    return ForceHistory(
        t=ts,
        cl=[cl_mean] * n,
        cd=[cd_mean] * n,
        cm=[0.0] * n,
        cl_mean=cl_mean,
        cl_rms=cl_rms,
        cd_mean=cd_mean,
        cd_rms=cd_rms,
        cm_mean=0.0,
        cm_rms=0.0,
        shedding_freq_hz=st * 10.0,
        strouhal=st,
        samples=n,
        period_s=1.0 / (st * 10.0),
        retained_cycles=7,
        window_start=t0,
        window_end=t1,
    )


# --- detector -------------------------------------------------------------


def test_flat_lift_signal_is_no_shedding():
    # naca-0012 alpha=0 class: cl~0, cd small, no oscillation.
    assert is_no_shedding(_flat_history(cl_mean=0.0006, cd_mean=0.012))
    # Loaded but perfectly steady also counts as no-shedding.
    assert is_no_shedding(_flat_history(cl_mean=0.7, cd_mean=0.3))
    # Small numerical noise still classifies as steady.
    assert is_no_shedding(_flat_history(cl_mean=0.7, cd_mean=0.3, noise_rms=1e-4))


def test_periodic_signal_is_not_no_shedding():
    # A genuine post-stall shedding history has a real oscillation amplitude.
    assert not is_no_shedding(_shedding_history(cl_mean=0.9, cd_mean=0.2, cl_rms=0.08, cd_rms=0.02))


def test_absent_history_is_not_no_shedding():
    # No force data at all is NOT no-shedding: it is an honest failure, and
    # there is nothing to average.
    assert not is_no_shedding(None)


# --- decision routes through evaluate_urans_quality -----------------------


def test_no_shedding_takes_steady_mean_path_not_refine(tmp_path):
    hist = _flat_history(cl_mean=0.0006, cd_mean=0.012)

    quality = evaluate_urans_quality(tmp_path, hist, speed=10.0, chord=1.0)

    # Valid steady-equivalent, and explicitly NOT refinable (auto-refining a
    # non-shedding case is what triggered the degenerate refined-copy crash).
    assert quality.ok
    assert quality.no_shedding
    assert not quality.can_refine
    assert quality.measured_period_s is None
    assert "no vortex shedding" in quality.reason


def test_shedding_history_takes_normal_path(tmp_path):
    # 8 s history, period 0.5 s -> 16 cycles; sparse frames -> refinable.
    hist = _shedding_history(cl_mean=0.9, cd_mean=0.2, cl_rms=0.08, cd_rms=0.02, st=0.05, t0=0.0, t1=8.0)
    for t in (0.0, 4.0, 8.0):
        (tmp_path / f"{t:.12g}").mkdir(parents=True, exist_ok=True)

    quality = evaluate_urans_quality(tmp_path, hist, speed=10.0, chord=1.0)

    assert not quality.no_shedding
    assert quality.measured_period_s is not None


def test_missing_history_is_honest_clean_failure(tmp_path):
    quality = evaluate_urans_quality(tmp_path, None, speed=10.0, chord=1.0)

    assert not quality.ok
    assert not quality.can_refine
    assert not quality.no_shedding
    assert "could not be measured" in quality.reason


# --- mean equals the average of the provided steady history ---------------


class _FakeCaseBuilder:
    def __init__(self, *_args, **_kwargs):
        pass

    def write_transient(self, *_args, **_kwargs):
        pass


def _write_flat_coeff(path: Path, cl: float, cd: float, cm: float, n: int = 60):
    rows = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        t = 0.01 * (i + 1)
        rows.append(f"{t:.4f} {cd:.6g} 0 0 {cl:.6g} 0 0 {cm:.6g} 0 0 0 0 0")
    path.write_text("\n".join(rows) + "\n")


def test_no_shedding_mean_equals_average_of_steady_history(tmp_path, monkeypatch):
    cl_true, cd_true, cm_true = 0.0009, 0.0121, -0.0004

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)
            _write_flat_coeff(coeff, cl_true, cd_true, cm_true)
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", _FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=0.6,
        delta_t=0.001,
    )

    # No crash, and a valid steady-equivalent result.
    assert result is not None
    assert result.quality.ok
    assert result.quality.no_shedding
    assert not result.quality.can_refine
    # Mean coefficients equal the (constant) steady history values.
    assert result.avg.cl == pytest.approx(cl_true, abs=1e-9)
    assert result.avg.cd == pytest.approx(cd_true, abs=1e-9)
    assert result.avg.cm == pytest.approx(cm_true, abs=1e-9)


def test_no_shedding_finalize_recovers_naca0012_alpha0_as_steady(tmp_path, monkeypatch):
    """naca-0012 alpha=0 class: escalated to URANS, no shedding -> recovered as a
    valid CONVERGED STEADY point (unsteady=false), never a crash."""
    from airfoilfoam.models import MeshParams
    from airfoilfoam.pipeline import TransientResult, UransQuality
    from airfoilfoam.postprocess.forces import AveragedCoefficients

    cl_true, cd_true, cm_true = 0.0006, 0.0118, -0.0002
    hist = _flat_history(cl_mean=cl_true, cd_mean=cd_true)
    avg = AveragedCoefficients(
        cl=cl_true, cd=cd_true, cm=cm_true, cl_std=0.0, cd_std=0.0, cm_std=0.0, samples=hist.samples
    )

    def fake_transient(case_dir, *_args, **_kwargs):
        return TransientResult(
            avg=avg,
            case_dir=case_dir,
            force_history=hist,
            quality=UransQuality(
                ok=True,
                can_refine=False,
                no_shedding=True,
                reason="URANS steady (no vortex shedding): time-averaged coefficients are the physical answer.",
            ),
            start_time=0.0,
            end_time=1.0,
            run_time=1.0,
        )

    class FakeRunner:
        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, check=lambda: None)

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0), reynolds=666_666)

    pipeline._finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="naca-0012", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, write_images=[]),
        runner=FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )

    # Recovered as a valid point, and marked steady (not unsteady).
    assert outcome.converged
    assert not outcome.unsteady
    assert outcome.cl == pytest.approx(cl_true)
    assert outcome.cd == pytest.approx(cd_true)
    # A non-shedding case has no meaningful Strouhal to report.
    assert outcome.strouhal is None
