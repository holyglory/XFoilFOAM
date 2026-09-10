import numpy as np
import pytest

import json
import hashlib
from scripts.materials.verify_rae2822 import configure_limited_nonorthogonal

from scripts.materials.verify_rae2822 import benchmark_mesh, benchmark_momentum_scheme, benchmark_time_budget, compare_pressure, configure_enthalpy_energy, configure_pressure_equation_relaxation, configure_pressure_krylov, configure_transonic_pressure, configure_upwind_energy, pressure_iteration, restore_verified_donor, wall_pressure


def test_benchmark_time_budget_preserves_default_and_allows_bounded_mesh_study():
    assert benchmark_time_budget() == 600
    assert benchmark_time_budget(3000) == 3000
    assert benchmark_time_budget(3600) == 3600


def test_nonorthogonal_comparison_changes_only_both_preflighted_corrections(tmp_path):
    path = tmp_path / "fvSchemes"
    original = "laplacianSchemes { default Gauss linear corrected; }\nsnGradSchemes { default corrected; }\ndivSchemes { default none; div(phi,h) bounded Gauss upwind; }"
    path.write_text(original)
    configure_limited_nonorthogonal(path)
    assert path.read_text() == original.replace("Gauss linear corrected", "Gauss linear limited 0.5").replace("default corrected", "default limited 0.5")
    for malformed in [original.replace("snGradSchemes", "other"), original.replace("laplacianSchemes", "other"), original + "\nsnGradSchemes { default corrected; }"]:
        path.write_text(malformed)
        with pytest.raises(ValueError, match="exact generated"):
            configure_limited_nonorthogonal(path)
        assert path.read_text() == malformed


@pytest.mark.parametrize("value", [0, -1, 3601, float("nan"), float("inf"), True, "3000", None])
def test_benchmark_time_budget_rejects_unbounded_or_ambiguous_values(value):
    with pytest.raises(ValueError, match="Benchmark time budget"):
        benchmark_time_budget(value)


def test_pressure_equation_relaxation_does_not_replace_field_relaxation(tmp_path):
    path = tmp_path / "fvSolution"
    fields = "fields { p 0.3; rho 0.01; }"
    path.write_text(f"relaxationFactors {{ {fields} equations {{ U 0.3; h 0.7; }} }}")
    configure_pressure_equation_relaxation(path)
    assert fields in path.read_text()
    assert "p 1;" in path.read_text()
    assert "pFinal 1;" in path.read_text()
    assert "U 0.3; h 0.7;" in path.read_text()
    before = path.read_text()
    with pytest.raises(ValueError, match="without pressure"):
        configure_pressure_equation_relaxation(path)
    assert path.read_text() == before


def test_pressure_equation_damping_is_explicit_and_bounded(tmp_path):
    path = tmp_path / "fvSolution"
    original = "relaxationFactors { fields {p 0.3;} equations {U 0.3; h 0.7;} }"
    path.write_text(original)
    for value in [0, -1, 1.1, float("nan")]:
        with pytest.raises(ValueError, match="relaxation must"):
            configure_pressure_equation_relaxation(path, value)
        assert path.read_text() == original
    configure_pressure_equation_relaxation(path, 0.3)
    assert "pFinal 0.3;" in path.read_text()
    assert "fields {p 0.3;}" in path.read_text()


def test_pressure_krylov_changes_only_two_generated_pressure_blocks(tmp_path):
    path = tmp_path / "fvSolution"
    pressure = "solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01;"
    other = "Phi {solver GAMG; smoother DIC; tolerance 1e-6;}"
    original = f"solvers {{p {{{pressure}}} pFinal {{{pressure}}} {other}}}"
    path.write_text(original)
    configure_pressure_krylov(path)
    assert path.read_text().count("solver PBiCGStab;") == 2
    assert path.read_text().count("preconditioner DILU;") == 2
    assert other in path.read_text()
    malformed = original.replace("pFinal", "otherPressure")
    path.write_text(malformed)
    with pytest.raises(ValueError, match="exactly p and pFinal"):
        configure_pressure_krylov(path)
    assert path.read_text() == malformed


