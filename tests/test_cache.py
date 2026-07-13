"""Persistent mesh cache + solution-seed cache: keys, atomicity, LRU, seeding."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from airfoilfoam import physics
from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.cache import MANIFEST_NAME, EngineCache
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
from airfoilfoam.meshing.base import BoundaryPatch, Mesher, MeshResult, get_mesher
from airfoilfoam.models import (
    AirfoilFormat,
    CaseSpec,
    FluidProperties,
    MeshParams,
    RoughnessParams,
    SolverParams,
    TurbulenceModel,
    TurbulenceParams,
)
from airfoilfoam.openfoam.runner import Runner, RunResult
from airfoilfoam.pipeline import (
    CaseOutcome,
    _publish_steady_seed,
    _solve_cold_marched,
    _try_seed_initial_field,
    prepare_mesh,
    resolve_mesh_params,
)

FLUID = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)


def _airfoil(text: str, name: str = "naca0012"):
    return load_airfoil(name, text, None, AirfoilFormat.auto)


def _resolved(chord: float = 1.0, speed: float = 50.0, **overrides) -> MeshParams:
    return resolve_mesh_params(
        MeshParams(**overrides), CaseSpec(chord=chord, speed=speed, aoa_deg=0.0), FLUID
    )


def _cache(tmp_path: Path, max_bytes: int = 10 * 1024**3) -> EngineCache:
    return EngineCache(tmp_path / "cache", max_bytes=max_bytes)


def _fake_polymesh(base: Path, marker: str = "v1") -> Path:
    pm = base / "constant" / "polyMesh"
    pm.mkdir(parents=True, exist_ok=True)
    for name in ("points", "faces", "owner", "neighbour", "boundary"):
        (pm / name).write_text(f"fake {name} {marker}\n")
    return pm


def _fake_time_dir(base: Path, name: str = "600", marker: str = "donor") -> Path:
    td = base / name
    td.mkdir(parents=True, exist_ok=True)
    for field in ("U", "p", "phi", "k", "omega", "nut"):
        (td / field).write_text(f"fake {field} field from {marker}\n")
    # non-field content that must NOT be carried into seeds
    (td / "uniform").mkdir(exist_ok=True)
    (td / "uniform" / "time").write_text("time data\n")
    return td


class CountingMesher(Mesher):
    """blockMesh stand-in that writes a fake polyMesh and counts invocations."""

    name = "counting"

    def __init__(self):
        self.mesh_runs = 0

    def write_inputs(self, case_dir: Path, airfoil, params: MeshParams, chord: float) -> None:
        path = case_dir / "system" / "blockMeshDict"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"// fake blockMeshDict chord={chord:g}\n")

    def patches(self, params: MeshParams) -> list[BoundaryPatch]:
        return [
            BoundaryPatch("airfoil", "wall"),
            BoundaryPatch("inlet", "inlet"),
            BoundaryPatch("outlet", "outlet"),
            BoundaryPatch("frontAndBack", "empty"),
        ]

    def run_mesh(self, case_dir: Path, params: MeshParams, runner: Runner) -> MeshResult:
        self.mesh_runs += 1
        _fake_polymesh(case_dir, marker=f"build{self.mesh_runs}")
        return MeshResult(patches=self.patches(params), span_chords=params.span_chords, n_cells=1234)


class FakeRunner(Runner):
    """Records every OpenFOAM command instead of executing it."""

    external_paths_visible = True

    def __init__(self):
        super().__init__()
        self.commands: list[str] = []

    def run(self, case_dir: Path, command: str, timeout: int = 7200, monitor=None) -> RunResult:
        self.commands.append(command)
        return RunResult(command=command, returncode=0, stdout="")

    def count(self, prefix: str) -> int:
        return sum(1 for c in self.commands if c.startswith(prefix))


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #
def test_mesh_key_stable_for_identical_inputs(naca0012_selig_text):
    af1 = _airfoil(naca0012_selig_text)
    af2 = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    assert EngineCache.mesh_key(af1, 1.0, resolved) == EngineCache.mesh_key(af2, 1.0, resolved)


def test_mesh_key_changes_with_chord_params_and_geometry(naca0012_selig_text, naca2412_points):
    af = _airfoil(naca0012_selig_text)
    other = load_airfoil("naca2412", None, naca2412_points, AirfoilFormat.auto)
    resolved = _resolved()
    base = EngineCache.mesh_key(af, 1.0, resolved)
    assert EngineCache.mesh_key(af, 0.5, resolved) != base
    assert EngineCache.mesh_key(af, 1.0, resolved.model_copy(update={"n_surface": 131})) != base
    assert EngineCache.mesh_key(other, 1.0, resolved) != base
    # resolved first-cell height (sized from y+/speed) is part of the key
    finer = _resolved(speed=25.0)
    assert EngineCache.mesh_key(af, 1.0, finer) != base


def test_mesh_key_changes_with_mesher_topology_version(naca0012_selig_text):
    """Legacy four-block meshes/seeds must not cross into repaired topology.

    The params and real geometry are intentionally byte-identical: only a
    mesher implementation version bump differentiates the cached evidence.
    """
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    legacy = BlockMeshCGrid()
    next_version = BlockMeshCGrid()
    next_version.cache_version = "must-catch-next-topology"
    base_mesh = EngineCache.mesh_key(af, 1.0, resolved, mesher=legacy)
    base_seed = EngineCache.seed_key(base_mesh, FLUID, 50.0)

    repaired_mesh = EngineCache.mesh_key(af, 1.0, resolved, mesher=next_version)
    repaired_seed = EngineCache.seed_key(repaired_mesh, FLUID, 50.0)

    assert repaired_mesh != base_mesh
    assert repaired_seed != base_seed


def test_mesh_key_uses_actual_mesher_even_when_params_still_name_public_default(
    naca0012_selig_text,
):
    """A recovery build must never inherit the request mesher's cache identity."""
    af = _airfoil(naca0012_selig_text)
    request_level = _resolved()
    public = get_mesher("blockmesh-cgrid")
    recovery_20 = get_mesher("blockmesh-cgrid-segmented-normal-20")
    recovery_24 = get_mesher("blockmesh-cgrid-segmented-normal-24")

    public_key = EngineCache.mesh_key(af, 1.0, request_level, mesher=public)
    recovery_20_key = EngineCache.mesh_key(
        af, 1.0, request_level, mesher=recovery_20
    )
    recovery_24_key = EngineCache.mesh_key(
        af, 1.0, request_level, mesher=recovery_24
    )

    assert len({public_key, recovery_20_key, recovery_24_key}) == 3


