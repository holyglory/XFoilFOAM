"""Precalc-tier established-oscillation stationarity + wave-1 escalation gate.

Two 2026-07-08 decisions pinned here:

1. User decision ("the solution should converge to a stable oscillation"):
   for the PRECALC fidelity tier the stationarity verdict is an
   ESTABLISHED-OSCILLATION test — per-cycle means with no monotonic trend
   (:func:`_cycle_mean_trend`), a stable period, and a bounded (non-growing)
   amplitude — instead of the strict 5% two-half mean-drift gate. A modulated
   limit cycle whose cycle means wander trendlessly (prod: drift_frac ~0.14
   points bounced forever) is an honest precalc point, DISCLOSED with the
   "cycle means scatter ±… (precalc)" quality warning. The FULL tier keeps
   the strict drift gate byte-identical ("verified" = converged mean).

2. Live incident (wave-1 sweep job 20b67295, s1223 -5 deg / 25 m/s / 1.0 m):
   campaign wave-1 jobs ship ``transient_fallback=false`` because the
   node-side ladder owns URANS escalation, yet a rejected steady point inside
   the 0-5 deg attached-range check promoted the WHOLE polar to an in-job
   URANS replacement — no tier fidelity/budget, full mesh — which diverged at
   startup and burned watchdog kills. The promotion must honor
   ``transient_fallback``.

Fixtures are shaped like the physics (relaxing startups, modulated limit
cycles, growing envelopes), not like the detector's implementation.
"""
import math
from types import SimpleNamespace

import numpy as np
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
    TransientResult,
    UransQuality,
    _finalize_outcome,
    solve_polar_marched,
)
from airfoilfoam.postprocess.unsteady import (
    ESTABLISHED_MIN_CYCLES,
    ForceHistory,
    _cycle_mean_trend,
    period_window_stats,
)

PERIOD = 0.5


def _stats(t, cl, period=PERIOD, **kwargs):
    return period_window_stats(
        t, cl, np.full_like(t, 0.05), np.full_like(t, -0.02), period, **kwargs
    )


# --------------------------------------------------------------------------- #
# Established-oscillation verdict: must-catch fixtures both directions
# --------------------------------------------------------------------------- #


def test_relaxing_startup_still_rejected_by_established_test():
    """MUST-CATCH: a startup transient still relaxing toward its attractor
    (exponentially decaying mean, the classic URANS spin-up shape) must NOT
    pass the precalc gate — its cycle means approach one-directionally."""
    t = np.linspace(0.0, 2.5, 2501)  # 5 whole periods
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD) + 0.15 * np.exp(-t / 1.2)

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert not stats.stationary
    assert "trend" in stats.stationary_reason
    # The strict gate agrees on this one (drift ~0.095) — same verdict, and
    # the new test rejects it for the RIGHT reason (monotone approach).
    assert stats.drift_frac > 0.05


def test_linear_ramp_rejected_with_near_zero_residual():
    """A perfectly collinear ramp (residual scatter ~ 0) is the strongest
    trend signature; the significance ratio must not divide by ~0 into a
    false accept."""
    t = np.linspace(0.0, 2.5, 2501)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD) + 0.15 * (t / t[-1])

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert not stats.stationary
    assert "monotonically" in stats.stationary_reason


def test_established_modulated_cycle_accepts_despite_mean_drift():
    """MUST-CATCH (the point of the change): an established limit cycle whose
    slow modulation makes the two half-window means differ by ~10% — the old
    5% gate bounced these forever — is stationary under the precalc test
    because its cycle means wander with NO monotonic trend."""
    t = np.linspace(0.0, 2.0, 2001)  # 4 whole periods
    cl = (
        0.7
        + 0.1 * np.sin(2 * np.pi * t / PERIOD)
        + 0.124 * np.sin(2 * np.pi * t / 2.0 + 0.9)  # slow wander, one window cycle
    )

    strict = _stats(t, cl)
    established = _stats(t, cl, established_oscillation=True)

    assert strict is not None and established is not None
    # The old gate genuinely rejects this signal (recall proof, not a mirror).
    assert strict.drift_frac > 0.05
    assert not strict.stationary
    # The established-oscillation gate accepts it, with the scatter measured.
    assert established.stationary
    assert "trendlessly" in established.stationary_reason
    assert established.cycle_mean_std > 0.05
    assert len(established.cycle_means) == established.whole_periods == 4
    diffs = np.diff(established.cycle_means)
    assert not (np.all(diffs > 0) or np.all(diffs < 0))  # honestly trendless


