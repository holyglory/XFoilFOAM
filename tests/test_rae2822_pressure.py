import numpy as np
import pytest

from scripts.materials.verify_rae2822 import benchmark_mesh, compare_pressure, configure_enthalpy_energy, configure_transonic_pressure, pressure_iteration, wall_pressure


@pytest.mark.parametrize("tier", ["fast", "precise", "refined"])
def test_wall_function_experiment_changes_only_requested_wall_resolution(tier):
    resolved = benchmark_mesh(tier)
    wall_function = benchmark_mesh(tier, True)
    assert resolved["target_y_plus"] == 1
    assert wall_function == {**resolved, "target_y_plus": 40}
    with pytest.raises(ValueError, match="explicit"):
        benchmark_mesh(tier, "true")


def surface_xml(pressure="100 120 110 130"):
    return f'''<VTKFile type="PolyData"><PolyData><Piece>
<Points><DataArray format="ascii" NumberOfComponents="3">
0 0 0 0.5 0.1 0 1 0 0 0.5 -0.1 0
0 0 0.1 0.5 0.1 0.1 1 0 0.1 0.5 -0.1 0.1
</DataArray></Points>
<Polys><DataArray Name="connectivity" format="ascii">0 1 5 4 1 2 6 5 0 3 7 4 3 2 6 7</DataArray>
<DataArray Name="offsets" format="ascii">4 8 12 16</DataArray></Polys>
<CellData><DataArray Name="p" format="ascii">{pressure}</DataArray></CellData>
</Piece></PolyData></VTKFile>'''


def test_pressure_uses_absolute_reference_and_both_actual_surfaces(tmp_path):
    path = tmp_path / "airfoil.vtp"
    path.write_text(surface_xml())
    coordinates = [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]
    result = wall_pressure(path, 1, 100, 2, 10, coordinates)
    assert result == {"upper": [[0.25, 0], [0.75, 0.2]], "lower": [[0.25, 0.1], [0.75, 0.3]]}
    with pytest.raises(ValueError, match="reference"):
        wall_pressure(path, 1, 100, 0, 10, coordinates)
    path.write_text(surface_xml("100 nan 110 130"))
    with pytest.raises(ValueError, match="Malformed"):
        wall_pressure(path, 1, 100, 2, 10, coordinates)
    path.write_text(surface_xml().replace('Name="p"', 'Name="not_pressure"'))
    with pytest.raises(ValueError, match="Missing"):
        wall_pressure(path, 1, 100, 2, 10, coordinates)


def test_comparison_brackets_instead_of_fabricating_endpoint_extrapolation():
    computed = {"upper": [[0.2, -1], [0.8, -0.4]], "lower": [[0.2, 0.3], [0.8, 0.9]]}
    measured = {"upper": [[0, 0], [0.2, -1], [0.5, -0.7], [0.8, -0.4], [1, 0]],
                "lower": [[0, 0], [0.2, 0.3], [0.5, 0.6], [0.8, 0.9], [1, 0]]}
    result = compare_pressure(computed, measured)
    for surface in result.values():
        assert surface["compared_samples"] == 3
        assert surface["excluded_extrapolations"] == 2
        assert surface["cp_rmse"] == pytest.approx(0, abs=1e-15)
    computed["upper"][1][0] = computed["upper"][0][0]
    with pytest.raises(ValueError, match="increasing"):
        compare_pressure(computed, measured)


def test_solution_coordinate_rejects_initial_field_and_missing_time(tmp_path):
    path = tmp_path / "airfoil.vtp"
    for value in ["0", "nan", "-1", "1 2"]:
        path.write_text(f'<VTKFile><PolyData><FieldData><DataArray Name="TimeValue" format="ascii">{value}</DataArray></FieldData></PolyData></VTKFile>')
        with pytest.raises(ValueError):
            pressure_iteration(path)
    path.write_text('<VTKFile><PolyData><FieldData><DataArray Name="TimeValue" format="ascii">1200</DataArray></FieldData></PolyData></VTKFile>')
    assert pressure_iteration(path) == 1200
    path.write_text(surface_xml())
    with pytest.raises(ValueError, match="no recorded"):
        pressure_iteration(path)


def test_transonic_experiment_requires_one_exact_generated_option(tmp_path):
    path = tmp_path / "fvSolution"
    original = "SIMPLE { transonic no; residualControl { p 1e-5; } }"
    path.write_text(original)
    configure_transonic_pressure(path)
    assert path.read_text() == original.replace("transonic no;", "transonic yes;")
    for text in ["SIMPLE {}", original + original, original.replace("no;", "yes;")]:
        path.write_text(text)
        with pytest.raises(ValueError, match="one generated"):
            configure_transonic_pressure(path)


def test_enthalpy_experiment_preflights_all_dictionaries_before_any_write(tmp_path):
    (tmp_path / "constant").mkdir()
    (tmp_path / "system").mkdir()
    originals = {"constant/thermophysicalProperties": "thermoType { energy sensibleInternalEnergy; }",
        "system/fvSchemes": "divSchemes { div(phi,e) bounded Gauss upwind; }",
        "system/fvSolution": "SIMPLE { residualControl {\n e 1e-4;\n} }\nrelaxationFactors { equations {\n e 0.7;\n} }\n"}
    for relative, content in originals.items():
        (tmp_path / relative).write_text(content)
    (tmp_path / "system/fvSolution").write_text("SIMPLE {}")
    with pytest.raises(ValueError, match="exact generated"):
        configure_enthalpy_energy(tmp_path)
    assert (tmp_path / "constant/thermophysicalProperties").read_text() == originals["constant/thermophysicalProperties"]
    assert (tmp_path / "system/fvSchemes").read_text() == originals["system/fvSchemes"]
    (tmp_path / "system/fvSolution").write_text(originals["system/fvSolution"])
    configure_enthalpy_energy(tmp_path)
    assert "sensibleEnthalpy" in (tmp_path / "constant/thermophysicalProperties").read_text()
    assert "div(phi,h)" in (tmp_path / "system/fvSchemes").read_text()
    assert (tmp_path / "system/fvSolution").read_text().count("\n h ") == 2
    with pytest.raises(ValueError, match="exact generated"):
        configure_enthalpy_energy(tmp_path)
