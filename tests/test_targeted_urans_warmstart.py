"""Targeted (URANS-only) job fixes, prod incident 2026-07-06 (clarky alpha=-2..4):

F1  URANS-only cases must run a steady RANS stage FIRST and warm-start the
    transient from that field only when the steady verdict is accepted (a
    cambered-airfoil uniform-flow cold start
    collapsed dt to ~1e-6 s and burned the whole 7200 s budget at t=0.010 of
    0.333 s).
F2  A base-pass solver timeout with a gradable coefficient.dat window is graded
    honestly as a partial window (quality warning), not raised as an error; a
    timeout with no gradable data raises a TRUTHFUL timeout message.
F3  "URANS transient produced no coefficient.dat" may only be raised when the
    transient's coefficient.dat is actually absent.

No real OpenFOAM solves; runners are faked with prod-shaped logs/outputs.
"""
import logging
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
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    OpenFOAMError,
    _run_subprocess,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    UransQuality,
    _finalize_outcome,
    _prepare_transient_case,
    _run_transient_attempt,
    run_case,
)

FLUID = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)

#: Prod-shaped tail of a dt-collapsed pimpleFoam log (clarky alpha=4, job
#: 9ab16d4b): healthy PIMPLE iterations, tiny adaptive timestep, wall timeout.
TIMEOUT_LOG = (
    "Courant Number mean: 0.011 max: 14.9\n"
    "deltaT = 2.4e-05\n"
    "Time = 0.0099\n\n"
    "PIMPLE: iteration 1\n"
    "GAMG:  Solving for p, Initial residual = 0.019, Final residual = 9.4e-08, No Iterations 668\n"
    "Courant Number mean: 0.012 max: 15.2\n"
    "deltaT = 1e-06\n"
    "Time = 0.01\n\n"
    "PIMPLE: iteration 1\n"
    "\nCommand timed out after 7200s"
)

PROD_DEGENERATE_CHECKMESH = (
    "Mesh non-orthogonality Max: 88.229104 average: 29.642901\n"
    "***High aspect ratio cells found, Max aspect ratio: 2559.0303, number of cells 42\n"
    "Mesh OK.\n"
)


def _write_shedding_coeff(path: Path, f=5.0, n=500, dt=0.002, cl0=0.7, cd0=0.2):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        t = i * dt
        cl = cl0 + 0.05 * math.sin(2 * math.pi * f * t)
        cd = cd0 + 0.01 * math.sin(2 * math.pi * f * t + 0.7)
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, -0.1, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
    path.write_text("\n".join(lines) + "\n")


