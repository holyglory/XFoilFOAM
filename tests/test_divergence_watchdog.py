"""In-run divergence watchdog: condemn diverging solves, spare physical ones.

Prod incident 2026-07-07 (job b01a7d46, naca-0012 a0 u15): long-horizon URANS
at Co=15 accumulated splitting error into a velocity singularity — |Cl|
excursions ±9.45e5, dt collapse 8e-6 → 5e-8, simulated time frozen at 0.069 s
for the whole 7200 s wall budget. The watchdog must catch BOTH divergence
shapes (coefficient blow-up, persistent dt collapse) and must NEVER condemn
physical post-stall high lift or a legitimate small-dt startup ramp.

Recall proof: the must-catch fixtures below are shaped like the production
coefficient.dat blow-up (real forceCoeffs header, adaptive dt rows, exploding
excursions with sign flips) — not like the detector's implementation.
"""
from __future__ import annotations

import math
import signal
import time as time_mod
from pathlib import Path

import numpy as np
import pytest

from airfoilfoam import tasks
from airfoilfoam.config import Settings
from airfoilfoam.models import JobPhase, JobState, JobStatus
from airfoilfoam.pipeline import (
    DIVERGENCE_MARKER_FILENAME,
    read_divergence_condemnation,
)
from airfoilfoam.storage import JobStore
from airfoilfoam.tasks import (
    DIVERGENCE_CL_CONSECUTIVE,
    DivergenceWatchdog,
    coefficient_tail,
)

_HEADER = (
    "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
)


