from pathlib import Path

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.openfoam.runner import (
    CommandLaunchError,
    CommandTimeoutError,
    InsufficientMpiSlotsError,
    RunResult,
    Runner,
)


class RecordingRunner(Runner):
    def __init__(self) -> None:
        self.commands: list[tuple[Path, str, int, object]] = []

    def run(self, case_dir, command, timeout=7200, monitor=None):
        self.commands.append((Path(case_dir), command, timeout, monitor))
        return RunResult(command=command, returncode=0, stdout="")


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