def test_clean_periodic_accepts_both_gates():
    t = np.linspace(0.0, 2.5, 2501)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD)

    strict = _stats(t, cl)
    established = _stats(t, cl, established_oscillation=True)

    assert strict is not None and strict.stationary
    assert established is not None and established.stationary


def test_growing_amplitude_rejected_even_with_trendless_means():
    """Bounded-amplitude guard: a symmetric growing envelope keeps its cycle
    MEANS flat (trendless) but is divergence in progress, not an established
    oscillation."""
    t = np.linspace(0.0, 2.5, 2501)
    cl = 0.7 + (0.05 + 0.10 * t / t[-1]) * np.sin(2 * np.pi * t / PERIOD)

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert not stats.stationary
    assert "amplitude growing" in stats.stationary_reason
    # The strict drift gate would have MISSED this (flat means, drift ~ 0).
    assert stats.drift_frac < 0.05


def test_unstable_period_rejected():
    t = np.linspace(0.0, 2.5, 2501)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD)

    stats = _stats(t, cl, established_oscillation=True, period_stable=False)

    assert stats is not None
    assert not stats.stationary
    assert "period unstable" in stats.stationary_reason


def test_fewer_than_three_cycles_cannot_certify_established_oscillation():
    t = np.linspace(0.0, 1.0, 1001)  # 2 whole periods
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD)

    established = _stats(t, cl, established_oscillation=True)
    strict = _stats(t, cl)

    assert established is not None
    assert not established.stationary
    assert f">= {ESTABLISHED_MIN_CYCLES}" in established.stationary_reason
    # Full-tier behavior at K=2 is untouched.
    assert strict is not None and strict.stationary


# --------------------------------------------------------------------------- #
# K=3 edge robustness (the precalc contract retains exactly 3 periods)
# --------------------------------------------------------------------------- #


def test_k3_relaxing_startup_rejected():
    t = np.linspace(0.0, 1.5, 1501)  # exactly 3 periods
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD) + 0.12 * np.exp(-t / 0.9)

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert stats.whole_periods == 3
    assert not stats.stationary
    assert "monotonically" in stats.stationary_reason


def test_k3_wandering_cycle_means_accepted():
    t = np.linspace(0.0, 1.5, 1501)
    cl = (
        0.7
        + 0.1 * np.sin(2 * np.pi * t / PERIOD)
        + 0.06 * np.sin(2 * np.pi * t / (2.6 * PERIOD) + 2.0)
    )

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert stats.whole_periods == 3
    assert stats.stationary
    assert "trendlessly" in stats.stationary_reason


def test_k3_femto_noise_monotone_means_accepted():
    """Absolute trend floor: numerically monotone but physically flat cycle
    means (net << 2% of the signal scale) must not reject the point."""
    t = np.linspace(0.0, 1.5, 1501)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD) + 1e-9 * t

    stats = _stats(t, cl, established_oscillation=True)

    assert stats is not None
    assert stats.stationary
    assert "trend floor" in stats.stationary_reason


