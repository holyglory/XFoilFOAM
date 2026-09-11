from copy import deepcopy

import pytest

from scripts.materials.verify_rae2822_hold import checkpoint_signatures, remaining_allocation


REPORT = {"kind": "rae2822-transonic-pressure-validation", "production_evidence": False,
          "outcome": "measured_converged", "convergence": {"converged": True}, "budget_exhausted": False,
          "request": {"solver": {"force_transient": False, "flow_solver_family": "rhoSimpleFoam", "n_iterations": 3000}},
          "pressure_iteration": 2150, "time_budget_seconds": 600, "active_seconds": 176.766426}
LOG = "Time = 2150\nSIMPLE solution converged in 2150 iterations\n"


def test_reference_hold_preserves_original_total_budget_and_iteration_ceiling():
    result = remaining_allocation(REPORT, LOG, 2150, 3000)
    assert result["remaining_seconds"] == pytest.approx(423.233574)
    assert result["prior_active_seconds"] + result["remaining_seconds"] == 600
    assert result["maximum_iteration"] == 3000


@pytest.mark.parametrize("changes", [
    {"outcome": "measured_unconverged"}, {"convergence": {"converged": False}},
    {"budget_exhausted": True}, {"experimental_local_time_pressure": True},
    {"experimental_density_local_time": True}, {"active_seconds": float("nan")},
    {"active_seconds": 600}, {"time_budget_seconds": True}, {"pressure_iteration": 2149},
])
def test_reference_hold_refuses_unproven_or_exhausted_sources(changes):
    with pytest.raises(ValueError):
        remaining_allocation({**deepcopy(REPORT), **changes}, LOG, 2150, 3000)


def test_report_claim_cannot_replace_native_convergence_or_extend_allocation():
    with pytest.raises(ValueError, match="converged"):
        remaining_allocation(REPORT, "Time = 2150\n", 2150, 3000)
    with pytest.raises(ValueError, match="ceiling"):
        remaining_allocation(REPORT, LOG, 2150, 3200)
    with pytest.raises(ValueError, match="ceiling"):
        remaining_allocation(REPORT, LOG, True, 3000)


def test_held_checkpoint_requires_every_nonempty_field(tmp_path):
    directory = tmp_path / "2350"
    directory.mkdir()
    for name in ("U", "p", "T", "k", "omega", "rho", "phi"):
        (directory / name).write_text(f"isolated checkpoint fixture {name}")
    assert len(checkpoint_signatures(tmp_path, 2350)) == 7
    for name in ("U", "p", "T", "k", "omega", "rho", "phi"):
        path = directory / name
        content = path.read_bytes()
        path.write_bytes(b"")
        with pytest.raises(ValueError, match="complete checkpoint"):
            checkpoint_signatures(tmp_path, 2350)
        path.write_bytes(content)
