"""Run one source-pinned rhoCentralFoam subsonic diagnostic canary."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from airfoilfoam.models import PolarRequest
from airfoilfoam.provenance import application_source_sha256


EXPECTED_ANGLES = (-5.0, 0.0)
EXPECTED_SPEED = 166.0
EXPECTED_CHORD = 0.5
EXPECTED_ITERATIONS = 3000
EXPECTED_MAX_COURANT = 0.5
FORBIDDEN_TOKENS = ("material_domain", "hard_solver", "nonfinite")


def _call(base_url: str, token: str, path: str, payload: object | None = None, *, timeout: float = 30) -> dict:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (HTTPError, URLError) as error:
        body = error.read().decode("utf-8", "replace") if isinstance(error, HTTPError) else str(error)
        raise RuntimeError(f"engine request {path} failed: {body[:2000]}") from error


def _deployment(root: Path) -> dict:
    raw = subprocess.check_output(
        ["devcoordinator2", "deployment", "status", str(root), "--name", "progressive-test-engine", "--client", "codex"],
        text=True,
        timeout=30,
    )
    result = json.loads(raw)
    if not result.get("ok"):
        raise RuntimeError(f"temporary engine status failed: {result}")
    data = result["data"]
    if data.get("state") != "running" or not data.get("readiness", {}).get("ready"):
        raise RuntimeError(f"temporary engine is not ready: {data}")
    components = [item for item in data.get("components", []) if item.get("name") == "engine"]
    if len(components) != 1 or components[0].get("health") != "healthy":
        raise RuntimeError(f"temporary engine component is not healthy: {components}")
    port = components[0].get("port")
    if not isinstance(port, int):
        raise RuntimeError(f"temporary engine has no local port: {components}")
    return {"deployment": data, "base_url": f"http://127.0.0.1:{port}"}


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _point_summary(point: dict) -> dict:
    return {
        key: point.get(key)
        for key in (
            "aoa_deg", "cl", "cd", "cm", "cl_cd", "converged", "iterations",
            "failure_disposition", "error", "quality_warnings",
        )
    }


def _contains_forbidden_token(value: object) -> str | None:
    if isinstance(value, dict):
        for nested in value.values():
            found = _contains_forbidden_token(nested)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _contains_forbidden_token(nested)
            if found is not None:
                return found
    elif isinstance(value, str):
        lowered = value.lower()
        for token in FORBIDDEN_TOKENS:
            if token in lowered:
                return token
    return None


def _build_request(base_request: dict, engine: dict, execution_pool: str) -> PolarRequest:
    if base_request.get("aoa", {}).get("angles") != [-5, 0]:
        raise ValueError("the canary input must contain exactly the -5 and 0 degree angles")
    if base_request.get("speeds") != [166]:
        raise ValueError("the canary input must contain exactly 166 m/s")
    if base_request.get("chord_lengths") != [0.5]:
        raise ValueError("the canary input must contain exactly 0.5 m chord")
    gas = base_request.get("fluid", {}).get("gas", {})
    if gas.get("heat_capacity_model") != "nasa7":
        raise ValueError("the canary must preserve the NASA7 material model")

    payload = json.loads(json.dumps(base_request))
    payload["expected_engine"] = engine
    payload["expected_execution_pool"] = execution_pool
    payload["solver"] = {
        **payload["solver"],
        "flow_solver_family": "rhoCentralFoam",
        "force_transient": False,
        "compressible_density_subsonic": True,
        "compressible_farfield_boundary": "static_freestream",
        "momentum_scheme": "upwind",
        "transient_max_courant": EXPECTED_MAX_COURANT,
        "n_iterations": EXPECTED_ITERATIONS,
        "write_images": [],
        "frame_fields": [],
    }
    payload["resources"] = {
        **payload.get("resources", {}),
        "cpu_budget": 1,
        "case_concurrency": 1,
        "solver_processes": 1,
        "case_solver_budget_seconds": 1500,
    }
    request = PolarRequest.model_validate(payload)
    solver = request.solver
    if (
        solver.flow_solver_family != "rhoCentralFoam"
        or solver.force_transient
        or not solver.compressible_density_subsonic
        or solver.momentum_scheme != "upwind"
        or solver.transient_max_courant != EXPECTED_MAX_COURANT
        or solver.n_iterations < EXPECTED_ITERATIONS
    ):
        raise ValueError("the sealed request does not match the rhoCentralFoam diagnostic recipe")
    return request


def _classify_result(result: dict) -> dict:
    if result.get("state") != "completed":
        raise RuntimeError(f"canary job ended in state {result.get('state')!r}")
    forbidden = _contains_forbidden_token(result)
    if forbidden is not None:
        raise RuntimeError(f"result contains forbidden failure evidence: {forbidden}")
    polars = result.get("polars") or []
    if len(polars) != 1:
        raise RuntimeError(f"expected one physical polar, got {len(polars)}")
    polar = polars[0]
    points = [point for point in polar.get("points", []) if point.get("aoa_deg") in EXPECTED_ANGLES]
    attempts = [point for point in polar.get("attempts", []) if point.get("aoa_deg") in EXPECTED_ANGLES]
    if attempts:
        raise RuntimeError(f"rejected or partial attempts remain for requested angles: {len(attempts)}")
    if len(points) != len(EXPECTED_ANGLES):
        raise RuntimeError(f"expected two accepted points, got {len(points)}")
    accepted_angles = []
    for angle in EXPECTED_ANGLES:
        matching = [point for point in points if float(point.get("aoa_deg")) == angle]
        if len(matching) != 1:
            raise RuntimeError(f"expected exactly one accepted point at {angle:g} degrees")
        point = matching[0]
        if point.get("failure_disposition") not in (None, "none"):
            raise RuntimeError(f"point at {angle:g} degrees has failure disposition {point.get('failure_disposition')!r}")
        if point.get("error"):
            raise RuntimeError(f"point at {angle:g} degrees has an error")
        if point.get("converged") is not True:
            raise RuntimeError(f"point at {angle:g} degrees is not converged")
        if any(not _finite(point.get(name)) for name in ("cl", "cd", "cm")):
            raise RuntimeError(f"point at {angle:g} degrees has nonfinite coefficients")
        if float(point["cd"]) <= 0:
            raise RuntimeError(f"point at {angle:g} degrees has non-positive drag")
        accepted_angles.append(angle)
    return {
        "accepted_angles": accepted_angles,
        "point_summary": [_point_summary(point) for point in points],
        "attempt_count": len(attempts),
    }


def run(base_request_path: Path, output_path: Path, max_seconds: float) -> dict:
    if os.environ.get("AIRFOILFOAM_DIAGNOSTIC_FINITE_T_GUARD") != "1":
        raise RuntimeError("finite-positive-temperature guard is not enabled")
    root = Path(__file__).resolve().parents[2]
    base_request_bytes = base_request_path.read_bytes()
    base_request = json.loads(base_request_bytes)
    expected_source = application_source_sha256(root)
    deployment = _deployment(root)
    env = (root / ".codex-artifacts/progressive-engine.env").read_text(encoding="utf-8")
    token = next((line.split("=", 1)[1].strip() for line in env.splitlines() if line.startswith("ENGINE_CONTROL_PLANE_TOKEN=")), "")
    if len(token) != 64:
        raise ValueError("the private temporary engine token is missing")
    base_url = deployment["base_url"]
    health = _call(base_url, token, "/health")
    queue = _call(base_url, token, "/queue")
    workers = queue.get("worker_queues") or []
    if len(workers) != 1:
        raise RuntimeError(f"expected one temporary worker, got {len(workers)}")
    worker = workers[0]
    runtime_source = (worker.get("engine") or {}).get("application_source_sha256")
    if runtime_source != expected_source:
        raise RuntimeError(f"worker source mismatch: expected {expected_source}, got {runtime_source}")
    engine_identity = health.get("default_engine")
    execution_pool = worker.get("execution_pool")
    if not isinstance(engine_identity, dict) or not isinstance(execution_pool, str):
        raise RuntimeError("temporary worker did not report an exact engine identity and execution pool")
    request = _build_request(base_request, engine_identity, execution_pool)
    request_path = output_path.with_name("request.json")
    request_path.parent.mkdir(parents=True, exist_ok=True)
    request_path.write_text(json.dumps(request.model_dump(mode="json"), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    submitted = _call(base_url, token, "/polars", request.model_dump(mode="json"), timeout=60)
    job_id = submitted.get("job_id")
    if job_id != str(request.execution_id):
        raise RuntimeError(f"engine changed the exact execution identity: {job_id!r}")
    report: dict = {
        "kind": "rho-central-subsonic-two-angle-canary-v1",
        "base_request_path": str(base_request_path),
        "base_request_sha256": hashlib.sha256(base_request_bytes).hexdigest(),
        "request_path": str(request_path),
        "request_sha256": hashlib.sha256(request_path.read_bytes()).hexdigest(),
        "expected_application_source_sha256": expected_source,
        "runtime_application_source_sha256": runtime_source,
        "finite_positive_temperature_guard": True,
        "deployment_id": deployment["deployment"].get("deployment_id"),
        "deployment_generation": deployment["deployment"].get("generation"),
        "deployment_name": deployment["deployment"].get("name"),
        "port": deployment["deployment"]["components"][0].get("port"),
        "engine": engine_identity,
        "execution_pool": execution_pool,
        "job_id": job_id,
        "request": request.model_dump(mode="json"),
        "statuses": [],
        "state": "running",
        "passed": False,
        "production_evidence": False,
    }
    deadline = time.monotonic() + max_seconds
    terminal = {"completed", "failed", "cancelled"}
    try:
        while True:
            status = _call(base_url, token, f"/jobs/{job_id}")
            report["statuses"].append({key: status.get(key) for key in ("state", "phase", "message", "active_aoa_deg", "solver_active_seconds", "solver_budget_progress")})
            if status.get("state") in terminal:
                report["state"] = status.get("state")
                report["terminal_status"] = status
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"canary did not finish within {max_seconds} seconds")
            time.sleep(2)
        result = _call(base_url, token, f"/jobs/{job_id}/result", timeout=120)
        report["result"] = result
        report.update(_classify_result(result))
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            report["stop_proof"] = _call(base_url, token, f"/jobs/{job_id}/execution-stop-proof", {}, timeout=60)
        except Exception as error:
            report["stop_proof_error"] = f"{type(error).__name__}: {error}"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=float, default=1500)
    args = parser.parse_args()
    run(args.base_request, args.output, args.max_seconds)


if __name__ == "__main__":
    main()
