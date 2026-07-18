"""In-run march-rate guard (hopeless-march early stop) — recall-proven.

Prod 2026-07-09 (job 571efe9f, s1223 c1 u50 @ Re 3.4M, precalc tier): the
transient reached t=0.0094 s of the 0.4 s chunk target in the FULL 7200 s
budget (~85 h projected). No shedding cycle completed, so the between-chunks
period-based projection guard never engaged and the budget burned blind.

MUST-CATCH classes covered here, shaped like that real breakage (not like the
detector's implementation):
  1. hopeless march (rate projects >3x budget) is stopped early through the
     REAL heartbeat check + kill path, with a truthful marker;
  2. a march-stopped chunk grades as a CONTINUABLE budget stop (the pinned
     cross-runtime marker) and its saved case state stages for continuation.
FALSE-POSITIVE guards: warmup, dt-ramp-then-recovery, feasible-but-slow runs
(< 3x), completed chunks, un-armed (steady) segments, and retry re-arming.
"""
from __future__ import annotations

import math
import signal
import time as time_mod
from pathlib import Path
from types import SimpleNamespace

from airfoilfoam import pipeline, tasks
from airfoilfoam.config import Settings
from airfoilfoam.models import (
    CaseSpec,
    FluidProperties,
    JobPhase,
    JobState,
    JobStatus,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import (
    MARCH_BUDGET_MARKER_FILENAME,
    MARCH_STOP_MARKER_FILENAME,
    URANS_BUDGET_STOP_MARKER,
    _run_transient_attempt,
    read_march_budget_marker,
    read_march_stop,
    stage_continuation_case,
    write_march_budget_marker,
    write_march_stop,
    write_transient_start_marker,
)
from airfoilfoam.storage import JobStore
from airfoilfoam.tasks import (
    MARCH_HOPELESS_FACTOR,
    MARCH_TRAIL_MIN_SPAN_S,
    MARCH_WARMUP_WALL_S,
    MarchRateWatchdog,
)

#: Prod-shaped hopeless class: s1223 c=1 m u=50 m/s — 0.0094 s simulated in
#: 7200 s wall => ~1.3e-6 simulated-seconds per wall-second.
HOPELESS_RATE = 1.3e-6
#: Feasible-but-slow: projects within MARCH_HOPELESS_FACTOR of the budget.
FEASIBLE_RATE = 2.0e-5
END_T = 0.4
BUDGET_S = 14400.0

SPEC = CaseSpec(chord=0.1, speed=25.0, aoa_deg=15.0)
FLUID = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
PERIOD_S = 0.02

_HEADER = "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"


def _write_coeff(path: Path, t_rows: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# forceCoeffs forceCoeffs1 write:", _HEADER]
    for t in t_rows:
        cl = 0.7 + 0.05 * math.sin(2 * math.pi * t / PERIOD_S)
        lines.append(f"{t:.10g}\t0.02\t0\t0\t{cl:.8g}\t0\t0\t-0.01\t0\t0\t0\t0\t0")
    path.write_text("\n".join(lines) + "\n")


def _coeff_rows_text(t_start: float, t_end: float, dt: float = 0.0005) -> str:
    lines = [_HEADER]
    t = t_start
    while t <= t_end + 1e-12:
        cl = 0.7 + 0.05 * math.sin(2 * math.pi * t / PERIOD_S)
        lines.append(f"{t:.10g} 0.02 0 0 {cl:.8g} 0 0 -0.01 0 0 0 0 0")
        t += dt
    return "\n".join(lines) + "\n"


def _write_time_dir(case: Path, name: str) -> None:
    d = case / name
    d.mkdir(parents=True, exist_ok=True)
    for f in ("U", "p", "k", "omega", "nut"):
        (d / f).write_text(f"saved {f} at {name}")


# --------------------------------------------------------------------------- #
# Pure verdict logic
# --------------------------------------------------------------------------- #


def _feed(wd: MarchRateWatchdog, rate: float, *, wall_start: float = 0.0,
          t0_sim: float = 0.0, beats: int = 60, beat_s: float = 60.0,
          start_beat: int = 0, key: str = "seg") -> list:
    """Feed realistic heartbeat samples at a fixed march rate; collect verdicts."""
    verdicts = []
    for i in range(start_beat, start_beat + beats):
        now = wall_start + beat_s * (i + 1)
        t_sim = t0_sim + rate * (now - wall_start)
        verdicts.append(
            wd.observe(key, t_sim, now, end_t=END_T, budget_s=BUDGET_S,
                       wall_start=wall_start, stop_marker_present=False)
        )
    return verdicts


def test_must_catch_prod_shaped_hopeless_march_is_stopped():
    """The s1223 Re-3.4M shape: without this guard the run burns its entire
    budget blind (the period projection guard needs a shedding cycle it will
    never get). The verdict must arrive shortly after warmup, not at the wall."""
    wd = MarchRateWatchdog()
    verdicts = _feed(wd, HOPELESS_RATE, beats=60)
    fired = [v for v in verdicts if v is not None]
    assert fired, "hopeless march never stopped — the budget would burn blind"
    first_fire_wall = (verdicts.index(fired[0]) + 1) * 60.0
    # Early, honest stop: within warmup + trailing-span latency + a few beats,
    # nowhere near the 4 h budget wall.
    assert first_fire_wall <= MARCH_WARMUP_WALL_S + MARCH_TRAIL_MIN_SPAN_S + 300.0
    assert "march-rate guard" in fired[0]
    assert "restartable state" in fired[0]
    assert f">{MARCH_HOPELESS_FACTOR:g}x" in fired[0]


def test_never_judges_during_warmup():
    wd = MarchRateWatchdog()
    beats = int(MARCH_WARMUP_WALL_S / 60.0) - 1
    verdicts = _feed(wd, HOPELESS_RATE, beats=beats)
    assert all(v is None for v in verdicts)


def test_dt_ramp_recovery_is_not_condemned():
    """Realistic adaptive-dt startup: crawl for the first 15 min, then the dt
    ramp completes and the march runs at a healthy rate. The trailing window
    sees only the recovered rate at judgment time — no stop."""
    wd = MarchRateWatchdog()
    slow_until = 900.0
    healthy_rate = END_T / (0.5 * BUDGET_S)  # finishes in half the budget
    for i in range(80):
        now = 60.0 * (i + 1)
        if now <= slow_until:
            t_sim = HOPELESS_RATE * now
        else:
            t_sim = HOPELESS_RATE * slow_until + healthy_rate * (now - slow_until)
        verdict = wd.observe("seg", t_sim, now, end_t=END_T, budget_s=BUDGET_S,
                             wall_start=0.0, stop_marker_present=False)
        assert verdict is None, f"healthy recovered march condemned at wall={now}s"


def test_feasible_but_over_budget_march_is_left_to_the_wall():
    """A run projecting past its budget but under the hopeless factor must NOT
    be stopped: it grades honestly at the budget wall and one continuation
    finishes it."""
    wd = MarchRateWatchdog()
    # Projects ~END_T/FEASIBLE_RATE = 20000 s ≈ 1.4x budget: over, not hopeless.
    verdicts = _feed(wd, FEASIBLE_RATE, beats=100)
    assert all(v is None for v in verdicts)


def test_completed_chunk_is_never_judged():
    wd = MarchRateWatchdog()
    now = MARCH_WARMUP_WALL_S + MARCH_TRAIL_MIN_SPAN_S + 600.0
    verdict = wd.observe("seg", END_T + 1e-6, now, end_t=END_T, budget_s=BUDGET_S,
                         wall_start=0.0, stop_marker_present=False)
    assert verdict is None


def test_fresh_chunk_rearm_resets_state():
    """A new chunk rewrites march_budget.json with a new wall_start: the stale
    samples and any stopped verdict from the previous chunk must not leak."""
    wd = MarchRateWatchdog()
    fired = [v for v in _feed(wd, HOPELESS_RATE, beats=60) if v is not None]
    assert fired
    # Same segment key, NEW wall_start (fresh chunk): verdict resets, warmup
    # applies again even though the old state was condemned.
    new_start = 10_000.0
    verdicts = _feed(wd, HOPELESS_RATE, wall_start=new_start, beats=20, key="seg")
    assert all(v is None for v in verdicts[: int(MARCH_WARMUP_WALL_S / 60.0) - 1])


def test_zero_rate_is_left_to_the_stall_and_divergence_watchdogs():
    wd = MarchRateWatchdog()
    for i in range(80):
        now = 60.0 * (i + 1)
        verdict = wd.observe("seg", 0.005, now, end_t=END_T, budget_s=BUDGET_S,
                             wall_start=0.0, stop_marker_present=False)
        assert verdict is None


# --------------------------------------------------------------------------- #
# Heartbeat-level: the REAL check + kill path over a prod-shaped job dir
# --------------------------------------------------------------------------- #


def _running(job_id: str, phase: JobPhase) -> JobStatus:
    return JobStatus(job_id=job_id, state=JobState.running, phase=phase)


def test_heartbeat_stops_hopeless_case_and_spares_healthy_and_unarmed(tmp_path, monkeypatch):
    import os

    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "j-march"
    store.write_status(_running(job_id, JobPhase.solving_urans))
    job_dir = store.job_dir(job_id)
    hopeless = job_dir / "cases" / "c1_u50_a25" / "transient"
    healthy = job_dir / "cases" / "c0p1_u25_a15" / "transient"
    unarmed = job_dir / "cases" / "c0p1_u25_a10" / "transient"  # steady: no marker

    base = time_mod.time()
    chunk_started = base - 1500.0  # 25 min into the chunk when observation begins
    write_march_budget_marker(hopeless, end_t=END_T, budget_s=BUDGET_S, wall_start=chunk_started)
    write_march_budget_marker(healthy, end_t=END_T, budget_s=BUDGET_S, wall_start=chunk_started)

    monkeypatch.setattr(
        JobStore,
        "job_process_details",
        lambda self, jid: [
            {"pid": 111, "cwd": str(hopeless), "command": "pimpleFoam", "solver_mode": "urans"},
            {"pid": 222, "cwd": str(healthy), "command": "pimpleFoam", "solver_mode": "urans"},
            {"pid": 333, "cwd": str(unarmed), "command": "simpleFoam", "solver_mode": "rans"},
        ],
    )
    kills: list[tuple[list[int], int]] = []
    monkeypatch.setattr(tasks, "_kill_pids", lambda pids, sig: kills.append((list(pids), sig)))

    wd = MarchRateWatchdog()
    healthy_rate = END_T / (0.5 * BUDGET_S)
    coeffs = {
        hopeless: (hopeless / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat", HOPELESS_RATE),
        healthy: (healthy / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat", healthy_rate),
        unarmed: (unarmed / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat", HOPELESS_RATE),
    }
    stopped_at_beat = None
    for i in range(40):
        now = base + 60.0 * i
        for case, (path, rate) in coeffs.items():
            elapsed = now - chunk_started
            ts = [elapsed * rate - k * 1e-5 * rate for k in range(5, -1, -1)]
            _write_coeff(path, [max(t, 0.0) for t in ts])
            os.utime(path, (now, now))  # live segment at synthetic 'now'
        tasks._check_and_stop_hopeless_march(store, job_id, wd, now=now)
        if read_march_stop(hopeless) is not None and stopped_at_beat is None:
            stopped_at_beat = i
    reason = read_march_stop(hopeless)
    assert reason is not None and "march-rate guard" in reason
    assert stopped_at_beat is not None and stopped_at_beat * 60.0 <= (
        MARCH_WARMUP_WALL_S - 1500.0
    ) + MARCH_TRAIL_MIN_SPAN_S + 300.0
    # Only the hopeless case's solver was killed, SIGTERM first, then SIGKILL
    # escalation on the following beats; the healthy and un-armed cases run on.
    assert kills[0] == ([111], signal.SIGTERM)
    assert all(pids == [111] for pids, _sig in kills)
    assert any(sig == signal.SIGKILL for _pids, sig in kills[1:])
    assert read_march_stop(healthy) is None
    assert read_march_stop(unarmed) is None


def test_heartbeat_ignores_non_solving_phases(tmp_path, monkeypatch):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "j-idle"
    store.write_status(JobStatus(job_id=job_id, state=JobState.running, phase=JobPhase.postprocessing))
    monkeypatch.setattr(JobStore, "job_process_details", lambda self, jid: [])
    tasks._check_and_stop_hopeless_march(store, job_id, MarchRateWatchdog())  # no crash, no-op


# --------------------------------------------------------------------------- #
# Grading seam: a march-stopped chunk is a CONTINUABLE budget stop
# --------------------------------------------------------------------------- #


def _transient_case(tmp_path: Path) -> tuple[Path, Path]:
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
    return case_dir, tcase


def test_must_catch_march_stopped_chunk_grades_continuable(tmp_path, monkeypatch):
    """Real breakage shape: the heartbeat guard SIGTERMs pimpleFoam mid-chunk
    (rc 143, NOT a timeout rc) after writing fields at t=0.009. Without the
    march-stop routing this returns None => 'All cases failed' with NO
    continuation offer. It must grade as an honest partial with the pinned
    continuable marker AND the guard's projection evidence, and the case must
    stage for continuation."""

    class FakeCaseBuilder:
        def __init__(self, *_a, **_k):
            pass

        def write_transient(self, *_a, **_k) -> None:
            pass

    stop_reason = (
        "march-rate guard: at t=0.009s of 0.4s after 32 min, the trailing "
        "simulated-time rate 1.3e-06 s/s projects ~85.0h total wall vs the "
        "4.0h budget (>3x) — stopping the hopeless march early with restartable state"
    )

    class MarchStoppedRunner:
        def solver(self, cdir, *_a, monitor=None, **_k):
            cdir = Path(cdir)
            # The attempt must have ARMED the guard before launching.
            armed = read_march_budget_marker(cdir)
            assert armed is not None and armed["end_t"] == 0.3 and armed["budget_s"] == BUDGET_S
            # And cleared the STALE stop verdict from the previous attempt.
            assert read_march_stop(cdir) is None
            seg = cdir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows_text(0.0005, 0.009))
            _write_time_dir(cdir, "0.009")
            write_march_stop(cdir, stop_reason)  # the heartbeat's verdict
            return SimpleNamespace(
                ok=False, returncode=143, timed_out=False,
                stdout="deltaT = 1e-06\nTime = 0.009\n",  # SIGTERM'd, no timeout line
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    case_dir, tcase = _transient_case(tmp_path)
    (tcase / MARCH_STOP_MARKER_FILENAME).write_text('{"reason": "stale verdict from attempt 1"}')

    result = _run_transient_attempt(
        tcase,
        airfoil=None, tmesh=None, patches={},
        spec=CaseSpec(chord=1.0, speed=50.0, aoa_deg=25.0),
        fluid=FLUID, roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, urans_min_periods=3),
        runner=MarchStoppedRunner(),
        n_proc=1,
        timeout=BUDGET_S,
        run_time=0.3,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )

    assert result is not None, "march-stopped chunk fell through to a hard failure"
    assert not result.quality.ok and not result.quality.can_refine
    assert "stopped early" in result.quality.reason
    assert "march-rate guard" in result.quality.reason
    # Cross-runtime recall: the node continuable predicate matches THIS literal.
    assert URANS_BUDGET_STOP_MARKER in result.quality.reason
    # The stopped case IS continuable: staging resumes from the killed fields.
    source = stage_continuation_case(case_dir, tmp_path / "staged")
    assert source.resume_from == 0.009
    staged = tmp_path / "staged" / "transient"
    assert (staged / "0.009" / "U").is_file()
    # Neither guard marker travels into the staged continuation.
    assert not (staged / MARCH_BUDGET_MARKER_FILENAME).exists()
    assert not (staged / MARCH_STOP_MARKER_FILENAME).exists()


def test_clean_run_grades_normally_despite_stale_stop_marker(tmp_path, monkeypatch):
    """False-positive guard at the seam: a FRESH attempt over a case whose
    previous attempt was march-stopped must not inherit the stale verdict —
    a successful solver pass grades on its own quality, no budget-stop text."""

    class FakeCaseBuilder:
        def __init__(self, *_a, **_k):
            pass

        def write_transient(self, *_a, **_k) -> None:
            pass

    class CleanRunner:
        def solver(self, cdir, *_a, monitor=None, **_k):
            cdir = Path(cdir)
            seg = cdir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows_text(0.0005, 0.3))
            _write_time_dir(cdir, "0.3")
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="Time = 0.3\nEnd\n")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    _case_dir, tcase = _transient_case(tmp_path)
    (tcase / MARCH_STOP_MARKER_FILENAME).write_text('{"reason": "stale verdict"}')

    result = _run_transient_attempt(
        tcase,
        airfoil=None, tmesh=None, patches={},
        spec=SPEC, fluid=FLUID, roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, urans_min_periods=3),
        runner=CleanRunner(),
        n_proc=1,
        timeout=BUDGET_S,
        run_time=0.3,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )
    assert result is not None
    assert URANS_BUDGET_STOP_MARKER not in result.quality.reason
    assert "march-rate guard" not in result.quality.reason
