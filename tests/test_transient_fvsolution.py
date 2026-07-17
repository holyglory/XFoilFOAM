from __future__ import annotations

import re
from pathlib import Path

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.case.builder import CaseBuilder
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import (
    AirfoilFormat,
    CaseSpec,
    FluidProperties,
    MeshParams,
    RoughnessParams,
    SolverParams,
)


def _foam_dict(path: Path) -> dict:
    text = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.DOTALL)
    text = re.sub(r"//.*", "", text)
    tokens = re.findall(r'"[^"]*"|[{};]|[^\s{};]+', text)
    index = 0

    def parse_block() -> dict:
        nonlocal index
        parsed = {}
        while index < len(tokens):
            key = tokens[index]
            index += 1
            if key == "}":
                return parsed
            if tokens[index] == "{":
                index += 1
                parsed[key] = parse_block()
                continue
            value = []
            while tokens[index] != ";":
                value.append(tokens[index])
                index += 1
            index += 1
            parsed[key] = value[0] if len(value) == 1 else " ".join(value)
        return parsed

    return parse_block()


def _builder(
    naca0012_selig_text: str,
    solver: SolverParams | None = None,
) -> CaseBuilder:
    airfoil = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    patches = [
        BoundaryPatch("airfoil", "wall"),
        BoundaryPatch("inlet", "inlet"),
        BoundaryPatch("outlet", "outlet"),
        BoundaryPatch("frontAndBack", "empty"),
    ]
    return CaseBuilder(
        airfoil,
        patches,
        MeshParams(),
        CaseSpec(chord=1.0, speed=50.0, aoa_deg=12.0),
        FluidProperties(),
        RoughnessParams(),
        solver or SolverParams(write_images=[]),
    )


def test_transient_fvsolution_pressure_solvers_handle_stretched_layers(tmp_path, naca0012_selig_text):
    case_dir = tmp_path / "transient"
    _builder(naca0012_selig_text).write_transient(
        case_dir,
        start_time=0.0,
        end_time=0.1,
        delta_t=0.001,
    )

    solvers = _foam_dict(case_dir / "system" / "fvSolution")["solvers"]

    assert solvers["p"]["smoother"] == "DICGaussSeidel"
    assert solvers["p"]["tolerance"] == "1e-07"
    assert solvers["p"]["relTol"] == "0.05"
    assert solvers["pFinal"]["smoother"] == "DICGaussSeidel"
    assert float(solvers["pFinal"]["tolerance"]) == 1e-6
    assert float(solvers["pFinal"]["relTol"]) == 0


def test_steady_fvsolution_pressure_solver_remains_unchanged(tmp_path, naca0012_selig_text):
    case_dir = tmp_path / "steady"
    _builder(naca0012_selig_text).write(case_dir)

    solvers = _foam_dict(case_dir / "system" / "fvSolution")["solvers"]

    assert solvers["p"]["smoother"] == "GaussSeidel"


def test_transient_upwind_recovery_writes_conservative_momentum_scheme(
    tmp_path, naca0012_selig_text
):
    case_dir = tmp_path / "transient-recovery"
    _builder(
        naca0012_selig_text,
        SolverParams(momentum_scheme="upwind", write_images=[]),
    ).write_transient(
        case_dir,
        start_time=0.0,
        end_time=0.1,
        delta_t=0.001,
    )

    schemes = _foam_dict(case_dir / "system" / "fvSchemes")["divSchemes"]

    assert schemes["div(phi,U)"] == "Gauss upwind"
