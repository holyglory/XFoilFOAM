"""Shared-mesh quality gating and bounded deterministic recovery.

These fixtures model the production failure shape: one shared mesh fans out to
many AoAs. A bad mesh must be rejected before cache publication/fan-out, while
an unavailable diagnostic must never be mistaken for a deterministic geometry
failure.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import pipeline, tasks
from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.cache import EngineCache
from airfoilfoam.config import Settings
from airfoilfoam.meshing.base import BoundaryPatch, Mesher, MeshResult, list_meshers
from airfoilfoam.models import (
    AoASpec,
    AirfoilFormat,
    CaseSpec,
    FailureDisposition,
    FluidProperties,
    MeshParams,
    PolarRequest,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    RunResult,
    Runner,
)
from airfoilfoam.storage import JobStore


FLUID = FluidProperties(density=1.225, dynamic_viscosity=1.81e-5)


def _airfoil(text: str):
    return load_airfoil("naca0012", text, None, AirfoilFormat.auto)


def _fake_polymesh(base: Path, marker: str) -> None:
    poly = base / "constant" / "polyMesh"
    poly.mkdir(parents=True, exist_ok=True)
    for name in ("points", "faces", "owner", "neighbour", "boundary"):
        (poly / name).write_text(f"{name} {marker}\n")


class CountingMesher(Mesher):
    name = "test-shared-mesh"

    def __init__(
        self,
        name: str = "test-shared-mesh",
        events: list[tuple[str, float | None]] | None = None,
    ) -> None:
        self.name = name
        self.cache_version = f"{name}-test-v1"
        self.runs = 0
        self.events = events

    def write_inputs(self, case_dir, airfoil, params, chord) -> None:
        (case_dir / "system").mkdir(parents=True, exist_ok=True)
        (case_dir / "system" / "blockMeshDict").write_text("// test\n")

    def patches(self, params):
        return [
            BoundaryPatch("airfoil", "wall"),
            BoundaryPatch("inlet", "inlet"),
            BoundaryPatch("outlet", "outlet"),
            BoundaryPatch("frontAndBack", "empty"),
        ]

    def run_mesh(self, case_dir, params, runner):
        self.runs += 1
        if self.events is not None:
            self.events.append((self.name, params.first_cell_height_chords))
        _fake_polymesh(case_dir, f"build-{self.runs}")
        return MeshResult(
            self.patches(params),
            params.span_chords,
            n_cells=7600,
            log=f"nCells: 7600\nmesher: {self.name}\n",
        )


class NoopRunner(Runner):
    external_paths_visible = True

    def run(self, case_dir, command, timeout=7200, monitor=None):
        return RunResult(command=command, returncode=0, stdout="")


def _cache(tmp_path: Path) -> EngineCache:
    return EngineCache(tmp_path / "cache", max_bytes=1024**3)


def _ladder_meshers(monkeypatch, events: list[tuple[str, float | None]]):
    names = (
        pipeline.MESH_RECOVERY_PUBLIC_MESHER,
        *pipeline.MESH_RECOVERY_MESHER_CANDIDATES,
    )
    meshers = {name: CountingMesher(name, events) for name in names}
    monkeypatch.setattr(pipeline, "get_mesher", lambda name: meshers[name])
    return meshers[pipeline.MESH_RECOVERY_PUBLIC_MESHER], meshers


def test_shared_mesh_is_validated_before_publish_and_revalidated_on_cache_hit(
    tmp_path, naca0012_selig_text
):
    airfoil = _airfoil(naca0012_selig_text)
    resolved = MeshParams(first_cell_height_chords=0.002)
    cache = _cache(tmp_path)
    mesher = CountingMesher()
    checked: list[Path] = []

    def validate(mesh_dir: Path, actual: MeshParams) -> bool:
        assert actual == resolved
        assert (mesh_dir / "constant" / "polyMesh" / "points").is_file()
        checked.append(mesh_dir)
        return True

    pipeline.prepare_mesh(
        tmp_path / "job-1", airfoil, resolved, 1.0, mesher, NoopRunner(),
        cache=cache, validate=validate,
    )
    pipeline.prepare_mesh(
        tmp_path / "job-2", airfoil, resolved, 1.0, mesher, NoopRunner(),
        cache=cache, validate=validate,
    )

    assert mesher.runs == 1
    assert checked == [tmp_path / "job-1", tmp_path / "job-2"]
    key = EngineCache.mesh_key(airfoil, 1.0, resolved, mesher=mesher)
    assert (cache.mesh_root / key / "manifest.json").is_file()


def test_deterministic_rejection_of_cached_mesh_evicts_it(
    tmp_path, naca0012_selig_text
):
    airfoil = _airfoil(naca0012_selig_text)
    resolved = MeshParams(first_cell_height_chords=0.002)
    cache = _cache(tmp_path)
    mesher = CountingMesher()
    first_dir = tmp_path / "first"
    pipeline.prepare_mesh(first_dir, airfoil, resolved, 1.0, mesher, NoopRunner(), cache=cache)
    key = EngineCache.mesh_key(airfoil, 1.0, resolved, mesher=mesher)
    assert (cache.mesh_root / key).is_dir()

    def reject(_mesh_dir: Path, _actual: MeshParams) -> bool:
        raise DeterministicMeshError("checkMesh reported negative-volume cells")

    with pytest.raises(DeterministicMeshError, match="negative-volume"):
        pipeline.prepare_mesh(
            tmp_path / "second", airfoil, resolved, 1.0, mesher, NoopRunner(),
            cache=cache, validate=reject,
        )

    assert mesher.runs == 1  # a known-bad cache hit is not rebuilt unchanged
    assert not (cache.mesh_root / key).exists()


def test_unavailable_quality_probe_neither_publishes_nor_triggers_recovery(
    tmp_path, naca0012_selig_text
):
    airfoil = _airfoil(naca0012_selig_text)
    resolved = MeshParams(first_cell_height_chords=0.02)
    cache = _cache(tmp_path)
    mesher = CountingMesher()

    result, actual, recovered = pipeline.prepare_mesh_with_recovery(
        tmp_path / "unknown",
        airfoil,
        resolved,
        1.0,
        mesher,
        NoopRunner(),
        cache=cache,
        validate=lambda _mesh, _resolved: False,
    )

    key = EngineCache.mesh_key(airfoil, 1.0, resolved, mesher=mesher)
    assert result.n_cells == 7600
    assert actual == resolved
    assert recovered is False
    assert mesher.runs == 1
    assert not (cache.mesh_root / key).exists()


@pytest.mark.parametrize(
    "result",
    [
        RunResult(
            command="checkMesh -time 0",
            returncode=1,
            stdout="Mesh non-orthogonality Max: 10 average: 1\nMesh OK.\n",
        ),
        RunResult(
            command="checkMesh -time 0",
            returncode=124,
            stdout="Mesh non-orthogonality Max: 10 average: 1\nMesh OK.\n",
            timed_out=True,
        ),
    ],
    ids=["benign-nonzero", "timeout-with-benign-partial-output"],
)
def test_failed_checkmesh_process_neither_marks_nor_caches_mesh(
    tmp_path, naca0012_selig_text, result
):
    """Process failure must not become a verified/cached geometry verdict."""
    airfoil = _airfoil(naca0012_selig_text)
    resolved = MeshParams(first_cell_height_chords=0.002)
    cache = _cache(tmp_path)
    mesher = CountingMesher()
    runner = NoopRunner()
    runner.run = lambda *_args, **_kwargs: result
    mesh_dir = tmp_path / "failed-probe"

    def validate(actual_dir: Path, _actual: MeshParams) -> bool:
        return pipeline._run_transient_mesh_qa_gate(actual_dir, runner, []) is not None

    with pytest.raises(InfrastructureError):
        pipeline.prepare_mesh(
            mesh_dir,
            airfoil,
            resolved,
            1.0,
            mesher,
            runner,
            cache=cache,
            validate=validate,
        )

    key = EngineCache.mesh_key(airfoil, 1.0, resolved, mesher=mesher)
    assert not (mesh_dir / pipeline.SHARED_MESH_QA_MARKER).exists()
    assert not (cache.mesh_root / key).exists()


@pytest.mark.parametrize("failed_checks", [None, {}, [], "0", True, -1])
def test_malformed_shared_mesh_qa_marker_is_unverified(tmp_path, failed_checks):
    """Corrupt marker fields fail closed instead of crashing cache validation."""
    marker = {
        "schemaVersion": 1,
        "maxNonOrthogonalityDeg": 10.0,
        "failedChecks": failed_checks,
        "negativeVolume": False,
    }
    (tmp_path / pipeline.SHARED_MESH_QA_MARKER).write_text(json.dumps(marker))

    assert pipeline.shared_mesh_qa_verified(tmp_path) is False


def test_recovery_tries_segmented_candidates_in_order_and_stops_on_early_success(
    tmp_path, naca0012_selig_text, monkeypatch
):
    airfoil = _airfoil(naca0012_selig_text)
    initial = MeshParams(first_cell_height_chords=0.01575)
    cache = _cache(tmp_path)
    events: list[tuple[str, float | None]] = []
    mesher, meshers = _ladder_meshers(monkeypatch, events)
    warnings: list[str] = []

    def validate(_mesh_dir: Path, actual: MeshParams) -> bool:
        if actual.mesher == pipeline.MESH_RECOVERY_PUBLIC_MESHER:
            raise DeterministicMeshError("legacy four-block fold")
        return True

    result, actual, recovered = pipeline.prepare_mesh_with_recovery(
        tmp_path / "mesh",
        airfoil,
        initial,
        0.05,
        mesher,
        NoopRunner(),
        cache=cache,
        validate=validate,
        quality_warnings=warnings,
    )

    assert result.n_cells == 7600
    assert recovered is True
    assert actual.mesher == pipeline.MESH_RECOVERY_MESHER_CANDIDATES[0]
    assert actual.first_cell_height_chords == pytest.approx(0.01575)
    assert events == [
        (pipeline.MESH_RECOVERY_PUBLIC_MESHER, 0.01575),
        (pipeline.MESH_RECOVERY_MESHER_CANDIDATES[0], 0.01575),
    ]
    assert any(actual.mesher in warning for warning in warnings)
    initial_key = EngineCache.mesh_key(airfoil, 0.05, initial, mesher=mesher)
    repaired_key = EngineCache.mesh_key(
        airfoil, 0.05, actual, mesher=meshers[actual.mesher]
    )
    assert not (cache.mesh_root / initial_key).exists()
    assert (cache.mesh_root / repaired_key / "manifest.json").is_file()


def test_recovery_retries_each_candidate_at_bounded_wall_height_only_after_typed_failure(
    tmp_path, naca0012_selig_text, monkeypatch
):
    """Production-shaped recall: low-speed 20-32C needed the 0.006c cap."""
    airfoil = _airfoil(naca0012_selig_text)
    initial = MeshParams(first_cell_height_chords=0.01575)
    events: list[tuple[str, float | None]] = []
    mesher, _meshers = _ladder_meshers(monkeypatch, events)
    first_candidate = pipeline.MESH_RECOVERY_MESHER_CANDIDATES[0]

    def validate(_mesh_dir: Path, actual: MeshParams) -> bool:
        if actual.mesher == pipeline.MESH_RECOVERY_PUBLIC_MESHER:
            raise DeterministicMeshError("legacy four-block fold")
        if (
            actual.mesher == first_candidate
            and actual.first_cell_height_chords
            > pipeline.MESH_RECOVERY_MAX_FIRST_CELL_HEIGHT_CHORDS
        ):
            raise DeterministicMeshError("low-speed first-wall skew")
        return True

    _result, actual, recovered = pipeline.prepare_mesh_with_recovery(
        tmp_path / "mesh",
        airfoil,
        initial,
        0.05,
        mesher,
        NoopRunner(),
        validate=validate,
    )

    assert recovered is True
    assert actual.mesher == first_candidate
    assert actual.first_cell_height_chords == pytest.approx(0.006)
    assert events == [
        (pipeline.MESH_RECOVERY_PUBLIC_MESHER, 0.01575),
        (first_candidate, 0.01575),
        (first_candidate, 0.006),
    ]


def test_recovered_mesh_evidence_is_checksummed_cached_and_archived_per_point(
    tmp_path, naca0012_selig_text, monkeypatch
):
    """A repaired point retains exact setup, QA, and failed-attempt proof."""
    airfoil = _airfoil(naca0012_selig_text)
    initial = MeshParams(first_cell_height_chords=0.01575)
    events: list[tuple[str, float | None]] = []
    mesher, meshers = _ladder_meshers(monkeypatch, events)
    cache = _cache(tmp_path)
    mesh_dir = tmp_path / "mesh"

    def validate(actual_dir: Path, actual: MeshParams) -> bool:
        if actual.mesher == pipeline.MESH_RECOVERY_PUBLIC_MESHER:
            (actual_dir / "log.checkMesh").write_text(
                "Mesh non-orthogonality Max: 94 average: 30\n"
                "*** negative volume cells\nFailed 1 mesh checks.\n"
            )
            raise DeterministicMeshError("checkMesh reported negative-volume cells")
        qa = pipeline.MeshQaResult(
            max_non_ortho_deg=54.0,
            failed_checks=0,
            negative_volume=False,
        )
        (actual_dir / "log.checkMesh").write_text(
            "Mesh non-orthogonality Max: 54 average: 18\nMesh OK.\n"
        )
        pipeline.write_shared_mesh_qa_marker(actual_dir, qa)
        return True

    result, actual, recovered = pipeline.prepare_mesh_with_recovery(
        mesh_dir,
        airfoil,
        initial,
        0.05,
        mesher,
        NoopRunner(),
        cache=cache,
        validate=validate,
    )

    assert recovered is True and result.n_cells == 7600
    assert pipeline.shared_mesh_evidence_verified(mesh_dir)
    evidence_dir = mesh_dir / pipeline.SHARED_MESH_EVIDENCE_DIR
    manifest_path = evidence_dir / pipeline.SHARED_MESH_EVIDENCE_MANIFEST
    manifest = json.loads(manifest_path.read_text())
    expected_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    checksum = evidence_dir / pipeline.SHARED_MESH_EVIDENCE_CHECKSUM
    assert checksum.read_text().split()[0] == expected_digest
    assert manifest["meshRecoveryVersion"] == 2
    assert manifest["status"] == "verified"
    assert manifest["actualMesh"]["params"]["mesher"] == actual.mesher
    assert manifest["actualMesh"]["params"]["first_cell_height_chords"] == pytest.approx(
        actual.first_cell_height_chords
    )
    assert manifest["actualMesh"]["mesher"] == {
        "name": actual.mesher,
        "cacheVersion": meshers[actual.mesher].cache_version,
    }
    assert manifest["qaVerdict"]["maxNonOrthogonalityDeg"] == pytest.approx(54.0)
    assert manifest["attempts"][0]["disposition"] == "deterministic_mesh"
    assert manifest["attempts"][0]["mesher"]["name"] == pipeline.MESH_RECOVERY_PUBLIC_MESHER
    assert "negative-volume" in manifest["attempts"][0]["error"]["message"]
    assert "94" in manifest["attempts"][0]["files"]["checkMeshLog"]["tail"]
    assert manifest["attempts"][-1]["disposition"] == "accepted"
    assert all(
        manifest["artifacts"][name] is not None
        for name in ("blockMeshDict", "blockMeshLog", "checkMeshLog", "qaMarker")
    )

    cache_key = EngineCache.mesh_key(
        airfoil,
        0.05,
        actual,
        mesher=meshers[actual.mesher],
    )
    assert (cache.mesh_root / cache_key / "meshEvidence" / "manifest.json").is_file()

    point_case = tmp_path / "point"
    pipeline._link_mesh(point_case, mesh_dir, NoopRunner())
    outcome = pipeline.CaseOutcome(
        spec=CaseSpec(chord=0.05, speed=30.0, aoa_deg=7.0),
        reynolds=100_000.0,
    )
    pipeline._archive_case_evidence(
        point_case,
        point_case,
        outcome,
        requested_fields=[],
    )
    archived_manifest = (
        point_case
        / "evidence"
        / "openfoam"
        / "mesh_evidence"
        / pipeline.SHARED_MESH_EVIDENCE_MANIFEST
    )
    assert archived_manifest.read_bytes() == manifest_path.read_bytes()
    point_evidence = json.loads(
        (point_case / "evidence" / "evidence_manifest.json").read_text()
    )
    archived_paths = {entry["path"] for entry in point_evidence["files"]}
    assert "openfoam/mesh_evidence/manifest.json" in archived_paths
    assert "openfoam/mesh_evidence/manifest.sha256" in archived_paths


def test_link_mesh_replaces_stale_evidence_symlink_with_verified_copy(tmp_path):
    """Point provenance cannot remain linked to mutable shared job storage."""
    source = tmp_path / "source"
    source_evidence = source / pipeline.SHARED_MESH_EVIDENCE_DIR
    source_evidence.mkdir(parents=True)
    manifest = {
        "schemaVersion": pipeline.SHARED_MESH_EVIDENCE_SCHEMA_VERSION,
        "artifacts": {},
    }
    manifest_path = source_evidence / pipeline.SHARED_MESH_EVIDENCE_MANIFEST
    manifest_path.write_text(json.dumps(manifest))
    digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    (source_evidence / pipeline.SHARED_MESH_EVIDENCE_CHECKSUM).write_text(
        f"{digest}  {pipeline.SHARED_MESH_EVIDENCE_MANIFEST}\n"
    )
    _fake_polymesh(source, "source")

    mutable_old = tmp_path / "mutable-old"
    mutable_old.mkdir()
    point = tmp_path / "point"
    point.mkdir()
    (point / pipeline.SHARED_MESH_EVIDENCE_DIR).symlink_to(
        mutable_old,
        target_is_directory=True,
    )

    pipeline._link_mesh(point, source, NoopRunner())

    copied = point / pipeline.SHARED_MESH_EVIDENCE_DIR
    assert copied.is_dir() and not copied.is_symlink()
    assert pipeline.shared_mesh_evidence_verified(point)
    assert (
        copied / pipeline.SHARED_MESH_EVIDENCE_MANIFEST
    ).read_bytes() == manifest_path.read_bytes()


def test_all_deterministic_candidates_exhaust_in_exact_order_with_real_diagnostics(
    tmp_path, naca0012_selig_text, monkeypatch
):
    airfoil = _airfoil(naca0012_selig_text)
    initial = MeshParams(first_cell_height_chords=0.01575)
    events: list[tuple[str, float | None]] = []
    mesher, _meshers = _ladder_meshers(monkeypatch, events)

    def reject(mesh_dir: Path, actual: MeshParams) -> bool:
        (mesh_dir / "log.checkMesh").write_text(
            f"real-log-{actual.mesher}-{actual.first_cell_height_chords}\n"
        )
        raise DeterministicMeshError(f"typed rejection for {actual.mesher}")

    with pytest.raises(DeterministicMeshError) as raised:
        pipeline.prepare_mesh_with_recovery(
            tmp_path / "mesh",
            airfoil,
            initial,
            0.05,
            mesher,
            NoopRunner(),
            validate=reject,
        )

    expected = [(pipeline.MESH_RECOVERY_PUBLIC_MESHER, 0.01575)]
    for name in pipeline.MESH_RECOVERY_MESHER_CANDIDATES:
        expected.extend(((name, 0.01575), (name, 0.006)))
        if name in pipeline.MESH_RECOVERY_FINE_WALL_MESHERS:
            expected.append((name, 0.003))
    assert events == expected
    message = str(raised.value)
    assert f"exhausted after {len(expected)} deterministic attempts" in message
    assert "real-log-blockmesh-cgrid-0.01575" in message
    assert (
        f"real-log-{pipeline.MESH_RECOVERY_MESHER_CANDIDATES[-1]}-0.003"
        in message
    )
    for name in (pipeline.MESH_RECOVERY_PUBLIC_MESHER, *pipeline.MESH_RECOVERY_MESHER_CANDIDATES):
        assert f"mesher={name}" in message


def test_infrastructure_failure_stops_ladder_without_cap_or_next_candidate(
    tmp_path, naca0012_selig_text, monkeypatch
):
    airfoil = _airfoil(naca0012_selig_text)
    initial = MeshParams(first_cell_height_chords=0.01575)
    events: list[tuple[str, float | None]] = []
    mesher, _meshers = _ladder_meshers(monkeypatch, events)

    def validate(_mesh_dir: Path, actual: MeshParams) -> bool:
        if actual.mesher == pipeline.MESH_RECOVERY_PUBLIC_MESHER:
            raise DeterministicMeshError("legacy four-block fold")
        raise InfrastructureError("checkMesh launcher unavailable")

    with pytest.raises(InfrastructureError, match="launcher unavailable"):
        pipeline.prepare_mesh_with_recovery(
            tmp_path / "mesh",
            airfoil,
            initial,
            0.05,
            mesher,
            NoopRunner(),
            validate=validate,
        )

    assert events == [
        (pipeline.MESH_RECOVERY_PUBLIC_MESHER, 0.01575),
        (pipeline.MESH_RECOVERY_MESHER_CANDIDATES[0], 0.01575),
    ]


@pytest.mark.parametrize(
    ("failure", "expected_disposition"),
    [
        (
            DeterministicMeshError(
                "blockMesh segmented topology preflight failed: recovery exhausted "
                "after "
                f"{1 + 2 * len(pipeline.MESH_RECOVERY_MESHER_CANDIDATES) + len(pipeline.MESH_RECOVERY_FINE_WALL_MESHERS)} "
                "deterministic attempts"
            ),
            FailureDisposition.deterministic_mesh,
        ),
        (
            InfrastructureError(
                "blockMesh process disappeared before topology preflight completed"
            ),
            FailureDisposition.infrastructure,
        ),
        (RuntimeError("unexpected worker wrapper failure"), None),
    ],
    ids=("preflight-exhausted", "infrastructure", "untyped"),
)
def test_terminal_pre_angle_failure_serializes_typed_job_disposition_without_points(
    tmp_path, monkeypatch, failure, expected_disposition
):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    request = PolarRequest(
        airfoil={
            "name": "typed-job-failure",
            "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]],
        },
        aoa=AoASpec(angles=[-5.0, 0.0, 5.0]),
    )
    job_id = f"job-{type(failure).__name__}"
    store.create(job_id, request)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "install_subprocess_signal_handlers", lambda: None)

    def fail_before_angle_fanout(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(tasks, "execute_job", fail_before_angle_fanout)

    with pytest.raises(type(failure), match=str(failure)):
        tasks.run_polar(job_id, request.model_dump_json())

    status = store.read_status(job_id)
    result = store.read_result(job_id)
    assert status is not None
    assert result is not None
    assert status.failure_disposition == expected_disposition
    assert result.failure_disposition == expected_disposition
    assert result.polars == []
    status_payload = json.loads((store.job_dir(job_id) / "status.json").read_text())
    result_payload = json.loads((store.job_dir(job_id) / "result.json").read_text())
    expected_wire_value = (
        expected_disposition.value if expected_disposition is not None else None
    )
    assert status_payload["failure_disposition"] == expected_wire_value
    assert result_payload["failure_disposition"] == expected_wire_value


def test_non_default_mesher_deterministic_failure_does_not_change_user_strategy(
    tmp_path, naca0012_selig_text, monkeypatch
):
    airfoil = _airfoil(naca0012_selig_text)
    actual = MeshParams(mesher="custom-public", first_cell_height_chords=0.01575)
    events: list[tuple[str, float | None]] = []
    mesher = CountingMesher("custom-public", events)
    monkeypatch.setattr(
        pipeline,
        "get_mesher",
        lambda _name: pytest.fail("custom mesher failure must not enter blockMesh recovery"),
    )

    with pytest.raises(DeterministicMeshError, match="custom deterministic failure"):
        pipeline.prepare_mesh_with_recovery(
            tmp_path / "mesh",
            airfoil,
            actual,
            0.05,
            mesher,
            NoopRunner(),
            validate=lambda _mesh, _actual: (_ for _ in ()).throw(
                DeterministicMeshError("custom deterministic failure")
            ),
        )

    assert events == [("custom-public", 0.01575)]


def test_cached_candidate_rejection_evicts_only_that_candidate(
    tmp_path, naca0012_selig_text
):
    airfoil = _airfoil(naca0012_selig_text)
    cache = _cache(tmp_path)
    first_name, other_name = pipeline.MESH_RECOVERY_MESHER_CANDIDATES[:2]
    first = CountingMesher(first_name)
    other = CountingMesher(other_name)
    first_params = MeshParams(mesher=first_name, first_cell_height_chords=0.006)
    other_params = MeshParams(mesher=other_name, first_cell_height_chords=0.006)

    pipeline.prepare_mesh(
        tmp_path / "first-source", airfoil, first_params, 0.05, first, NoopRunner(), cache=cache
    )
    pipeline.prepare_mesh(
        tmp_path / "other-source", airfoil, other_params, 0.05, other, NoopRunner(), cache=cache
    )
    first_key = EngineCache.mesh_key(airfoil, 0.05, first_params, mesher=first)
    other_key = EngineCache.mesh_key(airfoil, 0.05, other_params, mesher=other)

    with pytest.raises(DeterministicMeshError, match="cached candidate invalid"):
        pipeline.prepare_mesh(
            tmp_path / "first-consumer",
            airfoil,
            first_params,
            0.05,
            first,
            NoopRunner(),
            cache=cache,
            validate=lambda _mesh, _actual: (_ for _ in ()).throw(
                DeterministicMeshError("cached candidate invalid")
            ),
        )

    assert not (cache.mesh_root / first_key).exists()
    assert (cache.mesh_root / other_key / "manifest.json").is_file()


def test_public_mesher_registry_hides_internal_recovery_candidates():
    assert MeshParams().mesher == pipeline.MESH_RECOVERY_PUBLIC_MESHER
    assert pipeline.MESH_RECOVERY_PUBLIC_MESHER in list_meshers()
    for name in pipeline.MESH_RECOVERY_MESHER_CANDIDATES:
        assert name not in list_meshers()
        assert name in list_meshers(include_internal=True)


def test_verified_shared_mesh_skips_per_angle_checkmesh(tmp_path, monkeypatch):
    """A 26-angle fan-out must not execute the same mesh QA 26 times."""
    shared = tmp_path / "shared"
    shared.mkdir()
    pipeline.write_shared_mesh_qa_marker(
        shared,
        pipeline.MeshQaResult(max_non_ortho_deg=64.0),
    )
    calls: list[str] = []

    class FakeCaseBuilder:
        def __init__(self, *args, **kwargs):
            pass

        def write(self, case_dir):
            (Path(case_dir) / "0").mkdir(parents=True, exist_ok=True)

    class FakeRunner:
        def application(self, _case_dir, command, *args, **kwargs):
            calls.append(command)
            if command.startswith("checkMesh"):
                raise AssertionError("verified shared mesh must not be checked per angle")
            return SimpleNamespace(
                ok=True,
                stdout=f"{command} ok",
                check=lambda: SimpleNamespace(stdout=f"{command} ok"),
            )

        def solver(self, _case_dir, application, *args, **kwargs):
            calls.append(application)
            return SimpleNamespace(
                ok=True,
                stdout=f"{application} ok",
                check=lambda: SimpleNamespace(stdout=f"{application} ok"),
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *args, **kwargs: None)

    pipeline._prepare_transient_case(
        tmp_path / "angle",
        airfoil=SimpleNamespace(name="test", contour=[]),
        resolved=MeshParams(first_cell_height_chords=0.006),
        spec=CaseSpec(chord=0.05, speed=30.0, aoa_deg=10.0),
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True),
        runner=FakeRunner(),
        n_proc=1,
        timeout=60,
        shared_mesh_dir=shared,
    )

    assert not any(command.startswith("checkMesh") for command in calls)