def _write_flat_transient_coeff(path: Path, start: float, end: float, n: int = 80):
    path.parent.mkdir(parents=True, exist_ok=True)
    span = max(0.0, end - start)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        t = start + span * i / max(1, n - 1)
        row = [t, 0.035, 0.0, 0.0, 0.42, 0.0, 0.0, -0.015, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
    path.write_text("\n".join(lines) + "\n")


def _write_uniform_time_state(time_dir: Path, delta_t: float, delta_t0: float | None = None) -> Path:
    uniform = time_dir / "uniform"
    uniform.mkdir(parents=True, exist_ok=True)
    value = float(time_dir.name)
    path = uniform / "time"
    path.write_text(
        "FoamFile\n"
        "{\n"
        "    class       dictionary;\n"
        "    object      time;\n"
        "}\n"
        f"deltaT          {delta_t:.12g};\n"
        f"deltaT0         {(delta_t if delta_t0 is None else delta_t0):.12g};\n"
        f"index           {int(value)};\n"
        f"value           {value:.12g};\n"
    )
    return path


def _foam_entry(text: str, key: str) -> str | None:
    for raw in text.splitlines():
        parts = raw.strip().split()
        if len(parts) >= 2 and parts[0] == key:
            return parts[1].rstrip(";")
    return None


def _write_drifting_steady_coeff(path: Path, n=600):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        cl = 0.2 + 0.002 * i
        cd = 0.03 + 0.00008 * i
        row = [i + 1, cd, 0.0, 0.0, cl, 0.0, 0.0, -0.02, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
    path.write_text("\n".join(lines) + "\n")


class FakeCaseBuilder:
    def __init__(self, *_args, **_kwargs):
        pass

    def write(self, case_dir: Path) -> None:
        (Path(case_dir) / "0").mkdir(parents=True, exist_ok=True)
        (Path(case_dir) / "system").mkdir(parents=True, exist_ok=True)

    def write_transient(self, *_args, **_kwargs) -> None:
        pass


def _successful_no_shedding_transient(tcase: Path) -> TransientResult:
    tcase.mkdir(parents=True, exist_ok=True)
    (tcase / "0.1").mkdir(exist_ok=True)
    return TransientResult(
        avg=SimpleNamespace(
            cl=0.3,
            cd=0.03,
            cm=-0.02,
            cl_cd=10.0,
            cl_std=0.0,
            cd_std=0.0,
            cm_std=0.0,
        ),
        case_dir=tcase,
        force_history=None,
        quality=UransQuality(
            ok=True,
            can_refine=False,
            reason="no shedding",
            no_shedding=True,
        ),
        start_time=0.0,
        end_time=0.1,
        run_time=0.1,
    )


def _run_force_transient_seed_handoff(
    tmp_path,
    monkeypatch,
    steady_stdout: str,
    write_steady_coeff,
) -> tuple[CaseOutcome, dict[str, object]]:
    captured: dict[str, object] = {}
    calls: list[str] = []

    class FakeRunner:
        external_paths_visible = True

        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

        def solver(self, case_dir, app, *_args, **_kwargs):
            calls.append(app)
            assert app == "simpleFoam"
            cdir = Path(case_dir)
            latest = cdir / "600"
            latest.mkdir(parents=True, exist_ok=True)
            for name in ("U", "p", "k", "omega", "nut"):
                (latest / name).write_text(f"full steady {name}")
            write_steady_coeff(cdir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat")
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout=steady_stdout,
                check=lambda: SimpleNamespace(stdout=steady_stdout),
            )

    def fake_prepare(tcase, *_args, **kwargs):
        captured["prep_steady_field_dir"] = kwargs.get("steady_field_dir")
        captured["prep_freestream_fallback"] = kwargs.get("freestream_fallback")
        captured["calls_at_prep"] = list(calls)
        Path(tcase).mkdir(parents=True, exist_ok=True)
        return MeshParams(), {}

    def fake_attempt(tcase, *_args, **_kwargs):
        return _successful_no_shedding_transient(Path(tcase))

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    outcome = run_case(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="s1223", contour=[]),
        spec=CaseSpec(chord=0.5, speed=50.0, aoa_deg=10.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        mesh_params=MeshParams(),
        solver_params=SolverParams(force_transient=True, transient_fallback=True, write_images=[]),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=FakeRunner(),
        mesh_dir=mesh_dir,
        render_images=False,
    )
    return outcome, captured


# --------------------------------------------------------------------------- #
# F1: steady RANS stage first + warm-started transient
# --------------------------------------------------------------------------- #


def test_urans_only_run_case_runs_steady_rans_stage_before_transient(tmp_path, monkeypatch):
    """A targeted URANS-only case (force_transient) must run the steady RANS
    stage first (mocked runner call order) and hand its field to the transient."""
    calls: list[str] = []
    captured: dict[str, object] = {}

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

        def solver(self, case_dir, app, *_args, **_kwargs):
            calls.append(app)
            # steady stage converges and leaves a field
            lt = Path(case_dir) / "300"
            lt.mkdir(parents=True, exist_ok=True)
            for name in ("U", "p", "k", "omega", "nut"):
                (lt / name).write_text(f"steady {name}")
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout="Time = 300\nSIMPLE solution converged in 300 iterations\n",
                check=lambda: SimpleNamespace(stdout="Time = 300\nSIMPLE solution converged in 300 iterations\n"),
            )

    def fake_finalize(case_dir, outcome, *args, **kwargs):
        captured["steady_field_dir"] = kwargs.get("steady_field_dir")
        captured["calls_at_finalize"] = list(calls)

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)

    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    outcome = run_case(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="clarky", contour=[]),
        spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        mesh_params=MeshParams(),
        solver_params=SolverParams(force_transient=True, transient_fallback=True, write_images=[]),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=FakeRunner(),
        mesh_dir=mesh_dir,
    )

    assert outcome.error is None
    # The steady RANS stage ran BEFORE the transient (finalize) was entered.
    assert "simpleFoam" in captured["calls_at_finalize"]
    # The transient receives the developed steady field as its warm start.
    assert captured["steady_field_dir"] is not None
    assert captured["steady_field_dir"].name == "300"
    # Steady attempt evidence is recorded, not discarded.
    assert outcome.iterations == 300
    assert (tmp_path / "case" / "log.simpleFoam").exists()


def test_nonconverged_full_steady_field_not_used_as_transient_seed(
    tmp_path, monkeypatch, caplog
):
    """MUST-CATCH: prod-shaped URANS precalc failures had a root full-steady
    stage that ran to the iteration cap without "SIMPLE solution converged";
    that latestTime field must not seed pimpleFoam."""
    caplog.set_level(logging.WARNING, logger="airfoilfoam.pipeline")

    outcome, captured = _run_force_transient_seed_handoff(
        tmp_path,
        monkeypatch,
        steady_stdout="Time = 600\nEnd\n",
        write_steady_coeff=_write_drifting_steady_coeff,
    )

    assert outcome.error is None
    assert "simpleFoam" in captured["calls_at_prep"]
    assert captured["prep_steady_field_dir"] is None
    assert captured["prep_freestream_fallback"] is True
    assert any(
        "steady init not converged; transient starts from freestream instead "
        "of the non-converged field" in message
        and "skipping in-case short simpleFoam init" in message
        for message in caplog.messages
    )


