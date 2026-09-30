import argparse
from contextlib import nullcontext
import hashlib
import json
import math
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import numpy as np

from airfoilfoam.airfoil import Airfoil
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.storage import JobStore


SOURCE_SHA256 = "0e10c995bbb34aacbcdadc06a8cf57916ff4f9891fd01397f4ab789422cce488"


def source_preserving_airfoil(cls, name, contour):
    points = np.asarray(contour, dtype=float).copy()
    leading_edge = points[np.argmin(points[:, 0])].copy()
    trailing_edge = (points[0] + points[-1]) / 2
    chord_vector = trailing_edge - leading_edge
    angle = math.atan2(chord_vector[1], chord_vector[0])
    rotation = np.array([[math.cos(angle), math.sin(angle)], [-math.sin(angle), math.cos(angle)]])
    length = float(np.linalg.norm(chord_vector))
    normalized = (points - leading_edge) @ rotation.T / length
    gap = float(np.linalg.norm(normalized[0] - normalized[-1]))
    reconstructed = normalized @ rotation * length + leading_edge
    np.testing.assert_allclose(reconstructed, points, rtol=0, atol=1e-12)
    if gap > 1e-10:
        normalized = np.vstack([normalized, normalized[0]])
    return cls(name=name, contour=normalized, te_gap_original=gap)


def pinched_airfoil(cls, name, contour):
    airfoil = source_preserving_airfoil(cls, name, contour)
    if airfoil.te_gap_original > 1e-10:
        airfoil.contour = airfoil.contour[:-1].copy()
    airfoil.contour[0] = [1, 0]
    airfoil.contour[-1] = [1, 0]
    return airfoil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--variant", choices=["legacy", "pinched-cartesian", "source-cartesian", "production-fixed"], required=True)
    args = parser.parse_args()
    original = args.request.read_bytes()
    if hashlib.sha256(original).hexdigest() != SOURCE_SHA256:
        raise ValueError("The retained SG6051 production request changed")
    source = json.loads(original)["engineRequest"]
    for key in ("execution_id", "expected_engine", "expected_execution_pool", "expected_mesh_recovery_version", "expected_solver_budget_version"):
        source[key] = None
    source["resources"].update(cpu_budget=1, solver_processes=1, case_concurrency=1)
    source["solver"].update(write_images=[], frame_fields=[], rans_failure_policy="continue")
    if args.variant in {"pinched-cartesian", "source-cartesian"}:
        source["mesh"]["mesher"] = "cartesian2d-external-boundary-layer"
    request = PolarRequest.model_validate(source)
    destination = args.destination / args.variant / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    driver = Path(__file__).read_bytes()
    (destination / "replay-driver.py").write_bytes(driver)
    (destination / "source-request.json").write_bytes(original)
    settings = Settings(data_dir=destination / "data", cache_dir=destination / "cache",
                        cpu_token_state_path=destination / "cpu-tokens.json")
    if settings.evidence_bucket:
        raise ValueError("This isolated geometry experiment must not publish production evidence")
    store = JobStore(settings)
    job_id = str(uuid4())
    store.create(job_id, request)
    report = {
        "kind": "sg6051-trailing-edge-reproduction-v1", "production_evidence": False,
        "accuracy_certified": False, "variant": args.variant, "source_sha256": SOURCE_SHA256,
        "driver_sha256": hashlib.sha256(driver).hexdigest(),
        "source_engine_job": "94246be7-3823-435f-8742-cf361a84bba1", "local_job": job_id,
        "request": request.model_dump(mode="json"), "engine": settings.engine_identity().model_dump(mode="json"),
        "differences": ["isolated current-source runtime", "one solver process", "empty mesh and field cache",
                        "no rendered media", "continue to the second requested angle after rejected evidence",
                        "production mesh admission" if args.variant == "production-fixed" else request.mesh.mesher,
                        "original finite trailing edge retained" if args.variant in {"source-cartesian", "production-fixed"} else "original pinching transformation"],
        "outcomes": [],
    }
    transformation = (
        nullcontext() if args.variant == "production-fixed"
        else patch.object(Airfoil, "from_contour", classmethod(
            source_preserving_airfoil if args.variant == "source-cartesian" else pinched_airfoil
        ))
    )
    try:
        with transformation:
            result = execute_job(job_id, request, store=store, settings=settings)
        report["outcomes"] = [
            {"alpha": point.aoa_deg, "collection": collection, "cl": point.cl, "cd": point.cd, "cm": point.cm,
             "converged": point.converged, "iterations": point.iterations, "n_cells": point.n_cells,
             "unsteady": point.unsteady, "failure_disposition": point.failure_disposition,
             "error": point.error.splitlines()[0] if point.error else None,
             "quality_warnings": point.quality_warnings,
             "rans_hold_certificate": point.rans_hold_certificate.model_dump(mode="json") if point.rans_hold_certificate else None}
            for polar in result.polars for collection in ("points", "attempts") for point in getattr(polar, collection)
        ]
        report["result_status"] = result.state.value
        report["mesh_provenance"] = [
            {"path": str(path.relative_to(destination)), **json.loads(path.read_text())}
            for path in store.job_dir(job_id).rglob("mesh_evidence/manifest.json")
        ]
        if not report["outcomes"]:
            raise RuntimeError("The geometry experiment produced no physical attempts")
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        (destination / "report.json").write_text(json.dumps(report, indent=2, default=str, allow_nan=False) + "\n")
        print(json.dumps({"report": str(destination / "report.json"), "variant": args.variant,
                          "failure": report.get("failure"), "outcomes": [
                              {key: point[key] for key in ("alpha", "collection", "cl", "cd", "cm", "converged", "iterations")}
                              for point in report["outcomes"] if point["collection"] == "points"
                          ]}, default=str), flush=True)


if __name__ == "__main__":
    main()
