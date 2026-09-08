from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.openfoam.runner import (
    CommandLaunchError,
    CommandTimeoutError,
    InsufficientMpiSlotsError,
    RunResult,
    Runner,
    DockerRunner,
    InfrastructureError,
)


class RecordingRunner(Runner):
    def __init__(self) -> None:
        self.commands: list[tuple[Path, str, int, object]] = []

    def run(self, case_dir, command, timeout=7200, monitor=None):
        self.commands.append((Path(case_dir), command, timeout, monitor))
        return RunResult(command=command, returncode=0, stdout="")


@pytest.mark.parametrize("failure", [None, "timeout", "interrupt", "allocation"])
def test_docker_command_always_removes_its_exact_owned_container(monkeypatch, tmp_path, failure):
    from airfoilfoam.openfoam import runner as module

    operations = []

    def launch(args, **kwargs):
        operations.append(args)
        if args[1] == "create":
            if failure == "allocation":
                return RunResult(kwargs["command"], 125, "isolated allocation failure")
            return RunResult(kwargs["command"], 0, "isolated container identity")
        if failure == "interrupt":
            raise KeyboardInterrupt()
        return RunResult(kwargs["command"], 124 if failure == "timeout" else 0, "solver trace", failure == "timeout")

    def cleanup(args, **kwargs):
        operations.append(args)
        return SimpleNamespace(returncode=0, stdout="")

    monkeypatch.setattr(module, "_run_subprocess", launch)
    monkeypatch.setattr(module.subprocess, "run", cleanup)
    runner = DockerRunner(Settings())
    if failure == "interrupt":
        with pytest.raises(KeyboardInterrupt):
            runner.run(tmp_path, "rhoCentralFoam", timeout=10)
    elif failure == "allocation":
        with pytest.raises(CommandLaunchError):
            runner.run(tmp_path, "rhoCentralFoam", timeout=10)
    else:
        result = runner.run(tmp_path, "rhoCentralFoam", timeout=10)
        assert result.timed_out == (failure == "timeout")
    name = operations[0][operations[0].index("--name") + 1]
    assert name.startswith("airfoilfoam-command-")
    assert operations[-1] == ["docker", "rm", "--force", name]
    assert len(operations) == (2 if failure == "allocation" else 3)
    if failure != "allocation":
        assert operations[1] == ["docker", "start", "--attach", name]


@pytest.mark.parametrize("remaining_code,remaining_ids", [(0, "still-running"), (1, "")])
def test_docker_cleanup_cannot_claim_a_stopped_solver_without_confirmation(monkeypatch, remaining_code, remaining_ids):
    from airfoilfoam.openfoam import runner as module

    def cleanup(args, **kwargs):
        return SimpleNamespace(returncode=1 if args[1] == "rm" else remaining_code, stdout=remaining_ids)

    monkeypatch.setattr(module.subprocess, "run", cleanup)
    with pytest.raises(InfrastructureError, match="Cannot confirm removal"):
        DockerRunner(Settings())._remove_command_container("airfoilfoam-command-test-owned")


def test_docker_cleanup_allows_confirmed_absence_after_allocation_failure(monkeypatch):
    from airfoilfoam.openfoam import runner as module

    monkeypatch.setattr(module.subprocess, "run", lambda args, **kwargs: SimpleNamespace(returncode=1 if args[1] == "rm" else 0, stdout=""))
    DockerRunner(Settings())._remove_command_container("airfoilfoam-command-test-owned")


def test_parallel_solver_uses_bounded_logical_cpu_slots(tmp_path):
    runner = RecordingRunner()

    result = runner.solver(tmp_path, "pimpleFoam", n_proc=8, timeout=321)

    assert result.ok
    assert runner.commands == [
        (
            tmp_path,
            "decomposePar -force && "
            "mpirun --allow-run-as-root --use-hwthread-cpus -np 8 "
            "pimpleFoam -parallel && reconstructPar -latestTime",
            321,
            None,
        )
    ]
    assert "--oversubscribe" not in runner.commands[0][1]


def test_parallel_restart_decomposes_latest_time(tmp_path):
    runner = RecordingRunner()

    runner.solver(tmp_path, "simpleFoam", n_proc=2, restart=True)

    assert runner.commands[0][1].startswith("decomposePar -latestTime -force && ")
    assert "--use-hwthread-cpus -np 2 simpleFoam -parallel" in runner.commands[0][1]


def test_serial_solver_does_not_invoke_mpi_or_decomposition(tmp_path):
    runner = RecordingRunner()

    runner.solver(tmp_path, "simpleFoam", n_proc=1, timeout=42, restart=True)

    assert runner.commands == [(tmp_path, "simpleFoam", 42, None)]


def test_parallel_solver_rejects_rank_count_above_declared_worker_capacity(tmp_path):
    runner = RecordingRunner()
    runner.settings = Settings(worker_cpu_budget=4)

    with pytest.raises(InsufficientMpiSlotsError) as err:
        runner.solver(tmp_path, "simpleFoam", n_proc=8)

    assert err.value.requested == 8
    assert err.value.available == 4
    assert runner.commands == []


def test_run_result_timeout_flag_raises_typed_infrastructure_error():
    result = RunResult(
        command="mpirun -np 8 simpleFoam -parallel",
        returncode=124,
        stdout="solver process exceeded the command budget",
        timed_out=True,
    )

    with pytest.raises(CommandTimeoutError):
        result.check()


@pytest.mark.parametrize("returncode", [125, 126, 127])
def test_standard_launch_exit_codes_raise_typed_infrastructure_error(returncode):
    result = RunResult(
        command="blockMesh",
        returncode=returncode,
        stdout="runtime could not invoke requested command",
    )

    with pytest.raises(CommandLaunchError):
        result.check()
