from pathlib import Path
import shlex

import pytest

from airfoilfoam import physics
from airfoilfoam.cache import EngineCache
from airfoilfoam.cancellation import JobCancelled
from airfoilfoam.models import CaseSpec, RoughnessParams, SolverParams
from airfoilfoam.openfoam.runner import InfrastructureError, OpenFOAMError, RunResult, Runner
from airfoilfoam.pipeline import _rewrite_carried_inlet_velocity


class BoundaryRunner(Runner):
    def __init__(self, inlet="freestreamVelocity", outlet="freestreamVelocity", failure=None):
        super().__init__()
        self.boundaries = {
            "inlet": {"type": inlet, "value": "uniform (29.9817 1.04698 0)", "freestreamValue": "uniform (29.9817 1.04698 0)"},
            "outlet": {"type": outlet, "value": "uniform (29.9817 1.04698 0)", "freestreamValue": "uniform (29.9817 1.04698 0)", "inletValue": "uniform (0 0 0)"},
            "airfoil": {"type": "noSlip", "value": "uniform (0 0 0)"},
        }
        self.commands = []
        self.failure = failure

    def run(self, case_dir: Path, command: str, timeout: int = 7200, monitor=None):
        self.commands.append(command)
        if self.failure and self.failure in command:
            return RunResult(command, 1, "isolated dictionary failure")
        arguments = shlex.split(command)
        _, patch, entry = arguments[arguments.index("-entry") + 1].split(".")
        if "-value" in arguments:
            return RunResult(command, 0, self.boundaries[patch][entry] + ";\n")
        self.boundaries[patch][entry] = arguments[arguments.index("-set") + 1]
        return RunResult(command, 0, "")


@pytest.mark.parametrize("boundary_type", ["freestreamVelocity", "freestream"])
def test_carried_freestream_uses_requested_angle_not_donor_angle(tmp_path, boundary_type):
    runner = BoundaryRunner(boundary_type, boundary_type)
    spec = CaseSpec(chord=1, speed=30, aoa_deg=4)
    velocity = physics.freestream_vector(spec.speed, spec.aoa_deg)
    expected = f"uniform ({velocity.ux:.10g} {velocity.uy:.10g} 0)"
    _rewrite_carried_inlet_velocity(tmp_path, spec, "3415", runner)
    for patch in ("inlet", "outlet"):
        assert runner.boundaries[patch]["value"] == expected
        assert runner.boundaries[patch]["freestreamValue"] == expected
    assert runner.boundaries["airfoil"] == {"type": "noSlip", "value": "uniform (0 0 0)"}
    assert runner.boundaries["outlet"]["inletValue"] == "uniform (0 0 0)"
    assert all(command.endswith("3415/U") for command in runner.commands)
    assert all("-value" in command for command in runner.commands[:2])


@pytest.mark.parametrize("outlet", ["inletOutlet", "zeroGradient"])
def test_fixed_velocity_and_zero_backflow_policy_are_preserved(tmp_path, outlet):
    runner = BoundaryRunner("fixedValue", outlet)
    _rewrite_carried_inlet_velocity(tmp_path, CaseSpec(chord=1, speed=30, aoa_deg=4), "_seed_stage", runner)
    writes = [command for command in runner.commands if "-set" in command]
    assert len(writes) == 2
    assert all(".value -set" in command for command in writes)
    assert runner.boundaries["outlet"]["inletValue"] == "uniform (0 0 0)"
    assert all("airfoil" not in command for command in runner.commands)


@pytest.mark.parametrize("boundary_type", ["", "unexpectedBoundary"])
def test_unknown_boundary_refuses_all_writes_before_solve(tmp_path, boundary_type):
    runner = BoundaryRunner(outlet=boundary_type)
    with pytest.raises(InfrastructureError, match="Unsupported carried velocity boundary"):
        _rewrite_carried_inlet_velocity(tmp_path, CaseSpec(chord=1, speed=30, aoa_deg=4), "3415", runner)
    assert not any("-set" in command for command in runner.commands)


def test_failed_boundary_inspection_never_partially_retargets_a_field(tmp_path):
    runner = BoundaryRunner(failure="boundaryField.outlet.type")
    with pytest.raises(OpenFOAMError):
        _rewrite_carried_inlet_velocity(tmp_path, CaseSpec(chord=1, speed=30, aoa_deg=4), "3415", runner)
    assert not any("-set" in command for command in runner.commands)


def test_cancelled_retargeting_does_not_execute_dictionary_commands(tmp_path):
    runner = BoundaryRunner()

    def cancelled():
        raise JobCancelled("isolated cancellation")

    with pytest.raises(JobCancelled):
        _rewrite_carried_inlet_velocity(tmp_path, CaseSpec(chord=1, speed=30, aoa_deg=4), "3415", runner, cancel_check=cancelled)
    assert runner.commands == []


def test_failed_value_write_prevents_remaining_writes(tmp_path):
    runner = BoundaryRunner(failure="boundaryField.inlet.freestreamValue -set")
    with pytest.raises(OpenFOAMError):
        _rewrite_carried_inlet_velocity(tmp_path, CaseSpec(chord=1, speed=30, aoa_deg=4), "3415", runner)
    assert not any("boundaryField.outlet.value -set" in command for command in runner.commands)


def test_prior_field_carry_signatures_are_not_reused(monkeypatch):
    from airfoilfoam import cache

    current = EngineCache.solver_signature(SolverParams(), RoughnessParams())
    monkeypatch.setattr(cache, "STEADY_RANS_MARCHER_SEED_VERSION", "zero-anchored-v1")
    assert EngineCache.solver_signature(SolverParams(), RoughnessParams()) != current
