from unittest.mock import Mock
import pytest

from scripts.materials.mpi_binding_experiment import configure_unbound_mpi
from scripts.materials import checkpoint_placement as checkpoint
from scripts.materials import checkpoint_placement_control as control


def test_explicit_binding_only_changes_mpi_launch_and_preserves_bounds_and_monitor():
    runner = Mock()
    original = runner.run
    monitor = object()
    configure_unbound_mpi(runner)
    command = "mpirun --allow-run-as-root --use-hwthread-cpus -np 4 rhoPimpleFoam -parallel"
    runner.run("case", command, timeout=600, monitor=monitor)
    original.assert_called_once_with("case", "mpirun --bind-to none --report-bindings --allow-run-as-root --use-hwthread-cpus -np 4 rhoPimpleFoam -parallel", timeout=600, monitor=monitor)
    original.reset_mock()
    runner.run("case", "decomposePar -latestTime -force", timeout=120)
    original.assert_called_once_with("case", "decomposePar -latestTime -force", timeout=120, monitor=None)


def test_binding_probe_preserves_new_default_and_rejects_conflicting_explicit_policy():
    runner = Mock()
    original = runner.run
    configure_unbound_mpi(runner)
    command = "mpirun --allow-run-as-root --bind-to none --use-hwthread-cpus -np 4 rhoPimpleFoam -parallel"
    runner.run("case", command)
    actual = original.call_args.args[1]
    assert actual.count("--bind-to none") == 1
    assert actual.count("--report-bindings") == 1
    with pytest.raises(ValueError, match="Conflicting"):
        runner.run("case", command.replace("--bind-to none", "--bind-to core"))


@pytest.mark.parametrize("value", ["max 100000", "400000 100000", "200000 100000", "300000 0"])
def test_checkpoint_native_rejects_unbounded_or_different_cpu_quota(value):
    with pytest.raises(ValueError):
        checkpoint.quota_cpus(value)
    assert checkpoint.quota_cpus("300000 100000") == 3


def test_checkpoint_binding_uses_distinct_allowed_physical_cores(tmp_path):
    for cpu, core, sibling in ((0, 0, "0,4"), (1, 1, "1,5"), (2, 2, "2,6"), (4, 0, "0,4")):
        root = tmp_path / f"cpu{cpu}" / "topology"
        root.mkdir(parents=True)
        (root / "physical_package_id").write_text("0")
        (root / "core_id").write_text(str(core))
        (root / "thread_siblings_list").write_text(sibling)
    selected, topology = checkpoint.distinct_cores({0, 1, 2, 4}, tmp_path)
    assert selected == [0, 1, 2]
    assert len(topology) == 4
    with pytest.raises(ValueError, match="fewer than three"):
        checkpoint.distinct_cores({0, 1, 4}, tmp_path)


def test_checkpoint_tree_refuses_links_and_detects_changed_inputs(tmp_path):
    root = tmp_path / "input"
    root.mkdir()
    (root / "U").write_text("real retained fixture bytes")
    original = checkpoint.tree_identity(root)
    (root / "U").write_text("different fixture bytes")
    assert checkpoint.tree_identity(root) != original
    (root / "escape").symlink_to(tmp_path)
    with pytest.raises(ValueError, match="ordinary files"):
        checkpoint.tree_identity(root)


@pytest.mark.parametrize("state", [
    {"index": 31612, "value": float(checkpoint.END_TIME)},
    {"index": 31675, "value": float(checkpoint.END_TIME) + 1e-5},
    {"index": 31675, "value": float("nan")},
])
def test_checkpoint_endpoint_never_accepts_shorter_or_different_physical_work(state):
    with pytest.raises(ValueError, match="fixed 62/125-step"):
        checkpoint.validate_endpoint(state)
    checkpoint.validate_endpoint({"index": 31675, "value": float(checkpoint.END_TIME)})
    checkpoint.validate_endpoint({"index": 31612, "value": float(checkpoint.MEASUREMENT_START_TIME)}, 62)
    with pytest.raises(ValueError, match="62/125"):
        checkpoint.validate_endpoint({"index": 31613, "value": float(checkpoint.END_TIME)}, 63)


