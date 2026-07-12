"""Unit tests for URANS force-history + Strouhal extraction (no OpenFOAM needed)."""
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import pipeline
from airfoilfoam.cancellation import JobCancelled
from airfoilfoam.postprocess.unsteady import (
    ForceHistory,
    dominant_frequency,
    force_history,
    integer_period_window,
    stable_two_period_window,
    strouhal,
)
from airfoilfoam.postprocess.images import find_all_vtus, select_vtus
from airfoilfoam.models import CaseSpec, FailureDisposition
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    InsufficientMpiSlotsError,
    RunResult,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    UransQuality,
    _run_full_urans_replacement,
    _run_transient_attempt,
    evaluate_urans_quality,
    _finalize_outcome,
    refined_transient_timing,
    should_abort_rans_sweep_for_urans,
    solve_polar_marched,
)


def test_dominant_frequency_recovers_known_tone():
    f = 2.0  # Hz
    n = 600
    times = [i * 0.01 for i in range(n)]  # 6 s, dt = 0.01
    values = [0.75 + 0.05 * math.sin(2 * math.pi * f * t) for t in times]
    got = dominant_frequency(times, values)
    # FFT bin spacing here is ~1/6 Hz; recovered peak should be within a bin or two.
    assert abs(got - f) < 0.35


def test_dominant_frequency_handles_degenerate_input():
    assert dominant_frequency([0, 1, 2], [1, 1, 1]) == 0.0  # too few samples
    assert dominant_frequency([0.0] * 16, [0.0] * 16) == 0.0  # zero span / flat


def test_strouhal_formula():
    assert strouhal(2.0, 1.0, 20.0) == 0.1
    assert strouhal(5.0, 0.5, 10.0) == 0.25
    assert strouhal(2.0, 1.0, 0.0) == 0.0  # guard against zero speed


def _write_coeff(path, f, n=600, dt=0.01, cl0=0.75, cd0=0.30):
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        t = i * dt
        cl = cl0 + 0.05 * math.sin(2 * math.pi * f * t)
        cd = cd0 + 0.01 * math.sin(2 * math.pi * f * t + 0.7)
        cm = -0.10
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, cm, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
    path.write_text("\n".join(lines) + "\n")


def test_force_history_from_coefficient_dat(tmp_path):
    f = 2.0
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f, n=600, dt=0.01)
    hist = force_history(coeff, speed=20.0, chord=1.0, discard_fraction=0.4, max_points=400)

    # The exported window is the final integer number of measured periods.
    assert hist.retained_cycles == 7
    assert hist.period_s == pytest.approx(0.5, rel=0.03)
    assert hist.t[-1] - hist.t[0] == pytest.approx(7 * hist.period_s)
    assert hist.samples > 300
    assert len(hist.cl) <= 400 and len(hist.cl) > 100
    assert len(hist.t) == len(hist.cl) == len(hist.cd)

    assert abs(hist.cl_mean - 0.75) < 0.01
    assert abs(hist.cd_mean - 0.30) < 0.01
    assert hist.cl_rms > 0.02  # oscillation amplitude ~0.05/sqrt(2)

    # measured Strouhal: f c / U = 2 * 1 / 20 = 0.1
    assert abs(hist.strouhal - 0.1) < 0.03
    assert hist.shedding_freq_hz > 0


def test_integer_period_window_uses_final_whole_periods():
    window = integer_period_window([0.0, 0.1, 1.0, 2.0, 3.95, 4.0], period_s=0.5, discard_fraction=0.4, target_cycles=7)

    assert window is not None
    assert window.cycles == 4
    assert window.end == pytest.approx(4.0)
    assert window.start == pytest.approx(2.0)


def test_stable_two_period_window_accepts_two_matching_periods_with_frames(tmp_path: Path):
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f=5.0, n=500, dt=0.002)
    frame_times = [0.6 + i * (0.4 / 40) for i in range(41)]

    result = stable_two_period_window(
        coeff,
        speed=25.0,
        chord=1.0,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )

    assert result.ok
    assert result.stable
    assert result.cycles == 2
    assert result.period_s == pytest.approx(0.2, rel=0.03)
    assert result.frames_per_cycle >= 20