def test_freestream_fallback_skips_init_and_starts_pimple_from_time_zero(
    tmp_path, monkeypatch, caplog
):
    """Prod shape: a rejected full-steady field must not be followed by the
    in-case short SIMPLE init. pimpleFoam starts from the transient case's
    pristine 0/ freestream state, so the pseudo-time-600 axis cannot appear."""
    caplog.set_level(logging.WARNING, logger="airfoilfoam.pipeline")
    calls: list[str] = []
    transient_writes: list[dict[str, float]] = []
    latest_seen_by_pimple: list[float] = []

    class TrackingCaseBuilder(FakeCaseBuilder):
        def write_transient(
            self,
            case_dir: Path,
            start_time: float,
            end_time: float,
            delta_t: float,
            write_interval=None,
            max_delta_t=None,
        ) -> None:
            transient_writes.append(
                {"start_time": start_time, "end_time": end_time, "delta_t": delta_t}
            )
            system = Path(case_dir) / "system"
            system.mkdir(parents=True, exist_ok=True)
            (system / "controlDict").write_text(
                f"application pimpleFoam;\nstartTime {start_time:.12g};\n"
                f"endTime {end_time:.12g};\n"
            )

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            if cmd.split()[0] == "checkMesh":
                return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="Mesh OK.\n")
            # potentialFoam IS wanted on the fallback path: prod s1223 c=1
            # u=50 detonated on the first 1-2 steps even from pure uniform
            # freestream — the smooth potential-flow field is the classic
            # impulsive-start cure. Only the SIMPLE init stays banned.
            if cmd.split()[0] != "potentialFoam":
                raise AssertionError(f"freestream fallback must not run {cmd}")
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="potentialFoam ok\n")

        def solver(self, case_dir, app, *_args, **_kwargs):
            calls.append(app)
            if app == "simpleFoam":
                (Path(case_dir) / "600").mkdir(parents=True, exist_ok=True)
                raise AssertionError("freestream fallback must not run simpleFoam.init")
            assert app == "pimpleFoam"
            cdir = Path(case_dir)
            latest_seen_by_pimple.append(pipeline._latest_time(cdir))
            if len(latest_seen_by_pimple) == 1:
                assert latest_seen_by_pimple[-1] == pytest.approx(0.0)
            assert not (cdir / "600").exists()
            assert not (cdir / "log.simpleFoam.init").exists()
            assert transient_writes[-1]["start_time"] == pytest.approx(
                latest_seen_by_pimple[-1]
            )
            _write_flat_transient_coeff(
                cdir
                / "postProcessing"
                / "forceCoeffs1"
                / f"{transient_writes[-1]['start_time']:.12g}"
                / "coefficient.dat",
                transient_writes[-1]["start_time"],
                transient_writes[-1]["end_time"],
            )
            (cdir / f"{transient_writes[-1]['end_time']:.12g}").mkdir(exist_ok=True)
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout="Time = 0\nTime = end\n",
                check=lambda: SimpleNamespace(stdout="Time = 0\nTime = end\n"),
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", TrackingCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)

    params = SolverParams(force_transient=True, transient_auto_refine=False)
    spec = CaseSpec(chord=1.0, speed=25.0, aoa_deg=18.0)
    steady = tmp_path / "case" / "600"
    steady.mkdir(parents=True)
    mesh = tmp_path / "mesh"
    mesh.mkdir()

    result = pipeline._run_transient(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="s1223", contour=[]),
        resolved=MeshParams(),
        spec=spec,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=params,
        runner=FakeRunner(),
        n_proc=1,
        timeout=7200,
        shared_mesh_dir=mesh,
        steady_field_dir=steady,
        steady_field_accepted=False,
    )

    expected_horizon = params.transient_cycles * pipeline.physics.shedding_period(
        spec.speed,
        spec.chord,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    guess_period = pipeline.physics.shedding_period(
        spec.speed,
        spec.chord,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    physical_horizon = pipeline._period_acquisition_horizons(params)[-1] * guess_period
    assert result is not None
    assert result.quality.ok and result.quality.no_shedding
    assert calls == ["checkMesh", "potentialFoam", "pimpleFoam", "pimpleFoam", "pimpleFoam"]
    assert latest_seen_by_pimple == pytest.approx(
        [0.0, expected_horizon, 20.0 * guess_period]
    )
    assert transient_writes[0]["start_time"] == pytest.approx(0.0)
    assert transient_writes[0]["end_time"] == pytest.approx(expected_horizon)
    assert result.start_time == pytest.approx(0.0)
    assert result.run_time == pytest.approx(physical_horizon)
    assert pipeline.read_transient_start_marker(tmp_path / "case" / "transient") == pytest.approx(0.0)
    assert not (tmp_path / "case" / "transient" / "log.simpleFoam.init").exists()
    assert f"startTime {20.0 * guess_period:.12g};" in (
        tmp_path / "case" / "transient" / "system" / "controlDict"
    ).read_text()
    assert any("skipping in-case short simpleFoam init" in message for message in caplog.messages)


def test_converged_full_steady_field_still_warm_starts_transient(tmp_path, monkeypatch):
    """False-positive guard: a full steady stage with residual convergence is
    still the preferred URANS initial field."""
    outcome, captured = _run_force_transient_seed_handoff(
        tmp_path,
        monkeypatch,
        steady_stdout="Time = 300\nSIMPLE solution converged in 300 iterations\nEnd\n",
        write_steady_coeff=_write_drifting_steady_coeff,
    )

    assert outcome.error is None
    seed = captured["prep_steady_field_dir"]
    assert seed is not None
    assert seed.name == "600"
    assert captured["prep_freestream_fallback"] is False


def test_accepted_oscillating_full_steady_field_still_warm_starts_transient(
    tmp_path, monkeypatch
):
    """False-positive guard: a bounded accepted oscillating steady field is a
    valid developed seed even without the literal SIMPLE convergence line."""
    outcome, captured = _run_force_transient_seed_handoff(
        tmp_path,
        monkeypatch,
        steady_stdout="Time = 600\nEnd\n",
        write_steady_coeff=_write_shedding_coeff,
    )

    assert outcome.error is None
    seed = captured["prep_steady_field_dir"]
    assert seed is not None
    assert seed.name == "600"


def test_prepare_transient_case_warm_starts_from_steady_field(tmp_path, monkeypatch):
    """With an in-job steady field on the shared mesh, the transient 0/ fields
    are the steady fields and no uniform-flow cold start (potentialFoam) runs."""
    calls: list[str] = []

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

        def solver(self, _case_dir, app, *_args, **_kwargs):
            calls.append(app)
            return SimpleNamespace(ok=True, stdout="init ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)

    steady = tmp_path / "case" / "412"
    steady.mkdir(parents=True)
    for name in ("U", "p", "k", "omega", "nut", "phi"):
        (steady / name).write_text(f"steady {name}")
    (steady / "uniform").mkdir()  # subdirectory must be skipped, not copied

    tcase = tmp_path / "case" / "transient"
    _prepare_transient_case(
        tcase,
        airfoil=None,
        resolved=MeshParams(),
        spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True),
        runner=FakeRunner(),
        n_proc=1,
        timeout=60,
        shared_mesh_dir=tmp_path / "mesh",
        steady_field_dir=steady,
    )

    assert (tcase / "0" / "U").read_text() == "steady U"
    assert (tcase / "0" / "p").read_text() == "steady p"
    assert not (tcase / "0" / "uniform").exists()
    assert calls == ["checkMesh"]  # no potentialFoam cold start, no extra init solve


def test_prepare_transient_case_urans_only_falls_back_to_unconditional_steady_init(tmp_path, monkeypatch):
    """Without a usable steady field, a URANS-only transient must STILL run the
    steady initialisation stage (potentialFoam + short simpleFoam) — the exact
    cold-start skip that produced the prod dt collapse."""
    calls: list[str] = []

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

        def solver(self, _case_dir, app, *_args, **_kwargs):
            calls.append(app)
            return SimpleNamespace(ok=True, stdout="init ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)

    tcase = tmp_path / "case" / "transient"
    _prepare_transient_case(
        tcase,
        airfoil=None,
        resolved=MeshParams(),
        spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True),
        runner=FakeRunner(),
        n_proc=1,
        timeout=60,
        shared_mesh_dir=tmp_path / "mesh",
        steady_field_dir=None,
    )

    assert "potentialFoam" in calls
    assert "simpleFoam" in calls  # RANS-first fallback is unconditional
    assert (tcase / "log.simpleFoam.init").read_text() == "init ok"


def test_prepare_transient_case_standalone_no_shared_mesh_still_runs_init(tmp_path, monkeypatch):
    """False-positive guard: a standalone transient with no shared mesh has no
    rejected steady seed, so it keeps the potentialFoam + short SIMPLE init."""
    calls: list[str] = []

    class FakeMesher:
        def patches(self, _mesh):
            return {}

        def write_inputs(self, *_args, **_kwargs):
            calls.append("write_inputs")

        def run_mesh(self, *_args, **_kwargs):
            calls.append("run_mesh")
            return SimpleNamespace(n_cells=123)

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

        def solver(self, _case_dir, app, *_args, **_kwargs):
            calls.append(app)
            return SimpleNamespace(ok=True, stdout="standalone init ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "get_mesher", lambda _name: FakeMesher())

    tcase = tmp_path / "case" / "transient"
    _prepare_transient_case(
        tcase,
        airfoil=None,
        resolved=MeshParams(),
        spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True),
        runner=FakeRunner(),
        n_proc=1,
        timeout=60,
        shared_mesh_dir=None,
        steady_field_dir=None,
    )

    assert calls == ["write_inputs", "run_mesh", "checkMesh", "potentialFoam", "simpleFoam"]
    assert (tcase / "log.simpleFoam.init").read_text() == "standalone init ok"


def test_potential_foam_failure_is_infrastructure_before_urans_solver(
    tmp_path, monkeypatch
):
    """MUST-CATCH: initialization is checked and never reclassified as a
    physical URANS failure or allowed to feed an uninitialized pimpleFoam."""

    calls: list[str] = []

    class FakeMesher:
        def patches(self, _resolved):
            return {}

        def write_inputs(self, *_args, **_kwargs):
            pass

        def run_mesh(self, *_args, **_kwargs):
            return SimpleNamespace(n_cells=1)

    class FailedPotentialRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            if cmd.startswith("potentialFoam"):
                return SimpleNamespace(
                    ok=False,
                    returncode=127,
                    timed_out=False,
                    stdout="potentialFoam executable unavailable",
                )
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout="Mesh non-orthogonality Max: 20 average: 5\nMesh OK.\n",
            )

        def solver(self, *_args, **_kwargs):
            raise AssertionError("pimpleFoam/simpleFoam must not run")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "get_mesher", lambda _name: FakeMesher())

    with pytest.raises(InfrastructureError, match="potentialFoam initialization failed"):
        _prepare_transient_case(
            tmp_path / "case" / "transient",
            airfoil=None,
            resolved=MeshParams(),
            spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0),
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True),
            runner=FailedPotentialRunner(),
            n_proc=1,
            timeout=60,
        )

    assert calls[-1] == "potentialFoam"