def test_checkpoint_coefficient_trace_requires_all_real_steps(tmp_path):
    path = tmp_path / "postProcessing/forceCoeffs1/600/coefficient.dat"
    path.parent.mkdir(parents=True)
    rows = ["# Time Cl Cd CmPitch"]
    interval = (float(checkpoint.END_TIME) - float(checkpoint.MEASUREMENT_START_TIME)) / checkpoint.STEPS
    for step in range(1, checkpoint.STEPS + 1):
        rows.append(f"{float(checkpoint.MEASUREMENT_START_TIME) + step * interval:.16g} 0.4 0.03 -0.02")
    path.write_text("\n".join(rows) + "\n")
    assert len(checkpoint.coefficient_trace(tmp_path)) == 63
    path.write_text("\n".join(rows + [f"{float(checkpoint.END_TIME) + interval:.16g} 0."]) + "\n")
    assert len(checkpoint.coefficient_trace(tmp_path)) == 63
    path.write_text("\n".join(rows[:-1]) + "\n")
    with pytest.raises(ValueError, match="actual coefficient steps"):
        checkpoint.coefficient_trace(tmp_path)
    for invalid in (rows[-1].replace("0.4", "nan"), rows[-1].rsplit(" ", 1)[0]):
        path.write_text("\n".join(rows[:-1] + [invalid]) + "\n")
        with pytest.raises(ValueError, match="Incomplete or non-finite"):
            checkpoint.coefficient_trace(tmp_path)


def test_checkpoint_cleanup_cannot_remove_another_runs_fixture(tmp_path, monkeypatch):
    import json

    owner = {"runId": "current", "path": str(tmp_path), "name": control.NAME}
    root = tmp_path / control.RELATIVE_ROOT
    (root / "input").mkdir(parents=True)
    (root / "input/owner.json").write_text(json.dumps(owner))
    (root / "apply-intent.json").write_text(json.dumps({**owner, "runId": "another"}))
    operation = Mock()
    monkeypatch.setattr(control, "coordinator", operation)
    with pytest.raises(ValueError, match="another run"):
        control.cleanup(owner)
    operation.assert_not_called()


@pytest.mark.parametrize("generation", [None, 1])
@pytest.mark.parametrize("log_failure", [False, True])
def test_checkpoint_cleanup_uses_only_exact_coordinator_identity(tmp_path, monkeypatch, generation, log_failure):
    import json

    owner = {"runId": "current", "path": str(tmp_path), "name": control.NAME}
    root = tmp_path / control.RELATIVE_ROOT
    (root / "input").mkdir(parents=True)
    (root / "receipt").mkdir()
    (root / "input/owner.json").write_text(json.dumps(owner))
    (root / "apply-intent.json").write_text(json.dumps(owner))
    state = {"deployment_id": "exact-owned", "name": control.NAME, "source": "worktree", "current_generation": generation,
             "public": False, "observed_only": False, "components": [{"name": "benchmark", "state": "completed"}]}
    logs = RuntimeError("exact log reader unavailable") if log_failure else {"logs": "retained before removal"}
    operation = Mock(side_effect=[state, logs, {}, {"removed": True}, None])
    monkeypatch.setattr(control, "coordinator", operation)
    control.cleanup(owner)
    assert operation.call_args_list[1].args == ("deployment.logs", {"deployment_id": "exact-owned", "component": "benchmark", "tail_lines": 200})
    assert operation.call_args_list[2].args == ("deployment.stop", {"deployment_id": "exact-owned"})
    assert operation.call_args_list[3].args == ("deployment.remove", {"deployment_id": "exact-owned", "delete_data": True})
    assert (root / "receipt/runtime-status.json").is_file()
    if log_failure:
        assert json.loads((root / "receipt/runtime-log-error.json").read_text())["observationError"] == "RuntimeError"
    else:
        assert json.loads((root / "receipt/runtime-log.json").read_text()) == {"logs": "retained before removal"}


