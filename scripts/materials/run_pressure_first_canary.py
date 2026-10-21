"""Run the bounded pressure-first rhoSimpleFoam canary against the local engine."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from airfoilfoam.models import PolarRequest
from airfoilfoam.provenance import application_source_sha256


def call(base_url: str, token: str, path: str, payload: object | None = None, *, timeout: float = 30) -> dict:
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


def deployment(root: Path) -> dict:
    raw = subprocess.check_output(
        ["devcoordinator2", "deployment", "status", str(root), "--name", "progressive-engine", "--client", "codex"],
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


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def point_summary(point: dict) -> dict:
    return {key: point.get(key) for key in (
        "aoa_deg", "case_slug", "cl", "cd", "cm", "cl_cd", "converged", "failure_disposition", "error", "quality_warnings"
    )}


def run(request_path: Path, output_path: Path, max_seconds: float) -> dict:
    root = Path(__file__).resolve().parents[2]
    candidate = json.loads(request_path.read_text(encoding="utf-8"))
    if candidate.get("aoa", {}).get("angles") != [-5, 0]:
        raise ValueError("the canary must contain exactly the -5 and 0 degree angles")
    if candidate.get("solver", {}).get("compressible_pressure_energy_order") != "pressure_first":
        raise ValueError("the canary must select the pressure-first solver order")
    if candidate.get("solver", {}).get("compressible_farfield_boundary") != "static_freestream":
        raise ValueError("the canary must retain the standard static freestream boundary")
    expected_source = application_source_sha256(root)
    runtime = deployment(root)
    env = (root / ".codex-artifacts/progressive-engine.env").read_text(encoding="utf-8")
    token = next((line.split("=", 1)[1].strip() for line in env.splitlines() if line.startswith("ENGINE_CONTROL_PLANE_TOKEN=")), "")
    if len(token) != 64:
        raise ValueError("the private temporary engine token is missing")
    base_url = runtime["base_url"]
    health = call(base_url, token, "/health")
    queue = call(base_url, token, "/queue")
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
    candidate["expected_engine"] = engine_identity
    candidate["expected_execution_pool"] = execution_pool
    request = PolarRequest.model_validate(candidate)
    submitted = call(base_url, token, "/polars", request.model_dump(mode="json"), timeout=60)
    job_id = submitted.get("job_id")
    if job_id != str(request.execution_id):
        raise RuntimeError(f"engine changed the exact execution identity: {job_id!r}")
    report: dict = {
        "kind": "pressure-first-two-angle-canary-v1",
        "request_path": str(request_path),
        "request_sha256": hashlib.sha256(request_path.read_bytes()).hexdigest(),
        "expected_application_source_sha256": expected_source,
        "runtime_application_source_sha256": runtime_source,
        "deployment_id": runtime["deployment"].get("deployment_id"),
        "deployment_name": runtime["deployment"].get("name"),
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
    try:
        while True:
            status = call(base_url, token, f"/jobs/{job_id}")
            report["statuses"].append({key: status.get(key) for key in ("state", "phase", "message", "solver_active_seconds", "solver_budget_progress")})
            if status.get("state") in {"completed", "failed", "cancelled"}:
                report["state"] = status.get("state")
                report["terminal_status"] = status
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"canary did not finish within {max_seconds} seconds")
            time.sleep(2)
        result = call(base_url, token, f"/jobs/{job_id}/result", timeout=120)
        report["result"] = result
        points = [point for polar in result.get("polars", []) for point in polar.get("points", [])]
        attempts = [point for polar in result.get("polars", []) for point in polar.get("attempts", [])]
        report["point_summary"] = [point_summary(point) for point in points + attempts]
        accepted = []
        for angle in (-5.0, 0.0):
            point = next((item for item in points if float(item.get("aoa_deg")) == angle), None)
            if point is None or any(not finite(point.get(key)) for key in ("cl", "cd", "cm")):
                continue
            if point.get("failure_disposition") not in (None, "") or point.get("error"):
                continue
            if any(float(item.get("aoa_deg")) == angle and item.get("failure_disposition") is not None for item in attempts if item.get("aoa_deg") is not None):
                continue
            accepted.append(angle)
        report["accepted_angles"] = accepted
        report["passed"] = report["state"] == "completed" and accepted == [-5.0, 0.0]
        if not report["passed"]:
            raise RuntimeError("canary did not produce two accepted finite in-domain points")
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            report["stop_proof"] = call(base_url, token, f"/jobs/{job_id}/execution-stop-proof", {}, timeout=60)
        except Exception as error:
            report["stop_proof_error"] = f"{type(error).__name__}: {error}"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=float, default=1800)
    arguments = parser.parse_args()
    run(arguments.request, arguments.output, arguments.max_seconds)


if __name__ == "__main__":
    main()