def test_cold_rans_potential_failure_remains_infrastructure(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    class FailedPotentialRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            if cmd.startswith("potentialFoam"):
                return SimpleNamespace(
                    ok=False,
                    returncode=1,
                    timed_out=False,
                    stdout="initial field creation failed",
                )
            return SimpleNamespace(ok=True, returncode=0, stdout="ok")

        def solver(self, *_args, **_kwargs):
            raise AssertionError("simpleFoam must not run without initialization")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "_try_seed_initial_field", lambda *a, **k: False)
    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()

    outcome = run_case(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="n12", contour=[]),
        spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=0.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        mesh_params=MeshParams(),
        solver_params=SolverParams(force_transient=False, write_images=[]),
        mesher=SimpleNamespace(
            patches=lambda _resolved: {},
            cell_count=lambda _resolved: 1,
        ),
        runner=FailedPotentialRunner(),
        mesh_dir=mesh_dir,
        render_images=False,
    )

    assert outcome.failure_disposition.value == "infrastructure"
    assert outcome.error is not None
    assert "potentialFoam initialization failed" in outcome.error
    assert calls == ["potentialFoam"]


def _run_transient_with_checkmesh(tmp_path, monkeypatch, checkmesh_stdout: str):
    calls: list[str] = []
    quality_warnings: list[str] = []

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            if cmd.startswith("checkMesh"):
                return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout=checkmesh_stdout)
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout=f"{cmd} ok\n")

        def solver(self, case_dir, app, *_args, **_kwargs):
            calls.append(app)
            cdir = Path(case_dir)
            if app == "pimpleFoam":
                _write_flat_transient_coeff(
                    cdir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat",
                    0.0,
                    0.1,
                )
                (cdir / "0.1").mkdir(parents=True, exist_ok=True)
            return SimpleNamespace(
                ok=True,
                returncode=0,
                timed_out=False,
                stdout=f"{app} ok\n",
                check=lambda: SimpleNamespace(stdout=f"{app} ok\n"),
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)

    result = pipeline._run_transient(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="s1223", contour=[]),
        resolved=MeshParams(),
        spec=CaseSpec(chord=1.0, speed=25.0, aoa_deg=18.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, transient_auto_refine=False),
        runner=FakeRunner(),
        n_proc=1,
        timeout=7200,
        shared_mesh_dir=tmp_path / "mesh",
        quality_warnings=quality_warnings,
    )
    return result, calls, quality_warnings


