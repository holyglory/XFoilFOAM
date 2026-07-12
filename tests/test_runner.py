from pathlib import Path

from airfoilfoam.openfoam.runner import RunResult, Runner


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
