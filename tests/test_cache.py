"""Persistent mesh cache + solution-seed cache: keys, atomicity, LRU, seeding."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from airfoilfoam import cache as cache_module
from airfoilfoam import physics
from airfoilfoam.openfoam.dialects import OPENCFD_2606_IDENTITY
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
    EngineIdentity,
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
    return EngineCache(tmp_path / "cache", max_bytes=max_bytes, engine_identity=OPENCFD_2606_IDENTITY)


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
        if "boundaryField.inlet.type -value" in command:
            return RunResult(command=command, returncode=0, stdout="fixedValue\n")
        if "boundaryField.outlet.type -value" in command:
            return RunResult(command=command, returncode=0, stdout="inletOutlet\n")
        return RunResult(command=command, returncode=0, stdout="")

    def count(self, prefix: str) -> int:
        return sum(1 for c in self.commands if c.startswith(prefix))


def _minimal_cache_manifest(entry: Path, *, kind: str, size: int, namespace: str) -> None:
    entry.mkdir(parents=True, exist_ok=True)
    (entry / MANIFEST_NAME).write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "engineNamespace": namespace,
                "kind": kind,
                "key": entry.name,
                "byteSize": size,
                "files": [{"path": "unused", "sha256": "0" * 64, "byteSize": size}],
            }
        )
    )


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #
def test_cache_cap_and_stats_are_global_across_engine_namespaces(tmp_path):
    shared = tmp_path / "cache"
    foundation_identity = EngineIdentity(
        family="openfoam",
        distribution="foundation",
        version="14",
        numerics_revision="1",
        adapter_contract_version=1,
    )
    foundation_root = shared / "engines" / foundation_identity.compatibility_key.replace(":", "_")
    legacy_entry = shared / "mesh" / ("a" * 64)
    foundation_entry = foundation_root / "seed" / ("b" * 64) / "a0_adapter"
    _minimal_cache_manifest(
        legacy_entry,
        kind="mesh",
        size=100,
        namespace="openfoam:opencfd:2406:numerics-1",
    )
    _minimal_cache_manifest(
        foundation_entry,
        kind="seed",
        size=100,
        namespace=foundation_identity.compatibility_key,
    )
    os.utime(legacy_entry / MANIFEST_NAME, (1, 1))
    os.utime(foundation_entry / MANIFEST_NAME, (2, 2))

    foundation_cache = EngineCache(
        foundation_root,
        max_bytes=150,
        engine_identity=foundation_identity,
        shared_root=shared,
    )
    foundation_cache.evict_to_cap()

    assert not legacy_entry.exists()
    assert foundation_entry.exists()
    stats = EngineCache(shared, max_bytes=150).stats()
    assert stats["mesh_entries"] == 0
    assert stats["seed_entries"] == 1
    assert stats["total_bytes"] == 100
    assert stats["namespaces"][foundation_identity.compatibility_key]["total_bytes"] == 100


def test_mesh_key_stable_for_identical_inputs(naca0012_selig_text):
    af1 = _airfoil(naca0012_selig_text)
    af2 = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    assert EngineCache.mesh_key(af1, 1.0, resolved) == EngineCache.mesh_key(af2, 1.0, resolved)


def test_mesh_key_changes_with_chord_params_and_geometry(naca0012_selig_text, naca2412_points, monkeypatch):
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
    monkeypatch.setattr(cache_module, "MESH_WRITE_PRECISION", 6)
    rounded = EngineCache.mesh_key(af, 1.0, resolved)
    assert rounded != base
    assert EngineCache.seed_key(rounded, FLUID, 50.0) != EngineCache.seed_key(base, FLUID, 50.0)


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


def test_solver_signature_tracks_bc_relevant_fields(monkeypatch):
    base = EngineCache.solver_signature(SolverParams(), RoughnessParams())
    other_model = SolverParams(turbulence=TurbulenceParams(model=TurbulenceModel.spalart_allmaras))
    assert EngineCache.solver_signature(other_model, RoughnessParams()) != base
    rough = RoughnessParams(sand_grain_height=5e-4)
    assert EngineCache.solver_signature(SolverParams(), rough) != base
    # iteration/scheme knobs do not change the 0/ boundary conditions
    more_iters = SolverParams(n_iterations=5000, momentum_scheme="upwind")
    assert EngineCache.solver_signature(more_iters, RoughnessParams()) == base
    assert EngineCache.solver_signature(
        SolverParams(compressible_startup="uniform_freestream"), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_farfield_boundary="total_inlet_static_outlet"), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_energy_form="sensibleEnthalpy"), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_pressure_consistent=True), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_pressure_solver="PBiCGStab"), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_pressure_min_factor=0.1), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_transonic=True), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_energy_advection="upwind"), RoughnessParams()
    ) != base
    assert EngineCache.solver_signature(
        SolverParams(compressible_pressure_energy_order="pressure_first"), RoughnessParams()
    ) != base
    # A solver-march policy change invalidates old accepted-looking fields: a
    # cache entry can be byte-perfect yet come from the alternate A18 branch.
    monkeypatch.setattr(cache_module, "STEADY_RANS_MARCHER_SEED_VERSION", "legacy-march")
    assert EngineCache.solver_signature(SolverParams(), RoughnessParams()) != base


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


def test_negative_steady_seed_is_not_published_or_consumed(tmp_path, naca0012_selig_text):
    """MUST-CATCH A18: a numerically accepted negative branch is not reusable."""
    af = _airfoil(naca0012_selig_text)
    resolved = _resolved()
    cache = _cache(tmp_path)
    donor = tmp_path / "negative-donor"
    donor_time = _fake_time_dir(donor)
    negative_spec = CaseSpec(chord=1.0, speed=50.0, aoa_deg=-1.0)

    # Production code refuses to admit the negative state at all.
    _publish_steady_seed(
        cache, donor, af, 1.0, resolved, negative_spec, FLUID, RoughnessParams(), SolverParams()
    )
    mesh_key = EngineCache.mesh_key(af, 1.0, resolved)
    seed_key = EngineCache.seed_key(mesh_key, FLUID, 50.0)
    signature = EngineCache.solver_signature(SolverParams(), RoughnessParams())
    assert cache.find_seed(seed_key, -1.0, signature) is None

    # Defensive read-side gate: even a manually retained/current-signature
    # negative entry must not be consumed by a fresh case.
    assert cache.publish_seed(
        seed_key, -1.0, signature, donor_time, solver="simpleFoam", speed=50.0, fluid=FLUID
    )
    runner = FakeRunner()
    target = tmp_path / "target"
    (target / "0").mkdir(parents=True)
    (target / "0" / "U").write_text("cold field\n")
    assert not _try_seed_initial_field(
        target,
        af,
        1.0,
        resolved,
        CaseSpec(chord=1.0, speed=50.0, aoa_deg=-1.0),
        FLUID,
        RoughnessParams(),
        SolverParams(),
        runner,
        cache,
    )
    assert (target / "0" / "U").read_text() == "cold field\n"
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


# Exercise the maintenance operator through the same on-disk manifests, mesh
# materializer and seed lookup as a running worker. The two filesystems are real.
@pytest.fixture
def parking_case(tmp_path):
    import importlib.util
    import tempfile

    script = Path(__file__).parents[1] / "scripts/deploy/park-hz-engine-cache.py"
    spec = importlib.util.spec_from_file_location("hz_parking", script)
    op = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(op)
    with tempfile.TemporaryDirectory(dir="/dev/shm") as scratch:
        base = Path(scratch)
        assert base.stat().st_dev != tmp_path.stat().st_dev
        root = base / "cache"
        ns = root / op.NAMESPACE.parent
        cache = EngineCache(ns, 100 * 1024**3, engine_identity=OPENCFD_2606_IDENTITY, shared_root=root)
        key = "a" * 64
        src = _fake_polymesh(tmp_path / "original")
        (src / "points").write_bytes(b"original mesh\n" * 20000)
        sides = tmp_path / "sidecars"
        sides.mkdir()
        (sides / "force-evidence").write_bytes(b"unique original evidence\n")
        assert cache.publish_mesh(key, src, n_cells=4321, evidence_dir=sides)
        entry = ns / "mesh" / key
        epoch_ns = 1234567890123456789
        os.utime(entry / "manifest.json", ns=(epoch_ns, epoch_ns))
        item = op.inventory(entry)

        class Case:
            def plan(self, wanted=None, protected=()):
                if wanted is None:
                    wanted = item["allocated"] // 2
                total = op.free(root) + wanted
                guard = {"role": "remote-solver", "target": "public.progressive_worker_reports", "touched": [],
                         "worker": {"disk": {"source": "/dev/md4"}},
                         "workspace": {"replacementBytes": total - 4, "indexScratchBytes": 1, "additionalWalBytes": 1,
                                       "externalGrowthBytes": 1, "stopFreeBytes": 1, "requiredBytes": total}}
                return op.select_entries(root, tmp_path, guard, 0, 65536, 8 * 1024**2, 3, 14, protected)

        case = Case()
        case.op, case.cache, case.root, case.key = op, cache, root, key
        case.entry, case.src, case.item, case.run = entry, src, item, tmp_path / "parking"
        yield case


def _isolated_parking_fence(keys):
    from contextlib import nullcontext
    return nullcontext(lambda: None)


def test_parking_roundtrip_budget_and_scientific_sidecars(parking_case, tmp_path):
    c = parking_case
    p = c.plan()
    assert [i["key"] for i in p["entries"]] == [c.key]
    prior = c.op.free(c.root)
    c.op.prepare(c.run, p)
    sealed = (c.run / "prepared.json").read_bytes()
    assert c.op.prepare(c.run, p)["reusedSealedCopy"] and (c.run / "prepared.json").read_bytes() == sealed
    with pytest.raises(ValueError, match="falls short"):
        c.plan(protected={c.key})
    parked = c.op.park(c.run, _isolated_parking_fence)
    assert parked["parkedEntries"] == 1 and parked["meetsRequiredBytes"]
    assert not c.entry.exists() and c.op.free(c.root) > prior
    assert c.op.park(c.run, _isolated_parking_fence) == parked
    restored = c.op.restore(c.run, 65536, _isolated_parking_fence)
    assert restored["restoredEntries"] == 1
    assert c.op.restore(c.run, 65536, _isolated_parking_fence) == restored
    c.op.same_restored(c.entry, c.item)
    assert (c.entry / "manifest.json").stat().st_mtime_ns == c.item["lru"]
    assert c.cache.fetch_mesh(c.key, tmp_path / "case-mesh", tmp_path / "case-evidence")["nCells"] == 4321
    assert (tmp_path / "case-mesh/points").read_bytes() == (c.src / "points").read_bytes()
    assert (tmp_path / "case-evidence/force-evidence").read_bytes() == b"unique original evidence\n"


def test_parking_refuses_real_reader_between_hash_and_copy(parking_case, tmp_path, monkeypatch):
    import threading
    c = parking_case
    c.op.prepare(c.run, c.plan())
    hit = threading.Event()
    release = threading.Event()
    original = c.cache._verified_manifest

    def verified(entry):
        manifest = original(entry)
        hit.set()
        assert release.wait(8)
        return manifest

    monkeypatch.setattr(c.cache, "_verified_manifest", verified)
    result = []
    t = threading.Thread(target=lambda: result.append(c.cache.fetch_mesh(c.key, tmp_path / "flight")))
    t.start()
    try:
        assert hit.wait(8)
        monkeypatch.setattr(c.op, "VOLUME", c.root.parent)
        monkeypatch.setattr(c.op, "engine", lambda: {})
        monkeypatch.setattr(c.op, "worker_call", lambda owner, action: {"meshKeys": [c.key]})
        with pytest.raises(ValueError, match="Active solver"):
            c.op.park(c.run, lambda keys: c.op.live_fence(c.run, keys))
        assert c.entry.is_dir() and not (c.run / "reader-state.json").exists()
    finally:
        release.set()
        t.join(8)
    assert result[0] and (tmp_path / "flight/points").read_bytes() == (c.src / "points").read_bytes()
    with pytest.raises(ValueError, match="changed"):
        c.op.park(c.run, _isolated_parking_fence)


def test_parking_corruption_crash_and_regenerated_generation(parking_case, monkeypatch):
    c = parking_case
    c.op.prepare(c.run, c.plan())
    z = c.run / (c.key + ".zip")
    data = z.read_bytes()
    z.write_bytes(data + b"trailing change")
    with pytest.raises(ValueError, match="Sealed parking ZIP"):
        c.op.prepare(c.run, c.op.load_prepared(c.run))
    z.write_bytes(data[:-3])
    with pytest.raises(ValueError, match="ZIP changed"):
        c.op.park(c.run, _isolated_parking_fence)
    c.op.same_restored(c.entry, c.item)
    z.write_bytes(data)
    real = c.op.noreplace

    def interrupted(a, b):
        real(a, b)
        raise RuntimeError("interrupted after atomic rename")

    monkeypatch.setattr(c.op, "noreplace", interrupted)
    with pytest.raises(RuntimeError, match="interrupted"):
        c.op.park(c.run, _isolated_parking_fence)
    assert not c.entry.exists()
    monkeypatch.setattr(c.op, "noreplace", real)
    assert c.op.park(c.run, _isolated_parking_fence)["parkedEntries"] == 1
    with pytest.raises(ValueError, match="reserve"):
        c.op.restore(c.run, c.op.free(c.root) + 1, _isolated_parking_fence)
    (c.src / "points").write_bytes(b"changed generation")
    assert c.cache.publish_mesh(c.key, c.src, n_cells=2)
    conflict = c.op.restore(c.run, 65536, _isolated_parking_fence)
    assert conflict["restoredEntries"] == 0 and conflict["conflicts"][0]["key"] == c.key
    assert (c.entry / "polyMesh/points").read_bytes() == b"changed generation"
    c.op.verified_zip(z, c.item)


def test_parking_excludes_links_and_preserves_already_sufficient_volume(parking_case):
    c = parking_case
    assert c.plan(0)["entries"] == []
    (c.entry / "unexpected").symlink_to(c.src / "points")
    with pytest.raises(ValueError, match="Linked or special"):
        c.plan()


def test_parking_recovers_admission_with_real_prefork_worker(parking_case, tmp_path, monkeypatch, naca0012_selig_text):
    import importlib.util
    import signal
    import socket
    import subprocess
    import sys
    import time
    from types import SimpleNamespace
    import airfoilfoam.celery_app as production_celery
    import airfoilfoam.config as config
    from airfoilfoam.models import PolarRequest

    c = parking_case
    fixture = Path(__file__).parent / "fixtures"
    broker = tmp_path / "broker"
    for p in [broker, broker / "queue", broker / "bindings"]:
        p.mkdir()
    monkeypatch.setenv("HZ_PARKING_TEST_DIR", str(broker))
    monkeypatch.syspath_prepend(str(fixture))
    import hz_cache_celery_app as service
    worker_env = {**os.environ, "PYTHONPATH": str(fixture) + os.pathsep + str(Path(__file__).parents[1] / "src")}
    node = "celery@" + socket.gethostname()
    proc = subprocess.Popen([sys.executable, "-m", "celery", "-A", "hz_cache_celery_app:app", "worker", "-n", node,
                             "-P", "prefork", "-c", "1", "--without-mingle", "--without-gossip", "--without-heartbeat",
                             "-l", "WARNING"], cwd=broker, env=worker_env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    src = Path(c.op.__file__).with_name("hz_cache_reader_scope.py")
    spec = importlib.util.spec_from_file_location("parking_test_scope", src)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    monkeypatch.setattr(production_celery, "celery_app", service.app)
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(celery_queue="openfoam-opencfd-2606-numerics-2", resolved_cache_dir=lambda: Path("/data/airfoilfoam/cache"), engine_identity=lambda: OPENCFD_2606_IDENTITY))
    from airfoilfoam import jobs, pipeline
    import hashlib, inspect
    monkeypatch.setattr(reader, "PINS", {fn.__name__: hashlib.sha256(inspect.getsource(fn).encode()).hexdigest()
                        for fn in (jobs.execute_job, pipeline.prepare_mesh, pipeline.prepare_mesh_with_recovery)})
    owner = {"container": "disposable", "init": os.getpid(), "started": "fixture"}
    monkeypatch.setattr(c.op, "VOLUME", c.root.parent)
    monkeypatch.setattr(c.op, "engine", lambda: owner)
    monkeypatch.setattr(reader, "RESULTS_ROOT", c.root.parent)
    readers = c.op.open_cache_readers
    monkeypatch.setattr(c.op, "open_cache_readers", lambda keys: readers(keys, [Path("/proc/self")]))
    monkeypatch.setattr(c.op, "master", lambda owner, child: proc.pid if proc.pid == child else pytest.fail("foreign worker"))
    epochs = []
    def rpc(owner, action, prior=None):
        if action == "fence":
            epochs.append(dict(prior))
        return reader.control(action, prior)
    monkeypatch.setattr(c.op, "worker_call", rpc)
    deadline = time.monotonic() + 20
    try:
        while not service.app.control.ping(destination=[node], timeout=0.5):
            assert proc.poll() is None and time.monotonic() < deadline
        req = PolarRequest.model_validate({"airfoil": {"name": "0012", "coordinates": naca0012_selig_text},
                                           "chord_lengths": [1], "speeds": [30], "aoa": {"angles": [0]}})
        service.app.send_task("airfoilfoam.run_polar", args=["fixture", req.model_dump_json()])
        while not (broker / "reader-started").is_file():
            assert time.monotonic() < deadline
            time.sleep(0.04)
        prior = reader.control("inspect")
        assert prior["tasks"] == 1 and prior["meshKeys"] and prior["bindings"]
        c.op.prepare(c.run, c.plan())
        with pytest.raises(ValueError, match="Active solver"):
            with c.op.live_fence(c.run, {prior["meshKeys"][0]}):
                pytest.fail("Active mesh must stay accessible")
        with (c.entry / "polyMesh/points").open("rb"):
            with pytest.raises(ValueError, match="external process"):
                with c.op.live_fence(c.run, {c.key}):
                    pytest.fail("A live file handle must veto retirement")
        with c.op.live_fence(c.run, {c.key}) as check:
            check()
            assert c.op.proc(proc.pid)[0] == "T"
            # The actual solver pool child keeps executing while the consumer master holds admission.
            t = (broker / "solver-progress").stat().st_mtime_ns
            time.sleep(0.12)
            assert (broker / "solver-progress").stat().st_mtime_ns > t
        assert reader.control("inspect")["bindings"] == prior["bindings"]
        assert c.op.proc(proc.pid)[0] != "T" and not (c.run / "reader-state.json").exists()
        live = lambda keys: c.op.live_fence(c.run, keys)
        assert c.op.park(c.run, live)["parkedEntries"] == 1
        assert c.op.restore(c.run, 65536, live)["restoredEntries"] == 1
        c.op.same_restored(c.entry, c.item)

        service.app.control.cancel_consumer(prior["queue"], destination=[node], reply=True, timeout=4)
        assert not reader.control("inspect")["bindings"]
        with c.op.live_fence(c.run, {c.key}) as check:
            check()
        assert not reader.control("inspect")["bindings"]
        service.app.control.add_consumer(prior["queue"], destination=[node], reply=True, timeout=4)
        with pytest.raises(ValueError, match="revoked"):
            reader.control("fence", epochs[-1])
        assert reader.control("inspect")["bindings"] == prior["bindings"]

        # Kill the foreground operator inside the hard fence. Its independent watchdog
        # restores the same live master and the original real broker binding.
        rd, wr = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(rd)
            try:
                with c.op.live_fence(c.run, {c.key}):
                    os.write(wr, b"R")
                    time.sleep(30)
            finally:
                os._exit(2)
        os.close(wr)
        import select
        try:
            assert select.select([rd], [], [], 15)[0] and os.read(rd, 1) == b"R"
        finally:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
            os.close(rd)
        end = time.monotonic() + 12
        while (c.run / "reader-state.json").exists() and time.monotonic() < end:
            time.sleep(0.05)
        assert not (c.run / "reader-state.json").exists()
        assert reader.control("inspect")["bindings"] == prior["bindings"]
    finally:
        (broker / "reader-finished").touch()
        if proc.poll() is None:
            os.kill(proc.pid, signal.SIGCONT)
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)


@pytest.mark.parametrize("geometry", ["naca0012_selig_text", "sharp_naca0012_selig_text"])
def test_parking_protects_the_actual_mesh_recovery_ladder(tmp_path, monkeypatch, request, geometry):
    import importlib.util
    from airfoilfoam import jobs, pipeline as p
    from airfoilfoam.models import PolarRequest
    path = Path(__file__).parents[1] / "scripts/deploy/hz_cache_reader_scope.py"
    spec = importlib.util.spec_from_file_location("mesh_scope_ladder", path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    req = PolarRequest.model_validate({"airfoil": {"name": geometry, "coordinates": request.getfixturevalue(geometry)},
                                       "chord_lengths": [1], "speeds": [30], "aoa": {"angles": [0]}})
    airfoil = jobs.load_airfoil(req.airfoil.name, req.airfoil.coordinates, req.airfoil.points, req.airfoil.format)
    base, _ = jobs.effective_mesh_params_for_airfoil(req.mesh, req.solver, airfoil, urans_mesh=req.urans_mesh,
                                                    urans_precalc_mesh=req.urans_precalc_mesh)
    resolved = jobs.resolve_mesh_params(base, CaseSpec(chord=1, speed=30, aoa_deg=0), req.fluid)
    seen = set()

    def rejected(mesh_dir, geometry, actual, chord, actual_mesher, runner, **kwargs):
        seen.add(EngineCache.mesh_key(geometry, chord, actual, mesher=actual_mesher))
        raise p.DeterministicMeshError("exercise the next registered recovery candidate")

    monkeypatch.setattr(p, "prepare_mesh", rejected)
    monkeypatch.setattr(p, "capture_mesh_attempt_diagnostic", lambda *args, **kwargs: {"message": "fixture"})
    monkeypatch.setattr(p, "format_mesh_attempt_diagnostic", lambda item: "fixture")
    with pytest.raises(p.DeterministicMeshError):
        p.prepare_mesh_with_recovery(tmp_path / "mesh", airfoil, resolved, 1.0, jobs.get_mesher(resolved.mesher), None)
    assert len(seen) >= 2 and seen <= reader.mesh_keys(req.model_dump_json())
