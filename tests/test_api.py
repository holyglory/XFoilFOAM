"""End-to-end API/job-lifecycle test using eager Celery and a mocked CFD runner."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam import jobs
from airfoilfoam.capabilities import URANS_RECOVERY_VERSION
from airfoilfoam.celery_app import celery_app
from airfoilfoam.api.main import app
from airfoilfoam.storage import JobStore
from airfoilfoam.pipeline import CaseOutcome
from airfoilfoam.models import (
    AirfoilInput,
    ContinuationFailureKind,
    JobResult,
    JobState,
    JobStatus,
    PolarRequest,
)


@pytest.fixture(autouse=True)
def eager_celery():
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    yield
    celery_app.conf.task_always_eager = False


@pytest.fixture
def fake_run_case(monkeypatch):
    """Replace meshing + the marched-polar solve with cheap analytic stand-ins."""
    import math
    from types import SimpleNamespace

    from airfoilfoam import physics
    from airfoilfoam.models import CaseSpec

    def fake_prepare_mesh(mesh_dir, airfoil, resolved, chord, mesher, runner, **_kwargs):
        mesh_dir.mkdir(parents=True, exist_ok=True)
        return SimpleNamespace(n_cells=1000, patches=[], span_chords=0.1), resolved, False

    def fake_run_case(case_dir, airfoil, spec, fluid, roughness, mesh_params, solver_params,
                      mesher, runner, n_proc=1, render_images=True, solver_timeout=7200,
                      mesh_dir=None, **_kwargs):
        cl = 2 * math.pi * math.radians(spec.aoa_deg)
        cd = 0.01 + 0.02 * cl**2
        images = {}
        if render_images and solver_params.write_images:
            img_dir = case_dir / "images"
            img_dir.mkdir(parents=True, exist_ok=True)
            for f in solver_params.write_images:
                (img_dir / f"{f.value}.png").write_bytes(b"\x89PNG\r\n\x1a\nFAKE")
                images[f.value] = f"images/{f.value}.png"
        return CaseOutcome(
            spec=spec, reynolds=physics.reynolds(spec.speed, spec.chord, fluid.nu),
            cl=cl, cd=cd, cm=-0.01, cl_cd=cl / cd, converged=True, iterations=300,
            final_residual=1e-6, y_plus_avg=0.8, y_plus_max=3.0, n_cells=1000, images=images,
        )

    monkeypatch.setattr(jobs, "prepare_mesh_with_recovery", fake_prepare_mesh)
    monkeypatch.setattr(jobs, "run_case", fake_run_case)
    return fake_run_case


@pytest.fixture
def client():
    return TestClient(app)


def test_health_and_capabilities(client):
    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["mesh_recovery_version"] == 2
    assert health["urans_recovery_version"] == URANS_RECOVERY_VERSION
    caps = client.get("/capabilities").json()
    assert "blockmesh-cgrid" in caps["meshers"]
    assert "kOmegaSST" in caps["turbulence_models"]
    assert "kOmegaSSTLM" in caps["turbulence_models"]  # transition model exposed


def test_parse_airfoil_endpoint(client, naca0012_selig_text):
    r = client.post("/airfoils/parse", json={"name": "n12", "coordinates": naca0012_selig_text})
    assert r.status_code == 200
    body = r.json()
    assert body["max_thickness_fraction"] == pytest.approx(0.12, abs=0.02)


def test_parse_airfoil_bad_geometry(client):
    r = client.post("/airfoils/parse", json={"name": "x", "coordinates": "garbage\n1 1\n"})
    assert r.status_code == 422


def test_full_polar_job(client, fake_run_case, naca0012_selig_text):
    request = {
        "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
        "chord_lengths": [1.0],
        "speeds": [50.0],
        "aoa": {"angles": [0, 5, 10]},
        "fluid": {"density": 1.225, "kinematic_viscosity": 1.5e-5},
        "solver": {"n_iterations": 100, "write_images": ["velocity_magnitude", "pressure"]},
    }
    r = client.post("/polars", json=request)
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    status = client.get(f"/jobs/{job_id}").json()
    assert status["state"] == "completed"
    assert status["total_cases"] == 3
    assert status["completed_cases"] == 3
    assert status["mesh_recovery_version"] == 2

    result = client.get(f"/jobs/{job_id}/result").json()
    assert result["state"] == "completed"
    assert result["mesh_recovery_version"] == 2
    assert len(result["polars"]) == 1
    polar = result["polars"][0]
    assert polar["reynolds"] == pytest.approx(50 * 1.0 / 1.5e-5)
    assert len(polar["points"]) == 3
    # lift increases with AoA in the analytic stand-in
    cls = [p["cl"] for p in polar["points"]]
    assert cls[0] < cls[1] < cls[2]

    # image is served
    img_url = polar["points"][1]["images"]["velocity_magnitude"]
    img = client.get(img_url)
    assert img.status_code == 200
    assert img.content.startswith(b"\x89PNG")

    # CSV export
    csv = client.get(f"/jobs/{job_id}/polar.csv")
    assert csv.status_code == 200
    assert "aoa_deg,cl,cd" in csv.text
    assert csv.text.count("\n") >= 4  # header + 3 rows


def test_polar_submit_rejects_capability_cutover_before_queueing(
    client, naca0012_selig_text
):
    response = client.post(
        "/polars",
        json={
            "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
            "aoa": {"angles": [0]},
            "expected_mesh_recovery_version": 3,
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail == {
        "code": "mesh_recovery_version_mismatch",
        "requested_version": 3,
        "actual_version": 2,
        "message": (
            "Engine mesh-recovery capability changed before submission: "
            "requested v3, API is v2. Refresh capability and retry."
        ),
    }


def test_worker_rejects_capability_mismatch_before_geometry_or_solver(tmp_path):
    request = PolarRequest.model_validate(
        {
            "airfoil": {"name": "bad-on-purpose", "coordinates": "not geometry"},
            "aoa": {"angles": [0]},
            "expected_mesh_recovery_version": 3,
        }
    )

    with pytest.raises(RuntimeError, match="requested v3, worker is v2"):
        jobs.execute_job(
            "capability-mismatch",
            request,
            store=JobStore(),
        )


def test_polar_submit_rejects_urans_recovery_cutover_before_queueing(
    client, naca0012_selig_text
):
    response = client.post(
        "/polars",
        json={
            "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
            "aoa": {"angles": [0]},
            "expected_urans_recovery_version": 1,
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail == {
        "code": "urans_recovery_version_mismatch",
        "requested_version": 1,
        "actual_version": URANS_RECOVERY_VERSION,
        "message": (
            "Engine URANS-recovery capability changed before submission: "
            "requested v1, API is v2. Refresh capability and retry."
        ),
    }


def test_worker_rejects_urans_recovery_mismatch_before_geometry_or_solver(tmp_path):
    request = PolarRequest.model_validate(
        {
            "airfoil": {"name": "bad-on-purpose", "coordinates": "not geometry"},
            "aoa": {"angles": [0]},
            "expected_urans_recovery_version": 1,
        }
    )

    with pytest.raises(RuntimeError, match="requested v1, worker is v2"):
        jobs.execute_job(
            "urans-recovery-capability-mismatch",
            request,
            store=JobStore(),
        )


def test_polar_submit_rejects_continuation_without_recovery_version_pin(
    client, naca0012_selig_text
):
    response = client.post(
        "/polars",
        json={
            "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
            "aoa": {"angles": [0]},
            "solver": {"force_transient": True},
            "continue_from": {
                "engine_job_id": "a" * 32,
                "case_slug": "c1_u10_a0",
            },
        },
    )

    assert response.status_code == 422
    assert "expected_urans_recovery_version" in response.text


def test_worker_rejects_unpinned_continuation_before_geometry_or_solver(
    naca0012_selig_text,
):
    valid = PolarRequest.model_validate(
        {
            "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
            "aoa": {"angles": [0]},
            "solver": {"force_transient": True},
            "continue_from": {
                "engine_job_id": "b" * 32,
                "case_slug": "c1_u10_a0",
            },
            "expected_urans_recovery_version": URANS_RECOVERY_VERSION,
        }
    )
    # Bypass model revalidation to prove the worker independently fails closed
    # before trying to parse deliberately invalid geometry.
    unsafe = valid.model_copy(
        update={
            "airfoil": AirfoilInput(
                name="bad-on-purpose",
                coordinates="not geometry",
            ),
            "expected_urans_recovery_version": None,
        }
    )

    with pytest.raises(
        RuntimeError,
        match="requires expected_urans_recovery_version",
    ):
        jobs.execute_job(
            "unpinned-continuation",
            unsafe,
            store=JobStore(),
        )


def test_api_queued_status_does_not_claim_worker_execution(tmp_path, naca0012_selig_text):
    from airfoilfoam.config import Settings

    store = JobStore(Settings(data_dir=tmp_path / "data"))
    request = PolarRequest.model_validate(
        {
            "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
            "aoa": {"angles": [0]},
            "expected_mesh_recovery_version": 2,
        }
    )
    store.create("queued-only", request)

    status = store.read_status("queued-only")
    assert status is not None
    assert status.state.value == "pending"
    assert status.mesh_recovery_version is None


def test_multi_speed_chord_produces_multiple_polars(client, fake_run_case, naca0012_selig_text):
    request = {
        "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
        "chord_lengths": [0.5, 1.0],
        "speeds": [20.0, 40.0],
        "aoa": {"start": 0, "stop": 4, "step": 2},
        "solver": {"write_images": []},
    }
    r = client.post("/polars", json=request)
    job_id = r.json()["job_id"]
    result = client.get(f"/jobs/{job_id}/result").json()
    assert len(result["polars"]) == 4  # 2 chords x 2 speeds
    for polar in result["polars"]:
        assert len(polar["points"]) == 3  # 0,2,4


def test_cold_case_parallel_publishes_result_before_completed_count(
    tmp_path, monkeypatch, fake_run_case, naca0012_selig_text
):
    """A finished cold case must publish evidence before advertising progress.

    The second case stays inside ``run_case`` until the first running partial is
    durably readable.  This proves both that cold case-parallel publication is
    per-future (not end-of-batch) and that ``completed_cases`` can never lead
    the result file consumed by the sweeper.
    """
    import threading

    from airfoilfoam.config import Settings
    from airfoilfoam.models import AoASpec, ResourceParams, SolverParams

    partial_written = threading.Event()
    slow_case_returned = threading.Event()
    count_observations: list[bool] = []
    partial_observations: list[bool] = []
    job_id = "cold-case-parallel-partial-order"

    def point_count(result: JobResult | None) -> int:
        if result is None:
            return 0
        return sum(len(polar.points) for polar in result.polars)

    class ObservingStore(JobStore):
        def write_status(self, status):
            if status.state is JobState.running and status.completed_cases == 1:
                visible = self.read_result(status.job_id)
                count_observations.append(
                    visible is not None
                    and visible.state is JobState.running
                    and point_count(visible) == 1
                )
            super().write_status(status)

        def write_result(self, result):
            super().write_result(result)
            if result.state is JobState.running and point_count(result) == 1:
                # Observe before waking the slow case: the partial was written
                # while its sibling future was still genuinely open.
                partial_observations.append(not slow_case_returned.is_set())
                partial_written.set()

    def controlled_run_case(
        case_dir,
        airfoil,
        spec,
        fluid,
        roughness,
        mesh_params,
        solver_params,
        mesher,
        runner,
        **_kwargs,
    ):
        if spec.aoa_deg == 1.0:
            assert partial_written.wait(timeout=5.0)
            slow_case_returned.set()
        return CaseOutcome(
            spec=spec,
            reynolds=100_000.0,
            cl=0.1 + spec.aoa_deg,
            cd=0.02,
            cm=0.0,
            cl_cd=(0.1 + spec.aoa_deg) / 0.02,
            converged=True,
        )

    monkeypatch.setattr(jobs, "run_case", controlled_run_case)
    settings = Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cpu_token_state_path=tmp_path / "cpu-tokens.json",
        worker_cpu_budget=2,
        case_concurrency=2,
        solver_processes=1,
    )
    store = ObservingStore(settings)
    request = PolarRequest(
        airfoil=AirfoilInput(
            name="naca0012",
            coordinates=naca0012_selig_text,
        ),
        aoa=AoASpec(angles=[0.0, 1.0]),
        solver=SolverParams(
            force_transient=True,
            warm_start=False,
            write_images=[],
        ),
        resources=ResourceParams(
            policy="case_parallel",
            cpu_budget=2,
            case_concurrency=2,
            solver_processes=1,
        ),
    )
    store.create(job_id, request)

    result = jobs.execute_job(
        job_id,
        request,
        store=store,
        settings=settings,
    )

    assert partial_observations == [True]
    # More than one status callback may legitimately persist the same
    # completed count while the sibling remains open; every such snapshot
    # must observe the already-published partial.
    assert count_observations
    assert all(count_observations)
    assert result.state is JobState.completed
    assert point_count(result) == 2


def test_cold_case_parallel_serializes_status_context_writes(
    tmp_path, monkeypatch, fake_run_case, naca0012_selig_text
):
    """Concurrent case callbacks must not tear the singular status snapshot.

    ``JobStatus`` intentionally keeps one representative active case for
    compatibility.  More than one cold future can report phase progress at the
    same instant, so mutation of the shared status context and its persisted
    snapshot must be serialized.  This fixture forces two callbacks to enter
    together and makes an overlapping store write deterministic.
    """
    import threading
    import time

    from airfoilfoam.config import Settings
    from airfoilfoam.models import AoASpec, JobPhase, ResourceParams, SolverParams

    callback_barrier = threading.Barrier(2)
    write_guard = threading.Lock()
    concurrent_writes = 0
    max_concurrent_writes = 0
    observed_pairs: list[tuple[str | None, float | None]] = []

    class ObservingStore(JobStore):
        def write_status(self, status):
            nonlocal concurrent_writes, max_concurrent_writes
            if (
                status.state is JobState.running
                and status.message == "parallel observability probe"
            ):
                with write_guard:
                    concurrent_writes += 1
                    max_concurrent_writes = max(max_concurrent_writes, concurrent_writes)
                # Keep the first writer inside the persistence boundary long
                # enough for its sibling to expose an absent status lock.
                time.sleep(0.05)
                observed_pairs.append((status.active_case_slug, status.active_aoa_deg))
                try:
                    return super().write_status(status)
                finally:
                    with write_guard:
                        concurrent_writes -= 1
            return super().write_status(status)

    def controlled_run_case(
        case_dir,
        airfoil,
        spec,
        fluid,
        roughness,
        mesh_params,
        solver_params,
        mesher,
        runner,
        **kwargs,
    ):
        callback_barrier.wait(timeout=5.0)
        kwargs["phase_progress"](
            JobPhase.solving_urans,
            spec.aoa_deg,
            spec.slug,
            "pimpleFoam",
            "parallel observability probe",
        )
        return CaseOutcome(
            spec=spec,
            reynolds=100_000.0,
            cl=0.1 + spec.aoa_deg,
            cd=0.02,
            cm=0.0,
            cl_cd=(0.1 + spec.aoa_deg) / 0.02,
            converged=True,
        )

    monkeypatch.setattr(jobs, "run_case", controlled_run_case)
    settings = Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        cpu_token_state_path=tmp_path / "cpu-tokens.json",
        worker_cpu_budget=2,
        case_concurrency=2,
        solver_processes=1,
    )
    store = ObservingStore(settings)
    request = PolarRequest(
        airfoil=AirfoilInput(name="naca0012", coordinates=naca0012_selig_text),
        aoa=AoASpec(angles=[-5.0, -4.0]),
        solver=SolverParams(force_transient=True, warm_start=False, write_images=[]),
        resources=ResourceParams(
            policy="case_parallel",
            cpu_budget=2,
            case_concurrency=2,
            solver_processes=1,
        ),
    )
    store.create("cold-parallel-status-lock", request)

    result = jobs.execute_job(
        "cold-parallel-status-lock",
        request,
        store=store,
        settings=settings,
    )

    expected = {(spec.slug, spec.aoa_deg) for spec in request.cases()}
    assert set(observed_pairs) == expected
    assert max_concurrent_writes == 1
    assert result.state is JobState.completed


def test_job_not_found(client):
    assert client.get("/jobs/doesnotexist").status_code == 404


def test_cancel_terminalizes_partial_result_without_discarding_polars():
    store = JobStore()
    job_id = "cancel-partial-result"
    store.job_dir(job_id).mkdir(parents=True, exist_ok=True)
    store.write_result(JobResult(job_id=job_id, state=JobState.running, polars=[]))

    changed = store.terminalize_cancelled_result(job_id, "worker lost")

    result = store.read_result(job_id)
    assert changed is True
    assert result is not None
    assert result.state is JobState.cancelled
    assert result.message == "worker lost"


def test_cancel_does_not_overwrite_terminal_result():
    store = JobStore()
    job_id = "cancel-completed-result"
    store.job_dir(job_id).mkdir(parents=True, exist_ok=True)
    store.write_result(JobResult(job_id=job_id, state=JobState.completed, polars=[]))

    assert store.terminalize_cancelled_result(job_id) is False
    assert store.read_result(job_id).state is JobState.completed


def test_runtime_endpoint_reports_unreadable_status(client):
    store = JobStore()
    job_id = "runtime-broken-status"
    job_dir = store.job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "status.json").write_text("")

    body = client.post("/jobs/runtime", json={"job_ids": [job_id]}).json()
    row = body["jobs"][0]
    assert row["job_id"] == job_id
    assert row["exists"] is True
    assert row["status_readable"] is False
    assert "empty JSON" in row["status_error"]
    assert row["has_result"] is False
    assert row["process_count"] == 0
    assert client.get(f"/jobs/{job_id}").status_code == 409


def test_runtime_endpoint_reports_typed_continuation_failure(client):
    store = JobStore()
    job_id = "runtime-continuation-permanent"
    store.job_dir(job_id).mkdir(parents=True, exist_ok=True)
    store.write_status(
        JobStatus(
            job_id=job_id,
            state=JobState.failed,
            message="continuation_source_permanent: archive checksum mismatch",
            continuation_failure_kind=ContinuationFailureKind.permanent,
        )
    )
    store.write_result(
        JobResult(
            job_id=job_id,
            state=JobState.failed,
            polars=[],
            message="continuation_source_permanent: archive checksum mismatch",
            continuation_failure_kind=ContinuationFailureKind.permanent,
        )
    )

    body = client.post("/jobs/runtime", json={"job_ids": [job_id]}).json()
    row = body["jobs"][0]
    assert row["status_failure_disposition"] is None
    assert row["status_continuation_failure_kind"] == "permanent"
    assert row["result_failure_disposition"] is None
    assert row["result_continuation_failure_kind"] == "permanent"


def test_file_traversal_blocked(client, fake_run_case, naca0012_selig_text):
    request = {
        "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
        "aoa": {"angles": [0]}, "solver": {"write_images": []},
    }
    job_id = client.post("/polars", json=request).json()["job_id"]
    r = client.get(f"/jobs/{job_id}/files/../../../etc/passwd")
    assert r.status_code in (400, 404)
