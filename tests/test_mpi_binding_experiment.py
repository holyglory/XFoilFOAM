from unittest.mock import Mock

from scripts.materials.mpi_binding_experiment import configure_unbound_mpi


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