def test_stable_two_period_window_requires_animation_frames(tmp_path: Path):
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f=5.0, n=500, dt=0.002)

    result = stable_two_period_window(
        coeff,
        speed=25.0,
        chord=1.0,
        frame_times=[0.6, 0.8, 1.0],
        min_frames_per_cycle=20,
    )

    assert not result.ok
    assert result.stable
    assert "frames/cycle" in result.reason


def _history(t0, t1, st=0.6634408650015379, n=400, cl_rms=0.05, cd_rms=0.01):
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    return ForceHistory(
        t=ts,
        cl=[0.7] * n,
        cd=[0.3] * n,
        cm=[-0.1] * n,
        cl_mean=0.7,
        cl_rms=cl_rms,
        cd_mean=0.3,
        cd_rms=cd_rms,
        cm_mean=-0.1,
        cm_rms=0.0,
        shedding_freq_hz=st * 7.303255616469686,
        strouhal=st,
        samples=n,
        period_s=1.0 / (st * 7.303255616469686) if st else None,
        retained_cycles=7 if st else None,
        window_start=t0,
        window_end=t1,
    )


def _make_time_dirs(case_dir, times):
    for t in times:
        (case_dir / f"{t:.12g}").mkdir(parents=True, exist_ok=True)


def test_urans_quality_flags_current_sparse_animation_case(tmp_path):
    speed = 7.303255616469686
    hist = _history(221.01577688779508, 224.1077570847098)
    times = [220.0 + (224.1077570847098 - 220.0) * i / 48 for i in range(49)]
    times.append(224.1077570847098)
    _make_time_dirs(tmp_path, times)

    quality = evaluate_urans_quality(tmp_path, hist, speed=speed, chord=1.0)

    assert not quality.ok
    assert quality.can_refine
    assert quality.retained_cycles > 7
    assert quality.frames_per_cycle < 20
    assert "frames/cycle" in quality.reason


def test_urans_quality_passes_after_dense_refined_frames(tmp_path):
    speed = 7.303255616469686
    st = 0.6634408650015379
    period = 1.0 / (st * speed)
    hist = _history(10.0, 10.0 + 7.0 * period, st=st)
    times = [hist.t[0] + (hist.t[-1] - hist.t[0]) * i / 140 for i in range(141)]
    _make_time_dirs(tmp_path, times)

    quality = evaluate_urans_quality(tmp_path, hist, speed=speed, chord=1.0)

    assert quality.ok
    assert not quality.can_refine
    assert quality.retained_cycles == pytest.approx(7.0)
    assert quality.frames_per_cycle >= 20


def test_urans_frame_write_cadence_is_separate_from_quality_gate():
    assert pipeline.URANS_MIN_FRAMES_PER_CYCLE == pytest.approx(20.0)
    assert pipeline.URANS_FRAME_WRITE_PER_CYCLE == pytest.approx(30.0)


def test_refined_transient_timing_uses_measured_period():
    period = 0.2063864970944712
    timing = refined_transient_timing(
        measured_period_s=period,
        original_run_time_s=4.1077570847098,
        original_delta_t=0.00013692523615699336,
        discard_fraction=0.25,
    )

    assert timing.write_interval == pytest.approx(period / pipeline.URANS_FRAME_WRITE_PER_CYCLE)
    assert timing.delta_t == pytest.approx(min(0.00013692523615699336, period / 5000))
    assert timing.run_time_s >= (7 * period) / 0.75
    assert timing.max_delta_t <= timing.write_interval


def test_refined_transient_timing_can_use_safer_write_cadence():
    measured_period = 0.6384676775739064
    cadence_period = 1.0 / (0.75 * 7.5)
    timing = refined_transient_timing(
        measured_period_s=measured_period,
        original_run_time_s=1.0666666666666667,
        original_delta_t=0.00005333333333333333,
        discard_fraction=0.4,
        cadence_period_s=cadence_period,
    )

    assert timing.write_interval == pytest.approx(
        measured_period / pipeline.URANS_FRAME_WRITE_PER_CYCLE
    )
    assert timing.run_time_s >= (7 * measured_period) / 0.6
    assert (timing.run_time_s / timing.write_interval) == pytest.approx(
        round(timing.run_time_s / timing.write_interval)
    )