def _write_coeff(path: Path, rows: list[tuple[float, float, float]]) -> None:
    """OpenFOAM-shaped coefficient.dat: (time, cd, cl) rows under the real header."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# forceCoeffs forceCoeffs1 write:",
        _HEADER,
    ]
    for t, cd, cl in rows:
        lines.append(f"{t:.10g}\t{cd:.8g}\t0\t0\t{cl:.8g}\t0\t0\t-0.01\t0\t0\t0\t0\t0")
    path.write_text("\n".join(lines) + "\n")


def _diverged_rows(t0: float = 0.069, n: int = 40) -> list[tuple[float, float, float]]:
    """Prod-shaped blow-up: dt collapsed to ~5e-8, |Cl| excursions to ±9.45e5
    with sign flips, huge non-physical Cd."""
    rows = []
    rng = np.random.default_rng(7)
    for i in range(n):
        t = t0 + 5e-8 * i
        cl = float(((-1) ** i) * rng.uniform(5e4, 9.45e5))
        cd = float(rng.uniform(1e3, 8e5))
        rows.append((t, cd, cl))
    return rows


def _post_stall_rows(t0: float = 0.2, n: int = 400) -> list[tuple[float, float, float]]:
    """Physical deep-stall shedding: Cl oscillates 1.2 ± 1.8 (peaks near |Cl|~3),
    Cd 0.4 ± 0.3, healthy adaptive dt ~2e-4."""
    rows = []
    for i in range(n):
        t = t0 + 2e-4 * i
        phase = 2 * math.pi * t / 0.02
        rows.append((t, 0.4 + 0.3 * math.sin(phase + 0.7), 1.2 + 1.8 * math.sin(phase)))
    return rows


def _watchdog(**overrides) -> DivergenceWatchdog:
    kwargs = dict(cl_bound=50.0, dt_floor=1e-7, grace_s=300.0)
    kwargs.update(overrides)
    return DivergenceWatchdog(**kwargs)


def _tail(rows: list[tuple[float, float, float]], tmp_path: Path, name="coefficient.dat"):
    path = tmp_path / "postProcessing" / "forceCoeffs1" / "0.05" / name
    _write_coeff(path, rows)
    return coefficient_tail(path)


# --------------------------------------------------------------------------- #
# coefficient_tail parsing
# --------------------------------------------------------------------------- #


def test_coefficient_tail_reads_time_and_cl_columns(tmp_path):
    rows = _post_stall_rows(n=50)
    tail = _tail(rows, tmp_path)
    assert len(tail) == 20  # last ~20 rows only
    assert tail[-1][0] == pytest.approx(rows[-1][0])
    assert tail[-1][1] == pytest.approx(rows[-1][2], rel=1e-6)
    # empty / missing files never crash the heartbeat
    assert coefficient_tail(tmp_path / "missing.dat") == []
    empty = tmp_path / "empty.dat"
    empty.write_text(f"{_HEADER}\n")
    assert coefficient_tail(empty) == []


def test_coefficient_tail_reads_only_tail_of_large_file(tmp_path):
    # a long march: 20k rows; the tail read must still see the newest rows
    rows = [(0.001 * i, 0.05, 0.7) for i in range(20000)]
    rows[-1] = (rows[-1][0], 0.05, 1.234)
    tail = _tail(rows, tmp_path)
    assert tail[-1][1] == pytest.approx(1.234)


# --------------------------------------------------------------------------- #
# MUST-CATCH: both advertised divergence classes
# --------------------------------------------------------------------------- #


def test_condemns_prod_shaped_cl_blowup_after_three_consecutive_beats(tmp_path):
    wd = _watchdog()
    tail = _tail(_diverged_rows(), tmp_path)
    now = time_mod.time()
    verdicts = [wd.observe("seg", tail, now + 10.0 * i) for i in range(DIVERGENCE_CL_CONSECUTIVE)]
    assert verdicts[:-1] == [None, None]  # sustained, not instant
    reason = verdicts[-1]
    assert reason is not None
    assert reason.startswith("transient diverged at t=0.069")
    assert "|Cl|=" in reason and "dt=5e-08" in reason


def test_condemns_persistent_dt_collapse_after_grace(tmp_path):
    # dt collapse WITHOUT insane coefficients (frozen-time failure mode):
    # moderate |Cl| but dt pinned at 5e-8 for the whole grace window.
    rows = [(0.069 + 5e-8 * i, 0.05, 1.1) for i in range(40)]
    tail = _tail(rows, tmp_path)
    wd = _watchdog()
    t0 = time_mod.time()
    # Beats every 10 s. The dt clock only starts after the 60 s startup grace
    # (measured from first observation), then must run the full 300 s grace:
    # condemnation lands at beat 36 (60 + 300 s), not a beat earlier.
    verdicts = [wd.observe("seg", tail, t0 + 10.0 * i) for i in range(37)]
    assert all(v is None for v in verdicts[:36])  # not before the grace elapses
    reason = verdicts[36]
    assert reason is not None
    assert "transient diverged at t=" in reason
    assert "dt=5e-08" in reason


# --------------------------------------------------------------------------- #
# FALSE-POSITIVE GUARDS (must never condemn)
# --------------------------------------------------------------------------- #


def test_never_condemns_post_stall_high_lift(tmp_path):
    wd = _watchdog()
    tail = _tail(_post_stall_rows(), tmp_path)
    t0 = time_mod.time()
    for i in range(720):  # 2 h of beats
        assert wd.observe("seg", tail, t0 + 10.0 * i) is None


def test_never_condemns_legitimate_startup_small_dt(tmp_path):
    """Tiny dt during the first 60 s that recovers is a normal startup ramp."""
    wd = _watchdog()
    t0 = time_mod.time()
    ramp = [(1e-8 * i, 0.05, 0.4) for i in range(30)]
    tail = _tail(ramp, tmp_path)
    for i in range(6):  # beats within the first 60 s: clock must not tick
        assert wd.observe("seg", tail, t0 + 10.0 * i) is None
    # dt recovers to a healthy value after startup
    healthy = [(3e-7 + 2e-4 * i, 0.05, 0.4) for i in range(40)]
    tail = _tail(healthy, tmp_path, name="c2.dat")
    for i in range(6, 200):
        assert wd.observe("seg", tail, t0 + 10.0 * i) is None


def test_dt_collapse_clock_resets_on_recovery(tmp_path):
    wd = _watchdog()
    t0 = time_mod.time()
    slow = _tail([(0.05 + 5e-8 * i, 0.05, 0.9) for i in range(40)], tmp_path, name="slow.dat")
    fast = _tail([(0.06 + 2e-4 * i, 0.05, 0.9) for i in range(40)], tmp_path, name="fast.dat")
    # 200 s below the floor (post-startup), then one recovered beat, then 290 s
    # below again: neither stretch alone reaches the 300 s grace.
    beats = [slow] * 20 + [fast] + [slow] * 29
    for i, tail in enumerate(beats):
        assert wd.observe("seg", tail, t0 + 100.0 + 10.0 * i) is None


def test_single_cl_spike_is_not_condemned(tmp_path):
    """One spurious excursion row must not kill a recovering solve."""
    wd = _watchdog()
    t0 = time_mod.time()
    spike = _tail([(0.1 + 2e-4 * i, 0.05, 80.0) for i in range(40)], tmp_path, name="s1.dat")
    normal = _tail([(0.11 + 2e-4 * i, 0.05, 1.4) for i in range(40)], tmp_path, name="s2.dat")
    assert wd.observe("seg", spike, t0) is None
    assert wd.observe("seg", spike, t0 + 10.0) is None
    for i in range(2, 100):  # recovered before the 3rd consecutive insane beat
        assert wd.observe("seg", normal, t0 + 10.0 * i) is None


def test_settings_defaults_pinned():
    s = Settings()
    assert s.divergence_cl_bound == pytest.approx(50.0)
    assert s.divergence_dt_floor == pytest.approx(1e-7)
    assert s.divergence_grace_minutes == pytest.approx(5.0)


# --------------------------------------------------------------------------- #
# Heartbeat integration: marker written, ONLY the diverging case's pids killed
# --------------------------------------------------------------------------- #


def _running(job_id: str, phase: JobPhase) -> JobStatus:
    return JobStatus(job_id=job_id, state=JobState.running, phase=phase)


def test_check_and_condemn_kills_case_and_writes_truthful_marker(tmp_path, monkeypatch):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "j-div"
    store.write_status(_running(job_id, JobPhase.solving_urans))
    job_dir = store.job_dir(job_id)
    bad_case = job_dir / "cases" / "c1_u15_a0" / "transient"
    good_case = job_dir / "cases" / "c1_u15_a4" / "transient"
    _write_coeff(
        bad_case / "postProcessing" / "forceCoeffs1" / "0.05" / "coefficient.dat",
        _diverged_rows(),
    )
    _write_coeff(
        good_case / "postProcessing" / "forceCoeffs1" / "0.05" / "coefficient.dat",
        _post_stall_rows(),
    )

    monkeypatch.setattr(
        JobStore,
        "job_process_details",
        lambda self, jid: [
            {"pid": 4321, "cwd": str(bad_case), "command": "pimpleFoam", "solver_mode": "urans"},
            {"pid": 5678, "cwd": str(good_case), "command": "pimpleFoam", "solver_mode": "urans"},
        ],
    )
    kills: list[tuple[list[int], int]] = []
    monkeypatch.setattr(tasks, "_kill_pids", lambda pids, sig: kills.append((list(pids), sig)))

    wd = _watchdog()
    now = time_mod.time()
    for i in range(DIVERGENCE_CL_CONSECUTIVE):
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)

    reason = read_divergence_condemnation(bad_case)
    assert reason is not None and reason.startswith("transient diverged at t=0.069")
    assert "|Cl|=" in reason and "dt=5e-08" in reason
    # only the diverging case's solver was killed, with SIGTERM first
    assert kills == [([4321], signal.SIGTERM)]
    # the healthy post-stall case is untouched
    assert read_divergence_condemnation(good_case) is None

    # next beat: escalation to SIGKILL for stragglers, marker not rewritten
    marker_mtime = (bad_case / DIVERGENCE_MARKER_FILENAME).stat().st_mtime
    tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 40.0)
    assert kills[-1] == ([4321], signal.SIGKILL)
    assert (bad_case / DIVERGENCE_MARKER_FILENAME).stat().st_mtime == marker_mtime


def test_check_and_condemn_only_monitors_solving_phases(tmp_path, monkeypatch):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "j-phase"
    job_dir = store.job_dir(job_id)
    case = job_dir / "cases" / "c1_u15_a0" / "transient"
    _write_coeff(
        case / "postProcessing" / "forceCoeffs1" / "0.05" / "coefficient.dat",
        _diverged_rows(),
    )
    monkeypatch.setattr(JobStore, "job_process_details", lambda self, jid: [])
    wd = _watchdog()
    now = time_mod.time()
    for phase in (JobPhase.postprocessing, JobPhase.meshing, JobPhase.waiting_cpu, JobPhase.ingesting):
        store.write_status(_running(job_id, phase))
        for i in range(5):
            tasks._check_and_condemn_divergence(store, job_id, wd, now=now + i * 10.0)
        assert read_divergence_condemnation(case) is None
    done = _running(job_id, JobPhase.solving_urans)
    done.state = JobState.completed
    store.write_status(done)
    tasks._check_and_condemn_divergence(store, job_id, wd, now=now)
    assert read_divergence_condemnation(case) is None


def test_stale_coefficient_segments_are_ignored(tmp_path):
    """A finished steady-init segment (old mtime) must not be observed at all."""
    job_dir = tmp_path / "job"
    coeff = job_dir / "cases" / "c1" / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_coeff(coeff, _diverged_rows())
    now = time_mod.time()
    assert tasks._live_coefficient_segments(job_dir, now) == [coeff]
    assert tasks._live_coefficient_segments(job_dir, now + 3600.0) == []


# --------------------------------------------------------------------------- #
# Retry re-arm: the pipeline clears the marker before a FRESH attempt that can
# reuse the SAME coefficient.dat path (steady upwind fallback rewrites
# forceCoeffs1/0/coefficient.dat; a condemned steady init's file stays live
# while pimpleFoam starts). The stale in-memory verdict must never kill the
# fresh attempt — but a re-armed attempt that diverges AGAIN must be caught.
# --------------------------------------------------------------------------- #


def _retry_fixture(tmp_path, monkeypatch):
    """One steady case whose 2nd-order attempt diverges; returns hooks shaped
    like the run_case upwind-fallback journey."""
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "j-retry"
    store.write_status(_running(job_id, JobPhase.solving_rans))
    case = store.job_dir(job_id) / "cases" / "c1_u15_a0"
    coeff = case / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_coeff(coeff, _diverged_rows())
    monkeypatch.setattr(
        JobStore,
        "job_process_details",
        lambda self, jid: [
            {"pid": 4321, "cwd": str(case), "command": "simpleFoam", "solver_mode": "rans"},
        ],
    )
    kills: list[tuple[list[int], int]] = []
    monkeypatch.setattr(tasks, "_kill_pids", lambda pids, sig: kills.append((list(pids), sig)))
    return store, job_id, case, coeff, kills


def test_upwind_retry_at_same_path_is_not_rekilled_by_stale_verdict(tmp_path, monkeypatch):
    """MUST-NOT-KILL: 2nd-order steady condemned -> run_case clears the marker
    and retries with upwind IN THE SAME case dir; forceCoeffs rewrites the SAME
    forceCoeffs1/0/coefficient.dat with healthy rows. The watchdog must give
    the retry a fresh verdict instead of re-killing it with the stale one."""
    from airfoilfoam.pipeline import clear_divergence_condemnation

    store, job_id, case, coeff, kills = _retry_fixture(tmp_path, monkeypatch)
    wd = _watchdog()
    now = time_mod.time()
    for i in range(DIVERGENCE_CL_CONSECUTIVE):
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)
    assert read_divergence_condemnation(case) is not None  # 2nd-order condemned
    kills.clear()

    # pipeline retry: clear marker; upwind simpleFoam rewrites the same file
    # with healthy rows (steady Time column restarts at iteration 1)
    clear_divergence_condemnation(case)
    _write_coeff(coeff, [(float(i + 1), 0.012, 0.31) for i in range(60)])
    for i in range(3, 3 + 720):  # 2 h of beats over the healthy retry
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)

    assert kills == []  # the healthy retry must never be killed
    assert read_divergence_condemnation(case) is None  # no stale re-condemnation


def test_cleared_marker_with_unchanged_dead_tail_never_recondemns(tmp_path, monkeypatch):
    """MUST-NOT-KILL: between marker clear and the retry's first coefficient
    write, the killed attempt's garbage rows are still on disk (mtime inside
    the live window). The unchanged dead tail must not be re-judged — the
    retry's potentialFoam/simpleFoam pids must survive."""
    from airfoilfoam.pipeline import clear_divergence_condemnation

    store, job_id, case, coeff, kills = _retry_fixture(tmp_path, monkeypatch)
    wd = _watchdog()
    now = time_mod.time()
    for i in range(DIVERGENCE_CL_CONSECUTIVE):
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)
    kills.clear()
    clear_divergence_condemnation(case)  # retry started; file NOT rewritten yet

    for i in range(3, 12):  # beats while the dead file is still 'live' (<120 s)
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)

    assert kills == []
    assert read_divergence_condemnation(case) is None


