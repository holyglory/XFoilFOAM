from copy import deepcopy
from dataclasses import asdict
import re

import numpy as np
import pytest

from airfoilfoam.postprocess.forces import analyze_rans_hold
from scripts.materials.rae2822_unsteady import physical_window, validate_held_report, weighted_pressure_mean
from scripts.materials.verify_rae2822_unsteady import configure_unsteady_case
from test_rae2822_density import case_builder


def samples():
    return [(float(timestamp), {side: [[0.1, float(timestamp)], [0.9, 2 * float(timestamp)]] for side in ("upper", "lower")})
            for timestamp in np.linspace(2, 4, 41)]


def test_physical_window_and_weighting_do_not_use_iteration_coordinates():
    window = physical_window(1, 1)
    result = weighted_pressure_mean(samples(), window)
    assert result["available"] and result["field_frames"] == 41
    np.testing.assert_allclose(result["mean"]["upper"], [[0.1, 3.0], [0.9, 6.0]], rtol=0, atol=1e-12)
    assert result["statistical_certification"] is False
    assert not weighted_pressure_mean(samples()[:40], window)["available"]
    startup = [(timestamp - 2, pressure) for timestamp, pressure in samples()[1:]]
    assert not weighted_pressure_mean(startup, window)["available"]
    assert not weighted_pressure_mean([], window)["available"]
    assert physical_window(0.3, 300)["end_time"] == pytest.approx(0.01)


def test_nonuniform_frames_are_time_weighted_and_missing_intervals_are_not_bridged():
    times = 2 + 2 * np.linspace(0, 1, 61) ** 1.3
    frames = [(float(timestamp), {side: [[0.1, float(timestamp)], [0.9, float(timestamp)]] for side in ("upper", "lower")}) for timestamp in times]
    result = weighted_pressure_mean(frames, physical_window(1, 1))
    assert result["available"]
    assert result["mean"]["upper"][0][1] == pytest.approx(3, abs=1e-12)
    assert abs(result["mean"]["upper"][0][1] - float(np.mean(times))) > 0.1
    incomplete = weighted_pressure_mean(frames[:25] + frames[30:], physical_window(1, 1))
    assert incomplete["available"] is False and incomplete["reason"] == "pressure_frame_gap"


def test_common_window_interpolates_boundaries_without_inventing_saved_frames():
    frames = [(float(timestamp), {side: [[0.1, float(timestamp)], [0.9, float(timestamp)]] for side in ("upper", "lower")})
              for timestamp in np.linspace(2, 5, 61)]
    window = physical_window(1, 1)
    result = weighted_pressure_mean(frames, window, (2.12, 4.34))
    assert result["available"] and result["field_frames"] == 44
    assert result["interpolated_boundaries"] == [2.12, 4.34]
    assert result["mean"]["upper"][0][1] == pytest.approx(3.23, abs=1e-12)
    for interval in ((1.9, 4.5), (2.1, 5.1), (4, 3), (True, 4), (2, float("nan"))):
        with pytest.raises(ValueError):
            weighted_pressure_mean(frames, window, interval)


def test_pressure_mean_refuses_duplicate_times_changed_mesh_and_nonfinite_values():
    window = physical_window(1, 1)
    with pytest.raises(ValueError, match="unique"):
        weighted_pressure_mean(samples() + [samples()[-1]], window)
    for changed in ("mesh", "nonfinite"):
        frames = samples()
        frames[-1][1]["upper"][0][0 if changed == "mesh" else 1] = 0.2 if changed == "mesh" else float("nan")
        with pytest.raises(ValueError):
            weighted_pressure_mean(frames, window)