def test_transient_mesh_qa_gate_fails_prod_degenerate_mesh_before_solver(tmp_path, monkeypatch):
    calls: list[str] = []

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd.split()[0])
            if cmd.startswith("checkMesh"):
                return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout=PROD_DEGENERATE_CHECKMESH)
            raise AssertionError(f"mesh gate should stop before {cmd}")

        def solver(self, _case_dir, app, *_args, **_kwargs):
            calls.append(app)
            raise AssertionError(f"mesh gate should stop before {app}")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *a, **k: None)

    with pytest.raises(DeterministicMeshError) as err:
        pipeline._run_transient(
            tmp_path / "case",
            airfoil=SimpleNamespace(name="s1223", contour=[]),
            resolved=MeshParams(),
            spec=CaseSpec(chord=1.0, speed=25.0, aoa_deg=18.0),
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True),
            runner=FakeRunner(),
            n_proc=1,
            timeout=7200,
            shared_mesh_dir=tmp_path / "mesh",
        )

    assert "mesh degenerate at this fidelity tier (max non-orthogonality 88.2 deg)" in str(err.value)
    assert "checkMesh max non-orthogonality exceeds 85.0 deg" in str(err.value)
    assert "pimpleFoam" not in calls
    assert calls == ["checkMesh"]


def test_transient_mesh_qa_gate_allows_healthy_mesh_and_solver_runs(tmp_path, monkeypatch):
    result, calls, quality_warnings = _run_transient_with_checkmesh(
        tmp_path,
        monkeypatch,
        "Mesh non-orthogonality Max: 65 average: 22\nMesh OK.\n",
    )

    assert result is not None
    assert "pimpleFoam" in calls
    assert not quality_warnings


def test_transient_mesh_qa_gate_warns_near_limit_and_solver_runs(tmp_path, monkeypatch):
    result, calls, quality_warnings = _run_transient_with_checkmesh(
        tmp_path,
        monkeypatch,
        "Mesh non-orthogonality Max: 78 average: 25\nMesh OK.\n",
    )

    assert result is not None
    assert "pimpleFoam" in calls
    assert any("max non-orthogonality 78.0 deg" in warning for warning in quality_warnings)


def test_transient_mesh_qa_gate_missing_non_ortho_line_is_nonfatal(tmp_path):
    calls: list[str] = []

    class FakeRunner:
        def application(self, _case_dir, cmd, *args, **kwargs):
            calls.append(cmd)
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="Mesh OK.\n")

    pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), [])

    assert calls == ["checkMesh -time 0"]


def test_transient_mesh_qa_gate_failed_checks_are_degenerate(tmp_path):
    class FakeRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(
                ok=False,
                returncode=1,
                timed_out=False,
                stdout="Mesh non-orthogonality Max: 20 average: 5\nFailed 1 mesh checks.\n",
            )

    with pytest.raises(OpenFOAMError, match="Failed 1 mesh checks"):
        pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), [])


def test_transient_mesh_qa_gate_nonzero_benign_summary_is_infrastructure(tmp_path):
    """MUST-CATCH: parseable text cannot turn a failed process into proof."""

    class FakeRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(
                ok=False,
                returncode=1,
                timed_out=False,
                stdout="Mesh non-orthogonality Max: 10 average: 1\nMesh OK.\n",
            )

    with pytest.raises(InfrastructureError, match="checkMesh exited 1"):
        pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), [])

    assert (tmp_path / "log.checkMesh").read_text().endswith("Mesh OK.\n")