def test_rearmed_retry_that_diverges_again_is_recondemned(tmp_path, monkeypatch):
    """RECALL GUARD for the re-arm path: a fresh retry that blows up again must
    be condemned again (3 consecutive beats), not immunised by the reset."""
    from airfoilfoam.pipeline import clear_divergence_condemnation

    store, job_id, case, coeff, kills = _retry_fixture(tmp_path, monkeypatch)
    wd = _watchdog()
    now = time_mod.time()
    for i in range(DIVERGENCE_CL_CONSECUTIVE):
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)
    kills.clear()
    clear_divergence_condemnation(case)
    _write_coeff(coeff, _diverged_rows(t0=0.0731))  # retry diverges too (new rows)

    beats = []
    for i in range(3, 10):
        tasks._check_and_condemn_divergence(store, job_id, wd, now=now + 10.0 * i)
        beats.append(read_divergence_condemnation(case))

    # fresh verdict: condemned only after 3 NEW consecutive insane beats
    # (beat 3 resets state, beats 4-6 count) — and the retry pid is killed
    assert beats[0] is None
    assert any(b is not None for b in beats)
    assert ([4321], signal.SIGTERM) in kills
    reason = read_divergence_condemnation(case)
    assert reason is not None and "t=0.0731" in reason


# --------------------------------------------------------------------------- #
# Pipeline flow: condemned case fails with the truthful error through the
# EXISTING attempt path (never graded); stale markers never poison fresh runs
# --------------------------------------------------------------------------- #


