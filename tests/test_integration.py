"""Real OpenFOAM integration test. Requires Docker + the OpenFOAM image.

Run with:  pytest -m integration
Skipped automatically when Docker or the image is unavailable.
"""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

import pytest

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.case.builder import CaseBuilder
from airfoilfoam.config import get_settings
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid, SEGMENTED_NORMAL_COUNTS
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
from airfoilfoam.pipeline import (
    _parse_check_mesh_output,
    prepare_mesh_with_recovery,
    resolve_mesh_params,
    run_case,
    shared_mesh_qa_verified,
    validate_shared_mesh,
)

pytestmark = pytest.mark.integration

SELIG_SEED_DIR = Path(__file__).resolve().parents[1] / "packages/db/seed/selig-database"


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


@pytest.mark.parametrize(
    ("name", "target_y_plus"),
    [
        ("2032c", 40.0),  # production inverted-cell must-catch
        ("n0012", 40.0),  # symmetric healthy false-positive guard
        ("s1223", 1.0),  # strongly concave resolved-wall guard path
    ],
)
def test_segmented_normal_cgrid_is_valid_for_real_geometry_classes(
    require_docker, tmp_path, name, target_y_plus
):
    """Exercise the actual blockMesh/checkMesh failure class from production.

    Increasing counts could not repair 20-32C's legacy four-block topology:
    every speed/fidelity variant retained negative-volume cells at 93--95
    degrees. This test uses the campaign's high-speed 0.05 m cell, where the
    repaired half mesh must pass without weakening the 85-degree gate. NACA
    0012 and S1223 ensure the topology does not trade one geometry class for
    another.
    """
    af = load_airfoil(
        name,
        (SELIG_SEED_DIR / f"{name}.dat").read_text(),
        None,
        AirfoilFormat.auto,
    )
    spec = CaseSpec(chord=0.05, speed=166.0, aoa_deg=0.0)
    fluid = FluidProperties(density=1.225, dynamic_viscosity=1.81e-5)
    requested = MeshParams(
        n_surface=65,
        n_radial=40,
        n_wake=30,
        target_y_plus=target_y_plus,
    )
    mesh = resolve_mesh_params(requested, spec, fluid)
    mesher = BlockMeshCGrid.segmented_normal(20)
    case_dir = tmp_path / name
    CaseBuilder(
        af,
        mesher.patches(mesh),
        mesh,
        spec,
        fluid,
        RoughnessParams(),
        SolverParams(write_images=[]),
    ).write(case_dir)
    mesher.write_inputs(case_dir, af, mesh, spec.chord)
    built = mesher.run_mesh(case_dir, mesh, DockerRunner())

    checked = DockerRunner().application(case_dir, "checkMesh -time 0", timeout=300).check()
    qa = _parse_check_mesh_output(checked.stdout)

    assert built.n_cells == mesher.cell_count(mesh) == 7600
    assert not qa.negative_volume
    assert qa.max_non_ortho_deg is not None and qa.max_non_ortho_deg < 85.0
    assert qa.failed_checks == 0 or qa.aspect_ratio_only_failure


@pytest.mark.parametrize(
    "segments",
    [None, *SEGMENTED_NORMAL_COUNTS],
    ids=["legacy", *(f"segmented-{value}" for value in SEGMENTED_NORMAL_COUNTS)],
)
def test_corrected_e850_source_builds_valid_real_mesh(require_docker, tmp_path, segments):
    """The exact UIUC E850 contour must replace stale corrupted-source verdicts.

    The prior bundled file revisited LE after a spurious LE→TE traverse, so the
    structural preflight correctly rejected it.  With the authoritative source
    restored, both the default and every bounded recovery candidate must pass
    the unchanged real blockMesh/checkMesh quality gate.
    """
    af = load_airfoil(
        "e850",
        (SELIG_SEED_DIR / "e850.dat").read_text(),
        None,
        AirfoilFormat.auto,
    )
    spec = CaseSpec(chord=0.05, speed=166.0, aoa_deg=0.0)
    fluid = FluidProperties(density=1.225, dynamic_viscosity=1.81e-5)
    requested = MeshParams(
        n_surface=65,
        n_radial=40,
        n_wake=30,
        target_y_plus=40.0,
    )
    mesh = resolve_mesh_params(requested, spec, fluid)
    mesher = (
        BlockMeshCGrid()
        if segments is None
        else BlockMeshCGrid.segmented_normal(segments)
    )
    case_dir = tmp_path / mesher.name
    CaseBuilder(
        af,
        mesher.patches(mesh),
        mesh,
        spec,
        fluid,
        RoughnessParams(),
        SolverParams(write_images=[]),
    ).write(case_dir)
    mesher.write_inputs(case_dir, af, mesh, spec.chord)
    built = mesher.run_mesh(case_dir, mesh, DockerRunner())

    checked = DockerRunner().application(case_dir, "checkMesh -time 0", timeout=300).check()
    qa = _parse_check_mesh_output(checked.stdout)

    assert built.n_cells == mesher.cell_count(mesh) == 7600
    assert not qa.negative_volume
    assert qa.max_non_ortho_deg is not None and qa.max_non_ortho_deg < 85.0
    assert qa.failed_checks == 0 or qa.aspect_ratio_only_failure