def test_k3_trend_geometry_both_directions():
    """The documented K=3 decision boundary of the trend test: strict
    monotonicity AND net change >= 3x the residual scatter about the fitted
    line (s_resid = d*sqrt(2/3), d = interior deviation from the endpoint
    chord; monotone bounds d < |net|/2, so the boundary sits at
    d = 0.408|net|)."""
    scale = 0.7
    # Smooth exponential head (d = 0.10|net|): a relaxation -> trending.
    trending, why = _cycle_mean_trend([0.8227, 0.7809, 0.7533], scale)
    assert trending and "monotonically" in why
    # Near-collinear monotone (d = 0.25|net|): still a relaxation shape.
    trending, _ = _cycle_mean_trend([0.68, 0.725, 0.74], scale)
    assert trending
    # Monotone BY LUCK with the interior mean far off the chord
    # (d = 0.425|net| > 0.408): a modulated cycle, accepted.
    trending, why = _cycle_mean_trend([0.68, 0.7355, 0.74], scale)
    assert not trending and "trendlessly" in why
    # Non-monotone wander: accepted.
    trending, _ = _cycle_mean_trend([0.68, 0.74, 0.70], scale)
    assert not trending
    # Non-monotone but drift-dominated (slow drift with one noise flip,
    # net >> residual): the slow-drift guard still rejects it.
    trending, why = _cycle_mean_trend([0.60, 0.71, 0.70, 0.79, 0.88], scale)
    assert trending and "dominates" in why


# --------------------------------------------------------------------------- #
# Full-tier regression pins: the default path is byte-identical
# --------------------------------------------------------------------------- #


def test_full_gate_verdicts_unchanged_and_ignore_period_stability():
    """The strict gate's verdict is drift-only: the new period_stable input
    must not leak into full-tier results (ambiguous periods stay a warning,
    not a verdict, exactly as before)."""
    t = np.linspace(0.0, 4.0, 4001)
    clean = 0.7 + 0.1 * np.sin(2 * np.pi * t / PERIOD)
    drifting = clean + 0.15 * (t / t[-1])

    s_clean = _stats(t, clean, period_stable=False)
    s_drift = _stats(t, drifting, period_stable=True)

    assert s_clean is not None and s_clean.stationary
    assert s_clean.stationary_reason == ""
    assert s_drift is not None and not s_drift.stationary
    assert s_drift.drift_frac > 0.05


# --------------------------------------------------------------------------- #
# Pipeline wiring: the tier picks the gate; disclosure on acceptance
# --------------------------------------------------------------------------- #


def _write_coeff_rows(path, times, cl_fn, cd=0.05, cm=-0.02):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for t in times:
        lines.append(f"{t:.8g} {cd:.6g} 0 0 {cl_fn(t):.8g} 0 0 {cm:.6g} 0 0 0 0 0")
    path.write_text("\n".join(lines) + "\n")


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _finalize_transient(tmp_path, monkeypatch, cl_fn, solver_params, *, period_s=0.6):
    """Drive the REAL _finalize_outcome frame-stats path (real coefficient.dat,
    real discard/period/stats) with a faked solved transient."""
    t0, t1, n = 600.0, 612.0, 2400
    tcase = tmp_path / "transient"
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    ts = np.linspace(t0, t1, n)
    _write_coeff_rows(coeff, ts, cl_fn)
    hist = ForceHistory(
        t=[float(x) for x in ts], cl=[float(cl_fn(x)) for x in ts],
        cd=[0.05] * n, cm=[-0.02] * n,
        cl_mean=0.75, cl_rms=0.1, cd_mean=0.05, cd_rms=0.0, cm_mean=-0.02, cm_rms=0.0,
        shedding_freq_hz=1.0 / period_s, strouhal=1.0 / (period_s * 10.0), samples=n,
        period_s=period_s, retained_cycles=12, window_start=t0, window_end=t1,
    )
    transient = TransientResult(
        avg=SimpleNamespace(cl=99.0, cd=99.0, cm=99.0, cl_cd=1.0, cl_std=9.0, cd_std=9.0, cm_std=9.0),
        case_dir=tcase,
        force_history=hist,
        quality=UransQuality(
            ok=True, can_refine=False, reason="URANS quality target met.",
            measured_period_s=period_s,
        ),
        start_time=t0,
        end_time=t1,
        run_time=t1 - t0,
        coeff_paths=[coeff],
    )
    monkeypatch.setattr(pipeline, "_run_transient", lambda case_dir, *a, **k: transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0), reynolds=666_666)
    _finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=solver_params,
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    return outcome