def test_seed_key_scopes_fluid_and_speed(naca0012_selig_text):
    af = _airfoil(naca0012_selig_text)
    mesh_key = EngineCache.mesh_key(af, 1.0, _resolved())
    base = EngineCache.seed_key(mesh_key, FLUID, 50.0)
    assert EngineCache.seed_key(mesh_key, FLUID, 50.0) == base
    assert EngineCache.seed_key(mesh_key, FLUID, 40.0) != base
    thick = FluidProperties(density=1000.0, kinematic_viscosity=1.0e-6)
    assert EngineCache.seed_key(mesh_key, thick, 50.0) != base
    # nu given as mu/rho vs kinematic: same physical fluid -> same key
    same = FluidProperties(density=1.225, dynamic_viscosity=1.5e-5 * 1.225)
    assert EngineCache.seed_key(mesh_key, same, 50.0) == base


def test_solver_signature_tracks_bc_relevant_fields():
    base = EngineCache.solver_signature(SolverParams(), RoughnessParams())
    other_model = SolverParams(turbulence=TurbulenceParams(model=TurbulenceModel.spalart_allmaras))
    assert EngineCache.solver_signature(other_model, RoughnessParams()) != base
    rough = RoughnessParams(sand_grain_height=5e-4)
    assert EngineCache.solver_signature(SolverParams(), rough) != base
    # iteration/scheme knobs do not change the 0/ boundary conditions
    more_iters = SolverParams(n_iterations=5000, momentum_scheme="upwind")
    assert EngineCache.solver_signature(more_iters, RoughnessParams()) == base


# --------------------------------------------------------------------------- #
# Mesh store: publish/fetch, atomicity, corruption
# --------------------------------------------------------------------------- #
def test_mesh_publish_fetch_roundtrip(tmp_path):
    cache = _cache(tmp_path)
    src = _fake_polymesh(tmp_path / "built")
    assert cache.publish_mesh("k" * 64, src, n_cells=4321)
    assert not any((cache.tmp_root).iterdir())  # staging cleaned up

    dest = tmp_path / "job2" / "constant" / "polyMesh"
    manifest = cache.fetch_mesh("k" * 64, dest)
    assert manifest is not None and manifest["nCells"] == 4321
    assert (dest / "points").read_text() == (src / "points").read_text()


