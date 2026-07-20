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
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.models import CaseSpec, FluidProperties, RoughnessParams, SolverParams
from airfoilfoam.postprocess.unsteady import ForceHistory, force_history, is_no_shedding
from airfoilfoam import pipeline
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
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


def _weak_slow_history(
    t0: float,
    t1: float,
    *,
    period_s: float = 2.0,
    period_visible: bool,
    n: int = 1001,
) -> ForceHistory:
    """A single weak St=0.05 wake trajectory, windowed at different horizons.

    The phase puts the first 0.72 s retained window around a broad lift maximum:
    its RMS falls just below the no-shedding amplitude threshold even though the
    longer trajectory is a real 0.02-Cl oscillation.  This is the production
    risk created by a six-guessed-cycle first precalc chunk.
    """
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    cl = [
        0.7 + 0.02 * math.cos(2.0 * math.pi * (t - 0.84) / period_s)
        for t in ts
    ]
    cd = [0.05] * n
    cl_mean = sum(cl) / n
    cl_rms = math.sqrt(sum((value - cl_mean) ** 2 for value in cl) / n)
    st = 0.05 if period_visible else 0.0
    return ForceHistory(
        t=ts,
        cl=cl,
        cd=cd,
        cm=[0.0] * n,
        cl_mean=cl_mean,
        cl_rms=cl_rms,
        cd_mean=0.05,
        cd_rms=0.0,
        cm_mean=0.0,
        cm_rms=0.0,
        shedding_freq_hz=0.5 if period_visible else 0.0,
        strouhal=st,
        samples=n,
        period_s=period_s if period_visible else None,
        retained_cycles=None,
        window_start=t0,
        window_end=t1,
    )


