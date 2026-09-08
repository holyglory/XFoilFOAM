from dataclasses import replace
from pathlib import Path
import json
import subprocess
import sys

import numpy as np
import pytest

from airfoilfoam.neuralfoil_solver import BaselineCondition, BaselineRecipe, solve_baseline


def geometry():
    path = Path(__file__).resolve().parents[1] / "packages/db/seed/selig-database/ag24.dat"
    points = []
    for line in path.read_text().splitlines()[1:]:
        parts = line.split()
        if len(parts) == 2:
            points.append([float(value) for value in parts])
    return points, {"source": "repository-trusted-selig-file", "profile": "ag24"}


def condition(mach=0.1):
    return BaselineCondition(f"test-ag24-mach-{mach}", 500000.0, mach, [-4, -2, 0, 2, 4], 9, 0, 0, 0)


def recipe():
    return BaselineRecipe("test-fit-recipe", "large", 0.003, 0.012)


def test_real_batched_neuralfoil_predictions_keep_complete_geometry_and_model_provenance():
    points, provenance = geometry()
    predictions = solve_baseline(points, provenance, [condition(), condition(0.8), condition(2), condition(3)], recipe())
    assert len(predictions) == 4
    for prediction in predictions:
        assert np.asarray(prediction["coefficients"]).shape == (5, 3)
        assert np.all(np.asarray(prediction["coefficients"])[:, 1] > 0)
        assert prediction["cfd_evidence"] is False
        assert prediction["uncertainty_calibration"] == "unvalidated"
        assert prediction["geometry_fit"]["rms_chord"] < recipe().maximum_geometry_rms
        assert len(prediction["model"]["weights_sha256"]) == 64
        assert prediction["condition"]["transition_upper"] == 0
        assert len(prediction["compressibility_diagnostics"]["critical_mach"]) == 5
        assert all(value is not None for value in prediction["compressibility_diagnostics"]["critical_mach"])
        assert prediction["geometry_provenance"] == provenance
    assert not np.allclose(predictions[0]["coefficients"], predictions[1]["coefficients"])
    assert predictions == solve_baseline(points, provenance, [condition(), condition(0.8), condition(2), condition(3)], recipe())


@pytest.mark.parametrize("changes", [{"mach": 3.1}, {"roughness_height": 0.0001}, {"reynolds": -1},
                                     {"alpha": [0, 0]}, {"transition_upper": 1.1}])
def test_unsupported_inputs_do_not_produce_a_fabricated_baseline(changes):
    points, provenance = geometry()
    with pytest.raises(ValueError):
        solve_baseline(points, provenance, [replace(condition(), **changes)], recipe())


def test_inaccurate_geometry_fit_is_reported_as_unavailable():
    points, provenance = geometry()
    with pytest.raises(ValueError, match="not represented accurately"):
        solve_baseline(points, provenance, [condition()], replace(recipe(), maximum_geometry_rms=1e-12))


def test_missing_geometry_never_falls_back_to_name_based_airfoil_generation():
    with pytest.raises(ValueError, match="coordinates"):
        solve_baseline([], {"name": "naca0012"}, [condition()], recipe())


def test_preview_command_writes_real_curves_and_does_not_overwrite_existing_artifacts(tmp_path):
    source = Path(__file__).resolve().parents[1] / "packages/db/seed/selig-database/ag24.dat"
    output = tmp_path / "ag24-predictions.json"
    command = [sys.executable, "-m", "airfoilfoam.neuralfoil_solver", str(source),
               "--reynolds", "500000", "--mach", "0.1", "0.8", "--angles", "-2", "0", "2",
               "--transition-upper", "0", "--transition-lower", "0", "--n-crit", "9",
               "--maximum-geometry-rms", "0.003", "--maximum-geometry-error", "0.012", "--output", str(output)]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["curves"] == 2
    payload = json.loads(output.read_text())
    assert len(payload["predictions"]) == 2
    before = output.read_bytes()
    repeated = subprocess.run(command, capture_output=True, text=True, check=False)
    assert repeated.returncode != 0
    assert output.read_bytes() == before