def test_mesh_fetch_misses_and_removes_corrupt_entry(tmp_path):
    cache = _cache(tmp_path)
    src = _fake_polymesh(tmp_path / "built")
    key = "c" * 64
    assert cache.publish_mesh(key, src, n_cells=100)
    entry = cache.mesh_root / key
    # same size, different bytes -> sha256 mismatch
    points = entry / "polyMesh" / "points"
    points.write_text("fake points XX\n")
    assert cache.fetch_mesh(key, tmp_path / "dest") is None
    assert not entry.exists()


def test_partial_entry_without_manifest_is_ignored_and_removed(tmp_path):
    cache = _cache(tmp_path)
    key = "d" * 64
    partial = cache.mesh_root / key / "polyMesh"
    partial.mkdir(parents=True)
    (partial / "points").write_text("half-written\n")
    assert cache.fetch_mesh(key, tmp_path / "dest") is None
    assert not (cache.mesh_root / key).exists()


def test_lru_eviction_respects_cap(tmp_path):
    payload = tmp_path / "payload"
    payload.mkdir()
    (payload / "blob").write_bytes(b"x" * 1000)
    cache = _cache(tmp_path, max_bytes=2500)
    for key, age_s in (("a" * 64, 300), ("b" * 64, 200)):
        assert cache.publish_mesh(key, payload, n_cells=1)
        manifest = cache.mesh_root / key / MANIFEST_NAME
        stat = manifest.stat()
        os.utime(manifest, (stat.st_atime - age_s, stat.st_mtime - age_s))
    # a hit refreshes recency: entry "a" becomes newer than "b"
    assert cache.fetch_mesh("a" * 64, tmp_path / "dest") is not None
    assert cache.publish_mesh("c" * 64, payload, n_cells=1)  # pushes total over cap
    assert cache.total_bytes() <= 2500
    assert (cache.mesh_root / ("a" * 64)).exists()
    assert (cache.mesh_root / ("c" * 64)).exists()
    assert not (cache.mesh_root / ("b" * 64)).exists()  # least recently used


# --------------------------------------------------------------------------- #
# Seed store: nearest-angle selection
# --------------------------------------------------------------------------- #
def test_find_seed_nearest_angle_and_two_degree_boundary(tmp_path):
    cache = _cache(tmp_path)
    donor = _fake_time_dir(tmp_path / "case")
    key, sig = "s" * 64, "sig0123456789ab"
    for angle in (3.0, 6.0):
        assert cache.publish_seed(key, angle, sig, donor, solver="simpleFoam", speed=50.0, fluid=FLUID)

    assert cache.find_seed(key, 4.0, sig).aoa_deg == 3.0
    assert cache.find_seed(key, 5.5, sig).aoa_deg == 6.0
    assert cache.find_seed(key, 8.0, sig).aoa_deg == 6.0  # exactly 2.0 deg away: allowed
    assert cache.find_seed(key, 8.5, sig) is None  # 2.5 deg away: too far
    assert cache.find_seed(key, 0.5, sig) is None


def test_find_seed_scopes_key_and_solver_signature(tmp_path):
    cache = _cache(tmp_path)
    donor = _fake_time_dir(tmp_path / "case")
    assert cache.publish_seed("s" * 64, 4.0, "sigA", donor, solver="simpleFoam", speed=50.0, fluid=FLUID)
    assert cache.find_seed("t" * 64, 4.0, "sigA") is None  # other (mesh,fluid,speed) key
    assert cache.find_seed("s" * 64, 4.0, "sigB") is None  # incompatible solver signature


def test_publish_seed_takes_only_field_files(tmp_path):
    cache = _cache(tmp_path)
    donor = _fake_time_dir(tmp_path / "case")
    key = "u" * 64
    assert cache.publish_seed(key, 2.0, "sig", donor, solver="simpleFoam", speed=50.0, fluid=FLUID)
    hit = cache.find_seed(key, 2.0, "sig")
    copied = cache.materialize_seed(hit, tmp_path / "zero")
    assert "U" in copied and "p" in copied and "phi" in copied
    assert "uniform" not in copied
    manifest = json.loads((hit.entry_dir / MANIFEST_NAME).read_text())
    assert manifest["aoaDeg"] == 2.0
    assert manifest["solver"] == "simpleFoam"
    assert manifest["sourceTime"] == "600"
    assert all(f["byteSize"] > 0 for f in manifest["files"])


