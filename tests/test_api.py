"""End-to-end API/job-lifecycle test using eager Celery and a mocked CFD runner."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam import jobs
from airfoilfoam.celery_app import celery_app
from airfoilfoam.api.main import app
from airfoilfoam.pipeline import CaseOutcome


@pytest.fixture(autouse=True)
def eager_celery():
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    yield
    celery_app.conf.task_always_eager = False


@pytest.fixture
def fake_run_case(monkeypatch):
    """Replace the OpenFOAM pipeline with a cheap analytic stand-in that writes images."""

    def _fake(case_dir: Path, airfoil, spec, fluid, roughness, mesh_params, solver_params,
              mesher, runner, n_proc=1, render_images=True, solver_timeout=7200):
        import math
        from airfoilfoam import physics

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

    monkeypatch.setattr(jobs, "run_case", _fake)
    return _fake


@pytest.fixture
def client():
    return TestClient(app)


def test_health_and_capabilities(client):
    assert client.get("/health").json()["status"] == "ok"
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

    result = client.get(f"/jobs/{job_id}/result").json()
    assert result["state"] == "completed"
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


def test_job_not_found(client):
    assert client.get("/jobs/doesnotexist").status_code == 404


def test_file_traversal_blocked(client, fake_run_case, naca0012_selig_text):
    request = {
        "airfoil": {"name": "n12", "coordinates": naca0012_selig_text},
        "aoa": {"angles": [0]}, "solver": {"write_images": []},
    }
    job_id = client.post("/polars", json=request).json()["job_id"]
    r = client.get(f"/jobs/{job_id}/files/../../../etc/passwd")
    assert r.status_code in (400, 404)