@pytest.mark.parametrize("copy_uniform_supported", [False, True])
@pytest.mark.parametrize("experiment", ["placement", "serial-mpi", "changed-initial"])
def test_checkpoint_native_has_one_frozen_decomposition_for_all_arms(tmp_path, monkeypatch, copy_uniform_supported, experiment):
    import json

    source = tmp_path / "input"
    case = source / "case"
    (case / "system").mkdir(parents=True)
    (case / "system/controlDict").write_text("immutable actual-case fixture")
    (source / "case-files.json").write_text(json.dumps(checkpoint.tree_identity(case)))
    (source / "owner.json").write_text(json.dumps({"runId": "fixture", "driverSha256": checkpoint.digest(checkpoint.__file__),
                                                "experiment": "serial-mpi" if experiment == "changed-initial" else experiment}))
    adapter = tmp_path / "python"
    adapter.mkdir()
    executable = adapter / "python"
    executable.write_text("fixture interpreter identity")
    (source / "python-adapter.json").write_text(json.dumps({"executableSha256": checkpoint.digest(executable), "files": checkpoint.tree_identity(adapter)}))
    monkeypatch.setattr(checkpoint.sys, "executable", str(executable))
    monkeypatch.setattr(checkpoint.sys, "base_prefix", str(adapter))
    output = tmp_path / "output"
    output.mkdir()
    for name in ("DC2_DEPLOYMENT", "DC2_COMPONENT", "DC2_GENERATION"):
        monkeypatch.setenv(name, "fixture")
    monkeypatch.setattr(checkpoint, "native_identity", lambda: {"boundCpus": [0, 1, 2]})
    monkeypatch.setattr(checkpoint, "cgroup_cpu", lambda: {"usage_usec": 0})
    commands = []

    def finite(command, cwd, log, timeout):
        commands.append(command)
        if command == ["decomposePar", "-help"]:
            log.write_text("-copyUniform" if copy_uniform_supported else "unsupported pinned fixture")
        if command == ["reconstructPar", "-help"]:
            log.write_text("-time")

    monkeypatch.setattr(checkpoint, "run_finite", finite)
    arms = []
    initial_verified = []

    def validate_initial(original, reconstructed):
        if experiment == "changed-initial":
            raise ValueError("Changed initial field fixture")
        initial_verified.append(True)
        return {"valuesIdentical": True}

    monkeypatch.setattr(checkpoint, "reconstruct_global", lambda *args: {"wallSeconds": 1, "cgroupCpuSeconds": 1})
    monkeypatch.setattr(checkpoint, "validate_reconstructed_input", validate_initial)
    monkeypatch.setattr(checkpoint, "copy_checkpoint", lambda *args: {})

    def arm(canonical, destination, name, identity, deadline, ranks=3, experiment="placement"):
        if experiment == "serial-mpi":
            assert initial_verified == [True]
            assert ranks == (3 if name == "B" else 1)
        arms.append((name, checkpoint.tree_identity(canonical)))
        return {"arm": name, "ranks": ranks, "inputSha256": checkpoint.value_digest(checkpoint.tree_identity(canonical))}

    monkeypatch.setattr(checkpoint, "run_arm", arm)
    if not copy_uniform_supported:
        with pytest.raises(ValueError, match="does not advertise"):
            checkpoint.native_run(source, output)
        assert len(commands) == 2
        assert not arms
        return
    if experiment == "changed-initial":
        with pytest.raises(ValueError, match="Changed initial"):
            checkpoint.native_run(source, output)
        assert not arms
        assert not (output / "report.json").exists()
        return
    checkpoint.native_run(source, output)
    assert [command[0] for command in commands] == ["checkMesh", "decomposePar", "decomposePar"] + (["reconstructPar"] if experiment == "serial-mpi" else [])
    assert commands[1] == ["decomposePar", "-help"]
    assert commands[2][-1] == "-copyUniform"
    assert [name for name, _ in arms] == ["A1", "B", "A2"]
    assert arms[0][1] == arms[2][1]
    if experiment == "placement":
        assert arms[0][1] == arms[1][1]
    else:
        assert "system/decomposeParDict" not in arms[0][1]
        assert "system/decomposeParDict" in arms[1][1]
    assert (case / "system/controlDict").read_text() == "immutable actual-case fixture"
    report = json.loads((output / "report.json").read_text())
    assert report["acceptedCfd"] is False
    assert report["published"] is False
    assert report["acceptance"]["status"] == "incomplete"
    assert (report["preludeSteps"], report["fixedSteps"], report["totalRequestedSteps"]) == (62, 63, 125)
    assert report["sourcePhysicalStart"] == checkpoint.START_TIME
    assert report["physicalStart"] == checkpoint.MEASUREMENT_START_TIME


def test_checkpoint_declaration_is_private_finite_and_three_cpu_without_new_engine():
    from pathlib import Path
    import tomllib
    import yaml

    root = Path(__file__).parents[1]
    configuration = tomllib.loads((root / ".devcoordinator.toml").read_text())
    deployment = configuration["deployment"][control.NAME]
    component = deployment["component"]["benchmark"]
    assert deployment["public"] is False
    assert "domain" not in deployment
    assert component["services"] == component["finite_services"] == ["paired"]
    assert component["build"] is component["port"] is component["route"] is False
    service = yaml.safe_load((root / "compose.checkpoint-placement.yml").read_text())["services"]["paired"]
    assert service["image"] == checkpoint.IMAGE
    assert service["pull_policy"] == "never"
    assert service["network_mode"] == "none"
    assert service["cpus"] == 3
    assert "ports" not in service
    assert any(mount.endswith(":/input:ro") for mount in service["volumes"])
    assert any(mount.endswith(":/python:ro") for mount in service["volumes"])
    assert "/python/bin/python3.12" in service["command"][0]
    assert not any("docker.sock" in mount for mount in service["volumes"])
    ranks = configuration["test"]["checkpoint-rank-count"]
    placement = configuration["test"]["checkpoint-placement"]
    assert ranks["timeout_seconds"] == placement["timeout_seconds"] == 1800
    assert ranks["env"]["CHECKPOINT_EXPERIMENT"] == "serial-mpi"
    assert ranks["check"] == placement["check"]