def test_held_report_is_rechecked_against_exact_raw_three_channel_history(tmp_path):
    coefficients = tmp_path / "coefficient.dat"
    coefficients.write_text("# Time Cd Cl CmPitch\n" + "".join(f"{iteration} 0.02 0.5 -0.03\n" for iteration in range(1, 201)))
    hold = analyze_rans_hold(coefficients)
    report = {"kind": "rae2822-rans-hold-reference", "eligible_urans_seed": True, "outcome": "held_reference",
              "native_returncode": 0, "timed_out": False, "initial_numerical_convergence": {"converged": True},
              "force_hold": asdict(hold), "fields_iteration": 200}
    assert validate_held_report(report, coefficients) == 200
    for patch in ({"fields_iteration": 199}, {"native_returncode": False}, {"eligible_urans_seed": False},
                  {"force_hold": {**report["force_hold"], "certified": False}}):
        with pytest.raises(ValueError):
            validate_held_report({**deepcopy(report), **patch}, coefficients)


def test_unsteady_dictionary_uses_real_time_native_courant_control_and_enthalpy(tmp_path):
    builder = case_builder(tmp_path, scheme="linearUpwind")
    window = physical_window(builder.spec.chord, builder.spec.speed)
    configure_unsteady_case(builder, tmp_path, window)
    control = " ".join((tmp_path / "system/controlDict").read_text().split())
    schemes = (tmp_path / "system/fvSchemes").read_text()
    solution = " ".join((tmp_path / "system/fvSolution").read_text().split())
    assert "application rhoPimpleFoam;" in control and "adjustTimeStep yes;" in control
    assert "maxCo 0.5;" in control and "startTime 0;" in control and "purgeWrite 0;" in control
    assert "localEuler" not in schemes and "div(phi,h)" in schemes
    assert "nOuterCorrectors 3;" in solution and "nCorrectors 2;" in solution
    assert "energy sensibleEnthalpy;" in (tmp_path / "constant/thermophysicalProperties").read_text()


def test_pressure_advection_comparison_changes_only_the_selected_entry(tmp_path):
    first = tmp_path / "upwind"
    second = tmp_path / "vanleer"
    builders = [case_builder(directory, scheme="linearUpwind") for directory in (first, second)]
    window = physical_window(builders[0].spec.chord, builders[0].spec.speed)
    configure_unsteady_case(builders[0], first, window)
    configure_unsteady_case(builders[1], second, window, "vanLeer")
    for path in first.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(first)
        if str(relative) == "system/fvSchemes":
            expected, count = re.subn(r"(div\(phid,p\)\s+)Gauss upwind;", r"\g<1>Gauss vanLeer;", path.read_text())
            assert count == 1 and (second / relative).read_text() == expected
        else:
            assert (second / relative).read_bytes() == path.read_bytes()
    before = (first / "system/controlDict").read_bytes()
    with pytest.raises(ValueError, match="Unsupported"):
        configure_unsteady_case(builders[0], first, window, "invented")
    assert (first / "system/controlDict").read_bytes() == before


def test_refined_physical_request_changes_only_resolution_and_explicit_unsteady_recipe():
    from scripts.materials.rae2822_unsteady import unsteady_request

    original = {"mesh": {"n_surface": 128, "n_radial": 80, "n_wake": 64, "target_y_plus": 40},
                "solver": {"flow_solver_family": "rhoSimpleFoam", "momentum_scheme": "upwind", "turbulence": {"model": "SST"}},
                "flow_state": {"temperature_k": 255.5, "pressure_pa": 108987}, "speeds": [233.7], "airfoil": {"coordinates": "fixture"}}
    before = deepcopy(original)
    coarse = unsteady_request(original)
    fine = unsteady_request(original, True)
    assert original == before
    assert fine["mesh"] == {**original["mesh"], "n_surface": 256, "n_radial": 160, "n_wake": 128}
    assert {**fine, "mesh": coarse["mesh"]} == coarse
    assert fine["solver"]["force_transient"] is True and fine["solver"]["transient_fallback"] is False
    assert fine["flow_state"] == original["flow_state"]
    for value in [None, 0, True, 1.5]:
        changed = deepcopy(original)
        changed["mesh"]["n_surface"] = value
        with pytest.raises(ValueError, match="positive"):
            unsteady_request(changed, True)
    with pytest.raises(ValueError, match="explicitly"):
        unsteady_request(original, 1)