def _modulated_cl(x):
    """Established modulated limit cycle shaped like the bouncing prod points:
    12 retained 0.6 s cycles whose means wander trendlessly while the
    half-window mean drift is ~0.15 (the old gate rejects, 3x tolerance)."""
    return (
        0.75
        + 0.1 * math.sin(2 * math.pi * x / 0.6)
        + 0.16 * math.sin(2 * math.pi * (x - 604.8) / 7.2 + 0.9)
    )


def _relaxing_cl(x):
    return 0.75 + 0.1 * math.sin(2 * math.pi * x / 0.6) + 0.6 * math.exp(-(x - 600.0) / 3.0)


def test_precalc_tier_accepts_established_cycle_and_discloses_scatter(tmp_path, monkeypatch):
    """MUST-CATCH wiring: fidelity=precalc routes the stationarity verdict
    through the established-oscillation test, and ACCEPTANCE appends the
    scatter disclosure warning (uncertainty is disclosed, not hidden)."""
    outcome = _finalize_transient(
        tmp_path, monkeypatch, _modulated_cl,
        SolverParams(force_transient=True, urans_fidelity="precalc", write_images=[]),
    )

    ft = outcome.frame_track
    assert ft is not None
    assert ft.stationary
    assert ft.drift_frac > 0.05  # the strict gate would have rejected this
    assert not any("not stationary" in w for w in outcome.quality_warnings)
    scatter = [w for w in outcome.quality_warnings if "cycle means scatter" in w]
    assert len(scatter) == 1
    assert "±" in scatter[0]
    assert "cycles (precalc)" in scatter[0]


def test_full_tier_same_signal_keeps_strict_drift_gate(tmp_path, monkeypatch):
    """Full-fidelity regression pin: the SAME modulated signal keeps the
    byte-identical strict verdict — not stationary, the classic drift warning
    text, and no precalc scatter disclosure."""
    outcome = _finalize_transient(
        tmp_path, monkeypatch, _modulated_cl,
        SolverParams(force_transient=True, write_images=[]),  # urans_fidelity=full default
    )

    ft = outcome.frame_track
    assert ft is not None
    assert not ft.stationary
    drift_warnings = [
        w for w in outcome.quality_warnings
        if w.startswith("URANS window not stationary: Cl drift")
    ]
    assert len(drift_warnings) == 1
    assert "exceeds tolerance" in drift_warnings[0]
    assert not any("cycle means scatter" in w for w in outcome.quality_warnings)
    assert not any("established-oscillation" in w for w in outcome.quality_warnings)


def test_precalc_tier_still_rejects_relaxing_startup(tmp_path, monkeypatch):
    """The looser precalc gate is not amnesty: a still-relaxing transient is
    rejected with the established-oscillation reason."""
    outcome = _finalize_transient(
        tmp_path, monkeypatch, _relaxing_cl,
        SolverParams(force_transient=True, urans_fidelity="precalc", write_images=[]),
    )

    ft = outcome.frame_track
    assert ft is not None
    assert not ft.stationary
    warnings = [w for w in outcome.quality_warnings if "not stationary" in w]
    assert len(warnings) == 1
    assert "established-oscillation" in warnings[0]
    assert "trend" in warnings[0]
    assert not any("cycle means scatter" in w for w in outcome.quality_warnings)


# --------------------------------------------------------------------------- #
# Wave-1 in-job escalation gate (incident 20b67295)
# --------------------------------------------------------------------------- #