def test_checkpoint_stop_never_signals_a_foreign_process_group(monkeypatch):
    process = Mock(pid=12345)
    process.poll.return_value = None
    monkeypatch.setattr(checkpoint.os, "getpgid", lambda pid: 45678)
    send = Mock()
    monkeypatch.setattr(checkpoint.os, "killpg", send)
    with pytest.raises(ValueError, match="unexpected process group"):
        checkpoint.stop_owned(process)
    send.assert_not_called()


def test_checkpoint_apply_failure_retains_typed_diagnostic_before_raising(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    response = {"ok": False, "error": {"code": "deployment_apply_failed", "message": "native startup failed", "detail": "exact fixture diagnostic"}}
    monkeypatch.setattr(control.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps(response), returncode=1))
    receipt = tmp_path / "apply-error.json"
    with pytest.raises(RuntimeError, match="deployment_apply_failed"):
        control.coordinator("deployment.apply", {"name": control.NAME}, error_receipt=receipt)
    assert json.loads(receipt.read_text()) == {"operation": "deployment.apply", "response": response}


def test_checkpoint_stages_existing_python_without_install_or_image_change(tmp_path, monkeypatch):
    prefix = tmp_path / "installed-python"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "lib").mkdir()
    executable = prefix / "bin/python3.12"
    executable.write_bytes(b"existing interpreter fixture")
    (prefix / "lib/runtime.so.1").write_bytes(b"existing library fixture")
    (prefix / "lib/runtime.so").symlink_to("runtime.so.1")
    monkeypatch.setattr(control, "PYTHON_SHA256", checkpoint.digest(executable))
    result = control.stage_python_adapter(tmp_path / "staged", prefix)
    assert result["executableSha256"] == checkpoint.digest(executable)
    assert checkpoint.tree_identity(tmp_path / "staged") == result["files"]
    assert not (tmp_path / "staged/lib/runtime.so").is_symlink()
    assert executable.read_bytes() == b"existing interpreter fixture"


def test_checkpoint_python_adapter_rejects_changed_binary_and_external_links(tmp_path, monkeypatch):
    prefix = tmp_path / "installed-python"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "lib").mkdir()
    executable = prefix / "bin/python3.12"
    executable.write_bytes(b"existing interpreter fixture")
    with pytest.raises(ValueError, match="approved local identity"):
        control.stage_python_adapter(tmp_path / "refused", prefix)
    monkeypatch.setattr(control, "PYTHON_SHA256", checkpoint.digest(executable))
    outside = tmp_path / "outside"
    outside.write_text("must not copy")
    (prefix / "lib/escape").symlink_to(outside)
    with pytest.raises(ValueError, match="external link"):
        control.stage_python_adapter(tmp_path / "refused", prefix)
    assert not (tmp_path / "refused").exists()