def test_real_2032c_low_speed_mesh_recovers_thick_wall_cell_once(require_docker, tmp_path):
    """Production low-speed must-catch: y+40 resolves to ~0.01575c, whose
    legacy topology and first segmented candidate both fail; the bounded
    0.006c segmented candidate must pass the same real blockMesh/checkMesh path
    without weakening any quality threshold."""
    af = load_airfoil(
        "2032c",
        (SELIG_SEED_DIR / "2032c.dat").read_text(),
        None,
        AirfoilFormat.auto,
    )
    spec = CaseSpec(chord=0.05, speed=30.0, aoa_deg=0.0)
    fluid = FluidProperties(density=1.225, dynamic_viscosity=1.81e-5)
    requested = MeshParams(n_surface=65, n_radial=40, n_wake=30, target_y_plus=40.0)
    initial = resolve_mesh_params(requested, spec, fluid)
    mesher = BlockMeshCGrid()
    runner = DockerRunner()
    checked_heights: list[float] = []
    warnings: list[str] = []

    def validate(mesh_dir, actual):
        checked_heights.append(float(actual.first_cell_height_chords))
        return validate_shared_mesh(
            mesh_dir,
            af,
            actual,
            spec,
            fluid,
            RoughnessParams(),
            SolverParams(force_transient=True, write_images=[]),
            runner,
            1,
            warnings,
        )

    built, actual, recovered = prepare_mesh_with_recovery(
        tmp_path / "2032c-low-speed",
        af,
        initial,
        spec.chord,
        mesher,
        runner,
        validate=validate,
        quality_warnings=warnings,
    )

    assert checked_heights[0] > 0.015
    assert checked_heights == pytest.approx(
        [
            initial.first_cell_height_chords,
            initial.first_cell_height_chords,
            0.006,
        ]
    )
    assert recovered is True
    assert actual.mesher == "blockmesh-cgrid-segmented-normal-20"
    assert actual.first_cell_height_chords == pytest.approx(0.006)
    assert built.n_cells == 7600
    assert shared_mesh_qa_verified(tmp_path / "2032c-low-speed")
    assert any("automatic mesh repair" in warning for warning in warnings)


def test_mesh_once_marched_polar(require_docker, tmp_path, naca0012_selig_text):
    """A marched polar meshes once (reused for every AoA) and warm-starts each
    angle; results match independent cold solves."""
    from airfoilfoam.pipeline import prepare_mesh, resolve_mesh_params, run_case, solve_polar_marched

    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    mesh = MeshParams(n_surface=100, n_radial=70, n_wake=50,
                      farfield_radius_chords=12.0, wake_length_chords=10.0)
    solver = SolverParams(n_iterations=3000, write_images=[], transient_fallback=False)
    mesher = BlockMeshCGrid()
    runner = DockerRunner()
    resolved = resolve_mesh_params(mesh, CaseSpec(chord=1.0, speed=50.0, aoa_deg=0.0), fluid)

    mesh_dir = tmp_path / "mesh"
    mr = prepare_mesh(mesh_dir, af, resolved, 1.0, mesher, runner)
    assert mr.n_cells > 0
    assert (mesh_dir / "constant" / "polyMesh" / "points").exists()

    aoas = [2.0, 2.86, 3.72]
    march = solve_polar_marched(tmp_path / "polar", mesh_dir, af, 1.0, 50.0, fluid,
                                RoughnessParams(), resolved, solver, mesher, runner, aoas,
                                n_cells=mr.n_cells, render_images=False)
    outs = [item.outcome for item in march.points]
    assert len(outs) == 3
    cls = [o.cl for o in outs]
    assert all(c is not None for c in cls), [o.error for o in outs]
    assert cls[0] < cls[1] < cls[2]  # lift increases with AoA

    # cold reference at the top angle must agree with the marched value
    cold = run_case(tmp_path / "cold", af, CaseSpec(chord=1.0, speed=50.0, aoa_deg=3.72),
                    fluid, RoughnessParams(), mesh, solver, mesher, runner, n_proc=1,
                    render_images=False)
    assert abs(cold.cl - cls[2]) < 0.02, (cold.cl, cls[2])


