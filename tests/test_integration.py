"""Real OpenFOAM integration test. Requires Docker + the OpenFOAM image.

Run with:  pytest -m integration
Skipped automatically when Docker or the image is unavailable.
"""
from __future__ import annotations

import shutil
import subprocess

import pytest

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.config import get_settings
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
from airfoilfoam.models import (
    AirfoilFormat,
    CaseSpec,
    FluidProperties,
    ImageField,
    MeshParams,
    RoughnessParams,
    SolverParams,
    TurbulenceModel,
    TurbulenceParams,
)
from airfoilfoam.openfoam.runner import DockerRunner
from airfoilfoam.pipeline import run_case

pytestmark = pytest.mark.integration


def _docker_image_available() -> bool:
    if shutil.which("docker") is None:
        return False
    image = get_settings().openfoam_image
    out = subprocess.run(["docker", "images", "-q", image], capture_output=True, text=True)
    return bool(out.stdout.strip())


@pytest.fixture(scope="module")
def require_docker():
    if not _docker_image_available():
        pytest.skip("Docker or the OpenFOAM image is not available")


def test_real_naca0012_case(require_docker, tmp_path, naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=5.0)
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    # coarser mesh so the test runs in a couple of minutes
    mesh = MeshParams(n_surface=140, n_radial=90, n_wake=70, target_y_plus=1.0,
                      farfield_radius_chords=18.0, wake_length_chords=12.0)
    solver = SolverParams(
        turbulence=TurbulenceParams(model=TurbulenceModel.k_omega_sst),
        n_iterations=2500, write_images=[ImageField.velocity_magnitude],
    )
    out = run_case(tmp_path / "case", af, spec, fluid, RoughnessParams(), mesh, solver,
                   BlockMeshCGrid(), DockerRunner())

    assert out.error is None, out.error
    assert out.n_cells > 0
    # positive, physically sane (if conservative) lift/drag for NACA0012 at +5 deg
    assert 0.15 < out.cl < 0.8, out.cl
    assert 0.0 < out.cd < 0.05, out.cd
    assert out.cl_cd > 5.0
    assert out.y_plus_avg is not None and out.y_plus_avg < 5.0
    # image produced and served path recorded
    assert "velocity_magnitude" in out.images
    assert (tmp_path / "case" / out.images["velocity_magnitude"]).is_file()


def test_rough_wall_increases_drag(require_docker, tmp_path, naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=3.0)
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    # Sand-grain roughness needs the wall cell to be COARSER than Ks, so use an
    # explicit (coarse, wall-function) first-cell height larger than the roughness.
    ks = 5e-4
    mesh = MeshParams(n_surface=120, n_radial=80, n_wake=60,
                      first_cell_height_chords=2e-3,
                      farfield_radius_chords=18.0, wake_length_chords=12.0)
    solver = SolverParams(n_iterations=2000, write_images=[])

    smooth = run_case(tmp_path / "smooth", af, spec, fluid, RoughnessParams(), mesh, solver,
                      BlockMeshCGrid(), DockerRunner())
    rough = run_case(tmp_path / "rough", af, spec, fluid,
                     RoughnessParams(sand_grain_height=ks), mesh, solver,
                     BlockMeshCGrid(), DockerRunner())
    assert smooth.error is None, smooth.error
    assert rough.error is None, rough.error
    assert rough.cd > smooth.cd