def test_urans_quality_missing_strouhal_does_not_refine(tmp_path):
    # Flat force history with no strouhal AND no fluctuation: a physically
    # steady (no-shedding) URANS. It must resolve as a valid steady-mean point,
    # never as a refinable shedding case (auto-refining it triggers the
    # degenerate refined-copy crash).
    hist = _history(0.0, 4.3, st=0.0, cl_rms=0.0, cd_rms=0.0)

    quality = evaluate_urans_quality(tmp_path, hist, speed=10.0, chord=1.0)

    assert quality.ok
    assert quality.no_shedding
    assert not quality.can_refine
    assert quality.measured_period_s is None
    assert "no vortex shedding" in quality.reason


def test_vtu_selector_returns_final_retained_window(tmp_path):
    vtk = tmp_path / "VTK"
    period = 0.2
    final_time = 12.0
    start = final_time - 7 * period
    for i in range(240):
        t = 8.0 + (final_time - 8.0) * i / 239
        d = vtk / f"transient_{t:.6f}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text("")

    selected = select_vtus(find_all_vtus(tmp_path), start_time=start, end_time=final_time, max_frames=140)
    selected_times = [float(p.parent.name.split("_")[-1]) for p in selected]

    assert len(selected) <= 140
    assert selected_times[0] >= start
    assert selected_times[-1] <= final_time
    assert selected_times[-1] - selected_times[0] == pytest.approx(7 * period, rel=0.03)


def test_vtu_selector_uses_physical_time_for_foam_index_dirs(tmp_path):
    vtk = tmp_path / "VTK"
    for index, t in enumerate((606.0, 606.5, 607.0), start=2000):
        d = vtk / f"case_{index}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text(
            f"<?xml version='1.0'?>\n<!-- time='{t}' index='{index}' -->\n"
        )

    selected = select_vtus(find_all_vtus(tmp_path), start_time=606.4, end_time=607.1)

    assert [p.parent.name for p in selected] == ["case_2001", "case_2002"]


def _rans_outcome(
    aoa,
    *,
    converged=True,
    error=None,
    cl=0.4,
    cd=0.02,
    failure_disposition=FailureDisposition.none,
):
    return CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=aoa),
        reynolds=666_666,
        cl=cl,
        cd=cd,
        converged=converged,
        error=error,
        failure_disposition=failure_disposition,
    )