def test_transient_mesh_qa_gate_timeout_outranks_parseable_summary(tmp_path):
    """MUST-CATCH: a timed-out probe is unavailable, never a QA verdict."""

    class FakeRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(
                ok=False,
                returncode=124,
                timed_out=True,
                stdout=(
                    "Mesh non-orthogonality Max: 10 average: 1\n"
                    "Mesh OK.\nCommand timed out after 300s\n"
                ),
            )

    with pytest.raises(InfrastructureError, match="checkMesh timed out"):
        pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), [])


# Verbatim shape of the prod false positive (2026-07-11, sd8020 c1.0 u100):
# checkMesh failed ONLY its aspect-ratio heuristic — the normal anisotropy of
# a wall-function boundary layer at high Re — with non-ortho at a healthy 72.4.
_ASPECT_ONLY_CHECKMESH = (
    " ***High aspect ratio cells found, Max aspect ratio: 4870.8257, number of cells 96\n"
    "  <<Writing 96 cells with high aspect ratio to set highAspectRatioCells\n"
    "    Min volume = 9.5656255e-08. Max volume = 0.52245327.  Total volume = 74.329612.  Cell volumes OK.\n"
    "    Mesh non-orthogonality Max: 72.364462 average: 29.704061\n"
    "   *Number of severely non-orthogonal (> 70 degrees) faces: 419.\n"
    "    Max skewness = 1.0856355 OK.\n"
    "Failed 1 mesh checks.\n"
)


def test_transient_mesh_qa_gate_waives_aspect_ratio_only_failure(tmp_path):
    # MUST-CATCH: aspect-ratio-only checkMesh failure is a disclosure, never a
    # fatal mesh-degenerate verdict.
    class FakeRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(ok=False, returncode=1, timed_out=False, stdout=_ASPECT_ONLY_CHECKMESH)

    warnings: list[str] = []
    pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), warnings)

    assert any("high-aspect-ratio wall cells" in w and "4871" in w for w in warnings)


def test_transient_mesh_qa_gate_aspect_plus_other_failure_stays_fatal(tmp_path):
    # FALSE-POSITIVE GUARD for the waiver itself: aspect ratio plus ANY other
    # failed check (or degenerate non-ortho) must still kill the case.
    output = _ASPECT_ONLY_CHECKMESH.replace(
        "Failed 1 mesh checks.",
        " ***Max skewness = 6.2, 12 highly skew faces detected\nFailed 2 mesh checks.",
    )

    class FakeRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(ok=False, returncode=1, timed_out=False, stdout=output)

    with pytest.raises(DeterministicMeshError, match="Failed 2 mesh checks"):
        pipeline._run_transient_mesh_qa_gate(tmp_path, FakeRunner(), [])

    degenerate = _ASPECT_ONLY_CHECKMESH.replace("Max: 72.364462", "Max: 88.3")

    class DegenerateRunner:
        def application(self, _case_dir, _cmd, *args, **kwargs):
            return SimpleNamespace(ok=False, returncode=1, timed_out=False, stdout=degenerate)

    with pytest.raises(DeterministicMeshError, match="non-orthogonality"):
        pipeline._run_transient_mesh_qa_gate(tmp_path, DegenerateRunner(), [])


def test_seed_transient_from_steady_requires_essential_fields(tmp_path):
    steady = tmp_path / "700"
    steady.mkdir()
    (steady / "k").write_text("k only")
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    assert pipeline._seed_transient_from_steady(steady, tcase) is False
    assert not (tcase / "0" / "k").exists()


def test_freestream_init_rewrites_pseudo_time_delta_t_before_transient(tmp_path):
    """MUST-CATCH: simpleFoam init writes pseudo-time deltaT=1 at latestTime.
    pimpleFoam latestTime restart must enter with the transient initial dt, not
    exit zero-step on the inherited SIMPLE time state."""
    tcase = tmp_path / "transient"
    latest = tcase / "600"
    time_state = _write_uniform_time_state(latest, delta_t=1.0, delta_t0=1.0)
    (tcase / "log.simpleFoam.init").write_text("Time = 600\nEnd\n")
    initial_delta_t = pipeline.physics.shedding_period(
        50.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    ) / 5000.0

    start = 600.0
    run_span = 20.0 * 1.0 / 50.0
    assert not (start < start + run_span - 0.5 * 1.0)

    assert pipeline._sanitize_freestream_init_time_state(tcase, initial_delta_t)

    text = time_state.read_text()
    assert float(_foam_entry(text, "deltaT")) == pytest.approx(initial_delta_t)
    assert float(_foam_entry(text, "deltaT0")) == pytest.approx(initial_delta_t)
    assert _foam_entry(text, "index") == "600"
    assert _foam_entry(text, "value") == "600"
    assert start < start + run_span - 0.5 * initial_delta_t


def test_freestream_init_sanitize_is_not_a_warm_seed_rewrite(tmp_path):
    tcase = tmp_path / "transient"
    time_state = _write_uniform_time_state(tcase / "0", delta_t=0.002, delta_t0=0.002)
    before = time_state.read_text()

    assert not pipeline._sanitize_freestream_init_time_state(tcase, 8e-6)
    assert time_state.read_text() == before


