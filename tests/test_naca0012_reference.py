from copy import deepcopy
import json
from pathlib import Path

import pytest

from scripts.materials.naca0012_reference import SOURCES, fetch_sources, load_reference, parse_forces, parse_geometry
from scripts.materials.evaluate_naca0012_prior import compare_prediction, run_study


REFERENCE = Path(__file__).parent / "fixtures" / "naca0012"


def test_pinned_reference_retains_runs_columns_and_geometry_distinction():
    reference = load_reference(REFERENCE)
    assert [run["trip_grit"] for run in reference["runs"]] == ["80 grit", "120 grit", "180 grit"]
    assert [len(run["rows"]) for run in reference["runs"]] == [17, 18, 18]
    assert reference["runs"][0]["rows"][0] == {"alpha": -4.04, "coefficients": [-0.4417, 0.00871, None]}
    assert reference["runs"][1]["rows"][2:4] == [
        {"alpha": -0.01, "coefficients": [-0.012, 0.00811, None]},
        {"alpha": 0.01, "coefficients": [-0.0122, 0.00804, None]},
    ]
    assert reference["conditions"]["reported_mach"] == 0.15
    assert reference["conditions"]["reported_reynolds"] == 6000000
    assert reference["conditions"]["trip_location"] is None
    assert reference["conditions"]["equivalent_roughness"] is None
    assert reference["conditions"]["measurement_uncertainty"] is None
    coordinates = reference["coordinates"]
    assert len(coordinates) == 12299
    assert coordinates[0] == coordinates[-1] == [1, 0]
    assert coordinates[6149] == [0, 0]
    assert coordinates[1][1] > 0 and coordinates[-2][1] < 0
    assert reference["geometry_kind"] == "modified_TMR_benchmark_not_as_tested"
    assert reference["calibration_eligible"] is False
    assert all(row["coefficients"][2] is None for run in reference["runs"] for row in run["rows"])


@pytest.mark.parametrize("name", list(SOURCES))
@pytest.mark.parametrize("same_size", [False, True])
def test_changed_source_bytes_are_rejected_and_never_overwritten(tmp_path, name, same_size):
    fetch_sources(tmp_path, REFERENCE)
    assert fetch_sources(tmp_path, REFERENCE)["source_files"] == 2
    changed = tmp_path / name
    original = changed.read_bytes()
    if same_size:
        marker = b".00871" if name == "CLCD_Ladson_expdata.dat" else b"0.99999889521"
        replacement = b".00872" if name == "CLCD_Ladson_expdata.dat" else b"0.99999889520"
        corrupted = original.replace(marker, replacement, 1)
        assert len(corrupted) == len(original) and corrupted != original
    else:
        corrupted = original + b"\n"
    changed.write_bytes(corrupted)
    for operation in (lambda: load_reference(tmp_path), lambda: fetch_sources(tmp_path, REFERENCE)):
        with pytest.raises(ValueError, match="Changed"):
            operation()
    assert changed.read_bytes() == corrupted


@pytest.mark.parametrize("old,new", [
    ("transition tripped", "transition free"), ("M=0.15", "M=0.20"), ("Re=6 million", "Re=3 million"),
    ('"cl","cd"', '"cd","cl"'), ('t="120 grit"', 't="80 grit"'),
    ("-.05   -.0126", "-4.04   -.0126"), (".00871", "-.00871"), (".00871", "nan"),
])
def test_force_parser_rejects_unsupported_conditions_repeated_angles_and_corruption(old, new):
    text = (REFERENCE / "CLCD_Ladson_expdata.dat").read_text()
    with pytest.raises(ValueError):
        parse_forces(text.replace(old, new, 1))


def test_geometry_parser_rejects_truncation_and_nonplanar_or_wrong_surface_input():
    text = (REFERENCE / "n0012points_superbig_clust_fix.dat").read_text()
    lines = text.splitlines()
    with pytest.raises(ValueError, match="Incomplete"):
        parse_geometry("\n".join(lines[:-1]))
    modified = lines.copy()
    modified[5] = "0.99999889521 -0.15674435683E-06 1"
    with pytest.raises(ValueError, match="nonplanar"):
        parse_geometry("\n".join(modified))
    modified[5] = "0.99999889521 0.15674435683E-06 0"
    with pytest.raises(ValueError, match="Lower"):
        parse_geometry("\n".join(modified))


def test_comparison_uses_exact_angles_and_does_not_merge_trip_runs():
    reference = load_reference(REFERENCE)
    angles = sorted({row["alpha"] for run in reference["runs"] for row in run["rows"]})
    prediction = {"alpha": angles, "coefficients": [[0, 0.01, 0] for _ in angles]}
    compared = compare_prediction(reference, prediction)
    assert len(compared) == 3 and sum(row["samples"] for row in compared) == 53
    assert compared[0]["metrics"]["cl"]["rmse"] > 0
    assert compared[0]["metrics"]["cd"]["mae"] > 0
    assert all(len(row) == 2 for case in compared for row in case["reference_coefficients"])
    changed = deepcopy(prediction)
    changed["alpha"][0] += 0.001
    with pytest.raises(ValueError, match="exact predictions"):
        compare_prediction(reference, changed)
    changed = deepcopy(prediction)
    changed["coefficients"][0][0] = float("nan")
    with pytest.raises(ValueError, match="Invalid predicted"):
        compare_prediction(reference, changed)
    for invalid in (float("nan"), True, angles[0]):
        changed = deepcopy(prediction)
        changed["alpha"].append(invalid)
        changed["coefficients"].append([0, 0.01, 0])
        with pytest.raises(ValueError, match="finite and unique"):
            compare_prediction(reference, changed)


def test_protocol_precedes_prediction_and_survives_failure_without_fake_results(tmp_path, monkeypatch):
    output = tmp_path / "study"

    def failed_prediction(*args):
        protocol = json.loads((output / "protocol.json").read_text())
        assert protocol["assumptions"]["as_tested_geometry"] is False
        assert protocol["calibration_eligible"] is False
        assert protocol["production_policy_changed"] is False
        raise ValueError("isolated prediction failure")

    monkeypatch.setattr("scripts.materials.evaluate_naca0012_prior.solve_baseline", failed_prediction)
    with pytest.raises(ValueError, match="isolated prediction"):
        run_study(REFERENCE, output)
    assert not (output / "report.json").exists()
    before = (output / "protocol.json").read_bytes()
    with pytest.raises(FileExistsError):
        run_study(REFERENCE, output)
    assert (output / "protocol.json").read_bytes() == before