def test_core_rans_failure_aborts_whole_sweep_for_urans():
    hard = FailureDisposition.hard_solver
    assert should_abort_rans_sweep_for_urans(
        3.0, _rans_outcome(3.0, converged=False, failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        0.0, _rans_outcome(0.0, error="solver diverged", failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        5.0, _rans_outcome(5.0, cd=-0.01, failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        2.0, _rans_outcome(2.0, cl=math.nan, failure_disposition=hard)
    )


def test_rans_abort_rule_is_limited_to_attached_core_range():
    hard = FailureDisposition.hard_solver
    assert not should_abort_rans_sweep_for_urans(
        -1.0, _rans_outcome(-1.0, converged=False, failure_disposition=hard)
    )
    assert not should_abort_rans_sweep_for_urans(
        6.0, _rans_outcome(6.0, converged=False, failure_disposition=hard)
    )
    assert not should_abort_rans_sweep_for_urans(3.0, _rans_outcome(3.0, converged=True))


@pytest.mark.parametrize(
    "disposition",
    [FailureDisposition.deterministic_mesh, FailureDisposition.infrastructure],
)
def test_core_non_solver_failure_does_not_abort_whole_sweep(disposition):
    """FALSE-POSITIVE GUARD: rejected evidence in the attached range is not
    itself permission to spend a whole polar of URANS. Mesh and execution
    failures remain repair/retry work even when the point has no coefficients."""
    outcome = _rans_outcome(
        2.0,
        converged=False,
        # Deliberately solver-looking text: policy must use the typed field,
        # not accidentally promote because a launcher/mesh message contains
        # words such as "solver" or "diverged".
        error="simpleFoam solver diverged before force evidence",
        cl=None,
        cd=None,
        failure_disposition=disposition,
    )
    assert not should_abort_rans_sweep_for_urans(2.0, outcome)


def test_failure_disposition_serializes_on_engine_polar_point():
    from airfoilfoam.jobs import _outcome_to_point

    outcome = _rans_outcome(
        2.0,
        converged=False,
        failure_disposition=FailureDisposition.hard_solver,
    )
    payload = _outcome_to_point("engine-job", "polar/a0", outcome).model_dump(mode="json")

    assert payload["failure_disposition"] == "hard_solver"


def test_whole_polar_urans_replacement_reuses_shared_mesh(tmp_path, monkeypatch):
    from airfoilfoam import physics
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    shared_mesh = tmp_path / "mesh"
    seen_meshes = []

    def fake_run_case(
        case_dir,
        airfoil,
        spec,
        fluid,
        roughness,
        mesh_params,
        solver_params,
        mesher,
        runner,
        n_proc=1,
        render_images=True,
        solver_timeout=7200,
        mesh_dir=None,
        cancel_check=None,
        phase_progress=None,
        case_slug=None,
        media_budget_s=None,
    ):
        seen_meshes.append(mesh_dir)
        assert solver_params.force_transient
        assert solver_params.transient_auto_refine
        assert solver_params.urans_fidelity.value == "precalc"
        return CaseOutcome(
            spec=spec,
            reynolds=physics.reynolds(spec.speed, spec.chord, fluid.nu),
            cl=0.1 * spec.aoa_deg,
            cd=0.02,
            cl_cd=(0.1 * spec.aoa_deg) / 0.02,
            unsteady=True,
            converged=True,
            fidelity=f"urans_{solver_params.urans_fidelity.value}",
        )

    monkeypatch.setattr(pipeline, "run_case", fake_run_case)
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    points = _run_full_urans_replacement(
        tmp_path / "polar",
        shared_mesh,
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=fluid,
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=None,
        runner=None,
        aoas=[0.0, 2.0, 4.0],
    )

    assert len(points) == 3
    assert seen_meshes == [shared_mesh, shared_mesh, shared_mesh]
    assert all(p.outcome.unsteady for p in points)
    assert all(p.outcome.fidelity == "urans_precalc" for p in points)


@pytest.mark.parametrize(
    "failure",
    [
        RunResult(
            command="mpirun --use-hwthread-cpus -np 8 simpleFoam -parallel",
            returncode=124,
            stdout="Command timed out after 1200s",
            timed_out=True,
        ),
        RunResult(
            command="mpirun --use-hwthread-cpus -np 8 simpleFoam -parallel",
            returncode=1,
            stdout=(
                "There are not enough slots available in the system to satisfy "
                "the 8 slots that were requested"
            ),
        ),
        InsufficientMpiSlotsError(requested=8, available=4),
        DeterministicMeshError("checkMesh deterministic gate: negative-volume cells"),
    ],
    ids=[
        "solver-command-timeout",
        "openmpi-runtime-slot-refusal",
        "declared-capacity-refusal",
        "deterministic-mesh",
    ],
)
def test_marched_execution_or_mesh_failure_is_retained_but_never_promoted(
    tmp_path, monkeypatch, failure
):
    """MUST-CATCH: production-shaped timeout, MPI-capacity and deterministic
    mesh failures at 2 degrees stay evidence-only and cannot trigger the
    expensive whole-polar fallback."""
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(*_args, **_kwargs):
        if isinstance(failure, BaseException):
            raise failure
        return failure

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(
        pipeline,
        "_run_full_urans_replacement",
        lambda *_args, **_kwargs: pytest.fail("non-solver failure must not promote"),
    )

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "shared-mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert not result.promoted_to_urans
    assert result.points == []
    assert len(result.attempts) == 2
    first = result.attempts[0].outcome
    expected = (
        FailureDisposition.deterministic_mesh
        if isinstance(failure, DeterministicMeshError)
        else FailureDisposition.infrastructure
    )
    assert first.failure_disposition == expected


def test_marched_watchdog_divergence_is_hard_solver_failure_and_promotes(tmp_path, monkeypatch):
    """MUST-CATCH: a numerical divergence condemnation is aerodynamic/numerical
    solver evidence, unlike a timeout or launcher failure, so it promotes when
    it occurs in the inclusive 0..5 degree range."""
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(polar_dir, *_args, **_kwargs):
        pipeline.write_divergence_condemnation(
            polar_dir,
            "simpleFoam residuals and force coefficients diverged monotonically",
        )
        return RunResult(
            command="simpleFoam",
            returncode=143,
            stdout="watchdog terminated divergent solver",
            timed_out=False,
        )

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", lambda *_a, **_k: [])

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "shared-mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert result.promoted_to_urans
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome.failure_disposition == FailureDisposition.hard_solver


def test_marched_sweep_cancellation_is_not_promoted_to_urans(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(*_args, **_kwargs):
        raise JobCancelled("cancelled")

    def fake_urans(*_args, **_kwargs):
        raise AssertionError("cancelled RANS must not trigger URANS promotion")

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_urans)

    with pytest.raises(JobCancelled):
        solve_polar_marched(
            tmp_path / "polar",
            tmp_path / "mesh",
            airfoil=SimpleNamespace(),
            chord=1.0,
            speed=10.0,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            resolved=MeshParams(),
            solver_params=SolverParams(),
            mesher=SimpleNamespace(patches=lambda _resolved: {}),
            runner=SimpleNamespace(),
            aoas=[0.0, 2.0],
        )


def test_force_transient_accepts_missing_steady_coefficients(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeRunner:
        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, check=lambda: None)

    avg = SimpleNamespace(cl=0.45, cd=0.08, cm=-0.02, cl_cd=5.625, cl_std=0.01, cd_std=0.002, cm_std=0.001)

    def fake_transient(case_dir, *_args, **_kwargs):
        return TransientResult(
            avg=avg,
            case_dir=case_dir,
            force_history=None,
            quality=UransQuality(ok=True, can_refine=False, reason="ok"),
            start_time=0.0,
            end_time=1.0,
            run_time=1.0,
        )

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0), reynolds=666_666)

    _finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
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

    assert outcome.unsteady
    assert outcome.converged
    assert outcome.cl == pytest.approx(0.45)
    assert outcome.cd == pytest.approx(0.08)


def test_transient_attempt_accepts_force_coefficients_under_zero_folder(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, RoughnessParams, SolverParams

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs):
            pass

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)
            rows = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
            for i in range(20):
                t = 0.01 * (i + 1)
                rows.append(f"{t:.4f} 0.020 0 0 0.500 0 0 -0.010 0 0 0 0 0")
            coeff.write_text("\n".join(rows) + "\n")
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
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
        run_time=0.2,
        delta_t=0.001,
    )

    assert result is not None
    assert result.avg.cl == pytest.approx(0.5)
    assert result.avg.cd == pytest.approx(0.02)