def test_transition_model_runs(require_docker, tmp_path, naca0012_selig_text):
    """The k-omega SST-LM transition model builds its extra fields and converges."""
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    spec = CaseSpec(chord=1.0, speed=7.5, aoa_deg=4.0)  # Re=5e5
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    mesh = MeshParams(n_surface=130, n_radial=80, n_wake=60,
                      farfield_radius_chords=15.0, wake_length_chords=12.0)
    solver = SolverParams(
        turbulence=TurbulenceParams(model=TurbulenceModel.k_omega_sst_lm),
        n_iterations=2500, write_images=[],
    )
    out = run_case(tmp_path / "lm", af, spec, fluid, RoughnessParams(), mesh, solver,
                   BlockMeshCGrid(), DockerRunner(), n_proc=4)
    assert out.error is None, out.error
    assert 0.1 < out.cl < 0.8, out.cl
    assert 0.0 < out.cd < 0.05, out.cd


def test_transient_fallback_on_deep_stall(require_docker, tmp_path, naca0012_selig_text):
    """A deep-stall case that won't converge steady triggers the transient (URANS)
    fallback and returns time-averaged coefficients with a fluctuation."""
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    spec = CaseSpec(chord=1.0, speed=7.5, aoa_deg=20.0)  # deep stall
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    mesh = MeshParams(n_surface=120, n_radial=70, n_wake=60,
                      farfield_radius_chords=15.0, wake_length_chords=12.0)
    # few cycles so the test runs in a few minutes
    solver = SolverParams(n_iterations=1200, write_images=[], transient_cycles=4.0)
    out = run_case(tmp_path / "stall", af, spec, fluid, RoughnessParams(), mesh, solver,
                   BlockMeshCGrid(), DockerRunner(), n_proc=8)
    assert out.error is None, out.error
    if out.unsteady:  # steady may occasionally settle to a separated state instead
        assert out.cl is not None and out.cd is not None and out.cd > 0
        assert out.cl_std is not None and out.cl_std >= 0.0
        assert (tmp_path / "stall" / "transient").is_dir()
    else:
        assert out.converged


def test_urans_outputs_history_strouhal_animation(require_docker, tmp_path, naca0012_selig_text):
    """The URANS fallback emits a Cl/Cd time-history (+ measured Strouhal), a
    time-averaged field image, and an animation mp4 (rendered on the host)."""
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    spec = CaseSpec(chord=1.0, speed=7.5, aoa_deg=20.0)  # deep stall
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    mesh = MeshParams(n_surface=120, n_radial=70, n_wake=60,
                      farfield_radius_chords=15.0, wake_length_chords=12.0)
    solver = SolverParams(
        n_iterations=1200, transient_cycles=4.0,
        write_images=[ImageField.velocity_magnitude, ImageField.vorticity],
    )
    out = run_case(tmp_path / "urans", af, spec, fluid, RoughnessParams(), mesh, solver,
                   BlockMeshCGrid(), DockerRunner(), n_proc=8)
    assert out.error is None, out.error
    if not out.unsteady:
        pytest.skip("steady settled to a separated state; URANS path not exercised")

    # measured force history + Strouhal
    assert out.force_history is not None
    assert len(out.force_history.cl) > 10
    assert out.strouhal is not None and out.strouhal > 0.0
    assert out.quality_warnings == []

    # instantaneous + time-averaged contour images
    assert "velocity_magnitude" in out.images
    assert (tmp_path / "urans" / out.images["velocity_magnitude"]).is_file()
    assert "velocity_magnitude" in out.mean_images
    assert (tmp_path / "urans" / out.mean_images["velocity_magnitude"]).is_file()

    # vorticity field (newly supported) rendered too
    assert "vorticity" in out.images

    # animation mp4 (rendered on the host via ffmpeg)
    assert out.video, "no animation produced"
    assert (tmp_path / "urans" / out.video["velocity_magnitude"]).is_file()


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