class _FakeCaseBuilder:
    def __init__(self, *_args, **_kwargs):
        pass

    def write_transient(self, *_args, **_kwargs):
        pass


def _transient_attempt(tcase, runner):
    from airfoilfoam.models import CaseSpec, FluidProperties, RoughnessParams, SolverParams
    from airfoilfoam.pipeline import _run_transient_attempt

    return _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=15.0, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=runner,
        n_proc=1,
        timeout=7200,
        run_time=0.333,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )


def test_condemned_transient_raises_truthful_error_not_graded(tmp_path, monkeypatch):
    """When the watchdog kills pimpleFoam mid-run, the attempt must fail with
    the watchdog's 'transient diverged' message (flowing run_case's existing
    error path) — the garbage partial window must NEVER be graded like an
    honest timeout."""
    from types import SimpleNamespace

    from airfoilfoam import pipeline
    from airfoilfoam.openfoam.runner import OpenFOAMError
    from airfoilfoam.pipeline import write_divergence_condemnation

    monkeypatch.setattr(pipeline, "CaseBuilder", _FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    reason = "transient diverged at t=0.069: |Cl|=9.45e+05, dt=5e-08"

    class KilledRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            # the heartbeat watchdog condemned + SIGTERMed the solver mid-run,
            # after it had already appended garbage coefficient rows
            _write_coeff(
                case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat",
                _diverged_rows(),
            )
            write_divergence_condemnation(case_dir, reason)
            return SimpleNamespace(ok=False, returncode=143, stdout="killed", timed_out=False)

    with pytest.raises(OpenFOAMError, match="transient diverged at t=0.069"):
        _transient_attempt(tcase, KilledRunner())


def test_stale_marker_is_cleared_before_a_fresh_attempt(tmp_path, monkeypatch):
    """A marker left by a condemned earlier stage (e.g. the steady init) must
    not poison a healthy pimpleFoam pass: the attempt clears it and grades
    normally."""
    from types import SimpleNamespace

    from airfoilfoam import pipeline
    from airfoilfoam.pipeline import (
        DIVERGENCE_MARKER_FILENAME,
        write_divergence_condemnation,
    )

    monkeypatch.setattr(pipeline, "CaseBuilder", _FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    write_divergence_condemnation(tcase, "transient diverged at t=1: |Cl|=99, dt=1e-08")

    class HealthyRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            _write_coeff(
                case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat",
                _post_stall_rows(t0=0.0, n=2000),
            )
            return SimpleNamespace(ok=True, returncode=0, stdout="pimple ok", timed_out=False)

    result = _transient_attempt(tcase, HealthyRunner())

    assert result is not None
    assert not (tcase / DIVERGENCE_MARKER_FILENAME).exists()
    assert result.avg.cl == pytest.approx(1.2, abs=0.1)  # graded normally