def _run_marched(
    tmp_path, monkeypatch, solver_params, promotion_fake, *, aoas=None, seen_aoas=None
):
    """Marched polar where the aoa=2 warm point is rejected INSIDE the 0-5 deg
    attached-range check window (the promotion trigger)."""

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout):
            self.stdout = stdout

        def check(self):
            return self

    def fake_cold(*args, **_kwargs):
        if seen_aoas is not None:
            seen_aoas.append(args[5].aoa_deg)
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(_polar_dir, spec, *_args, **_kwargs):
        if seen_aoas is not None:
            seen_aoas.append(spec.aoa_deg)
        return FakeRunResult(
            "Time = 2\n"
            if spec.aoa_deg == 2.0
            else "Time = 2\nSIMPLE solution converged in 1 iterations\n"
        )

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1 * outcome.spec.aoa_deg + 0.01
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = outcome.cl / outcome.cd

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_publish_steady_seed", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", promotion_fake)

    return solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=25.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=solver_params,
        mesher=FakeMesher(),
        runner=None,
        aoas=aoas or [0.0, 2.0],
        render_images=False,
    )


def test_wave1_rans_tier_never_runs_in_job_urans_promotion(tmp_path, monkeypatch):
    """MUST-CATCH (incident 20b67295): with transient_fallback=false (every
    node-built wave-1 campaign/sweep job) a rejected steady point inside the
    attached-range window must NOT trigger the engine-side whole-polar URANS
    replacement — the honest rejected-RANS point ships and the node-side
    ladder owns escalation."""

    def never_promote(*_args, **_kwargs):
        pytest.fail("wave-1 (transient_fallback=false) must not run in-job URANS promotion")

    result = _run_marched(
        tmp_path, monkeypatch,
        SolverParams(transient_fallback=False, force_transient=False, write_images=[]),
        never_promote,
    )

    assert not result.promoted_to_urans
    # Both points ship honestly: converged aoa=0 and the rejected-with-data
    # aoa=2 (converged=false) — the ladder's tier-1 evidence.
    assert [p.outcome.spec.aoa_deg for p in result.points] == [0.0, 2.0]
    assert result.points[0].outcome.converged
    assert not result.points[1].outcome.converged


def test_wave1_conditional_policy_aborts_remaining_rans_for_external_precalc(
    tmp_path, monkeypatch
):
    """A node-owned promotion stops the marched RANS loop immediately, emits a
    durable per-polar signal, and never starts an ungated in-job transient."""

    def never_promote(*_args, **_kwargs):
        pytest.fail("external PRECALC policy must not run in-job URANS")

    seen = []
    result = _run_marched(
        tmp_path,
        monkeypatch,
        SolverParams(
            transient_fallback=False,
            force_transient=False,
            rans_failure_policy="abort_for_precalc",
            write_images=[],
        ),
        never_promote,
        aoas=[-2.0, 0.0, 2.0, 4.0],
        seen_aoas=seen,
    )

    assert seen == [0.0, 2.0]
    assert not result.promoted_to_urans
    assert result.precalc_promotion is not None
    assert result.precalc_promotion.trigger_aoa_deg == 2.0
    # The march is zero-anchored, so the untouched negative branch is also
    # omitted.  This must be requested scope minus actual attempts, not a
    # slice of the execution order.
    assert result.precalc_promotion.intentionally_omitted_aoas == [-2.0, 4.0]
    assert [item.outcome.spec.aoa_deg for item in result.attempts] == [0.0, 2.0]