def test_transient_attempt_early_stop_retains_gate_minimum_periods(tmp_path, monkeypatch):
    """Early stop fires only after URANS_STABLE_RETAINED_CYCLES (+margin)
    periods of certified-stable data exist past the FIRST stable window start,
    so early-stopped points retain >= the node acceptance gate (5 periods) —
    never the old 2-period stop the classifier deterministically rejected."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, RoughnessParams, SolverParams

    period = 0.2  # f = 5 Hz

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, case_dir, *_args, **_kwargs):
            system = case_dir / "system"
            system.mkdir(parents=True, exist_ok=True)
            (system / "controlDict").write_text(
                "stopAt endTime;\nendTime 3;\nwriteInterval 0.1;\nmaxDeltaT 0.1;\nrunTimeModifiable true;\n"
            )

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)

            def grow_to(t_end: float) -> None:
                n = int(round(t_end / 0.002))
                _write_coeff(coeff, f=5.0, n=n, dt=0.002, cl0=0.7, cd0=0.2)
                i = 0
                while 0.6 + i * 0.005 <= t_end + 1e-9:
                    (case_dir / f"{0.6 + i * 0.005:.6f}").mkdir(parents=True, exist_ok=True)
                    i += 1

            # First poll: stable two-period window detected (window start
            # ~t=0.8) but retention target not reached -> NO stop yet.
            grow_to(1.2)
            if monitor is not None:
                monitor()
            assert not (case_dir / "urans_early_stop.json").exists()
            # Data accumulates past stable_since + (5 + 0.5) periods -> stop.
            grow_to(2.2)
            if monitor is not None:
                monitor()
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=25.0, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=3.0,
        delta_t=0.001,
    )

    assert result is not None
    assert result.early_stopped
    marker = pipeline._read_early_stop_marker(tcase)
    assert marker is not None
    # retain_from = start of the FIRST certified-stable window.
    assert isinstance(marker.get("retain_from"), float)
    assert result.force_history is not None
    # Retention floor: the early stop must never retain fewer whole periods
    # than the node gate (packages/core FRAME_TRACK_MIN_PERIODS = 5).
    assert result.force_history.retained_cycles == int(pipeline.URANS_STABLE_RETAINED_CYCLES)
    assert result.force_history.retained_cycles >= 5
    assert result.quality.ok
    assert result.quality.retained_cycles == pytest.approx(
        pipeline.URANS_STABLE_RETAINED_CYCLES, rel=0.05
    )
    assert "early-stop target met" in result.quality.reason


def test_marched_core_rans_failure_stops_rans_and_promotes_full_urans(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout: str):
            self.stdout = stdout

        def check(self):
            return self

    rans_aoas = []
    shared_mesh = tmp_path / "shared-mesh"
    requested_aoas = [-1.0, 0.0, 1.0, 2.0, 6.0]

    def fake_cold(*args, **kwargs):
        spec = args[5]
        rans_aoas.append(spec.aoa_deg)
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(_polar_dir, spec, *_args, **_kwargs):
        rans_aoas.append(spec.aoa_deg)
        if spec.aoa_deg == 0.0:
            return FakeRunResult("Time = 2\n")
        return FakeRunResult("Time = 2\nSIMPLE solution converged in 1 iterations\n")

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1 * outcome.spec.aoa_deg
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = outcome.cl / outcome.cd

    def fake_full_urans(
        polar_dir,
        mesh_dir,
        _airfoil,
        chord,
        speed,
        _fluid,
        _roughness,
        _resolved,
        _solver_params,
        _mesher,
        _runner,
        aoas,
        **_kwargs,
    ):
        assert mesh_dir == shared_mesh
        assert list(aoas) == sorted(requested_aoas)
        points = []
        for i, aoa in enumerate(sorted(aoas)):
            outcome = CaseOutcome(
                spec=CaseSpec(chord=chord, speed=speed, aoa_deg=aoa),
                reynolds=666_666,
                cl=0.2 * aoa,
                cd=0.03,
                cm=0.0,
                cl_cd=(0.2 * aoa) / 0.03,
                unsteady=True,
                converged=True,
            )
            points.append(pipeline.StoredCaseOutcome(slug=f"{polar_dir.name}/urans_a{i}", outcome=outcome))
        return points

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_full_urans)

    result = solve_polar_marched(
        tmp_path / "polar",
        shared_mesh,
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=requested_aoas,
        render_images=False,
    )

    assert rans_aoas == [-1.0, 0.0]
    assert result.promoted_to_urans
    assert "switching the whole polar to URANS" in result.abort_reason
    assert [p.outcome.spec.aoa_deg for p in result.attempts] == [-1.0, 0.0]
    assert [p.outcome.spec.aoa_deg for p in result.points] == sorted(requested_aoas)
    assert all(p.outcome.unsteady for p in result.points)


def test_marched_primary_rans_honors_profile_iterations_and_short_timeout(tmp_path, monkeypatch):
    """The PRIMARY steady RANS stage runs the profile's full n_iterations
    budget (the worker-side rans_max_iterations cap is scoped to URANS-init
    steady stages; 2026-07-07 gate incident: profile n_iterations=3000 ran
    with controlDict endTime 600) while still using the short RANS wall-clock
    timeout; the promoted URANS replacement keeps the guard timeout."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout: str):
            self.stdout = stdout

        def check(self):
            return self

    rans_timeouts = []
    rans_iterations = []
    urans_timeout = None

    def fake_cold(*args, **_kwargs):
        rans_timeouts.append(args[10])
        rans_iterations.append(args[8].n_iterations)
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(*args, **_kwargs):
        rans_timeouts.append(args[4])
        rans_iterations.append(args[2].n_iterations)
        return FakeRunResult("Time = 2\n")

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = 5.0

    def fake_full_urans(*_args, **kwargs):
        nonlocal urans_timeout
        urans_timeout = kwargs["solver_timeout"]
        return []

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_full_urans)

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(n_iterations=3000),
        mesher=FakeMesher(),
        runner=None,
        aoas=[0.0, 1.0],
        render_images=False,
        solver_timeout=7200,
        rans_solver_timeout=123,
        rans_max_iterations=456,
    )

    assert result.promoted_to_urans
    assert rans_timeouts == [123, 123]
    # MUST-CATCH (gate incident): the worker cap (456 here, 600 in prod) must
    # NOT shrink the primary steady budget below the profile's n_iterations.
    assert rans_iterations == [3000, 3000]
    assert urans_timeout == 7200


