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
def test_checkpoint_native_has_one_frozen_decomposition_for_all_arms(tmp_path, monkeypatch, copy_uniform_supported):
    import json

    source = tmp_path / "input"
    case = source / "case"
    (case / "system").mkdir(parents=True)
    (case / "system/controlDict").write_text("immutable actual-case fixture")
    (source / "case-files.json").write_text(json.dumps(checkpoint.tree_identity(case)))
    (source / "owner.json").write_text(json.dumps({"runId": "fixture", "driverSha256": checkpoint.digest(checkpoint.__file__)}))
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
    commands = []

    def finite(command, cwd, log, timeout):
        commands.append(command)
        if command == ["decomposePar", "-help"]:
            log.write_text("-copyUniform" if copy_uniform_supported else "unsupported pinned fixture")

    monkeypatch.setattr(checkpoint, "run_finite", finite)
    arms = []

    def arm(canonical, destination, name, identity, deadline):
        arms.append((name, checkpoint.tree_identity(canonical)))
        return {"arm": name, "inputSha256": "same-frozen-input"}

    monkeypatch.setattr(checkpoint, "run_arm", arm)
    if not copy_uniform_supported:
        with pytest.raises(ValueError, match="does not advertise"):
            checkpoint.native_run(source, output)
        assert len(commands) == 2
        assert not arms
        return
    checkpoint.native_run(source, output)
    assert [command[0] for command in commands] == ["checkMesh", "decomposePar", "decomposePar"]
    assert commands[1] == ["decomposePar", "-help"]
    assert commands[2][-1] == "-copyUniform"
    assert [name for name, _ in arms] == ["A1", "B", "A2"]
    assert arms[0][1] == arms[1][1] == arms[2][1]
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


def checkpoint_boundary_fixture(step):
    return {"relativeStep": step, "time": float(checkpoint.MEASUREMENT_START_TIME if step == 62 else checkpoint.END_TIME),
            "elapsedSeconds": float(step), "masterExecutionSeconds": step * 0.8, "masterClockSeconds": float(step),
            "cgroupCpu": {"usage_usec": step * 2500000, "user_usec": step * 2300000,
                          "system_usec": step * 200000, "throttled_usec": step * 10000},
            "rankCpu": {str(rank): {"pid": 100 + rank, "startTicks": 500 + rank, "affinity": [rank],
                                    "userSeconds": step * 0.7, "systemSeconds": step * 0.1} for rank in range(3)}}


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