def test_engine_publishes_condition_promotion_before_sibling_speed_finishes(
    tmp_path, monkeypatch, naca0012_selig_text
):
    """MUST-CATCH: a batched condition can abort while another speed is still
    running. Its typed promotion must reach partial result.json immediately so
    Node cannot generically requeue the hard failure before terminal ingest."""
    import threading

    from airfoilfoam import jobs
    from airfoilfoam.config import Settings
    from airfoilfoam.models import (
        AirfoilInput,
        AoASpec,
        FailureDisposition,
        PolarRequest,
        RansPrecalcPromotion,
        ResourceParams,
    )
    from airfoilfoam.pipeline import PolarMarchResult, StoredCaseOutcome
    from airfoilfoam.storage import JobStore

    promotion_published = threading.Event()
    slow_saw_promotion = []

    class ObservingStore(JobStore):
        def write_result(self, result):
            super().write_result(result)
            if result.state.value == "running" and any(
                polar.rans_precalc_promotion is not None
                for polar in result.polars
            ):
                promotion_published.set()

    monkeypatch.setattr(
        jobs,
        "prepare_mesh_with_recovery",
        lambda mesh_dir, _airfoil, resolved, *_args, **_kwargs: (
            (
                mesh_dir.mkdir(parents=True, exist_ok=True)
                or SimpleNamespace(n_cells=100, patches=[], span_chords=0.1)
            ),
            resolved,
            False,
        ),
    )

    def fake_march(_polar_dir, _mesh_dir, _airfoil, chord, speed, *_args, **_kwargs):
        if speed == 20.0:
            slow_saw_promotion.append(promotion_published.wait(timeout=2.0))
            point = CaseOutcome(
                spec=CaseSpec(chord=chord, speed=speed, aoa_deg=0.0),
                reynolds=1e6,
                cl=0.1,
                cd=0.02,
                cm=0.0,
                cl_cd=5.0,
                converged=True,
            )
            return PolarMarchResult(
                points=[StoredCaseOutcome(slug="slow/a0", outcome=point)],
                attempts=[StoredCaseOutcome(slug="slow/a0", outcome=point)],
            )
        accepted = CaseOutcome(
            spec=CaseSpec(chord=chord, speed=speed, aoa_deg=0.0),
            reynolds=1e6,
            cl=0.0,
            cd=0.02,
            cm=0.0,
            cl_cd=0.0,
            converged=True,
        )
        failed = CaseOutcome(
            spec=CaseSpec(chord=chord, speed=speed, aoa_deg=2.0),
            reynolds=1e6,
            converged=False,
            failure_disposition=FailureDisposition.hard_solver,
            error="HardSolverError: divergence watchdog condemned RANS",
        )
        return PolarMarchResult(
            points=[StoredCaseOutcome(slug="fast/a0", outcome=accepted)],
            attempts=[
                StoredCaseOutcome(slug="fast/a0", outcome=accepted),
                StoredCaseOutcome(slug="fast/a2", outcome=failed),
            ],
            precalc_promotion=RansPrecalcPromotion(
                trigger_aoa_deg=2.0,
                attempted_aoas=[0.0, 2.0],
                intentionally_omitted_aoas=[4.0],
            ),
        )

    monkeypatch.setattr(jobs, "solve_polar_marched", fake_march)
    settings = Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cpu_token_state_path=tmp_path / "cpu-tokens.json",
        worker_cpu_budget=2,
        case_concurrency=2,
        solver_processes=1,
    )
    store = ObservingStore(settings)
    request = PolarRequest(
        airfoil=AirfoilInput(name="naca0012", coordinates=naca0012_selig_text),
        speeds=[10.0, 20.0],
        aoa=AoASpec(angles=[0.0, 2.0, 4.0]),
        solver=SolverParams(
            warm_start=True,
            transient_fallback=False,
            rans_failure_policy="abort_for_precalc",
            write_images=[],
        ),
        resources=ResourceParams(
            policy="case_parallel",
            cpu_budget=2,
            case_concurrency=2,
            solver_processes=1,
        ),
    )

    result = jobs.execute_job(
        "partial-promotion-publication",
        request,
        store=store,
        settings=settings,
    )

    assert slow_saw_promotion == [True]
    assert any(
        polar.rans_precalc_promotion is not None for polar in result.polars
    )
    status = store.read_status("partial-promotion-publication")
    assert status is not None
    assert status.state.value == "completed"
    assert status.phase.value == "completed"


def test_default_transient_fallback_keeps_in_job_promotion(tmp_path, monkeypatch):
    """False-positive guard: direct-API requests (engine default
    transient_fallback=true) keep the in-job whole-polar promotion."""
    promoted = []

    def fake_promotion(*_args, **kwargs):
        promoted.append(True)
        return []

    result = _run_marched(tmp_path, monkeypatch, SolverParams(write_images=[]), fake_promotion)

    assert promoted == [True]
    assert result.promoted_to_urans
    assert "switching the whole polar to URANS" in result.abort_reason