def test_rejected_non_core_rans_with_force_data_ships_honest_points(tmp_path, monkeypatch):
    """MUST-CATCH (2026-07-07 ladder-gate incident, job a2379532): a
    non-converged steady RANS point that produced REAL force data ships as an
    honest point (converged=false) instead of silently vanishing into the
    attempts bucket — a fully-non-converged (e.g. single-point) job must never
    ship points=[] / "All cases failed" when force data exists."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True
        stdout = "Time = 1\n"

        def check(self):
            return self

    def fake_cold(*_args, **_kwargs):
        return FakeRunResult()

    def fake_warm(*_args, **_kwargs):
        return FakeRunResult()

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.2
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = 10.0
        outcome.converged = False

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_publish_steady_seed", lambda *a, **k: pytest.fail(
        "a rejected (non-converged) steady point must never publish a warm-start seed"
    ))

    accepted_flags = []

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=[-1.0, 6.0],
        render_images=False,
        outcome_progress=lambda _stored, accepted: accepted_flags.append(accepted),
    )

    assert not result.promoted_to_urans
    # Honest points ship (converged=false) AND stay in attempts as evidence.
    assert [p.outcome.spec.aoa_deg for p in result.points] == [-1.0, 6.0]
    assert all(not p.outcome.converged for p in result.points)
    assert all(p.outcome.error is None for p in result.points)
    assert [p.outcome.spec.aoa_deg for p in result.attempts] == [-1.0, 6.0]
    # Each outcome is recorded first as an attempt, then as an accepted point.
    assert accepted_flags == [False, True, False, True]


def test_missing_coefficient_evidence_is_infrastructure_and_never_promotes(
    tmp_path, monkeypatch
):
    """MUST-CATCH: a true crash (no coefficient data at all — _finalize_outcome
    raises) keeps the pre-existing behavior: evidence-only attempt with a
    truthful error, honestly ABSENT from the polar points."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams
    from airfoilfoam.openfoam.runner import OpenFOAMError

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True
        stdout = "Time = 1\n"

        def check(self):
            return self

    monkeypatch.setattr(pipeline, "_solve_cold_marched", lambda *a, **k: FakeRunResult())
    monkeypatch.setattr(pipeline, "_solve_warm", lambda *a, **k: FakeRunResult())

    def fake_finalize(_case_dir, _outcome, *_args, **_kwargs):
        raise OpenFOAMError("forceCoeffs produced no coefficient.dat")

    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert not result.promoted_to_urans
    assert result.points == []
    assert len(result.attempts) == 2
    assert all(
        item.outcome.failure_disposition == FailureDisposition.infrastructure
        for item in result.attempts
    )
    assert all("no coefficient.dat" in item.outcome.error for item in result.attempts)