def test_checkpoint_existing_python_relocates_without_installing_dependencies(tmp_path):
    import json
    import os
    import subprocess

    staged = tmp_path / "python"
    receipt = control.stage_python_adapter(staged)
    command = [str(staged / "bin/python3.12"), "-c",
               "import hashlib,json,pathlib,sys; print(json.dumps({'prefix':sys.base_prefix,'version':sys.version.split()[0],'fileDigest':hasattr(hashlib,'file_digest')}))"]
    completed = subprocess.run(command, capture_output=True, text=True, check=True,
                               env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    observed = json.loads(completed.stdout)
    assert observed == {"prefix": str(staged), "version": "3.12.13", "fileDigest": True}
    assert checkpoint.tree_identity(staged) == receipt["files"]


def checkpoint_boundary_fixture(step, ranks=3):
    return {"relativeStep": step, "time": float(checkpoint.MEASUREMENT_START_TIME if step == 62 else checkpoint.END_TIME),
            "elapsedSeconds": float(step), "masterExecutionSeconds": step * 0.8, "masterClockSeconds": float(step),
            "cgroupCpu": {"usage_usec": step * 2500000, "user_usec": step * 2300000,
                          "system_usec": step * 200000, "throttled_usec": step * 10000},
            "rankCpu": {str(rank): {"pid": 100 + rank, "startTicks": 500 + rank, "affinity": [rank],
                                    "userSeconds": step * 0.7, "systemSeconds": step * 0.1} for rank in range(ranks)}}


@pytest.mark.parametrize("mutation", [None, "pid", "startTicks", "affinity", "sparse", "reset", "step", "time", "clock"])
def test_checkpoint_timing_subtracts_prelude_and_refuses_replaced_or_sparse_ranks(mutation):
    first, last = checkpoint_boundary_fixture(62), checkpoint_boundary_fixture(125)
    if mutation in ("pid", "startTicks"):
        last["rankCpu"]["1"][mutation] += 1
    elif mutation == "affinity":
        last["rankCpu"]["1"]["affinity"] = [9]
    elif mutation == "sparse":
        del last["rankCpu"]["2"]
    elif mutation == "reset":
        last["rankCpu"]["1"]["userSeconds"] = 0
    elif mutation == "step":
        last["relativeStep"] = 124
    elif mutation == "time":
        last["time"] += 1e-5
    elif mutation == "clock":
        last["elapsedSeconds"] = float("nan")
    if mutation:
        with pytest.raises(ValueError):
            checkpoint.interval_metrics(first, last)
    else:
        result = checkpoint.interval_metrics(first, last)
        assert result["steps"] == result["wallSeconds"] == 63
        assert result["rankCpuSeconds"] == pytest.approx(63 * 0.8 * 3)
        assert result["masterExecutionSeconds"] == pytest.approx(63 * 0.8)
        assert result["cgroupCpuDelta"]["usage_usec"] == 63 * 2500000


def checkpoint_coefficients_fixture():
    interval = (float(checkpoint.END_TIME) - float(checkpoint.MEASUREMENT_START_TIME)) / 63
    return [{"time": float(checkpoint.MEASUREMENT_START_TIME) + step * interval,
             "Cl": 0.4, "Cd": 0.03, "Cm": -0.02} for step in range(1, 64)]


@pytest.mark.parametrize("experiment,ranks", [("placement", 3), ("serial-mpi", 1), ("serial-mpi", 3)])
@pytest.mark.parametrize("delayed_coefficients", [False, True])
def test_checkpoint_arm_stops_after_actual_second_write_and_separates_prelude(tmp_path, monkeypatch, experiment, ranks, delayed_coefficients):
    import json
    from types import SimpleNamespace

    canonical, output = tmp_path / "canonical", tmp_path / "output"
    canonical.mkdir()
    output.mkdir()
    (canonical / "frozen-input").write_text("one authenticated decomposition fixture")
    monkeypatch.setattr(checkpoint, "cgroup_cpu", lambda: {"usage_usec": 0})
    monkeypatch.setattr(checkpoint, "capture_boundary",
                        lambda step, physical, execution, started, receipts, expected: checkpoint_boundary_fixture(step, expected))
    monkeypatch.setattr(checkpoint, "checkpoint_ready", lambda case, step, ranks: step in (62, 125))
    monkeypatch.setattr(checkpoint, "reconstruct_global", lambda *args: {"wallSeconds": 2, "cgroupCpuSeconds": 2})
    snapshots = []
    monkeypatch.setattr(checkpoint, "copy_checkpoint", lambda case, destination, step, ranks: snapshots.append(step) or {})
    coefficient_calls = []

    def coefficients(case, start, end, expected_steps=63):
        coefficient_calls.append((start, end, expected_steps))
        if delayed_coefficients and len(coefficient_calls) == 1:
            raise ValueError("Final native coefficient row has not reached disk yet")
        return [{"time": end}] * expected_steps

    monkeypatch.setattr(checkpoint, "coefficient_trace", coefficients)
    process = SimpleNamespace(returncode=-15, poll=lambda: None)

    def launch(command, stdout, **kwargs):
        if ranks == 3:
            assert command[:8] == ["mpirun", "--allow-run-as-root", "--bind-to", "none", "--use-hwthread-cpus", "-np", "3", checkpoint.sys.executable]
        else:
            assert command[0] == checkpoint.sys.executable
            assert "mpirun" not in command
        rows = []
        for step in range(1, 126):
            physical = checkpoint.MEASUREMENT_START_TIME if step == 62 else checkpoint.END_TIME
            rows.append(f"Time = {physical}\nExecutionTime = {step * 0.8} s  ClockTime = {step} s\n")
        stdout.write("".join(rows).encode())
        stdout.flush()
        return process

    monkeypatch.setattr(checkpoint.subprocess, "Popen", launch)
    stop = Mock()
    stop.side_effect = lambda process: coefficient_calls.append("stop-after-complete-coefficients")
    monkeypatch.setattr(checkpoint, "stop_owned", stop)
    arm = "B" if experiment == "serial-mpi" and ranks == 3 else "A1"
    result = checkpoint.run_arm(canonical, output, arm, {"boundCpus": [0, 1, 2]}, float("inf"), ranks, experiment)
    stop.assert_called_once_with(process)
    assert snapshots == [62, 125]
    assert result["prelude"]["steps"] == result["prelude"]["wallSeconds"] == 62
    assert result["measurement"]["steps"] == result["measurement"]["wallSeconds"] == 63
    assert result["totalLoggedSteps"] == 125
    assert result["postEndpointLoggedSteps"] == 0
    expected = [(float(checkpoint.MEASUREMENT_START_TIME), float(checkpoint.END_TIME), 63),
                (float(checkpoint.START_TIME), float(checkpoint.MEASUREMENT_START_TIME), 62)]
    assert coefficient_calls[-5:] == expected + ["stop-after-complete-coefficients"] + expected
    assert len(coefficient_calls) == (6 if delayed_coefficients else 5)
    assert len(result["measurement"]["rankCpu"]) == ranks
    assert json.loads((output / f"{arm}-measurement.json").read_text()) == result


@pytest.mark.parametrize("mutation", [None, "sparse", "time", "duplicate", "nan"])
def test_checkpoint_comparison_requires_exact_aligned_63_real_coefficient_times(mutation):
    first, last = checkpoint_coefficients_fixture(), checkpoint_coefficients_fixture()
    if mutation == "sparse":
        last.pop(20)
    elif mutation == "time":
        last[20]["time"] += 1e-9
    elif mutation == "duplicate":
        last[20]["time"] = last[19]["time"]
    elif mutation == "nan":
        last[20]["Cl"] = float("nan")
    if mutation:
        with pytest.raises(ValueError):
            control.aligned_coefficients(first, last)
    else:
        assert control.aligned_coefficients(first, last) == {"Cl": 0, "Cd": 0, "Cm": 0}
        last[20]["Cl"] += 0.01
        assert control.aligned_coefficients(first, last)["Cl"] == pytest.approx(0.01)


def write_checkpoint_fixture(case, ranks=3, include_initial=False):
    def foam(path, kind, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"FoamFile {{ version 2.0; format ascii; class {kind}; object {path.name}; }}\n"
                        + body + "\n" + checkpoint.FOAM_FOOTER.decode() + "\n")

    for processor in checkpoint.checkpoint_roots(case, ranks).values():
        mesh = processor / "constant/polyMesh"
        foam(mesh / "owner", "labelList", "2(0 1)")
        foam(mesh / "neighbour", "labelList", "1(1)")
        foam(mesh / "boundary", "polyBoundaryMesh", "1(fixtureWall { type wall; nFaces 1; startFace 1; })")
        times = [(62, checkpoint.MEASUREMENT_START_TIME), (125, checkpoint.END_TIME)]
        if include_initial:
            times.insert(0, (0, checkpoint.START_TIME))
        for step, physical in times:
            directory = processor / physical
            foam(directory / "uniform/time", "dictionary",
                 f"value {physical};\nindex {checkpoint.START_INDEX + step};\ndeltaT 2.6666667e-05;\ndeltaT0 2.6666667e-05;")
            for field in checkpoint.FIELDS:
                kind = "volVectorField" if field == "U" else "surfaceScalarField" if field == "phi" else "volScalarField"
                data = "List<vector> 2((1 2 3)(4 5 6))" if field == "U" else "List<scalar> 1(1)" if field == "phi" else "List<scalar> 2(1 2)"
                value = "(0 0 0)" if field == "U" else "0"
                foam(directory / field, kind, f"dimensions [0 0 0 0 0 0 0]; internalField nonuniform {data};\n"
                     + f"boundaryField {{ fixtureWall {{ type fixedValue; value uniform {value}; }} }}")


@pytest.mark.parametrize("mutation", [None, "missing", "truncated", "count", "nan", "identity", "wrong_time"])
def test_checkpoint_validates_all_three_rank_fields_before_copy(tmp_path, mutation):
    case = tmp_path / "case"
    write_checkpoint_fixture(case)
    directory = case / "processor2" / checkpoint.END_TIME
    target = directory / "p"
    if mutation == "missing":
        target.unlink()
    elif mutation == "truncated":
        target.write_text(target.read_text().replace(checkpoint.FOAM_FOOTER.decode(), ""))
    elif mutation == "count":
        target.write_text(target.read_text().replace("2(1 2)", "2(1)"))
    elif mutation == "nan":
        target.write_text(target.read_text().replace("2(1 2)", "2(1 nan)"))
    elif mutation == "identity":
        target.write_text(target.read_text().replace("object p;", "object k;"))
    elif mutation == "wrong_time":
        target = directory / "uniform/time"
        target.write_text(target.read_text().replace("31675", "31674"))
    destination = tmp_path / "snapshot"
    if mutation:
        with pytest.raises(ValueError):
            checkpoint.copy_checkpoint(case, destination, 125)
        assert not destination.exists()
    else:
        assert checkpoint.checkpoint_ready(case, 62)
        assert checkpoint.checkpoint_ready(case, 125)
        for step in (62, 125):
            result = checkpoint.copy_checkpoint(case, destination / str(step), step)
            assert set(result) == {"0", "1", "2"}
            for rank, record in result.items():
                assert record["state"]["index"] == checkpoint.START_INDEX + step
                assert set(record["files"]) == {*checkpoint.FIELDS, "uniform/time"}
                assert record["files"]["U"]["count"] == 2
                assert record["files"]["phi"]["count"] == 1


@pytest.mark.parametrize("experiment,mutation", [
    (experiment, mutation) for experiment in ("placement", "serial-mpi")
    for mutation in (None, "finite_delta", "misaligned", "sparse", "corrupt")
] + [("serial-mpi", mutation) for mutation in ("missing-proof", "changed-proof", "rank", "input")])
def test_checkpoint_paired_journey_compares_both_actual_writes_without_publication(tmp_path, experiment, mutation):
    import json

    owner = {"runId": "paired-fixture", "path": str(tmp_path), "name": control.NAME, "experiment": experiment}
    root = tmp_path / control.RELATIVE_ROOT
    (root / "input").mkdir(parents=True)
    (root / "receipt").mkdir()
    checkpoint.write_json(root / "input/owner.json", owner)
    report = {"kind": "checkpoint-placement-benchmark-only", "runId": owner["runId"],
              "acceptedCfd": False, "published": False, "fixedSteps": 63, "arms": [], "experiment": experiment}
    if experiment == "serial-mpi":
        initial = root / "initial"
        write_checkpoint_fixture(initial, ranks=1, include_initial=True)
        report["initialReconstruction"] = checkpoint.validate_reconstructed_input(initial, initial)
        report["inputIdentities"] = {"global": "global-input", "parallel": "decomposed-input"}
    for arm in ("A1", "B", "A2"):
        case = root / "output" / arm
        snapshot_ranks = 1 if experiment == "serial-mpi" else 3
        write_checkpoint_fixture(case, snapshot_ranks)
        directory = "global" if experiment == "serial-mpi" else "processor1"
        if arm == "B" and mutation == "finite_delta":
            target = (case if snapshot_ranks == 1 else case / directory) / checkpoint.MEASUREMENT_START_TIME / "p"
            target.write_text(target.read_text().replace("2(1 2)", "2(1 2.5)"))
        snapshots = {label: checkpoint.copy_checkpoint(case, root / "output/snapshots" / arm / label, step, snapshot_ranks)
                     for label, step in (("start", 62), ("end", 125))}
        ranks = 1 if experiment == "serial-mpi" and arm != "B" else 3
        input_sha = "identical-fixture-decomposition" if experiment == "placement" else report["inputIdentities"]["parallel" if arm == "B" else "global"]
        report["arms"].append({"arm": arm, "ranks": ranks, "inputSha256": input_sha, "snapshots": snapshots,
                               "boundaries": {"start": checkpoint_boundary_fixture(62), "end": checkpoint_boundary_fixture(125)},
                               "prelude": {"steps": 62, "wallSeconds": 62},
                               "measurement": {"steps": 63, "wallSeconds": 63, "rankCpuSeconds": ranks * 50},
                               "coefficients": checkpoint_coefficients_fixture()})
    if mutation == "misaligned":
        report["arms"][1]["coefficients"][12]["time"] += 1e-8
    elif mutation == "sparse":
        report["arms"][1]["coefficients"].pop()
    elif mutation == "corrupt":
        (root / "output/snapshots/B/end" / ("global" if experiment == "serial-mpi" else "processor2") / "U").write_text("incomplete")
    elif mutation == "missing-proof":
        report.pop("initialReconstruction")
    elif mutation == "changed-proof":
        report["initialReconstruction"]["fields"]["p"]["candidateValueSha256"] = "changed"
    elif mutation == "rank":
        report["arms"][0]["ranks"] = 3
    elif mutation == "input":
        report["arms"][1]["inputSha256"] = "foreign"
    checkpoint.write_json(root / "output/report.json", report)
    if mutation not in (None, "finite_delta"):
        with pytest.raises(ValueError):
            control.verify(owner)
        assert not (root / "receipt/comparison.json").exists()
    else:
        control.verify(owner)
        comparison = json.loads((root / "receipt/comparison.json").read_text())
        assert comparison["acceptedCfd"] is comparison["published"] is False
        assert comparison["numericalEquivalence"] == ("requires_review" if mutation else "identical")
        for value in comparison["comparisons"].values():
            assert value["baselinePrelude"]["steps"] == 62
            assert value["baselineWallSeconds"] == value["parallelWallSeconds" if experiment == "serial-mpi" else "boundWallSeconds"] == 63
            assert len(value["maxAbsoluteFieldDeltaAtBothWrites"]) == (12 if experiment == "serial-mpi" else 36)
            assert value["maxAbsoluteFieldDeltaAtBothWrites"][f"start/{directory}/p"]["internal"] == (0.5 if mutation else 0)
            if experiment == "serial-mpi":
                assert value["parallelToSerialCpuCostRatio"] == 3
                assert value["idealThreeCoreParallelEfficiency"] == pytest.approx(1 / 3)


@pytest.mark.parametrize("mutation", [None, "value", "boundary", "mesh", "time", "sparse", "nan"])
def test_checkpoint_initial_reconstruction_requires_exact_global_values_and_boundaries(tmp_path, mutation):
    original, reconstructed = tmp_path / "original", tmp_path / "reconstructed"
    write_checkpoint_fixture(original, 1, True)
    write_checkpoint_fixture(reconstructed, 1, True)
    target = reconstructed / checkpoint.START_TIME / "p"
    if mutation == "value":
        target.write_text(target.read_text().replace("2(1 2)", "2(1 2.0000000000001)"))
    elif mutation == "boundary":
        target.write_text(target.read_text().replace("value uniform 0;", "value uniform 0.001;"))
    elif mutation == "mesh":
        target = reconstructed / "constant/polyMesh/owner"
        target.write_text(target.read_text().replace("2(0 1)", "2(0 2)"))
    elif mutation == "time":
        target = reconstructed / checkpoint.START_TIME / "uniform/time"
        target.write_text(target.read_text().replace("31550", "31551"))
    elif mutation == "sparse":
        target.unlink()
    elif mutation == "nan":
        target.write_text(target.read_text().replace("2(1 2)", "2(1 nan)"))
    if mutation:
        with pytest.raises(ValueError):
            checkpoint.validate_reconstructed_input(original, reconstructed)
    else:
        result = checkpoint.validate_reconstructed_input(original, reconstructed)
        assert result["valuesIdentical"] is True
        assert set(result["fields"]) == set(checkpoint.FIELDS)


@pytest.mark.parametrize("ranks", [1, 3])
def test_checkpoint_serial_mpi_rank_entry_never_binds_and_serial_avoids_mpi(tmp_path, monkeypatch, ranks):
    for name in list(checkpoint.os.environ):
        if name.startswith("OMPI_COMM_WORLD_"):
            monkeypatch.delenv(name)
    if ranks == 3:
        for name, value in (("OMPI_COMM_WORLD_LOCAL_RANK", "0"), ("OMPI_COMM_WORLD_SIZE", "3"), ("OMPI_COMM_WORLD_LOCAL_SIZE", "3")):
            monkeypatch.setenv(name, value)
    bind = Mock()
    execute = Mock()
    monkeypatch.setattr(checkpoint.os, "sched_setaffinity", bind)
    monkeypatch.setattr(checkpoint.os, "execv", execute)
    monkeypatch.setattr(checkpoint.shutil, "which", lambda name: "/pinned/pimpleFoam")
    checkpoint.rank_entry(tmp_path, tmp_path, "B" if ranks == 3 else "A1", [0, 1, 2], ranks, "serial-mpi")
    bind.assert_not_called()
    execute.assert_called_once_with("/pinned/pimpleFoam", ["/pinned/pimpleFoam", *(["-parallel"] if ranks == 3 else []), "-case", str(tmp_path)])
    first, last = checkpoint_boundary_fixture(62, ranks), checkpoint_boundary_fixture(125, ranks)
    assert checkpoint.interval_metrics(first, last, ranks)["rankCpuSeconds"] == pytest.approx(63 * 0.8 * ranks)


def test_checkpoint_reconstruction_uses_only_validated_times_and_never_mutates_input(tmp_path, monkeypatch):
    import shutil

    case, destination = tmp_path / "case", tmp_path / "reconstructed"
    write_checkpoint_fixture(case, 3, True)
    shutil.copytree(case / "processor0/constant", case / "constant")
    (case / "system").mkdir()
    (case / "system/controlDict").write_text("unchanged original numerics")
    before = checkpoint.tree_identity(case)
    monkeypatch.setattr(checkpoint, "cgroup_cpu", lambda: {"usage_usec": 0})
    finite = Mock()
    monkeypatch.setattr(checkpoint, "run_finite", finite)
    checkpoint.reconstruct_global(case, destination, (62, 125))
    command = finite.call_args.args[0]
    assert command == ["reconstructPar", "-case", str(destination), "-time", f"{checkpoint.MEASUREMENT_START_TIME},{checkpoint.END_TIME}"]
    assert checkpoint.tree_identity(case) == before
    for rank in range(3):
        assert not (destination / f"processor{rank}" / checkpoint.START_TIME).exists()
        assert (destination / f"processor{rank}" / checkpoint.END_TIME / "phi").is_file()
