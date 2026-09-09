import json
from pathlib import Path
import shutil

import pytest

from scripts.materials.rae2822_reference import load_reference, parse_geometry, parse_pressure, selig_coordinates


REFERENCE = Path(__file__).parent / "fixtures" / "rae2822"


def test_source_geometry_and_pressure_conventions_are_preserved():
    reference = load_reference(REFERENCE)
    coordinates = reference["coordinates"]
    assert len(coordinates) == 129
    assert coordinates[0] == coordinates[-1] == (1, 0)
    assert coordinates[64] == (0, 0)
    assert coordinates[65] == (0.00060, -0.00317)
    assert coordinates[63] == (0.00060, 0.00323)
    pressure = reference["pressure"]
    assert pressure["upper"][-1] == (0.9938, 0.1432)
    assert pressure["lower"][-1] == (0.9938, 0.2146)
    assert min(point[1] for point in pressure["upper"]) < -1
    assert max(point[1] for point in pressure["lower"]) > 1
    assert reference["conditions"] == pytest.approx({"mach": 0.729, "alpha_deg": 2.31,
        "reference_reynolds": 6500000, "chord_m": 0.3048, "temperature_k": 460 * 5 / 9,
        "pressure_pa": 15.80734 * 6894.757293168})
    assert reference["provenance"]["measurement_uncertainty"] is None
    assert reference["provenance"]["solver_validation_performed"] is False
    assert len(selig_coordinates(reference).splitlines()) == 130


@pytest.mark.parametrize("kind", ["geometry", "pressure"])
def test_reference_hashes_reject_changed_source_bytes(tmp_path, kind):
    shutil.copytree(REFERENCE, tmp_path / "reference")
    filename = "geometry.txt" if kind == "geometry" else "pressure.gen"
    with (tmp_path / "reference" / filename).open("a") as stream:
        stream.write("\n")
    with pytest.raises(ValueError, match=f"Changed {kind}"):
        load_reference(tmp_path / "reference")


def test_pressure_sign_and_study_are_not_inferred_from_labels(tmp_path):
    shutil.copytree(REFERENCE, tmp_path / "reference")
    path = tmp_path / "reference" / "provenance.json"
    provenance = json.loads(path.read_text())
    provenance["pressure"]["ordinate"] = "cp"
    path.write_text(json.dumps(provenance))
    with pytest.raises(ValueError, match="sign convention"):
        load_reference(tmp_path / "reference")
    raw = (REFERENCE / "pressure.gen").read_text()
    with pytest.raises(ValueError, match="Study 1"):
        parse_pressure(raw.replace("0.729", "0.725"))
    with pytest.raises(ValueError, match="monotonic"):
        parse_pressure(raw.replace("0.9875 -0.1318", "0.9938 -0.1318"))


def test_geometry_rejects_missing_rows_and_intersecting_surfaces():
    raw = (REFERENCE / "geometry.txt").read_text()
    with pytest.raises(ValueError, match="Incomplete"):
        parse_geometry("\n".join(raw.splitlines()[:-1]))
    with pytest.raises(ValueError, match="intersect"):
        parse_geometry(raw.replace("0.00060   0.00317   0.00323", "0.00060  -0.00400   0.00323"))