# --------------------------------------------------------------------------- #
# Seeding a case: inlet rewrite for the new angle
# --------------------------------------------------------------------------- #
def _seed_context(tmp_path, naca0012_selig_text, aoa_donor: float = 4.0):
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    donor_case = tmp_path / "donor"
    _fake_time_dir(donor_case)
    _publish_steady_seed(
        cache, donor_case, af, 1.0, resolved,
        CaseSpec(chord=1.0, speed=50.0, aoa_deg=aoa_donor), FLUID,
        RoughnessParams(), SolverParams(),
    )
    return af, resolved, cache


def test_seed_apply_rewrites_inlet_velocity_for_new_angle(tmp_path, naca0012_selig_text):
    af, resolved, cache = _seed_context(tmp_path, naca0012_selig_text)
    runner = FakeRunner()
    case_dir = tmp_path / "case_new"
    (case_dir / "0").mkdir(parents=True)
    (case_dir / "0" / "U").write_text("builder U\n")
    spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=5.0)

    assert _try_seed_initial_field(
        case_dir, af, 1.0, resolved, spec, FLUID, RoughnessParams(), SolverParams(), runner, cache
    )
    # donor fields replaced the cold-start 0/ fields
    assert (case_dir / "0" / "U").read_text() == "fake U field from donor\n"
    assert (case_dir / "0" / "p").read_text() == "fake p field from donor\n"
    assert not (case_dir / "_seed_stage").exists()
    # the inlet/outlet velocity was rewritten for THIS angle (not the donor's)
    fv = physics.freestream_vector(50.0, 5.0)
    expected = f"uniform ({fv.ux:.10g} {fv.uy:.10g} 0)"
    rewrites = [c for c in runner.commands if c.startswith("foamDictionary")]
    assert any("boundaryField.inlet.value" in c and expected in c for c in rewrites)
    assert any("boundaryField.outlet.value" in c and expected in c for c in rewrites)
    assert all("_seed_stage/U" in c for c in rewrites)  # staged before touching 0/


def test_seed_apply_misses_beyond_two_degrees(tmp_path, naca0012_selig_text):
    af, resolved, cache = _seed_context(tmp_path, naca0012_selig_text, aoa_donor=4.0)
    runner = FakeRunner()
    case_dir = tmp_path / "case_far"
    (case_dir / "0").mkdir(parents=True)
    (case_dir / "0" / "U").write_text("builder U\n")
    spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=6.5)

    assert not _try_seed_initial_field(
        case_dir, af, 1.0, resolved, spec, FLUID, RoughnessParams(), SolverParams(), runner, cache
    )
    assert (case_dir / "0" / "U").read_text() == "builder U\n"
    assert runner.commands == []


# --------------------------------------------------------------------------- #
# Fake-solver pipeline: cross-job mesh reuse + seeding
# --------------------------------------------------------------------------- #
def test_second_job_reuses_cached_mesh_without_blockmesh(tmp_path, naca0012_selig_text):
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    mesher = CountingMesher()
    runner = FakeRunner()

    first = prepare_mesh(tmp_path / "job1" / "mesh", af, resolved, 1.0, mesher, runner, cache=cache)
    assert mesher.mesh_runs == 1
    assert first.n_cells == 1234

    second = prepare_mesh(tmp_path / "job2" / "mesh", af, resolved, 1.0, mesher, runner, cache=cache)
    assert mesher.mesh_runs == 1  # no second blockMesh invocation
    assert second.n_cells == 1234
    assert (tmp_path / "job2" / "mesh" / "constant" / "polyMesh" / "points").read_text() == (
        tmp_path / "job1" / "mesh" / "constant" / "polyMesh" / "points"
    ).read_text()
    # a different chord is a different mesh and must rebuild
    other = resolve_mesh_params(MeshParams(), CaseSpec(chord=0.5, speed=50.0, aoa_deg=0.0), FLUID)
    prepare_mesh(tmp_path / "job3" / "mesh", af, other, 0.5, mesher, runner, cache=cache)
    assert mesher.mesh_runs == 2