def test_checkpoint_arm_stops_after_actual_second_write_and_separates_prelude(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    canonical, output = tmp_path / "canonical", tmp_path / "output"
    canonical.mkdir()
    output.mkdir()
    (canonical / "frozen-input").write_text("one authenticated decomposition fixture")
    monkeypatch.setattr(checkpoint, "cgroup_cpu", lambda: {"usage_usec": 0})
    monkeypatch.setattr(checkpoint, "capture_boundary",
                        lambda step, physical, execution, started, receipts: checkpoint_boundary_fixture(step))
    monkeypatch.setattr(checkpoint, "checkpoint_ready", lambda case, step: step in (62, 125))
    snapshots = []
    monkeypatch.setattr(checkpoint, "copy_checkpoint", lambda case, destination, step: snapshots.append(step) or {})
    coefficient_calls = []

    def coefficients(case, start, end, expected_steps=63):
        coefficient_calls.append((start, end, expected_steps))
        return [{"time": end}] * expected_steps

    monkeypatch.setattr(checkpoint, "coefficient_trace", coefficients)
    process = SimpleNamespace(returncode=-15)

    def launch(command, stdout, **kwargs):
        assert command[:8] == ["mpirun", "--allow-run-as-root", "--bind-to", "none", "--use-hwthread-cpus", "-np", "3", checkpoint.sys.executable]
        rows = []
        for step in range(1, 126):
            physical = checkpoint.MEASUREMENT_START_TIME if step == 62 else checkpoint.END_TIME
            rows.append(f"Time = {physical}\nExecutionTime = {step * 0.8} s  ClockTime = {step} s\n")
        stdout.write("".join(rows).encode())
        stdout.flush()
        return process

    monkeypatch.setattr(checkpoint.subprocess, "Popen", launch)
    stop = Mock()
    monkeypatch.setattr(checkpoint, "stop_owned", stop)
    result = checkpoint.run_arm(canonical, output, "A1", {"boundCpus": [0, 1, 2]}, float("inf"))
    stop.assert_called_once_with(process)
    assert snapshots == [62, 125]
    assert result["prelude"]["steps"] == result["prelude"]["wallSeconds"] == 62
    assert result["measurement"]["steps"] == result["measurement"]["wallSeconds"] == 63
    assert result["totalLoggedSteps"] == 125
    assert result["postEndpointLoggedSteps"] == 0
    assert coefficient_calls == [(float(checkpoint.MEASUREMENT_START_TIME), float(checkpoint.END_TIME), 63),
                                 (float(checkpoint.START_TIME), float(checkpoint.MEASUREMENT_START_TIME), 62)]
    assert json.loads((output / "A1-measurement.json").read_text()) == result


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


def write_checkpoint_fixture(case):
    def foam(path, kind, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"FoamFile {{ version 2.0; format ascii; class {kind}; object {path.name}; }}\n"
                        + body + "\n" + checkpoint.FOAM_FOOTER.decode() + "\n")

    for rank in range(3):
        processor = case / f"processor{rank}"
        mesh = processor / "constant/polyMesh"
        foam(mesh / "owner", "labelList", "2(0 1)")
        foam(mesh / "neighbour", "labelList", "1(1)")
        foam(mesh / "boundary", "polyBoundaryMesh", "1(fixtureWall { type wall; nFaces 1; startFace 1; })")
        for step, physical in ((62, checkpoint.MEASUREMENT_START_TIME), (125, checkpoint.END_TIME)):
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


@pytest.mark.parametrize("mutation", [None, "finite_delta", "misaligned", "sparse", "corrupt"])
def test_checkpoint_paired_journey_compares_both_actual_writes_without_publication(tmp_path, mutation):
    import json

    owner = {"runId": "paired-fixture", "path": str(tmp_path), "name": control.NAME}
    root = tmp_path / control.RELATIVE_ROOT
    (root / "input").mkdir(parents=True)
    (root / "receipt").mkdir()
    checkpoint.write_json(root / "input/owner.json", owner)
    report = {"kind": "checkpoint-placement-benchmark-only", "runId": owner["runId"],
              "acceptedCfd": False, "published": False, "fixedSteps": 63, "arms": []}
    for arm in ("A1", "B", "A2"):
        case = root / "output" / arm
        write_checkpoint_fixture(case)
        if arm == "B" and mutation == "finite_delta":
            target = case / "processor1" / checkpoint.MEASUREMENT_START_TIME / "p"
            target.write_text(target.read_text().replace("2(1 2)", "2(1 2.5)"))
        snapshots = {label: checkpoint.copy_checkpoint(case, root / "output/snapshots" / arm / label, step)
                     for label, step in (("start", 62), ("end", 125))}
        report["arms"].append({"arm": arm, "inputSha256": "identical-fixture-decomposition", "snapshots": snapshots,
                               "boundaries": {"start": checkpoint_boundary_fixture(62), "end": checkpoint_boundary_fixture(125)},
                               "prelude": {"steps": 62, "wallSeconds": 62},
                               "measurement": {"steps": 63, "wallSeconds": 63, "rankCpuSeconds": 150},
                               "coefficients": checkpoint_coefficients_fixture()})
    if mutation == "misaligned":
        report["arms"][1]["coefficients"][12]["time"] += 1e-8
    elif mutation == "sparse":
        report["arms"][1]["coefficients"].pop()
    elif mutation == "corrupt":
        (root / "output/snapshots/B/end/processor2/U").write_text("incomplete")
    checkpoint.write_json(root / "output/report.json", report)
    if mutation in ("misaligned", "sparse", "corrupt"):
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
            assert value["baselineWallSeconds"] == value["boundWallSeconds"] == 63
            assert len(value["maxAbsoluteFieldDeltaAtBothWrites"]) == 36
            assert value["maxAbsoluteFieldDeltaAtBothWrites"]["start/processor1/p"]["internal"] == (0.5 if mutation else 0)
