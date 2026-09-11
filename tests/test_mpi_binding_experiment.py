from unittest.mock import Mock
import pytest

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
