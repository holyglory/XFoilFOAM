import pytest

from scripts.materials.solver_stability import solver_stability


def test_tail_excludes_startup_clamping_and_keeps_real_signed_continuity():
    lines = """Time = 1
pressureControl: p max 240000
Time = 2
time step continuity errors : sum local = 1e-7, global = -2e-8, cumulative = 8e-6
Time = 3
time step continuity errors : sum local = 2e-7, global = 3e-8, cumulative = 8.03e-6
""".splitlines()
    measured = solver_stability(lines, 2)
    assert measured["window_iterations"] == 2
    assert measured["pressure_limited_iterations"] == 0
    assert measured["first_coordinate"] == 2
    assert measured["last_continuity"]["global"] == 3e-8
    assert measured["maximum_absolute_global"] == 3e-8
    assert measured["acceptance_verdict"] == "not_evaluated"


def test_counts_iterations_not_repeated_nonorthogonal_correctors():
    measured = solver_stability("""Time = 6000
pressureControl: p min 2000
pressureControl: p max 230000
pressureControl: p max 230000
time step continuity errors : sum local = 3.1, global = -0.49, cumulative = -10875
time step continuity errors : sum local = 2.9, global = -0.4, cumulative = -10875.4
""".splitlines())
    assert measured["pressure_limited_iterations"] == 1
    assert measured["pressure_min_limited_iterations"] == 1
    assert measured["pressure_max_limited_iterations"] == 1
    assert measured["continuity_samples"] == 2
    assert measured["maximum_absolute_global"] == 0.49
    assert measured["maximum_sum_local"] == 3.1


def test_reconstruction_time_does_not_displace_a_real_iteration():
    lines = ["Time = 1", "pressureControl: p max 230000", "Time = 2",
             "time step continuity errors : sum local = 1e-7, global = 0, cumulative = 0"]
    measured = solver_stability(lines + ["Time = 2", "Reconstructing fields"], 2)
    assert measured == solver_stability(lines, 2)
    assert measured["pressure_limited_iterations"] == 1
    assert measured["first_coordinate"] == 1


def test_restarted_coordinates_do_not_mix_with_a_prior_run():
    measured = solver_stability(["Time = 100", "pressureControl: p max 230000", "Time = 1",
                                 "time step continuity errors : sum local = 1e-7, global = 0, cumulative = 0"])
    assert measured["window_iterations"] == 1
    assert measured["first_coordinate"] == 1
    assert measured["pressure_limited_iterations"] == 0


def test_does_not_invent_continuity_or_match_configuration_text():
    assert solver_stability(["pressureControl: p max 2"]) == {"available": False, "reason": "no_solver_iterations"}
    measured = solver_stability(["Time = 1", "    pMaxFactor 2;", "pressureControl limits disabled"])
    assert measured["continuity_samples"] == 0
    assert measured["last_continuity"] is None
    assert measured["maximum_sum_local"] is None
    assert measured["pressure_limited_iterations"] == 0


def test_reports_persistent_late_pressure_limiting_without_assigning_acceptance():
    lines = []
    for iteration in range(1, 302):
        lines.extend([f"Time = {iteration}", "pressureControl: p max 227864.87",
                      "time step continuity errors : sum local = 3.139, global = -0.489, cumulative = -10875.941"])
    measured = solver_stability(iter(lines))
    assert measured["window_iterations"] == 200
    assert measured["first_coordinate"] == 102
    assert measured["pressure_limited_iterations"] == 200
    assert measured["last_continuity"]["global"] == -0.489
    assert measured["acceptance_verdict"] == "not_evaluated"


@pytest.mark.parametrize("window", [0, -1, True, 1.5])
def test_refuses_invalid_windows(window):
    with pytest.raises(ValueError):
        solver_stability([], window)


@pytest.mark.parametrize("line", ["Time = -1", "Time = 1e999", "time step continuity errors : sum local = -1, global = 0, cumulative = 0", "pressureControl: p max 1e999"])
def test_refuses_nonfinite_or_invalid_measurements(line):
    with pytest.raises(ValueError):
        solver_stability(["Time = 1", line])