def _write_low_amplitude_inband_coeff(path: Path, span_s: float) -> None:
    """Real coefficient file with a tiny but spectrally clean St=0.2 ripple.

    Its amplitude is below the no-shedding floor, while its FFT peak is strong
    enough that the old period-first history path cropped the observation to
    the last three 0.5 s cycles.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    dt = 0.001
    n = int(round(span_s / dt)) + 1
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    for i in range(n):
        t = min(span_s, i * dt)
        cl = 0.0006 + 0.0005 * math.sin(2.0 * math.pi * t / 0.5)
        rows.append(
            f"{t:.6f} 0.012 0 0 {cl:.9g} 0 0 -0.0004 0 0 0 0 0"
        )
    path.write_text("\n".join(rows) + "\n")


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
    hist = _flat_history(cl_mean=0.0006, cd_mean=0.012, t1=4.3)

    quality = evaluate_urans_quality(tmp_path, hist, speed=10.0, chord=1.0)

    # Valid steady-equivalent, and explicitly NOT refinable (auto-refining a
    # non-shedding case is what triggered the degenerate refined-copy crash).
    assert quality.ok
    assert quality.no_shedding
    assert not quality.can_refine
    assert quality.measured_period_s is None
    assert "no vortex shedding" in quality.reason


@pytest.mark.parametrize(
    ("retained_span_s", "accepted"),
    [(4.19, False), (4.21, True)],
)
def test_low_amplitude_inband_ripple_uses_full_no_shedding_observation_horizon(
    tmp_path,
    retained_span_s,
    accepted,
):
    """A tiny credible FFT line must not crop the physical flat-wake horizon.

    At U=10 m/s and c=1 m the shared floor is exactly 4.2 s. The below-floor
    trace remains pending physical acquisition; the above-floor trace is a
    valid steady-equivalent mean. Both retain their full real observation and
    expose no spurious shedding period.
    """
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_low_amplitude_inband_coeff(coeff, retained_span_s)
    history = force_history(
        coeff,
        speed=10.0,
        chord=1.0,
        discard_fraction=0.0,
        target_cycles=3,
    )
    minimum = pipeline._no_shedding_min_observation_s(10.0, 1.0)

    assert minimum == pytest.approx(4.2)
    assert is_no_shedding(history)
    assert history.period_s is None
    assert history.strouhal == 0.0
    assert history.t[-1] - history.t[0] == pytest.approx(retained_span_s)

    quality = evaluate_urans_quality(
        tmp_path,
        history,
        speed=10.0,
        chord=1.0,
        min_cycles=3.0,
        min_no_shedding_observation_s=minimum,
    )
    assert quality.ok is accepted
    assert quality.no_shedding is accepted
    if accepted:
        assert "no vortex shedding" in quality.reason
    else:
        assert "apparently flat" in quality.reason
        assert "slow-shedding observation horizon" in quality.reason

    # The mandatory precalc stationarity gate may not reinterpret a tiny FFT
    # ripple and bypass the no-shedding observation decision above.
    graded = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        quality,
        early_stopped=False,
    )
    assert graded is quality


def test_precalc_short_apparent_flat_signal_is_not_yet_no_shedding(tmp_path):
    """Less than one slow plausible cycle cannot prove a wake is steady."""
    history = _weak_slow_history(0.48, 1.2, period_visible=False)
    minimum = pipeline._no_shedding_min_observation_s(10.0, 1.0)

    assert is_no_shedding(history)  # the short envelope really looks flat
    assert minimum == pytest.approx(4.2)  # 2.1 periods at the St=0.05 edge

    quality = evaluate_urans_quality(
        tmp_path,
        history,
        speed=10.0,
        chord=1.0,
        min_no_shedding_observation_s=minimum,
    )

    assert not quality.ok
    assert not quality.no_shedding
    assert quality.measured_period_s is None
    assert "apparently flat" in quality.reason
    assert "slow-shedding observation horizon" in quality.reason


def test_precalc_apparent_flat_signal_acquires_slow_period_in_same_case(
    tmp_path, monkeypatch
):
    """The apparent-flat first chunk follows bounded physical acquisition.

    The same weak St=0.05 trajectory is regraded as its retained window grows.
    It is not allowed to terminate as no-shedding at 0.36 real cycles; the
    controller reaches the physical slow edge and then the three-period target
    without copying or restarting the case.
    """
    speed = 10.0
    chord = 1.0
    guess_period = chord / (pipeline.TRANSIENT_INITIAL_STROUHAL * speed)
    minimum = pipeline._no_shedding_min_observation_s(speed, chord)
    discard = 0.4
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_discard_fraction=discard,
    )
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    def result_for(start: float, end: float) -> TransientResult:
        retained_start = discard * end
        retained_span = end - retained_start
        history = _weak_slow_history(
            retained_start,
            end,
            period_visible=retained_span + 1e-9 >= minimum,
        )
        quality = evaluate_urans_quality(
            tcase,
            history,
            speed=speed,
            chord=chord,
            min_cycles=3.0,
            min_frames_per_cycle=0.0,
            min_no_shedding_observation_s=minimum,
        )
        if quality.measured_period_s is not None:
            # Recorder density is outside this controller-policy regression;
            # model a healthy 30-frame/cycle tail so only aerodynamic horizon
            # acquisition determines the continuation size.
            quality = pipeline._quality_with(
                quality,
                retained_frame_count=max(1, round(30.0 * quality.retained_cycles)),
                frames_per_cycle=30.0,
            )
        return TransientResult(
            avg=SimpleNamespace(
                cl=history.cl_mean,
                cd=history.cd_mean,
                cm=history.cm_mean,
                cl_cd=history.cl_mean / history.cd_mean,
                cl_std=history.cl_rms,
                cd_std=history.cd_rms,
                cm_std=history.cm_rms,
            ),
            case_dir=tcase,
            force_history=history,
            quality=quality,
            start_time=start,
            end_time=end,
            run_time=end - start,
            wall_seconds=0.0,
        )

    first_end = 6.0 * guess_period
    (tcase / f"{first_end:.10g}").mkdir()
    first = result_for(0.0, first_end)
    assert is_no_shedding(first.force_history)
    assert not first.quality.no_shedding

    calls: list[dict] = []

    def fake_attempt(
        case_dir,
        *_args,
        run_time=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        start = pipeline._latest_time(case_dir)
        end = start + float(run_time)
        (case_dir / f"{end:.10g}").mkdir(exist_ok=True)
        calls.append(
            {
                "run_time": float(run_time),
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
        return result_for(start, end)

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=chord, speed=speed, aoa_deg=15.0),
        None,
        None,
        solver,
        None,
        1,
        4 * 3600,
        guess_period / 5000.0,
    )

    assert result.quality.ok
    assert not result.quality.no_shedding
    assert result.quality.measured_period_s == pytest.approx(2.0)
    # 6 guessed cycles were already run; acquisition reaches 10, 20, then the
    # St=0.05 slow-edge acquisition horizon (37), before measured-period retention reaches
    # the three-cycle preliminary target.
    assert [call["run_time"] / guess_period for call in calls] == pytest.approx(
        [4.0, 10.0, 17.0, 23.0]
    )
    assert all(call["coeff_start_time"] == pytest.approx(0.0) for call in calls)
    assert all(not call["refined"] for call in calls)


def test_precalc_true_no_shedding_is_accepted_after_slow_horizon(tmp_path):
    minimum = pipeline._no_shedding_min_observation_s(10.0, 1.0)
    history = _flat_history(
        cl_mean=0.0006,
        cd_mean=0.012,
        t0=0.0,
        t1=minimum + 1e-6,
        n=1600,
    )

    quality = evaluate_urans_quality(
        tmp_path,
        history,
        speed=10.0,
        chord=1.0,
        min_no_shedding_observation_s=minimum,
    )

    assert quality.ok
    assert quality.no_shedding
    assert not quality.can_refine
    assert quality.measured_period_s is None


def test_period_acquisition_skips_exhausted_field_horizon_using_force_progress(
    tmp_path, monkeypatch
):
    """A lagging field write must not schedule a zero-progress continuation.

    Production angle 12 had force evidence at 20.000 guessed periods while the
    latest restartable field directory was still at 19.84. The controller used
    only the field directory to select the next 20-period horizon, so the
    resulting chunk could not advance beyond force evidence already retained.
    It must select the following physical slow-edge horizon from the strongest
    same-case progress token instead.
    """
    speed = 30.0
    chord = 0.05
    guess_period = chord / (pipeline.TRANSIENT_INITIAL_STROUHAL * speed)
    field_cycles = 19.8409264843968
    force_cycles = 20.0002196814797
    field_end = field_cycles * guess_period
    force_end = force_cycles * guess_period
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    (tcase / f"{field_end:.15g}").mkdir()

    first_history = _flat_history(
        cl_mean=0.893659,
        cd_mean=0.156141,
        t0=force_end - 0.00609854,
        t1=force_end,
        n=500,
    )
    minimum = pipeline._no_shedding_min_observation_s(speed, chord)
    first_quality = evaluate_urans_quality(
        tcase,
        first_history,
        speed=speed,
        chord=chord,
        min_cycles=3.0,
        min_no_shedding_observation_s=minimum,
    )
    assert not first_quality.ok
    assert pipeline.URANS_APPARENT_FLAT_OBSERVATION_MARKER in first_quality.reason
    first = TransientResult(
        avg=SimpleNamespace(cl=0.893659, cd=0.156141, cm=-0.136212),
        case_dir=tcase,
        force_history=first_history,
        quality=first_quality,
        start_time=0.0,
        end_time=force_end,
        run_time=force_end,
        wall_seconds=1.0,
    )
    calls: list[float] = []

    def fake_attempt(case_dir, *_args, run_time=None, **_kwargs):
        run_time = float(run_time)
        calls.append(run_time)
        # A sub-guess request reproduces the production no-progress boundary:
        # OpenFOAM retains no newer restart field or force sample.
        if run_time < guess_period:
            return first
        end = pipeline._latest_time(case_dir) + run_time
        (case_dir / f"{end:.15g}").mkdir()
        history = _flat_history(
            cl_mean=0.893659,
            cd_mean=0.156141,
            t0=0.0,
            t1=end,
            n=1500,
        )
        quality = evaluate_urans_quality(
            case_dir,
            history,
            speed=speed,
            chord=chord,
            min_cycles=3.0,
            min_no_shedding_observation_s=minimum,
        )
        return TransientResult(
            avg=SimpleNamespace(cl=0.893659, cd=0.156141, cm=-0.136212),
            case_dir=case_dir,
            force_history=history,
            quality=quality,
            start_time=field_end,
            end_time=end,
            run_time=run_time,
            wall_seconds=1.0,
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_cycles=10,
        transient_discard_fraction=0.4,
    )
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=chord, speed=speed, aoa_deg=12.0),
        None,
        None,
        solver,
        None,
        1,
        4 * 3600,
        guess_period / 5000.0,
    )

    slow_horizon = pipeline._period_acquisition_horizons(solver)[-1]
    assert calls == pytest.approx([(slow_horizon - force_cycles) * guess_period])
    assert result.quality.ok
    assert result.quality.no_shedding


def test_full_true_flat_signal_waits_for_same_physical_horizon(
    tmp_path, monkeypatch
):
    """Verified/full evidence must not certify steady flow more easily.

    The default ten-guess full run retains only 1.2 s here (0.6 cycles at the
    St=0.05 edge).  It therefore follows the same bounded, same-case physical
    acquisition to 20 and 37 guesses before accepting a truly flat wake.
    """
    speed = 10.0
    chord = 1.0
    discard = 0.4
    guess_period = chord / (pipeline.TRANSIENT_INITIAL_STROUHAL * speed)
    minimum = pipeline._no_shedding_min_observation_s(speed, chord)
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="full",
        urans_min_periods=7,
        transient_cycles=10.0,
        transient_discard_fraction=discard,
    )
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    def result_for(start: float, end: float) -> TransientResult:
        history = _flat_history(
            cl_mean=0.0006,
            cd_mean=0.012,
            t0=discard * end,
            t1=end,
            n=1001,
        )
        quality = evaluate_urans_quality(
            tcase,
            history,
            speed=speed,
            chord=chord,
            min_cycles=7.0,
            min_no_shedding_observation_s=minimum,
        )
        return TransientResult(
            avg=SimpleNamespace(
                cl=history.cl_mean,
                cd=history.cd_mean,
                cm=history.cm_mean,
                cl_cd=history.cl_mean / history.cd_mean,
                cl_std=history.cl_rms,
                cd_std=history.cd_rms,
                cm_std=history.cm_rms,
            ),
            case_dir=tcase,
            force_history=history,
            quality=quality,
            start_time=start,
            end_time=end,
            run_time=end - start,
            wall_seconds=0.0,
        )

    first_end = 10.0 * guess_period
    (tcase / f"{first_end:.10g}").mkdir()
    first = result_for(0.0, first_end)
    assert not first.quality.ok
    assert not first.quality.no_shedding
    assert first.force_history.t[-1] - first.force_history.t[0] == pytest.approx(1.2)

    calls: list[dict] = []

    def fake_attempt(
        case_dir,
        *_args,
        run_time=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        start = pipeline._latest_time(case_dir)
        end = start + float(run_time)
        (case_dir / f"{end:.10g}").mkdir(exist_ok=True)
        calls.append(
            {
                "run_time": float(run_time),
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
        return result_for(start, end)

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=chord, speed=speed, aoa_deg=0.0),
        None,
        None,
        solver,
        None,
        1,
        12 * 3600,
        guess_period / 5000.0,
    )

    assert result.quality.ok
    assert result.quality.no_shedding
    retained_span = result.force_history.t[-1] - result.force_history.t[0]
    assert retained_span >= minimum
    assert retained_span == pytest.approx(
        pipeline._period_acquisition_horizons(solver)[-1]
        * guess_period
        * (1.0 - discard)
    )
    assert [call["run_time"] / guess_period for call in calls] == pytest.approx(
        [10.0, 17.0]
    )
    assert all(call["coeff_start_time"] == pytest.approx(0.0) for call in calls)
    assert all(not call["refined"] for call in calls)


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


def test_restart_boundary_force_impulses_do_not_mint_false_shedding(tmp_path):
    """Production-shaped integration guard: a flat trajectory split across
    continuation segments remains no-shedding even when each older segment's
    terminal boundary row is numerically inconsistent.

    Raw evidence is retained unchanged; only the merged analysis series gives
    ownership of a restart boundary to the newer segment.
    """

    header = "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    paths: list[Path] = []
    for start, end in ((0.0, 0.04), (0.04, 0.08), (0.08, 0.12)):
        path = (
            tmp_path
            / "postProcessing"
            / "forceCoeffs1"
            / f"{start:g}"
            / "coefficient.dat"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [header]
        for index in range(41):
            t = start + index * 0.001
            cl = 1.0 if index == 40 and end < 0.12 else 0.7
            cd = 0.01 if index == 40 and end < 0.12 else 0.025
            rows.append(
                f"{t:.6f} {cd:.8g} 0 0 {cl:.8g} 0 0 -0.1 0 0 0 0 0"
            )
        path.write_text("\n".join(rows) + "\n")
        paths.append(path)

    history = force_history(
        paths,
        speed=30.0,
        chord=0.05,
        discard_fraction=0.0,
        target_cycles=3,
        alpha_deg=2.0,
    )

    assert is_no_shedding(history)
    assert history.period_s is None
    assert history.strouhal == 0.0
    assert history.cl_mean == pytest.approx(0.7)
    assert history.cd_mean == pytest.approx(0.025)


def test_no_shedding_mean_equals_average_of_steady_history(tmp_path, monkeypatch):
    cl_true, cd_true, cm_true = 0.0009, 0.0121, -0.0004

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)
            # Retain about 4.27 s, safely beyond the shared 4.2 s slow-shedding
            # observation floor after the default 40% startup discard.
            _write_flat_coeff(coeff, cl_true, cd_true, cm_true, n=712)
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
        run_time=7.2,
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


def test_early_stop_no_shedding_uses_trailing_physical_horizon(
    tmp_path, monkeypatch
):
    """A spurious early-stop marker must not turn a flat wake into URANS.

    The OpenCFD 2606 canary produced this exact control-flow collision: a tiny
    numerical ripple armed the periodic early-stop marker, while the final
    force trace had no credible shedding frequency.  The startup portion is
    intentionally violent here so only the trailing 2.1 slow-period physical
    horizon is a valid no-shedding observation or averaging window.
    """
    cl_tail, cd_tail, cm_tail = -0.0046, 0.01514, 0.001065
    speed, chord = 166.0, 0.05
    required = pipeline._no_shedding_min_observation_s(speed, chord)
    end_time = 0.03

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = (
                case_dir
                / "postProcessing"
                / "forceCoeffs1"
                / "0"
                / "coefficient.dat"
            )
            coeff.parent.mkdir(parents=True, exist_ok=True)
            rows = [
                "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
                "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
            ]
            for i in range(3001):
                t = end_time * i / 3000
                if t < end_time - required:
                    # A non-flat startup that must be excluded from both the
                    # physical verdict and the reported steady-equivalent mean.
                    phase = 2.0 * math.pi * t / 0.004
                    cl = 0.08 * math.sin(phase)
                    cd = 0.04 + 0.015 * math.cos(phase)
                    cm = 0.01 * math.sin(phase)
                else:
                    cl, cd, cm = cl_tail, cd_tail, cm_tail
                rows.append(
                    f"{t:.10g} {cd:.10g} 0 0 {cl:.10g} 0 0 "
                    f"{cm:.10g} 0 0 0 0 0"
                )
            coeff.write_text("\n".join(rows) + "\n")
            pipeline._write_early_stop_marker(
                case_dir,
                pipeline.StablePeriodResult(
                    ok=True,
                    reason="two stable periods with sufficient frames",
                    stable=True,
                    period_s=0.004,
                    window_start=0.02,
                    window_end=end_time,
                    cycles=2,
                    frame_count=60,
                    frames_per_cycle=30.0,
                ),
                retain_from=0.0,
            )
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", _FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=chord, speed=speed, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            transient_discard_fraction=0.4,
        ),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=end_time,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )

    assert result is not None and result.early_stopped
    assert result.quality.ok and result.quality.no_shedding
    assert "no vortex shedding" in result.quality.reason
    assert result.force_history is not None
    assert result.force_history.window_end - result.force_history.window_start == pytest.approx(
        required, abs=2e-5
    )
    assert result.avg.cl == pytest.approx(cl_tail, abs=2e-7)
    assert result.avg.cd == pytest.approx(cd_tail, abs=2e-7)
    assert result.avg.cm == pytest.approx(cm_tail, abs=2e-7)


def test_trailing_physical_horizon_does_not_hide_real_slow_shedding(tmp_path):
    """Two-plus real St=0.05 cycles are not a flat-wake false positive."""
    speed, chord = 166.0, 0.05
    slow_period = chord / (pipeline.SHEDDING_STROUHAL_BAND[0] * speed)
    required = pipeline._no_shedding_min_observation_s(speed, chord)
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    for i in range(3001):
        t = required * i / 3000
        phase = 2.0 * math.pi * t / slow_period
        rows.append(
            f"{t:.10g} {0.015 + 0.002 * math.cos(phase):.10g} 0 0 "
            f"{0.01 * math.sin(phase):.10g} 0 0 0 0 0 0 0 0"
        )
    coeff.write_text("\n".join(rows) + "\n")

    history = pipeline._force_history_for_no_shedding_horizon(
        [coeff],
        CaseSpec(chord=chord, speed=speed, aoa_deg=0.0),
        target_cycles=3,
    )

    assert history is not None
    assert history.window_end - history.window_start <= required + 2e-5
    assert not is_no_shedding(history)


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


def test_finalize_rejects_short_flat_urans_before_publishing_transient_media(
    tmp_path, monkeypatch
):
    """A warning-only flat trace below the physical horizon is not a point.

    OpenCFD 2606 exposed this exact shape in the production canary: pimpleFoam
    reached its requested field horizon, but the force function-object history
    stopped at 0.00722634 s, below the 0.0126506 s slow-shedding observation
    floor.  The old finalizer nevertheless set ``converged=true`` and rendered
    mean/video media with ``frame_track=null``.  Raw solve evidence must still
    be archived, but no derived transient media or accepted coefficients may
    escape this gate.
    """
    from airfoilfoam.models import MeshParams
    from airfoilfoam.openfoam.runner import HardSolverError
    from airfoilfoam.postprocess.forces import AveragedCoefficients

    hist = _flat_history(
        cl_mean=-0.004595975527344631,
        cd_mean=0.01513725538636765,
        t0=0.00482046,
        t1=0.0120468,
        n=400,
    )
    reason = (
        "URANS period acquisition exhausted the physical slow-shedding horizon "
        "(39.0 initial guesses); URANS quality could not be measured: an "
        "apparently flat signal spans 0.00722634s, below the physical "
        "slow-shedding observation horizon 0.0126506s."
    )
    transient_dir = tmp_path / "transient"
    transient_dir.mkdir()
    (tmp_path / "system").mkdir()
    (tmp_path / "system" / "controlDict").write_text("application simpleFoam;\n")
    (transient_dir / "system").mkdir()
    (transient_dir / "system" / "controlDict").write_text(
        "application pimpleFoam;\n"
    )
    pipeline.write_transient_start_marker(transient_dir, 0.0)
    (transient_dir / "constant").mkdir()
    (transient_dir / "constant" / "transportProperties").write_text(
        "transportModel Newtonian;\n"
    )
    (transient_dir / "log.pimpleFoam").write_text(
        "Time = 0.0235548\nEnd\n"
    )
    coeff_dir = transient_dir / "postProcessing" / "forceCoeffs1" / "0"
    coeff_dir.mkdir(parents=True)
    (coeff_dir / "coefficient.dat").write_text(
        "# Time Cd Cs Cl CmRoll CmPitch CmYaw Cd(f) Cd(r) Cs(f) Cs(r) Cl(f) Cl(r)\n"
        "0.0120468 0.0151 0 -0.0046 0 0.00106 0 0 0 0 0 0 0\n"
    )
    latest_time = transient_dir / "0.0235548"
    latest_time.mkdir()
    (latest_time / "U").write_text("internalField uniform (166 0 0);\n")

    def fake_transient(*_args, **_kwargs):
        return TransientResult(
            avg=AveragedCoefficients(
                cl=hist.cl_mean,
                cd=hist.cd_mean,
                cm=hist.cm_mean,
                cl_std=hist.cl_rms,
                cd_std=hist.cd_rms,
                cm_std=hist.cm_rms,
                samples=hist.samples,
            ),
            case_dir=transient_dir,
            force_history=hist,
            quality=pipeline.UransQuality(
                ok=False,
                can_refine=False,
                no_shedding=False,
                reason=reason,
            ),
            start_time=0.0,
            end_time=0.0235548,
            run_time=0.0235548,
        )

    class FakeRunner:
        commands = []

        def application(self, *_args, **_kwargs):
            command = str(_args[1]) if len(_args) > 1 else ""
            self.commands.append(command)
            if "foamToVTK" in command:
                raise RuntimeError("VTK conversion intentionally unavailable")
            return SimpleNamespace(ok=True, check=lambda: None)

    media_calls = []

    def forbidden_media(*_args, **_kwargs):
        media_calls.append(True)
        return {"velocity_magnitude": "should-not-exist.png"}

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    monkeypatch.setattr(pipeline, "render_contours", forbidden_media)
    monkeypatch.setattr(pipeline, "render_mean_contours", forbidden_media)
    monkeypatch.setattr(
        pipeline,
        "render_animations",
        lambda *_args, **_kwargs: (
            media_calls.append(True)
            or SimpleNamespace(
                videos={"velocity_magnitude": "should-not-exist.mp4"},
                errors={},
            )
        ),
    )
    runner = FakeRunner()
    outcome = CaseOutcome(
        spec=CaseSpec(chord=0.05, speed=166.0, aoa_deg=0.0),
        reynolds=553_333,
    )

    with pytest.raises(HardSolverError, match="URANS evidence rejected"):
        pipeline._finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="NACA0012", contour=[]),
            resolved=MeshParams(),
            spec=outcome.spec,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            solver_params=SolverParams(
                force_transient=True,
                urans_fidelity="precalc",
                write_images=["velocity_magnitude"],
                frame_fields=["velocity_magnitude"],
            ),
            runner=runner,
            n_proc=1,
            render_images=True,
            solver_timeout=14_400,
        )

    # Rejected attempts do not depend on a derived VTK conversion that may
    # itself fail. Their original OpenFOAM bytes are archived directly.
    assert not any("foamToVTK" in command for command in runner.commands)
    manifest = json.loads((tmp_path / "evidence" / "evidence_manifest.json").read_text())
    files = {entry["path"]: entry["role"] for entry in manifest["files"]}
    assert manifest["media"]["requestedFields"] == []
    assert files["openfoam/system/controlDict"] == "dictionary"
    assert files["openfoam/transient/system/controlDict"] == "dictionary"
    assert (
        files["openfoam/transient/transient_start.json"]
        == "continuation_state"
    )
    assert files["openfoam/logs/transient/log.pimpleFoam"] == "log"
    assert (
        files["openfoam/postProcessing/forceCoeffs1/0/coefficient.dat"]
        == "force_coefficients"
    )
    assert files["time_directories/0.0235548/U"] == "time_directory"
    assert (tmp_path / "evidence" / "engine_evidence.tar.zst").is_file()
    assert not media_calls
    assert not outcome.converged
    assert outcome.frame_track is None
    assert outcome.images == {}
    assert outcome.mean_images == {}
    assert outcome.video == {}