def test_second_job_nearby_angle_is_seeded_without_potentialfoam(tmp_path, naca0012_selig_text):
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    mesher = CountingMesher()
    runner = FakeRunner()
    patches = mesher.patches(resolved)
    solver = SolverParams(transient_fallback=False, write_images=[])
    mesh_dir = tmp_path / "shared_mesh"
    prepare_mesh(mesh_dir, af, resolved, 1.0, mesher, runner, cache=cache)

    # job 1: first angle of a polar cold-starts with potentialFoam
    polar1 = tmp_path / "job1" / "polar"
    spec1 = CaseSpec(chord=1.0, speed=50.0, aoa_deg=4.0)
    outcome1 = CaseOutcome(spec=spec1, reynolds=physics.reynolds(50.0, 1.0, FLUID.nu))
    res = _solve_cold_marched(
        polar1, mesh_dir, af, patches, resolved, spec1, FLUID, RoughnessParams(),
        solver, runner, 600, outcome1, cache=cache,
    )
    assert res.ok
    assert runner.count("potentialFoam") == 1
    # the solve "converged": its latest-time fields become a cross-job seed
    _fake_time_dir(polar1, name="600", marker="job1")
    _publish_steady_seed(cache, polar1, af, 1.0, resolved, spec1, FLUID, RoughnessParams(), solver)

    # job 2: nearby angle at the same mesh/fluid/speed seeds from job 1
    polar2 = tmp_path / "job2" / "polar"
    spec2 = CaseSpec(chord=1.0, speed=50.0, aoa_deg=5.0)
    outcome2 = CaseOutcome(spec=spec2, reynolds=physics.reynolds(50.0, 1.0, FLUID.nu))
    res2 = _solve_cold_marched(
        polar2, mesh_dir, af, patches, resolved, spec2, FLUID, RoughnessParams(),
        solver, runner, 600, outcome2, cache=cache,
    )
    assert res2.ok
    assert runner.count("potentialFoam") == 1  # no second potentialFoam call
    assert (polar2 / "0" / "U").read_text() == "fake U field from job1\n"
    fv = physics.freestream_vector(50.0, 5.0)
    expected = f"uniform ({fv.ux:.10g} {fv.uy:.10g} 0)"
    assert any("boundaryField.inlet.value" in c and expected in c for c in runner.commands)

    # job 3: same speed but a far angle cold-starts again
    polar3 = tmp_path / "job3" / "polar"
    spec3 = CaseSpec(chord=1.0, speed=50.0, aoa_deg=12.0)
    outcome3 = CaseOutcome(spec=spec3, reynolds=physics.reynolds(50.0, 1.0, FLUID.nu))
    _solve_cold_marched(
        polar3, mesh_dir, af, patches, resolved, spec3, FLUID, RoughnessParams(),
        solver, runner, 600, outcome3, cache=cache,
    )
    assert runner.count("potentialFoam") == 2


def test_seed_is_speed_scoped_in_pipeline(tmp_path, naca0012_selig_text):
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    donor_case = tmp_path / "donor"
    _fake_time_dir(donor_case)
    _publish_steady_seed(
        cache, donor_case, af, 1.0, resolved,
        CaseSpec(chord=1.0, speed=50.0, aoa_deg=4.0), FLUID, RoughnessParams(), SolverParams(),
    )
    runner = FakeRunner()
    case_dir = tmp_path / "case_other_speed"
    (case_dir / "0").mkdir(parents=True)
    spec = CaseSpec(chord=1.0, speed=30.0, aoa_deg=4.0)  # same angle, other speed
    assert not _try_seed_initial_field(
        case_dir, af, 1.0, resolved, spec, FLUID, RoughnessParams(), SolverParams(), runner, cache
    )


def test_publish_steady_seed_skips_unsolved_cases(tmp_path, naca0012_selig_text):
    """A case whose only time dir is 0/ (never solved) must not publish a seed."""
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    case_dir = tmp_path / "unsolved"
    (case_dir / "0").mkdir(parents=True)
    (case_dir / "0" / "U").write_text("initial only\n")
    spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=4.0)
    _publish_steady_seed(cache, case_dir, af, 1.0, resolved, spec, FLUID, RoughnessParams(), SolverParams())
    mesh_key = EngineCache.mesh_key(af, 1.0, resolved)
    seed_key = EngineCache.seed_key(mesh_key, FLUID, 50.0)
    sig = EngineCache.solver_signature(SolverParams(), RoughnessParams())
    assert cache.find_seed(seed_key, 4.0, sig) is None
