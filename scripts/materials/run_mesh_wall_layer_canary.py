"""Run one source-bound mesh wall-layer canary against the local Coordinator engine."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from airfoilfoam.models import PolarRequest
from airfoilfoam.physics import first_cell_height_for_yplus
from airfoilfoam.provenance import application_source_sha256


EXPECTED_SPEED = 166.0
EXPECTED_CHORD = 0.5
EXPECTED_AOAS = [-5.0, 0.0]
BASELINE_TARGET_Y_PLUS = 1.0
CANDIDATE_TARGET_Y_PLUS = 40.0
BASELINE_MAX_ASPECT_RATIO = 10_594.0
EXPECTED_CELLS = 27_428


def _json_call(
    base_url: str,
    token: str,
    path: str,
    payload: object | None = None,
    *,
    timeout: float = 30,
) -> dict:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except (HTTPError, URLError) as error:
        body = error.read().decode("utf-8", "replace") if isinstance(error, HTTPError) else str(error)
        raise RuntimeError(f"engine request {path} failed: {body[:2000]}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"engine request {path} returned a non-object response")
    return value


def _raw_call(base_url: str, token: str, path: str, *, timeout: float = 60) -> bytes:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.read()
    except (HTTPError, URLError) as error:
        body = error.read().decode("utf-8", "replace") if isinstance(error, HTTPError) else str(error)
        raise RuntimeError(f"engine artifact request {path} failed: {body[:2000]}") from error


def _temporary_engine(root: Path) -> dict:
    raw = subprocess.check_output(
        [
            "devcoordinator2",
            "deployment",
            "status",
            str(root),
            "--name",
            "progressive-engine",
            "--client",
            "codex",
            "--format",
            "json",
        ],
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


def _load_request(path: Path) -> tuple[dict, dict]:
    wrapper = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(wrapper, dict) or not isinstance(wrapper.get("engineRequest"), dict):
        raise ValueError("the retained production request must contain engineRequest")
    original = copy.deepcopy(wrapper["engineRequest"])
    candidate = copy.deepcopy(original)
    if candidate.get("chord_lengths") != [EXPECTED_CHORD] or candidate.get("speeds") != [EXPECTED_SPEED]:
        raise ValueError("the canary must use the retained 0.5 m / 166 m/s physical case")
    if not set(EXPECTED_AOAS).issubset({float(value) for value in candidate.get("aoa", {}).get("angles", [])}):
        raise ValueError("the retained production request does not contain both -5 and 0 degrees")
    candidate["aoa"] = {"angles": EXPECTED_AOAS}
    solver = candidate.get("solver", {})
    if {
        solver.get("flow_solver_family"),
        solver.get("force_transient"),
        solver.get("transient_fallback"),
        solver.get("momentum_scheme"),
        solver.get("n_iterations"),
    } != {"rhoSimpleFoam", False, "linearUpwind", 3000}:
        raise ValueError("the canary solver recipe differs from the retained rhoSimpleFoam recipe")
    gas = candidate.get("fluid", {}).get("gas", {})
    nasa7 = gas.get("nasa7", {})
    if gas.get("heat_capacity_model") != "nasa7" or nasa7.get("minimum_temperature_k") != 100 or nasa7.get("maximum_temperature_k") != 2000:
        raise ValueError("the canary must retain the NASA7 material bounds")
    mesh = candidate.get("mesh", {})
    if mesh.get("target_y_plus") != BASELINE_TARGET_Y_PLUS or mesh.get("first_cell_height_chords") not in (None,):
        raise ValueError("the retained request does not have the expected y+1 mesh profile")
    for field, expected in {
        "mesher": "blockmesh-cgrid",
        "n_surface": 130,
        "n_radial": 80,
        "n_wake": 60,
        "farfield_radius_chords": 15,
        "wake_length_chords": 12,
        "span_chords": 0.1,
    }.items():
        if mesh.get(field) != expected:
            raise ValueError(f"retained mesh field {field} changed")
    mesh["target_y_plus"] = CANDIDATE_TARGET_Y_PLUS
    mesh["first_cell_height_chords"] = None
    return original, candidate


def _assert_candidate_request(request: PolarRequest, original: dict) -> float:
    if request.chord_lengths != [EXPECTED_CHORD] or request.speeds != [EXPECTED_SPEED]:
        raise ValueError("candidate changed the physical case")
    if request.aoa.expand() != EXPECTED_AOAS:
        raise ValueError("candidate did not restrict the canary to -5 and 0 degrees")
    if request.solver.flow_solver_family != "rhoSimpleFoam" or request.solver.force_transient or request.solver.transient_fallback:
        raise ValueError("candidate changed the rhoSimpleFoam numerical recipe")
    if request.solver.momentum_scheme != "linearUpwind" or request.solver.n_iterations != 3000:
        raise ValueError("candidate changed the solver discretization or iteration budget")
    if request.solver.compressible_startup != "potential" or request.solver.compressible_farfield_boundary != "static_freestream" or request.solver.compressible_pressure_energy_order != "standard":
        raise ValueError("candidate enabled a numerical diagnostic outside the mesh hypothesis")
    if request.mesh.target_y_plus != CANDIDATE_TARGET_Y_PLUS or request.mesh.first_cell_height_chords is not None:
        raise ValueError("candidate did not use only the bounded y+40 mesh change")
    if request.fluid.gas is None or request.fluid.gas.heat_capacity_model != "nasa7":
        raise ValueError("candidate lost the NASA7 gas model")
    if request.fluid.gas.nasa7.minimum_temperature_k != 100 or request.fluid.gas.nasa7.maximum_temperature_k != 2000:
        raise ValueError("candidate changed the NASA7 bounds")
    if original.get("solver", {}).get("flow_solver_family") != request.solver.flow_solver_family:
        raise ValueError("candidate solver family differs from the retained request")
    return first_cell_height_for_yplus(CANDIDATE_TARGET_Y_PLUS, EXPECTED_SPEED, EXPECTED_CHORD, request.fluid.nu) / EXPECTED_CHORD


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def _point_summary(point: dict) -> dict:
    return {
        key: point.get(key)
        for key in (
            "aoa_deg",
            "case_slug",
            "cl",
            "cd",
            "cm",
            "cl_cd",
            "converged",
            "failure_disposition",
            "error",
            "n_cells",
            "quality_warnings",
        )
    }


def _mesh_evidence(base_url: str, token: str, point: dict) -> dict:
    artifacts = point.get("evidence_artifacts") or []
    manifest_record = next(
        (item for item in artifacts if item.get("kind") == "mesh_evidence" and str(item.get("path", "")).endswith("/manifest.json")),
        None,
    )
    log_record = next(
        (item for item in artifacts if item.get("kind") == "mesh_evidence" and str(item.get("path", "")).endswith("logs/log.checkMesh")),
        None,
    )
    if not manifest_record or not manifest_record.get("url"):
        raise RuntimeError("accepted point did not expose the immutable mesh evidence manifest")
    manifest = json.loads(_raw_call(base_url, token, manifest_record["url"]).decode("utf-8"))
    if not isinstance(manifest, dict) or manifest.get("status") != "verified":
        raise RuntimeError("mesh evidence manifest is not verified")
    actual = manifest.get("actualMesh") or {}
    params = actual.get("params") or {}
    qa = manifest.get("qaVerdict") or {}
    check_mesh_log = ""
    if log_record and log_record.get("url"):
        check_mesh_log = _raw_call(base_url, token, log_record["url"]).decode("utf-8", "replace")
    aspect_values = [
        float(match.group(1))
        for match in re.finditer(r"Max aspect ratio\s*(?:=|:)\s*([0-9.+\-eE]+)", check_mesh_log, re.IGNORECASE)
    ]
    max_aspect = aspect_values[-1] if aspect_values else qa.get("maxAspectRatio")
    return {
        "manifest": manifest,
        "actual_mesh": actual,
        "qa": qa,
        "max_aspect_ratio": max_aspect,
        "check_mesh_log_present": bool(check_mesh_log),
    }


def run(request_path: Path, output_path: Path, max_seconds: float) -> dict:
    root = Path(__file__).resolve().parents[2]
    original, candidate = _load_request(request_path)
    expected_source = application_source_sha256(root)
    temporary = _temporary_engine(root)
    base_url = temporary["base_url"]
    env_path = root / ".codex-artifacts/progressive-engine.env"
    token = next(
        (line.split("=", 1)[1].strip() for line in env_path.read_text(encoding="utf-8").splitlines() if line.startswith("ENGINE_CONTROL_PLANE_TOKEN=")),
        "",
    )
    if len(token) != 64:
        raise ValueError("the private temporary engine token is missing")
    health = _json_call(base_url, token, "/health")
    queue = _json_call(base_url, token, "/queue")
    workers = queue.get("worker_queues") or []
    if len(workers) != 1:
        raise RuntimeError(f"expected one temporary worker, got {len(workers)}")
    worker = workers[0]
    runtime = worker.get("engine") or {}
    if runtime.get("application_source_sha256") != expected_source:
        raise RuntimeError(
            f"worker source mismatch: expected {expected_source}, got {runtime.get('application_source_sha256')}"
        )
    engine_identity = health.get("default_engine")
    execution_pool = worker.get("execution_pool")
    if not isinstance(engine_identity, dict) or not isinstance(execution_pool, str):
        raise RuntimeError("temporary worker did not report an exact engine identity and execution pool")
    candidate["expected_engine"] = engine_identity
    candidate["expected_execution_pool"] = execution_pool
    request = PolarRequest.model_validate(candidate)
    expected_first_cell = _assert_candidate_request(request, original)
    submitted = _json_call(base_url, token, "/polars", request.model_dump(mode="json"), timeout=60)
    job_id = submitted.get("job_id")
    if job_id != str(request.execution_id):
        raise RuntimeError(f"engine changed the exact execution identity: {job_id!r}")
    report: dict = {
        "kind": "subsonic-mesh-wall-layer-two-angle-canary-v1",
        "production_write": False,
        "request_path": str(request_path),
        "source_request_sha256": hashlib.sha256(json.dumps(original, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "candidate_request_sha256": hashlib.sha256(request_path.read_bytes()).hexdigest(),
        "expected_application_source_sha256": expected_source,
        "runtime_application_source_sha256": runtime.get("application_source_sha256"),
        "deployment_id": temporary["deployment"].get("deployment_id"),
        "deployment_name": temporary["deployment"].get("name"),
        "engine": engine_identity,
        "execution_pool": execution_pool,
        "hypothesis": {
            "baseline_target_y_plus": BASELINE_TARGET_Y_PLUS,
            "candidate_target_y_plus": CANDIDATE_TARGET_Y_PLUS,
            "baseline_max_aspect_ratio": BASELINE_MAX_ASPECT_RATIO,
            "expected_first_cell_height_chords": expected_first_cell,
            "unchanged_solver_recipe": True,
            "unchanged_nasa7_bounds": True,
        },
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
            status = _json_call(base_url, token, f"/jobs/{job_id}")
            report["statuses"].append(
                {key: status.get(key) for key in ("state", "phase", "message", "solver_active_seconds", "solver_budget_progress")}
            )
            if status.get("state") in {"completed", "failed", "cancelled"}:
                report["state"] = status.get("state")
                report["terminal_status"] = status
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"canary did not finish within {max_seconds} seconds")
            time.sleep(2)
        result = _json_call(base_url, token, f"/jobs/{job_id}/result", timeout=120)
        report["result"] = result
        points = [point for polar in result.get("polars", []) for point in polar.get("points", [])]
        attempts = [point for polar in result.get("polars", []) for point in polar.get("attempts", [])]
        report["point_summary"] = [_point_summary(point) for point in points + attempts]
        by_angle = {float(point.get("aoa_deg")): point for point in points if point.get("aoa_deg") is not None}
        accepted = []
        for angle in EXPECTED_AOAS:
            point = by_angle.get(angle)
            if point is None or point.get("converged") is not True or point.get("failure_disposition") not in (None, "none", ""):
                continue
            if any(not _finite(point.get(key)) for key in ("cl", "cd", "cm")):
                continue
            accepted.append(angle)
        if not points:
            raise RuntimeError("canary returned no point results")
        evidence = _mesh_evidence(base_url, token, points[0])
        report["mesh_evidence"] = {
            "actual_mesh": evidence["actual_mesh"],
            "qa": evidence["qa"],
            "max_aspect_ratio": evidence["max_aspect_ratio"],
            "check_mesh_log_present": evidence["check_mesh_log_present"],
        }
        actual_params = evidence["actual_mesh"].get("params") or {}
        actual_cells = int(evidence["actual_mesh"].get("nCells") or 0)
        actual_first_cell = float(actual_params.get("first_cell_height_chords"))
        actual_aspect = evidence["max_aspect_ratio"]
        if actual_cells != EXPECTED_CELLS:
            raise RuntimeError(f"candidate mesh cell count is {actual_cells}, expected {EXPECTED_CELLS}")
        if actual_params.get("target_y_plus") != CANDIDATE_TARGET_Y_PLUS or not math.isclose(actual_first_cell, expected_first_cell, rel_tol=1e-8):
            raise RuntimeError("candidate mesh evidence does not match the y+40 profile")
        if not _finite(actual_aspect) or float(actual_aspect) >= BASELINE_MAX_ASPECT_RATIO:
            raise RuntimeError(f"candidate mesh aspect ratio did not improve: {actual_aspect}")
        report["accepted_angles"] = accepted
        report["passed"] = report["state"] == "completed" and accepted == EXPECTED_AOAS
        if not report["passed"]:
            raise RuntimeError("canary did not produce two accepted finite in-domain points")
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            report["stop_proof"] = _json_call(base_url, token, f"/jobs/{job_id}/execution-stop-proof", {}, timeout=60)
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
    args = parser.parse_args()
    run(args.request, args.output, args.max_seconds)


if __name__ == "__main__":
    main()