def test_energy_transport_experiment_preserves_momentum_and_preflights_before_write(tmp_path):
    path = tmp_path / "fvSchemes"
    original = "divSchemes {\n" + "\n".join(f"div(phi,{field}) bounded Gauss linearUpwind limited;" for field in ["U", "h", "K", "Ekp"]) + "\n}"
    path.write_text(original)
    configure_upwind_energy(path)
    assert "div(phi,U) bounded Gauss linearUpwind limited;" in path.read_text()
    for field in ["h", "K", "Ekp"]:
        assert f"div(phi,{field}) bounded Gauss upwind;" in path.read_text()
    malformed = original.replace("div(phi,h)", "div(phi,T)")
    path.write_text(malformed)
    with pytest.raises(ValueError, match="three energy"):
        configure_upwind_energy(path)
    assert path.read_text() == malformed


def donor_fixture(directory):
    source, destination = directory / "donor", directory / "fresh"
    (source / "2147").mkdir(parents=True)
    (source / "constant/polyMesh").mkdir(parents=True)
    destination.mkdir()
    request = {"solver": {"momentum_scheme": "linearUpwind"}, "mesh": {"n_surface": 128}}
    report = {"outcome": "measured_converged", "convergence": {"converged": True}, "pressure_iteration": 2147,
              "request": {**request, "solver": {"momentum_scheme": "upwind"}},
              "experimental_transonic_pressure": False, "experimental_energy_form": "sensibleEnthalpy"}
    (source / "report.json").write_text(json.dumps(report))
    for field in ["U", "p", "T", "k", "omega", "rho", "phi"]:
        (source / "2147" / field).write_text(f"isolated field fixture {field}")
    for member in ["points", "faces", "owner", "neighbour", "boundary"]:
        (source / "constant/polyMesh" / member).write_text(f"isolated mesh fixture {member}")
    return source, destination, request


def test_verified_donor_preserves_source_and_copies_only_exact_mesh_and_field_bytes(tmp_path):
    source, destination, request = donor_fixture(tmp_path)
    before = {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*") if path.is_file()}
    receipt = restore_verified_donor(source, destination, request, True, False)
    assert receipt["coordinate"] == 2147
    assert receipt["report_sha256"] == hashlib.sha256(before["report.json"]).hexdigest()
    assert len(receipt["members"]) == 12
    for member in receipt["members"]:
        assert (destination / member["path"]).read_bytes() == before[member["path"]]
    assert before == {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*") if path.is_file()}
    assert not (destination / "report.json").exists()
    assert not (destination / "postProcessing").exists()


@pytest.mark.parametrize("defect", ["field", "mesh", "physical", "convergence", "symlink"])
def test_donor_preflight_rejects_incomplete_or_incompatible_input_before_copy(tmp_path, defect):
    source, destination, request = donor_fixture(tmp_path)
    if defect == "field":
        (source / "2147/T").unlink()
    elif defect == "mesh":
        (source / "constant/polyMesh/points").unlink()
    elif defect == "physical":
        request["mesh"]["n_surface"] = 256
    elif defect == "convergence":
        report = json.loads((source / "report.json").read_text())
        report["convergence"]["converged"] = False
        (source / "report.json").write_text(json.dumps(report))
    else:
        (source / "2147/linked").symlink_to(source / "2147/U")
    with pytest.raises(ValueError):
        restore_verified_donor(source, destination, request, True, False)
    assert list(destination.iterdir()) == []
    with pytest.raises(ValueError, match="separate sibling"):
        restore_verified_donor(source, source / "nested", request, True, False)


def test_first_order_experiment_is_explicit_and_preserves_the_default():
    assert benchmark_momentum_scheme() == "linearUpwind"
    assert benchmark_momentum_scheme(True) == "upwind"
    with pytest.raises(ValueError, match="explicit"):
        benchmark_momentum_scheme("true")


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
