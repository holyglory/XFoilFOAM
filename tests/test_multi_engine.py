"""Multi-engine identity, OpenFOAM dialect, routing, and provenance contracts."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.api import main as api_main
from airfoilfoam.cache import MANIFEST_NAME, EngineCache
from airfoilfoam.case.builder import CaseBuilder
from airfoilfoam.celery_app import celery_app
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import (
    AirfoilFormat,
    CaseSpec,
    EngineIdentity,
    FluidProperties,
    JobState,
    JobStatus,
    MeshParams,
    PolarRequest,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.openfoam.dialects import (
    FOUNDATION_14,
    FOUNDATION_14_IDENTITY,
    OPENCFD_2406_IDENTITY,
    OPENCFD_2606,
    OPENCFD_2606_IDENTITY,
    UnsupportedEngineIdentity,
    get_openfoam_dialect,
    supported_openfoam_identities,
)
from airfoilfoam.openfoam.runner import EngineIdentityMismatch
from airfoilfoam.postprocess.forces import parse_force_coefficients
from airfoilfoam.postprocess.images import find_all_vtus
from airfoilfoam.provenance import application_source_sha256
from airfoilfoam.storage import JobStore
from airfoilfoam import pipeline, tasks


def _patches() -> list[BoundaryPatch]:
    return [
        BoundaryPatch("airfoil", "wall"),
        BoundaryPatch("inlet", "inlet"),
        BoundaryPatch("outlet", "outlet"),
        BoundaryPatch("frontAndBack", "empty"),
    ]


def _builder(tmp_path: Path, naca0012_selig_text: str, dialect):
    airfoil = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    builder = CaseBuilder(
        airfoil,
        _patches(),
        MeshParams(),
        CaseSpec(chord=1.0, speed=30.0, aoa_deg=4.0),
        FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        RoughnessParams(),
        SolverParams(n_iterations=100),
        dialect=dialect,
    )
    case = tmp_path / dialect.identity.distribution
    builder.write(case)
    return builder, case


def _request_payload(naca0012_selig_text: str) -> dict:
    return {
        "airfoil": {"name": "naca0012", "coordinates": naca0012_selig_text},
        "aoa": {"angles": [0]},
        "solver": {"write_images": []},
        "expected_engine": FOUNDATION_14_IDENTITY.model_dump(mode="json"),
        "expected_execution_pool": FOUNDATION_14.queue_name,
    }


def _words(text: str) -> str:
    return " ".join(text.split())


def test_engine_identity_cache_and_handshake_keys_are_separate():
    v1 = EngineIdentity(
        family="thesis_bl",
        distribution="community",
        version="0.1",
        numerics_revision="7",
        adapter_contract_version=1,
    )
    v2 = v1.model_copy(update={"adapter_contract_version": 2})

    assert v1.compatibility_key == v2.compatibility_key
    assert v1.handshake_key != v2.handshake_key
    assert v1.family == "thesis_bl"  # family slugs are not a closed enum


def test_runtime_provenance_normalizes_optional_values_and_hashes_adapter_sources():
    runtime = Settings(
        engine_source_revision=" ",
        engine_image_digest="",
        engine_package_sha256="  ",
        engine_binary_sha256="",
        engine_application_source_sha256=" ",
        engine_architecture=" ",
    ).engine_runtime_identity()

    assert runtime.source_revision is None
    assert runtime.image_digest is None
    assert runtime.application_source_sha256 == application_source_sha256(
        Path(__file__).resolve().parents[1]
    )
    assert runtime.package_sha256 is None
    assert runtime.binary_sha256 is None
    assert runtime.architecture is None


def test_runtime_provenance_rejects_label_only_and_malformed_digests():
    from pydantic import ValidationError

    from airfoilfoam.models import EngineRuntimeIdentity

    with pytest.raises(ValidationError, match="content fingerprint"):
        EngineRuntimeIdentity(build_id="label-only")
    with pytest.raises(ValidationError, match="image_digest"):
        EngineRuntimeIdentity(
            build_id="malformed-image",
            application_source_sha256="a" * 64,
            image_digest="sha256:not-a-digest",
        )


def test_worker_images_cannot_override_recorded_upstream_package_digests():
    """The value exported as package provenance must be measured, not a label.

    A caller-controlled build argument previously allowed an otherwise valid
    worker image to advertise any 64-character value as the OpenCFD package
    checksum.  Keep both engine images tied to hard-coded release artifacts and
    require the downloaded bytes to pass the recorded digest before use.
    """
    root = Path(__file__).resolve().parents[1]
    opencfd = (root / "docker" / "Dockerfile.worker").read_text()
    foundation = (root / "docker" / "Dockerfile.worker-foundation14").read_text()

    assert "ARG OPENFOAM2606_" not in opencfd
    assert "openfoam2606_2606.0~rc2-1_${package_arch}.deb" in opencfd
    assert 'echo "${package_sha}  /tmp/openfoam2606.deb" | sha256sum -c -' in opencfd
    assert 'cmp -s "${binary}" "/tmp/openfoam2606-root${binary}"' in opencfd
    assert "ARG OPENFOAM14_" not in foundation
    assert 'echo "${package_sha}  /tmp/openfoam14.deb" | sha256sum -c -' in foundation


def test_worker_compose_raises_nofile_limit_for_both_engine_pools():
    root = Path(__file__).resolve().parents[1]

    for compose_name in ("docker-compose.yml", "docker-compose.deploy.yml"):
        compose = (root / compose_name).read_text()
        for service in ("worker", "worker-foundation14"):
            service_match = re.search(
                rf"(?ms)^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)",
                compose,
            )
            assert service_match is not None, f"{service} missing from {compose_name}"
            assert re.search(
                r"(?m)^    ulimits:\n"
                r"      nofile:\n"
                r"        soft: 65536\n"
                r"        hard: 524288$",
                service_match.group("body"),
            ), f"{service} has no durable nofile limit in {compose_name}"


def test_foundation14_case_uses_foundation_dictionary_and_function_object_dialect(
    tmp_path, naca0012_selig_text
):
    builder, case = _builder(tmp_path, naca0012_selig_text, FOUNDATION_14)

    assert (case / "constant" / "physicalProperties").is_file()
    assert (case / "constant" / "momentumTransport").is_file()
    assert not (case / "constant" / "transportProperties").exists()
    assert not (case / "constant" / "turbulenceProperties").exists()
    physical = (case / "constant" / "physicalProperties").read_text()
    momentum = (case / "constant" / "momentumTransport").read_text()
    control = (case / "system" / "controlDict").read_text()
    assert "viscosityModel constant;" in _words(physical)
    assert "rho 1.225;" in _words(physical)
    assert "nu 1.5e-05;" in _words(physical)
    assert "model kOmegaSST;" in _words(momentum)
    assert "solver incompressibleFluid;" in _words(control)
    assert "application simpleFoam;" not in _words(control)
    assert 'libs ("libforces.so");' in _words(control)
    assert "timeInterval 1;" in _words(control)

    builder.write_transient(case, start_time=100.0, end_time=101.0, delta_t=1e-4)
    transient_control = (case / "system" / "controlDict").read_text()
    assert "solver incompressibleFluid;" in _words(transient_control)
    # A continued adaptive-time run can own a directory such as
    # ``601.0650259374383``.  decomposePar preserves that exact name; the
    # restarted solver must not round it to ``601.065`` and then look for a
    # non-existent processor field directory.
    assert "timePrecision 16;" in _words(transient_control)
    assert FOUNDATION_14.steady_solver_command == "foamRun -solver incompressibleFluid"
    assert FOUNDATION_14.transient_solver_command == "foamRun -solver incompressibleFluid"
    assert FOUNDATION_14.coefficient_filename == "forceCoeffs.dat"
    assert FOUNDATION_14.vtk_all_times_command == "foamToVTK -useTimeName"


@pytest.mark.parametrize("dialect", [OPENCFD_2606, FOUNDATION_14])
def test_transient_field_writes_never_reschedule_physical_timesteps(
    tmp_path, naca0012_selig_text, dialect
):
    """MUST-CATCH: output alignment must not inject Cl/Cd/Cm impulses.

    With ``adjustableRunTime``, densifying ``writeInterval`` to 24 field
    frames per measured period forced a very short step at every output
    boundary. The live OpenCFD 2606 trace jumped in all three coefficients at
    those boundaries. ``runTime`` preserves the Courant-owned physical march
    and writes the first completed state after each requested boundary.
    """
    builder, case = _builder(tmp_path, naca0012_selig_text, dialect)
    builder.write_transient(
        case,
        start_time=0.0,
        end_time=0.02,
        delta_t=1e-6,
        write_interval=2e-5,
        max_delta_t=2e-6,
    )

    transient_control = _words((case / "system" / "controlDict").read_text())
    assert "writeControl runTime;" in transient_control
    assert "writeControl adjustableRunTime;" not in transient_control
    assert "adjustTimeStep yes;" in transient_control


def test_opencfd_2606_case_uses_verified_opencfd_dictionary_and_command_dialect(
    tmp_path, naca0012_selig_text
):
    builder, case = _builder(tmp_path, naca0012_selig_text, OPENCFD_2606)
    control = (case / "system" / "controlDict").read_text()

    assert (case / "constant" / "transportProperties").is_file()
    assert (case / "constant" / "turbulenceProperties").is_file()
    assert not (case / "constant" / "physicalProperties").exists()
    assert "application simpleFoam;" in _words(control)
    assert "libs (forces);" in _words(control)
    assert "writeInterval 1;" in _words(control)
    assert OPENCFD_2606.steady_solver_command == "simpleFoam"
    assert OPENCFD_2606.coefficient_filename == "coefficient.dat"

    builder.write_transient(
        case,
        start_time=601.0650259374383,
        end_time=601.1650259374383,
        delta_t=1e-4,
    )
    transient_control = (case / "system" / "controlDict").read_text()
    assert "startFrom latestTime;" in _words(transient_control)
    assert "timeFormat general;" in _words(transient_control)
    assert "timePrecision 16;" in _words(transient_control)


def test_opencfd_2406_identity_is_historical_but_not_executable_or_routable():
    assert OPENCFD_2406_IDENTITY not in supported_openfoam_identities()
    with pytest.raises(UnsupportedEngineIdentity, match="unsupported solver identity"):
        get_openfoam_dialect(OPENCFD_2406_IDENTITY)
    assert get_openfoam_dialect().identity == OPENCFD_2606_IDENTITY
    assert Settings().engine_identity() == OPENCFD_2606_IDENTITY


def test_foundation_force_header_and_legacy_vtk_layout_are_read(tmp_path):
    coeff = tmp_path / "forceCoeffs.dat"
    coeff.write_text(
        "# Time Cm Cd Cl Cl(f) Cl(r)\n"
        "0 -0.01 0.02 0.30 0.15 0.15\n"
        "1 -0.02 0.04 0.50 0.25 0.25\n"
    )
    parsed = parse_force_coefficients(coeff, average_last=2)
    assert parsed.cl == pytest.approx(0.4)
    assert parsed.cd == pytest.approx(0.03)
    assert parsed.cm == pytest.approx(-0.015)

    vtk_dir = tmp_path / "VTK"
    vtk_dir.mkdir()
    legacy = vtk_dir / "case_0.5.vtk"
    legacy.write_text("# vtk DataFile Version 2.0\n")
    assert legacy in find_all_vtus(tmp_path)


def test_foundation_evidence_classifies_dictionaries_mesh_forces_and_yplus(tmp_path):
    case = tmp_path / "case"
    files = {
        "system/controlDict": "FoamFile {}\n",
        "constant/physicalProperties": "FoamFile {}\n",
        "constant/momentumTransport": "FoamFile {}\n",
        "constant/polyMesh/points": "0\n(\n)\n",
        "constant/polyMesh/boundary": "0\n(\n)\n",
        "postProcessing/forceCoeffs1/50/forceCoeffs.dat": "# Time Cm Cd Cl\n",
        "postProcessing/yPlus/50/yPlus.dat": "# Time patch min max average\n",
        "postProcessing/residuals/50/solverInfo.dat": "# residual history\n",
    }
    for relative, content in files.items():
        path = case / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    outcome = pipeline.CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=30.0, aoa_deg=4.0),
        reynolds=2_000_000.0,
        engine=Settings(
            engine_distribution="foundation",
            engine_version="14",
        ).engine_runtime_identity(),
    )
    pipeline._archive_case_evidence(case, case, outcome, requested_fields=[])

    manifest = json.loads(
        (case / "evidence" / "evidence_manifest.json").read_text()
    )
    manifest_roles = {
        entry["path"]: entry["role"] for entry in manifest["files"]
    }
    assert manifest_roles["openfoam/constant/physicalProperties"] == "dictionary"
    assert manifest_roles["openfoam/constant/momentumTransport"] == "dictionary"
    assert manifest_roles["openfoam/constant/polyMesh/points"] == "mesh"
    assert manifest_roles["openfoam/constant/polyMesh/boundary"] == "mesh"
    assert (
        manifest_roles[
            "openfoam/postProcessing/forceCoeffs1/50/forceCoeffs.dat"
        ]
        == "force_coefficients"
    )
    assert manifest_roles["openfoam/postProcessing/yPlus/50/yPlus.dat"] == "y_plus"
    assert (
        manifest_roles["openfoam/postProcessing/residuals/50/solverInfo.dat"]
        == "field_data"
    )

    artifacts = {artifact.path: artifact for artifact in outcome.evidence_artifacts}
    assert artifacts["evidence/openfoam/constant/physicalProperties"].kind == "dictionary"
    assert artifacts["evidence/openfoam/constant/physicalProperties"].role == "dictionary"
    assert artifacts["evidence/openfoam/constant/polyMesh/points"].kind == "mesh"
    assert artifacts["evidence/openfoam/constant/polyMesh/points"].role == "mesh"
    assert (
        artifacts[
            "evidence/openfoam/postProcessing/forceCoeffs1/50/forceCoeffs.dat"
        ].kind
        == "force_coefficients"
    )
    yplus = artifacts["evidence/openfoam/postProcessing/yPlus/50/yPlus.dat"]
    assert yplus.kind == "field_data"
    assert yplus.role == "y_plus"
    residuals = artifacts[
        "evidence/openfoam/postProcessing/residuals/50/solverInfo.dat"
    ]
    assert residuals.kind == "field_data"
    assert residuals.role == "field_data"


def test_foundation_cache_manifest_and_path_are_numerically_namespaced(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cache_max_gb=0.001,
        engine_distribution="foundation",
        engine_version="14",
        celery_queue=FOUNDATION_14.queue_name,
    )
    cache = EngineCache.from_settings(settings)
    polymesh = tmp_path / "source-polyMesh"
    polymesh.mkdir()
    (polymesh / "points").write_text("points")

    assert cache.publish_mesh("a" * 64, polymesh, n_cells=10)
    manifest = json.loads(
        (cache.mesh_root / ("a" * 64) / MANIFEST_NAME).read_text()
    )
    assert cache.root != settings.resolved_cache_dir()
    assert manifest["engine"] == FOUNDATION_14_IDENTITY.model_dump(mode="json")
    assert manifest["engineNamespace"] == FOUNDATION_14_IDENTITY.compatibility_key


def test_gateway_advertises_routing_keys_and_routes_foundation_submission(
    tmp_path, naca0012_selig_text, monkeypatch
):
    settings = Settings(
        data_dir=tmp_path / "data",
        enabled_engine_keys=(
            f"{OPENCFD_2606_IDENTITY.handshake_key},"
            f"{FOUNDATION_14_IDENTITY.handshake_key}"
        ),
    )
    calls: list[dict] = []

    class AsyncResult:
        id = "foundation-task"

    class FakeRunPolar:
        def apply_async(self, **kwargs):
            calls.append(kwargs)
            return AsyncResult()

    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "run_polar", FakeRunPolar())
    app = api_main.create_app()
    client = TestClient(app)

    capabilities = client.get("/capabilities").json()
    by_distribution = {
        item["engine"]["distribution"]: item for item in capabilities["engines"]
    }
    assert by_distribution["opencfd"]["routing_key"] == OPENCFD_2606.queue_name
    assert by_distribution["foundation"]["routing_key"] == FOUNDATION_14.queue_name

    response = client.post("/polars", json=_request_payload(naca0012_selig_text))
    assert response.status_code == 202
    assert calls[0]["queue"] == FOUNDATION_14.queue_name
    body = response.json()
    assert body["requested_engine"] == FOUNDATION_14_IDENTITY.model_dump(mode="json")
    assert body["requested_execution_pool"] == FOUNDATION_14.queue_name
    assert body["engine"] is None
    assert body["execution_pool"] is None


def test_gateway_rejects_stale_execution_pool_before_queueing(
    tmp_path, naca0012_selig_text, monkeypatch
):
    settings = Settings(
        data_dir=tmp_path / "data",
        enabled_engine_keys=FOUNDATION_14_IDENTITY.handshake_key,
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    app = api_main.create_app()
    payload = _request_payload(naca0012_selig_text)
    payload["expected_execution_pool"] = "celery"

    response = TestClient(app).post("/polars", json=payload)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "execution_pool_mismatch"
    assert list((tmp_path / "data" / "jobs").glob("*")) == []


def test_queue_reports_all_registered_routes_and_live_worker_consumers(
    tmp_path, monkeypatch
):
    import redis as redis_module

    settings = Settings(
        data_dir=tmp_path / "data",
        enabled_engine_keys=OPENCFD_2606_IDENTITY.handshake_key,
    )

    class FakeRedis:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            return cls()

        def llen(self, queue):
            return {OPENCFD_2606.queue_name: 2, FOUNDATION_14.queue_name: 5}[queue]

    class FakeInspect:
        def active(self):
            return {"worker@opencfd": [], "worker@foundation": []}

        def reserved(self):
            return {"worker@opencfd": [], "worker@foundation": []}

        def scheduled(self):
            return {"worker@opencfd": [], "worker@foundation": []}

        def active_queues(self):
            return {
                "worker@opencfd": [{"name": OPENCFD_2606.queue_name}],
                "worker@foundation": [{"name": FOUNDATION_14.queue_name}],
            }

        def conf(self):
            return {
                "worker@opencfd": {
                    "airfoilfoam_worker_runtime": {
                        "execution_pool": OPENCFD_2606.queue_name,
                        "engine": settings.engine_runtime_identity()
                        .model_copy(
                            update={
                                "distribution": "opencfd",
                                "version": "2606",
                            }
                        )
                        .model_dump(mode="json"),
                    }
                },
                "worker@foundation": {
                    "airfoilfoam_worker_runtime": {
                        "execution_pool": FOUNDATION_14.queue_name,
                        "engine": settings.engine_runtime_identity()
                        .model_copy(
                            update={
                                "distribution": "foundation",
                                "version": "14",
                            }
                        )
                        .model_dump(mode="json"),
                    }
                },
            }

    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(redis_module, "Redis", FakeRedis)
    monkeypatch.setattr(
        celery_app.control,
        "inspect",
        lambda timeout=None: FakeInspect(),
    )

    body = TestClient(api_main.create_app()).get("/queue").json()

    assert body["queue_depths"] == {
        OPENCFD_2606.queue_name: 2,
        FOUNDATION_14.queue_name: 5,
    }
    assert body["queue_depth"] == 7
    assert body["default_queue_depth"] == 2
    assert body["queue_enabled"] == {
        OPENCFD_2606.queue_name: True,
        FOUNDATION_14.queue_name: False,
    }
    assert body["worker_queues"] == [
        {
            "worker": "worker@foundation",
            "queues": [FOUNDATION_14.queue_name],
            "execution_pool": FOUNDATION_14.queue_name,
            "engine": {
                **FOUNDATION_14_IDENTITY.model_dump(mode="json"),
                "build_id": "dev",
                "source_revision": None,
                "image_digest": None,
                "application_source_sha256": settings.engine_runtime_identity().application_source_sha256,
                "package_sha256": None,
                "binary_sha256": None,
                "architecture": settings.engine_runtime_identity().architecture,
            },
        },
        {
            "worker": "worker@opencfd",
            "queues": [OPENCFD_2606.queue_name],
            "execution_pool": OPENCFD_2606.queue_name,
            "engine": settings.engine_runtime_identity().model_dump(mode="json"),
        },
    ]
    assert body["worker_queues_error"] is None
    assert body["worker_runtime_error"] is None
    assert body["inspection_errors"] == {}
    assert body["inspection_workers"] == {
        "active": ["worker@foundation", "worker@opencfd"],
        "reserved": ["worker@foundation", "worker@opencfd"],
        "scheduled": ["worker@foundation", "worker@opencfd"],
    }


def test_queue_caches_runtime_inspection_until_worker_queue_binding_changes(
    tmp_path, monkeypatch
):
    import redis as redis_module

    settings = Settings(data_dir=tmp_path / "data")

    class FakeRedis:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            return cls()

        def llen(self, _queue):
            return 0

    class FakeInspect:
        queue_name = OPENCFD_2606.queue_name
        conf_calls = 0

        def active(self):
            return {"worker@engine": []}

        def reserved(self):
            return {"worker@engine": []}

        def scheduled(self):
            return {"worker@engine": []}

        def active_queues(self):
            return {"worker@engine": [{"name": self.queue_name}]}

        def conf(self):
            self.conf_calls += 1
            return {
                "worker@engine": {
                    "airfoilfoam_worker_runtime": {
                        "execution_pool": self.queue_name,
                        "engine": settings.engine_runtime_identity().model_dump(mode="json"),
                    }
                }
            }

    inspect = FakeInspect()
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(redis_module, "Redis", FakeRedis)
    monkeypatch.setattr(
        celery_app.control,
        "inspect",
        lambda timeout=None: inspect,
    )
    client = TestClient(api_main.create_app())

    first = client.get("/queue").json()
    second = client.get("/queue").json()

    assert first["worker_runtime_error"] is None
    assert second["worker_runtime_error"] is None
    assert inspect.conf_calls == 1
    assert second["worker_queues"][0]["execution_pool"] == OPENCFD_2606.queue_name

    inspect.queue_name = FOUNDATION_14.queue_name
    changed = client.get("/queue").json()

    assert changed["worker_runtime_error"] is None
    assert inspect.conf_calls == 2
    assert changed["worker_queues"][0]["execution_pool"] == FOUNDATION_14.queue_name


def test_queue_reports_incomplete_task_and_runtime_worker_coverage(
    tmp_path, monkeypatch
):
    import redis as redis_module

    settings = Settings(data_dir=tmp_path / "data")

    class FakeRedis:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            return cls()

        def llen(self, _queue):
            return 0

    class FakeInspect:
        def active(self):
            return {"worker@opencfd": []}

        def reserved(self):
            return {"worker@opencfd": [], "worker@foundation": []}

        def scheduled(self):
            return {"worker@opencfd": [], "worker@foundation": []}

        def active_queues(self):
            return {
                "worker@opencfd": [{"name": OPENCFD_2606.queue_name}],
                "worker@foundation": [{"name": FOUNDATION_14.queue_name}],
            }

        def conf(self):
            return {"worker@opencfd": {}}

    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(redis_module, "Redis", FakeRedis)
    monkeypatch.setattr(
        celery_app.control,
        "inspect",
        lambda timeout=None: FakeInspect(),
    )

    body = TestClient(api_main.create_app()).get("/queue").json()

    assert "worker coverage is incomplete" in body["inspection_errors"]["active"]
    assert "worker-runtime coverage is incomplete" in body["worker_runtime_error"]
    assert body["inspection_workers"]["active"] == ["worker@opencfd"]


def test_queue_reports_unknown_worker_consumers_when_inspector_unavailable(
    tmp_path, monkeypatch
):
    import redis as redis_module

    settings = Settings(data_dir=tmp_path / "data")

    class FakeRedis:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            return cls()

        def llen(self, _queue):
            return 0

    class FakeInspect:
        def active(self):
            return {}

        def reserved(self):
            return {}

        def scheduled(self):
            return {}

        def active_queues(self):
            raise ConnectionError("inspect unavailable")

        def conf(self):
            raise AssertionError("conf is not inspected without active queues")

    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(redis_module, "Redis", FakeRedis)
    monkeypatch.setattr(
        celery_app.control,
        "inspect",
        lambda timeout=None: FakeInspect(),
    )

    body = TestClient(api_main.create_app()).get("/queue").json()

    assert body["worker_queues"] is None
    assert "inspect unavailable" in body["worker_queues_error"]
    assert set(body["queue_depths"]) == {
        OPENCFD_2606.queue_name,
        FOUNDATION_14.queue_name,
    }


def test_worker_rejects_wrong_configured_pool_as_infrastructure_before_geometry(tmp_path):
    request = PolarRequest.model_validate(
        {
            "airfoil": {"name": "invalid", "coordinates": "not geometry"},
            "aoa": {"angles": [0]},
            "expected_engine": FOUNDATION_14_IDENTITY.model_dump(mode="json"),
            "expected_execution_pool": FOUNDATION_14.queue_name,
        }
    )
    settings = Settings(
        data_dir=tmp_path / "data",
        engine_distribution="foundation",
        engine_version="14",
        celery_queue="celery",
    )

    with pytest.raises(EngineIdentityMismatch, match="execution_pool_mismatch"):
        execute_job("wrong-pool", request, store=JobStore(settings), settings=settings)


def test_cancel_routes_every_reaper_to_the_job_engine_pool(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    store.write_status(
        JobStatus(
            job_id="foundation-running",
            state=JobState.running,
            requested_engine=FOUNDATION_14_IDENTITY,
            requested_execution_pool=FOUNDATION_14.queue_name,
        )
    )
    calls: list[dict] = []

    class ReaperResult:
        def get(self, **_kwargs):
            return {"terminated": []}

    class FakeReaper:
        def apply_async(self, **kwargs):
            calls.append(kwargs)
            return ReaperResult()

    revoked: list[tuple] = []
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "kill_job_processes", FakeReaper())
    monkeypatch.setattr(
        celery_app.control,
        "revoke",
        lambda *args, **kwargs: revoked.append((args, kwargs)),
    )
    client = TestClient(api_main.create_app())

    response = client.post("/jobs/foundation-running/cancel")

    assert response.status_code == 200
    assert len(calls) == 3
    assert {call["queue"] for call in calls} == {FOUNDATION_14.queue_name}
    assert revoked and revoked[0][0] == ("foundation-running",)