def test_chunk_restart_attempt_keeps_real_transient_uniform_time(tmp_path, monkeypatch):
    """False-positive guard: in-run restart chunks carry a real transient dt in
    latestTime/uniform/time. _run_transient_attempt must not sanitize it just
    because the original case still has log.simpleFoam.init."""
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    time_state = _write_uniform_time_state(tcase / "12", delta_t=0.002, delta_t0=0.002)
    (tcase / "log.simpleFoam.init").write_text("Time = 600\nEnd\n")
    before = time_state.read_text()

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            assert (Path(case_dir) / "12" / "uniform" / "time").read_text() == before
            return SimpleNamespace(ok=False, returncode=1, timed_out=False, stdout="crash")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)

    with pytest.raises(InfrastructureError, match="transient process failed"):
        _run_transient_attempt(
            tcase,
            airfoil=None,
            tmesh=None,
            patches={},
            spec=CaseSpec(chord=1.0, speed=50.0, aoa_deg=25.0),
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(),
            runner=FakeRunner(),
            n_proc=1,
            timeout=60,
            run_time=0.4,
            delta_t=8e-6,
        )
    assert time_state.read_text() == before


def test_cross_job_continuation_keeps_real_transient_uniform_time(tmp_path, monkeypatch):
    tcase = tmp_path / "case" / "transient"
    (tcase / "0").mkdir(parents=True)
    time_state = _write_uniform_time_state(tcase / "12", delta_t=0.002, delta_t0=0.002)
    (tcase / "log.simpleFoam.init").write_text("original init evidence")
    before = time_state.read_text()

    monkeypatch.setattr(pipeline, "get_mesher", lambda _name: SimpleNamespace(patches=lambda _mesh: {}))

    def fake_attempt(tcase_arg, *_args, **_kwargs):
        assert (Path(tcase_arg) / "12" / "uniform" / "time").read_text() == before
        return TransientResult(
            avg=SimpleNamespace(cl=0.3, cd=0.03, cm=-0.02, cl_cd=10.0, cl_std=0.0, cd_std=0.0, cm_std=0.0),
            case_dir=Path(tcase_arg),
            force_history=None,
            quality=UransQuality(ok=True, can_refine=False, reason="continued"),
            start_time=0.0,
            end_time=12.1,
            run_time=0.1,
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = pipeline._run_transient(
        tmp_path / "case",
        airfoil=None,
        resolved=MeshParams(),
        spec=CaseSpec(chord=1.0, speed=50.0, aoa_deg=25.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=None,
        n_proc=1,
        timeout=60,
        resume=pipeline.TransientResume(transient_start=0.0, resume_from=12.0),
    )

    assert result is not None
    assert time_state.read_text() == before


# --------------------------------------------------------------------------- #
# F2: base-pass timeout honesty
# --------------------------------------------------------------------------- #


def _timeout_attempt(tcase, runner, run_time=3.0, timeout=7200):
    return _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=25.0, aoa_deg=4.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=runner,
        n_proc=1,
        timeout=timeout,
        run_time=run_time,
        delta_t=0.001,
    )


def test_timed_out_transient_with_coefficient_window_is_graded_partial(tmp_path, monkeypatch):
    """Prod shape: pimpleFoam killed by the 7200 s wall timeout, but
    coefficient.dat holds a healthy shedding window -> graded partial with an
    honest warning, no exception, and never 'produced no coefficient.dat'."""

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            _write_shedding_coeff(case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat")
            return SimpleNamespace(ok=False, returncode=124, timed_out=True, stdout=TIMEOUT_LOG)

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _timeout_attempt(tcase, FakeRunner())

    assert result is not None
    assert result.avg.cl == pytest.approx(0.7, abs=0.02)
    assert not result.quality.ok
    assert not result.quality.can_refine  # never refine a run that exhausted its budget
    assert "base transient timed out at t=" in result.quality.reason
    assert "graded partial window" in result.quality.reason
    assert "of 3s" in result.quality.reason
    assert "coefficient.dat" not in result.quality.reason


def test_timed_out_transient_without_data_raises_truthful_timeout_message(tmp_path, monkeypatch):
    """Timeout with NO gradable output must raise the truthful timeout message
    (simulated span + collapsed dt), never 'produced no coefficient.dat'."""

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            (case_dir / "0.01").mkdir(parents=True, exist_ok=True)  # dirs reached t=0.010
            return SimpleNamespace(ok=False, returncode=124, timed_out=True, stdout=TIMEOUT_LOG)

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    with pytest.raises(OpenFOAMError) as err:
        _timeout_attempt(tcase, FakeRunner(), run_time=0.333, timeout=7200)

    msg = str(err.value)
    assert "URANS transient timed out after 7200s" in msg
    assert "at t=0.01" in msg
    assert "of 0.333s" in msg
    assert "dt collapsed to 1e-06" in msg
    assert "produced no coefficient.dat" not in msg


def test_timed_out_transient_with_unusable_rows_raises_truthful_timeout_message(tmp_path, monkeypatch):
    """A coefficient.dat with only a header (no gradable rows) is 'not enough
    data': truthful timeout error, not a partial grade and not a false claim."""

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)
            coeff.write_text("# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)\n")
            return SimpleNamespace(ok=False, returncode=124, timed_out=True, stdout=TIMEOUT_LOG)

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    with pytest.raises(OpenFOAMError) as err:
        _timeout_attempt(tcase, FakeRunner(), run_time=0.333)

    assert "URANS transient timed out after" in str(err.value)
    assert "produced no coefficient.dat" not in str(err.value)


def test_ambiguous_non_timeout_solver_failure_is_infrastructure(tmp_path, monkeypatch):
    """False-positive guard: an untyped non-zero exit is infrastructure and
    does not fabricate a numerical recovery attempt or partial grade."""

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            return SimpleNamespace(ok=False, returncode=1, timed_out=False, stdout="FOAM FATAL ERROR")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    with pytest.raises(InfrastructureError, match="transient process failed"):
        _timeout_attempt(tcase, FakeRunner())


def test_refined_pass_timeout_falls_back_to_base_result(tmp_path, monkeypatch):
    """A refined pass that times out with nothing gradable must not discard the
    completed base pass."""
    from airfoilfoam.pipeline import TransientResult, UransQuality

    attempts = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, refined=False, **_kwargs):
        attempts.append(refined)
        if refined:
            raise pipeline.TransientTimeoutError(
                "URANS transient timed out after 7200s at t=0.31 of 3s "
                "(dt collapsed to 1e-06)"
            )
        (tcase / "0.3").mkdir(exist_ok=True)
        return TransientResult(
            avg=SimpleNamespace(cl=0.5, cd=0.02, cm=-0.01, cl_cd=25.0, cl_std=0.0, cd_std=0.0, cm_std=0.0),
            case_dir=tcase,
            force_history=None,
            quality=UransQuality(ok=False, can_refine=True, reason="retained cycles 2.0 < 7.0", measured_period_s=0.1),
            start_time=0.0,
            end_time=0.3,
            run_time=0.3,
            wall_seconds=10.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = pipeline._run_transient(
        tmp_path,
        airfoil=None,
        resolved=None,
        spec=CaseSpec(chord=1.0, speed=7.3, aoa_deg=0.0),
        fluid=None,
        roughness=None,
        solver_params=SolverParams(),
        runner=None,
        n_proc=1,
        timeout=7200,
    )

    assert attempts == [False, True]
    assert result is not None
    assert not result.refined
    assert "auto-refinement failed after first pass" in result.quality.reason


def test_refined_pass_infrastructure_failure_propagates(tmp_path, monkeypatch):
    """An optional second trajectory does not turn runtime failure into a
    physical URANS rejection merely because a base window already exists."""

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, refined=False, **_kwargs):
        if refined:
            raise InfrastructureError("MPI admission unavailable")
        (tcase / "0.3").mkdir(exist_ok=True)
        return TransientResult(
            avg=SimpleNamespace(
                cl=0.5,
                cd=0.02,
                cm=-0.01,
                cl_cd=25.0,
                cl_std=0.0,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=tcase,
            force_history=None,
            quality=UransQuality(
                ok=False,
                can_refine=True,
                reason="retained cycles 2.0 < 7.0",
                measured_period_s=0.1,
            ),
            start_time=0.0,
            end_time=0.3,
            run_time=0.3,
            wall_seconds=10.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    with pytest.raises(InfrastructureError, match="MPI admission unavailable"):
        pipeline._run_transient(
            tmp_path,
            airfoil=None,
            resolved=None,
            spec=CaseSpec(chord=1.0, speed=7.3, aoa_deg=0.0),
            fluid=None,
            roughness=None,
            solver_params=SolverParams(),
            runner=None,
            n_proc=1,
            timeout=7200,
        )


def test_runner_marks_timeout_results(tmp_path):
    """Real subprocess timeouts must carry timed_out=True (both code paths) —
    the pipeline's honesty fixes depend on this signal."""
    res = _run_subprocess(
        ["bash", "-c", "echo deltaT = 1e-06; sleep 5"],
        cwd=tmp_path, timeout=1, command="fake-solver",
    )
    assert res.timed_out and not res.ok and res.returncode == 124
    assert "Command timed out after 1s" in res.stdout

    res_monitored = _run_subprocess(
        ["bash", "-c", "sleep 5"],
        cwd=tmp_path, timeout=1, command="fake-solver", monitor=lambda: None,
    )
    assert res_monitored.timed_out and not res_monitored.ok and res_monitored.returncode == 124


# --------------------------------------------------------------------------- #
# F3: "produced no coefficient.dat" only when the file is actually absent
# --------------------------------------------------------------------------- #


def _finalize_force_transient(case_dir, monkeypatch):
    monkeypatch.setattr(pipeline, "_run_transient", lambda *a, **k: None)
    outcome = CaseOutcome(spec=CaseSpec(chord=0.25, speed=15.0, aoa_deg=4.0), reynolds=250_000)
    _finalize_outcome(
        case_dir,
        outcome,
        airfoil=SimpleNamespace(name="clarky", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, write_images=[]),
        runner=SimpleNamespace(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )


def test_no_coefficient_error_not_raised_when_transient_file_exists(tmp_path, monkeypatch):
    """Prod bug: transient/postProcessing/.../coefficient.dat EXISTED with rows,
    yet the job error said the file was never produced."""
    _write_shedding_coeff(tmp_path / "transient" / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat")

    with pytest.raises(OpenFOAMError) as err:
        _finalize_force_transient(tmp_path, monkeypatch)

    msg = str(err.value)
    assert "produced no coefficient.dat" not in msg
    assert "coefficient.dat has data up to t=" in msg
    assert "log.pimpleFoam" in msg


def test_no_coefficient_error_raised_only_when_file_truly_absent(tmp_path, monkeypatch):
    with pytest.raises(OpenFOAMError, match="produced no coefficient.dat"):
        _finalize_force_transient(tmp_path, monkeypatch)


def test_urans_only_never_silently_reports_steady_point_when_transient_fails(tmp_path, monkeypatch):
    """With the new steady-first stage, steady coefficients exist in the case
    dir; a failed URANS must still raise instead of passing the steady values
    off as the requested URANS result."""
    steady_coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_shedding_coeff(steady_coeff, n=50)

    with pytest.raises(OpenFOAMError):
        _finalize_force_transient(tmp_path, monkeypatch)
