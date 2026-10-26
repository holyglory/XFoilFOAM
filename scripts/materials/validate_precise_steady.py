"""Bounded source-bound steady-RANS verification for the retained FX61147 case."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
from typing import Any
from uuid import uuid4

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.cache import EngineCache
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.meshing.base import get_mesher
from airfoilfoam.models import CaseSpec, PolarRequest
from airfoilfoam.openfoam.runner import DockerRunner
from airfoilfoam.pipeline import (
    _case_builder,
    _link_mesh,
    _run_transient_mesh_qa_gate,
    dialect_for_runner,
    prepare_mesh,
    resolve_mesh_params,
    validate_shared_mesh,
    write_shared_mesh_evidence,
    write_shared_mesh_qa_marker,
)
from airfoilfoam.provenance import application_source_files, application_source_sha256
from airfoilfoam.storage import JobStore


EXPECTED_APPLICATION_SOURCE_SHA256 = "f8d4018a3fa4694539629db33549ab22e32bd3e70fcf4a5b05c7cd9f013f8ca6"
SOURCE_JOB_ID = "dd937c94-1de1-4209-af9a-a7fe5aad0fe4"
SOURCE_REQUEST_SHA256 = "522157667e854ab0d530e6302e4099bfea7d0f5ea58b67727bb970f2f5d94d7f"
EXACT_MESH_SHA256 = "287aecc9ef3c0a53de25e9611143aacae9800b84a37772ca6a57b7cc0483a406"
PINNED_IMAGE = "opencfd/openfoam-run:2606@sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb"
PINNED_IMAGE_DIGEST = "sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb"
EXPECTED_MESH_CELLS = 30400
CASE_SOLVER_BUDGET_SECONDS = 900.0
REQUESTED_ANGLES = (-5.0, 0.0)
EXPECTED_MESH_MEMBERS = {
    "constant/polyMesh/boundary",
    "constant/polyMesh/cellZones",
    "constant/polyMesh/faceZones",
    "constant/polyMesh/faces",
    "constant/polyMesh/neighbour",
    "constant/polyMesh/owner",
    "constant/polyMesh/pointZones",
    "constant/polyMesh/points",
    "constant/polyMesh/sets/highAspectRatioCells",
    "constant/polyMesh/sets/nonOrthoFaces",
}


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    return {"bytes": path.stat().st_size, "sha256": sha256_file(path)}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n")
    os.replace(temporary, path)


def governed_context() -> dict[str, Any]:
    required = ("DEVCOORDINATOR_RUN_ID", "DEVCOORDINATOR_CHECK_NAME", "DEVCOORDINATOR_DIAGNOSTIC_FD")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError("Native validation requires a governed check: " + ", ".join(missing))
    os.fstat(int(os.environ["DEVCOORDINATOR_DIAGNOSTIC_FD"]))
    return {
        "run_id": os.environ["DEVCOORDINATOR_RUN_ID"],
        "check_name": os.environ["DEVCOORDINATOR_CHECK_NAME"],
    }


def source_identity(root: Path) -> dict[str, Any]:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    source_sha256 = application_source_sha256(root)
    if source_sha256 != EXPECTED_APPLICATION_SOURCE_SHA256:
        raise RuntimeError(
            f"Expected engine source SHA-256 {EXPECTED_APPLICATION_SOURCE_SHA256}, got {source_sha256}"
        )
    files = {}
    for path in application_source_files(root):
        files[path.relative_to(root).as_posix()] = file_record(path)
    return {
        "checkout_revision": revision,
        "application_source_sha256": source_sha256,
        "expected_application_source_sha256": EXPECTED_APPLICATION_SOURCE_SHA256,
        "source_files": files,
    }


def load_authenticated_source(path: Path) -> tuple[dict[str, Any], bytes]:
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != SOURCE_REQUEST_SHA256:
        raise ValueError("Retained FX61147 source request changed")
    source = json.loads(payload)
    if source.get("execution_id") != SOURCE_JOB_ID:
        raise ValueError("Retained source request has the wrong production execution identity")
    if source.get("airfoil", {}).get("name") != "FX 61-147 AIRFOIL":
        raise ValueError("Retained source request is not FX 61-147")
    if source.get("chord_lengths") != [0.05] or source.get("speeds") != [30.0]:
        raise ValueError("Retained source request has unexpected physical scales")
    return source, payload


def build_steady_request(source: dict[str, Any]) -> tuple[PolarRequest, list[str]]:
    candidate = copy.deepcopy(source)
    candidate["execution_id"] = None
    candidate["aoa"] = {"angles": list(REQUESTED_ANGLES), "start": None, "stop": None, "step": None}
    solver = candidate["solver"]
    solver_overrides = {
        "flow_solver_family": "simpleFoam",
        "force_transient": False,
        "transient_fallback": False,
        "warm_start": False,
        "rans_failure_policy": "continue",
        "write_images": [],
        "frame_fields": [],
    }
    for key, value in solver_overrides.items():
        solver[key] = value
    resources = candidate["resources"]
    resources.update(
        {
            "case_solver_budget_seconds": CASE_SOLVER_BUDGET_SECONDS,
            "case_solver_allocations": None,
            "cpu_budget": None,
            "case_concurrency": None,
            "queue_pressure": None,
            "policy": "auto",
            "solver_processes": 1,
        }
    )
    request = PolarRequest.model_validate(candidate)
    if request.aoa.expand() != list(REQUESTED_ANGLES):
        raise ValueError("Candidate request angle order changed")
    return request, sorted(solver_overrides)


def verify_request_preservation(source: dict[str, Any], request: PolarRequest) -> None:
    if request.mesh.model_dump(mode="json") != source["mesh"]:
        raise ValueError("Candidate changed the precise mesh profile")
    if request.fluid.model_dump(mode="json") != source["fluid"]:
        raise ValueError("Candidate changed the source material properties")
    if request.roughness.model_dump(mode="json") != source["roughness"]:
        raise ValueError("Candidate changed the source wall roughness")
    source_turbulence = source["solver"]["turbulence"]
    if request.solver.turbulence.model_dump(mode="json") != source_turbulence:
        raise ValueError("Candidate changed the source turbulence model or inputs")
    if request.solver.n_iterations != 3000:
        raise ValueError("Candidate did not retain 3000 steady iterations")
    if request.solver.convergence_tolerance != 1.0e-5:
        raise ValueError("Candidate did not retain the 1e-5 residual tolerance")
    if request.solver.momentum_scheme != "linearUpwind":
        raise ValueError("Candidate changed the source momentum scheme")
    if request.solver.flow_solver_family != "simpleFoam" or request.solver.force_transient:
        raise ValueError("Candidate is not a steady simpleFoam request")
    if request.solver.transient_fallback or request.solver.warm_start:
        raise ValueError("Candidate retained an unbounded transient or marched fallback")
    resources = request.resources
    if (
        resources.case_solver_budget_seconds != CASE_SOLVER_BUDGET_SECONDS
        or resources.cpu_budget is not None
        or resources.case_concurrency is not None
        or resources.solver_processes != 1
        or resources.policy.value != "auto"
    ):
        raise ValueError("Candidate resource policy is not the bounded auto-scheduled diagnostic")


def extract_exact_mesh(archive_path: Path, destination: Path) -> dict[str, Any]:
    if sha256_file(archive_path) != EXACT_MESH_SHA256:
        raise ValueError("Retained exact FX61147 mesh archive changed")
    if destination.exists():
        raise ValueError("Exact mesh extraction destination already exists")
    destination.mkdir(parents=True)
    records: dict[str, Any] = {}
    seen: set[str] = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            relative = PurePosixPath(member.name.rstrip("/"))
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Exact mesh archive contains an unsafe path")
            name = relative.as_posix()
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise ValueError("Exact mesh archive contains a link or unsupported member")
            if name in seen or name not in EXPECTED_MESH_MEMBERS:
                raise ValueError(f"Unexpected exact mesh member: {name}")
            seen.add(name)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"Cannot read exact mesh member: {name}")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            records[name] = file_record(target)
    if seen != EXPECTED_MESH_MEMBERS:
        raise ValueError("Exact mesh archive member set is incomplete")
    return {"archive": file_record(archive_path), "members": records}


def verify_mesh_member_hashes(
    generated_mesh_root: Path, authenticated_members: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    generated_poly_mesh = generated_mesh_root / "constant" / "polyMesh"
    generated_members = {
        path.relative_to(generated_mesh_root).as_posix(): file_record(path)
        for path in generated_poly_mesh.rglob("*")
        if path.is_file()
    }
    if set(generated_members) != set(authenticated_members):
        missing = sorted(set(authenticated_members) - set(generated_members))
        extra = sorted(set(generated_members) - set(authenticated_members))
        raise RuntimeError(
            f"Generated polyMesh member set differs from authenticated archive: missing={missing}, extra={extra}"
        )
    mismatches = {
        name: {"generated": generated_members[name], "authenticated": authenticated_members[name]}
        for name in sorted(authenticated_members)
        if generated_members[name] != authenticated_members[name]
    }
    if mismatches:
        raise RuntimeError(
            "Generated polyMesh member hashes differ from the authenticated archive: "
            + ", ".join(sorted(mismatches))
        )
    return {
        "matched": True,
        "members": {
            name: {"generated": generated_members[name], "authenticated": authenticated_members[name]}
            for name in sorted(authenticated_members)
        },
    }


def check_generated_mesh_evidence(mesh_root: Path) -> dict[str, Any]:
    evidence_dir = mesh_root / "mesh-evidence"
    manifest_path = evidence_dir / "manifest.json"
    checksum_path = evidence_dir / "manifest.sha256"
    if not manifest_path.is_file() or not checksum_path.is_file():
        raise RuntimeError("Fresh mesh preparation did not produce signed mesh evidence")
    if checksum_path.read_text().split()[0] != sha256_file(manifest_path):
        raise RuntimeError("Fresh mesh evidence manifest checksum does not verify")
    manifest = json.loads(manifest_path.read_text())
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise RuntimeError("Fresh mesh evidence manifest has no artifact records")
    records = {}
    for label, relative in (
        ("blockMeshLog", "logs/log.blockMesh"),
        ("checkMeshLog", "logs/log.checkMesh"),
    ):
        record = artifacts.get(label)
        path = evidence_dir / relative
        if not isinstance(record, dict) or record.get("path") != relative or not path.is_file():
            raise RuntimeError(f"Fresh mesh evidence is missing real {label}")
        actual = file_record(path)
        if actual["bytes"] <= 0 or actual != {
            "bytes": int(record.get("byteSize", -1)),
            "sha256": str(record.get("sha256", "")),
        }:
            raise RuntimeError(f"Fresh mesh evidence {label} does not match its signed record")
        records[label] = actual
    return {
        "manifest": file_record(manifest_path),
        "checksum": file_record(checksum_path),
        "artifacts": records,
        "mesh_identity": manifest.get("resolvedMeshIdentity"),
        "qa_verdict": manifest.get("qaVerdict"),
    }


def capture_native_identity(runner: DockerRunner, case_dir: Path) -> dict[str, Any]:
    case_dir.mkdir(parents=True, exist_ok=False)
    command = (
        "printf 'WM_PROJECT_VERSION=%s\\n' \"$WM_PROJECT_VERSION\"; "
        "for executable in blockMesh checkMesh simpleFoam; do "
        "path=\"$(command -v \"$executable\")\" || exit 41; "
        "printf '%s_path=%s\\n' \"$executable\" \"$path\"; "
        "printf '%s_sha256=%s\\n' \"$executable\" \"$(sha256sum \"$path\" | cut -d ' ' -f 1)\"; "
        "done"
    )
    result = runner.run(case_dir, command, timeout=60)
    result.check()
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    version = values.get("WM_PROJECT_VERSION", "").removeprefix("v")
    if version != "2606":
        raise RuntimeError(f"Governed runner reported OpenCFD version {version!r}, expected 2606")
    binaries = {}
    for executable in ("blockMesh", "checkMesh", "simpleFoam"):
        path = values.get(f"{executable}_path", "")
        digest = values.get(f"{executable}_sha256", "")
        if not path or len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise RuntimeError(f"Governed runner did not report a valid {executable} binary hash")
        binaries[executable] = {"path": path, "sha256": digest}
    return {
        "version": version,
        "binaries": binaries,
        "image": runner.settings.openfoam_image,
        "bashrc": runner.settings.openfoam_bashrc,
    }


def retain_generated_mesh_qa(
    mesh_root: Path,
    airfoil: Any,
    resolved: Any,
    request: PolarRequest,
    runner: DockerRunner,
) -> Any:
    qa_root = mesh_root / "_mesh_qa_retained"
    qa_root.mkdir(parents=True, exist_ok=False)
    try:
        _case_builder(
            runner,
            airfoil,
            get_mesher(resolved.mesher).patches(resolved),
            resolved,
            CaseSpec(chord=0.05, speed=30.0, aoa_deg=REQUESTED_ANGLES[0]),
            request.fluid,
            request.roughness,
            request.solver,
            n_proc=1,
            dialect=dialect_for_runner(runner),
        ).write(qa_root)
        _link_mesh(qa_root, mesh_root, runner)
        qa = _run_transient_mesh_qa_gate(qa_root, runner)
        if qa is None:
            raise RuntimeError("Fresh retained mesh QA did not produce a complete checkMesh verdict")
        source_sets = qa_root / "constant" / "polyMesh" / "sets"
        destination_sets = mesh_root / "constant" / "polyMesh" / "sets"
        if not source_sets.is_dir():
            raise RuntimeError("Fresh retained mesh QA did not produce checkMesh set evidence")
        shutil.rmtree(destination_sets, ignore_errors=True)
        shutil.copytree(source_sets, destination_sets)
        shutil.copy2(qa_root / "log.checkMesh", mesh_root / "log.checkMesh")
        return qa
    finally:
        shutil.rmtree(qa_root, ignore_errors=True)


def finite_coefficients(point: Any) -> bool:
    return all(
        isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
        for value in (point.cl, point.cd, point.cm)
    )


def point_is_accepted(point: Any) -> bool:
    certificate = point.rans_hold_certificate
    budget = point.solver_budget
    warnings = [str(value).lower() for value in (point.quality_warnings or [])]
    return bool(
        point.error is None
        and point.failure_disposition.value == "none"
        and point.method_key == "openfoam.rans"
        and point.fidelity == "rans"
        and not point.unsteady
        and point.converged
        and finite_coefficients(point)
        and certificate is not None
        and certificate.certified
        and budget is not None
        and not budget.exhausted
        and not any("stalled" in warning for warning in warnings)
    )


def point_summary(point: Any, collection: str) -> dict[str, Any]:
    payload = point.model_dump(mode="json")
    payload["collection"] = collection
    payload["finite_coefficients"] = finite_coefficients(point)
    payload["native_steady_accepted"] = point_is_accepted(point)
    payload["stall_markers"] = [
        warning for warning in point.quality_warnings if "stall" in str(warning).lower()
    ]
    return payload


def summarize_result(result: Any, requested_angles: tuple[float, ...]) -> dict[str, Any]:
    summaries: list[dict[str, Any]] = []
    for polar in result.polars:
        for point in polar.points:
            summaries.append(point_summary(point, "points"))
        for point in polar.attempts:
            summaries.append(point_summary(point, "attempts"))
    by_angle: dict[float, list[dict[str, Any]]] = {}
    for summary in summaries:
        by_angle.setdefault(float(summary["aoa_deg"]), []).append(summary)
    selected: dict[float, dict[str, Any]] = {}
    for angle in requested_angles:
        candidates = by_angle.get(angle, [])
        accepted = [item for item in candidates if item["native_steady_accepted"]]
        selected[angle] = accepted[0] if accepted else (candidates[0] if candidates else {"aoa_deg": angle})
    accepted_angles = [angle for angle, item in selected.items() if item.get("native_steady_accepted")]
    inconclusive_angles = [
        angle
        for angle, item in selected.items()
        if not item.get("native_steady_accepted")
        and (angle not in by_angle or item.get("failure_disposition") in {"infrastructure", "material_domain"})
    ]
    rejected_angles = [
        angle
        for angle, item in selected.items()
        if not item.get("native_steady_accepted") and angle not in inconclusive_angles and "failure_disposition" in item
    ]
    if len(accepted_angles) == len(requested_angles):
        status = "accepted"
    elif inconclusive_angles:
        status = "inconclusive"
    elif accepted_angles:
        status = "partial"
    else:
        status = "rejected"
    return {
        "engine_state": result.state.value,
        "status": status,
        "accepted_angles": accepted_angles,
        "rejected_angles": rejected_angles,
        "inconclusive_angles": inconclusive_angles,
        "points": sorted(summaries, key=lambda item: (float(item["aoa_deg"]), item["collection"])),
    }


def check_mesh_evidence(job_root: Path, expected_boundary: dict[str, Any]) -> dict[str, Any]:
    logs = sorted(
        path
        for path in job_root.joinpath("meshes").rglob("log.checkMesh")
        if len(path.relative_to(job_root).parts) == 4
    )
    if len(logs) != 1:
        raise RuntimeError(f"Expected one exact-mesh checkMesh log, found {len(logs)}")
    log = logs[0]
    text = log.read_text(errors="replace")
    match = None
    for line in text.splitlines():
        if line.strip().startswith("cells:"):
            match = line.strip()
            break
    if match is None or int(match.split(":", 1)[1].strip()) != EXPECTED_MESH_CELLS:
        raise RuntimeError(f"Exact mesh checkMesh cell count was not {EXPECTED_MESH_CELLS}: {match!r}")
    boundary = log.parent / "constant" / "polyMesh" / "boundary"
    if file_record(boundary) != expected_boundary:
        raise RuntimeError("Candidate mesh boundary differs from the authenticated exact mesh")
    block_logs = sorted(job_root.joinpath("meshes").rglob("mesh-evidence/logs/log.blockMesh"))
    if len(block_logs) != 1 or block_logs[0].stat().st_size <= 0:
        raise RuntimeError("Executed job did not retain exactly one real blockMesh log")
    return {
        "checkMesh_log": file_record(log),
        "blockMesh_log": file_record(block_logs[0]),
        "cells_line": match,
        "boundary": file_record(boundary),
    }


def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    context = governed_context()
    driver_path = Path(__file__).resolve()
    driver_sha256 = sha256_file(driver_path)
    root = driver_path.parents[2]
    identity = source_identity(root)
    source, source_bytes = load_authenticated_source(args.request)
    request, solver_overrides = build_steady_request(source)
    verify_request_preservation(source, request)
    run_root = args.destination.resolve() / f"run-{uuid4().hex}"
    run_root.mkdir(parents=True, exist_ok=False)
    authenticated_mesh_root = run_root / "authenticated-mesh"
    mesh_manifest = extract_exact_mesh(args.mesh_archive, authenticated_mesh_root)
    exact_poly_mesh = authenticated_mesh_root / "constant" / "polyMesh"
    airfoil = load_airfoil(
        request.airfoil.name,
        request.airfoil.coordinates,
        request.airfoil.points,
        request.airfoil.format,
    )
    resolved = resolve_mesh_params(
        request.mesh,
        CaseSpec(chord=0.05, speed=30.0, aoa_deg=REQUESTED_ANGLES[0]),
        request.fluid,
    )
    mesher = get_mesher(resolved.mesher)
    if mesher.cell_count(resolved) != EXPECTED_MESH_CELLS:
        raise RuntimeError("Candidate mesh recipe does not resolve to the authenticated 30400-cell profile")
    source_hash = identity["application_source_sha256"]
    settings = Settings(
        data_dir=run_root / "data",
        cache_dir=run_root / "cache",
        cpu_token_state_path=run_root / "cpu-tokens.json",
        openfoam_runner="docker",
        openfoam_image=PINNED_IMAGE,
        engine_image_digest=PINNED_IMAGE_DIGEST,
        engine_source_revision=identity["checkout_revision"],
        engine_application_source_sha256=source_hash,
        solver_timeout=int(CASE_SOLVER_BUDGET_SECONDS),
        rans_solver_timeout=int(CASE_SOLVER_BUDGET_SECONDS),
        rans_max_iterations=3000,
    )
    identity_runner = DockerRunner(settings)
    native_identity = capture_native_identity(identity_runner, run_root / "engine-identity")
    settings = settings.model_copy(
        update={"engine_binary_sha256": native_identity["binaries"]["simpleFoam"]["sha256"]}
    )
    runner = DockerRunner(settings)
    generated_mesh_root = run_root / "generated-mesh"
    quality_warnings: list[str] = []

    def validate_generated_mesh(candidate_dir: Path, candidate_resolved: Any) -> bool:
        return validate_shared_mesh(
            candidate_dir,
            airfoil,
            candidate_resolved,
            CaseSpec(chord=0.05, speed=30.0, aoa_deg=REQUESTED_ANGLES[0]),
            request.fluid,
            request.roughness,
            request.solver,
            runner,
            1,
            quality_warnings,
        )

    generated_result = prepare_mesh(
        generated_mesh_root,
        airfoil,
        resolved,
        0.05,
        mesher,
        runner,
        cache=None,
        validate=validate_generated_mesh,
    )
    generated_qa = retain_generated_mesh_qa(
        generated_mesh_root,
        airfoil,
        resolved,
        request,
        runner,
    )
    write_shared_mesh_qa_marker(generated_mesh_root, generated_qa)
    write_shared_mesh_evidence(
        generated_mesh_root,
        resolved,
        mesher,
        0.05,
        generated_result,
        [],
        engine=settings.engine_runtime_identity(),
    )
    if generated_result.n_cells != EXPECTED_MESH_CELLS:
        raise RuntimeError("Fresh blockMesh did not produce the authenticated 30400-cell profile")
    mesh_match = verify_mesh_member_hashes(generated_mesh_root, mesh_manifest["members"])
    generated_mesh_evidence = check_generated_mesh_evidence(generated_mesh_root)
    cache = EngineCache.from_settings(settings)
    mesh_key = cache.mesh_key(airfoil, 0.05, resolved, mesher=mesher)
    if not cache.publish_mesh(
        mesh_key,
        exact_poly_mesh,
        n_cells=EXPECTED_MESH_CELLS,
        evidence_dir=generated_mesh_root / "mesh-evidence",
        resolved_mesh_identity={
            "source_archive_sha256": EXACT_MESH_SHA256,
            "source_request_sha256": SOURCE_REQUEST_SHA256,
            "checkout_revision": identity["checkout_revision"],
        },
    ):
        raise RuntimeError("Could not publish the authenticated exact mesh into the isolated cache")
    job_id = str(uuid4())
    store = JobStore(settings)
    store.create(job_id, request)
    result = execute_job(job_id, request, store=store, settings=settings)
    result_summary = summarize_result(result, REQUESTED_ANGLES)
    mesh_evidence = check_mesh_evidence(
        store.job_dir(job_id),
        mesh_manifest["members"]["constant/polyMesh/boundary"],
    )
    final_identity = source_identity(root)
    if final_identity["source_files"] != identity["source_files"] or sha256_file(driver_path) != driver_sha256:
        raise RuntimeError("Engine or diagnostic source bytes changed during execution")
    report = {
        "kind": "source-bound-precise-steady-rans-v1",
        "context": context,
        "source": {
            "request": str(args.request.resolve()),
            "request_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "execution_id": SOURCE_JOB_ID,
            "mesh_archive": mesh_manifest,
            "mesh_cache_key": mesh_key,
            "saved_transient_fields_used": False,
        },
        "source_identity": {
            **identity,
            "driver_sha256": driver_sha256,
            "verified_after_execution": True,
        },
        "native_identity": native_identity,
        "candidate": {
            "request_sha256": hashlib.sha256(
                json.dumps(request.model_dump(mode="json"), sort_keys=True).encode("utf-8")
            ).hexdigest(),
            "solver_overrides": solver_overrides,
            "preserved": ["mesh", "fluid", "roughness", "turbulence", "n_iterations", "convergence_tolerance", "momentum_scheme"],
            "flow_solver_family": request.solver.flow_solver_family,
            "angles": list(REQUESTED_ANGLES),
            "case_solver_budget_seconds": CASE_SOLVER_BUDGET_SECONDS,
            "resource_policy": request.resources.model_dump(mode="json"),
        },
        "engine": {
            "image": PINNED_IMAGE,
            "image_digest": PINNED_IMAGE_DIGEST,
            "runtime": result.engine.model_dump(mode="json") if result.engine else None,
            "requested": result.requested_engine.model_dump(mode="json") if result.requested_engine else None,
            "execution_pool": result.execution_pool,
        },
        "scheduling": result.scheduling.model_dump(mode="json") if result.scheduling else None,
        "mesh_evidence": mesh_evidence,
        "generated_mesh_evidence": generated_mesh_evidence,
        "generated_mesh_match": mesh_match,
        "job_id": job_id,
        "result_path": str((store.job_dir(job_id) / "result.json").relative_to(run_root)),
        "outcome": result_summary,
    }
    write_json(run_root / "candidate-request.json", request.model_dump(mode="json"))
    write_json(run_root / "report.json", report)
    exit_code = 2 if result_summary["status"] == "inconclusive" else 0
    print(json.dumps({"status": result_summary["status"], "run_root": str(run_root), "job_id": job_id, "exit_code": exit_code}, sort_keys=True))
    return report, exit_code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--mesh-archive", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    _report, exit_code = run(args)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
