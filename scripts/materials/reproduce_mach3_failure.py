import argparse
import hashlib
import json
import re
from pathlib import Path
from uuid import uuid4

from airfoilfoam.airfoil import parse_airfoil
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.numerical_canary import source_material_for_canary
from airfoilfoam.storage import JobStore


SOURCE_JOB = "c8827f4c-65d8-4490-bdc8-e84c98529a57"
POINTS_SHA256 = "62678a8b062a9cdd2d0d18fe4791944044cc74f43986759ba7ec646172654b8e"
MATERIAL_SHA256 = "fc174fc87eb50300a2e5412bcc86e5b334bb7ba20a3645c365b0e55f81013766"


def diagnostic_request(coordinates_path, material_path, start, courant=4.0):
    if start not in ("cold", "marched"):
        raise ValueError("Unknown diagnostic starting state")
    if isinstance(courant, bool) or courant not in (4.0, 0.25, 0.1):
        raise ValueError("Unsupported diagnostic Courant comparison")
    points = parse_airfoil(Path(coordinates_path).read_text()).tolist()
    points_hash = hashlib.sha256(json.dumps(points, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    if points_hash != POINTS_SHA256:
        raise ValueError("The diagnostic geometry does not match the observed production request")
    if hashlib.sha256(Path(material_path).read_bytes()).hexdigest() != MATERIAL_SHA256:
        raise ValueError("The diagnostic requires the pinned source-air fixture")
    gas = source_material_for_canary(material_path)
    return PolarRequest.model_validate({
        "airfoil": {"name": "FX 60-100 AIRFOIL", "points": points},
        "chord_lengths": [0.1], "speeds": [1021.025],
        "aoa": {"angles": [13] if start == "cold" else [-4, 13]},
        "fluid": {"density": 1.2250159925164, "kinematic_viscosity": 1.4665638853861052e-05,
                  "gas": gas.model_dump(mode="json")},
        "flow_state": {"temperature_k": 288.15, "pressure_pa": 101325},
        "roughness": {"sand_grain_height": 0, "roughness_constant": 0.5},
        "mesh": {"mesher": "blockmesh-cgrid", "farfield_radius_chords": 15, "wake_length_chords": 12,
                 "n_surface": 84, "n_radial": 52, "n_wake": 40, "target_y_plus": 40, "span_chords": 0.1},
        "solver": {"flow_solver_family": "rhoCentralFoam", "turbulent_prandtl": 0.85,
                   "turbulence": {"model": "kOmegaSST", "intensity": 0.001, "viscosity_ratio": 10},
                   "n_iterations": 5000, "convergence_tolerance": 0.0001, "momentum_scheme": "upwind",
                   "force_transient": False, "transient_fallback": False, "rans_failure_policy": "abort_for_precalc",
                   "transient_max_courant": courant,
                   "warm_start": True, "write_images": [], "frame_fields": []},
        "resources": {"case_solver_budget_seconds": 900, "solver_processes": 1},
    })


def collect_diagnostics(job_dir):
    diagnostics = []
    for path in sorted(Path(job_dir).rglob("material-domain-diagnostic.json")):
        record = json.loads(path.read_text())
        expected = record["solver_log_sha256"]
        if not re.fullmatch(r"[0-9a-f]{64}", expected) or record["solver_log"] != f"log.material-domain-{expected}":
            raise ValueError("Invalid material diagnostic log identity")
        log = path.parent / record["solver_log"]
        if hashlib.sha256(log.read_bytes()).hexdigest() != expected:
            raise ValueError("Material diagnostic raw log is missing or changed")
        diagnostics.append({"path": path.relative_to(job_dir).as_posix(), **record})
    return diagnostics


def summarize_outcomes(result):
    return [{"aoa_deg": point.aoa_deg, "converged": point.converged, "error": point.error,
             "result_collection": collection, "failure_disposition": point.failure_disposition,
             "cl": point.cl, "cd": point.cd, "cm": point.cm,
             "solver_active_seconds": point.solver_active_seconds}
            for polar in result.polars for collection in ("points", "attempts")
            for point in getattr(polar, collection)]


def main():
    parser = argparse.ArgumentParser(description="Isolated real Mach-3 failure diagnosis; never publishes campaign evidence")
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--start", choices=["cold", "marched"], default="cold")
    parser.add_argument("--courant", type=float, choices=[4.0, 0.25, 0.1], default=4.0)
    args = parser.parse_args()
    request = diagnostic_request(args.coordinates, args.material, args.start, args.courant)
    destination = args.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    settings = Settings(data_dir=destination / "data", cache_dir=destination / "cache",
                        cpu_token_state_path=destination / "cpu-tokens.json")
    if settings.evidence_bucket:
        raise ValueError("This isolated diagnosis must not upload evidence")
    store = JobStore(settings)
    job_id = str(uuid4())
    store.create(job_id, request)
    report = {"kind": "mach3-failure-diagnosis", "source_job": SOURCE_JOB, "local_job": job_id,
              "starting_state": args.start, "geometry_points_sha256": POINTS_SHA256,
              "effective_local_courant_target": min(0.5, args.courant),
              "material_sha256": MATERIAL_SHA256, "airfoil_polar_validation": False,
              "differences_from_production": ["current source", "serial solve", "isolated empty cache", "no rendered media"],
              "diagnostic_completed": False}
    if args.start == "cold":
        report["differences_from_production"].append("13-degree angle without the preceding -4-degree march")
    if args.courant != 4.0:
        report["differences_from_production"].append("smaller local pseudo-time Courant target")
    try:
        result = execute_job(job_id, request, store=store, settings=settings)
        report.update({"solver_state": result.state.value, "solver_message": result.message,
                       "case_outcomes": summarize_outcomes(result),
                       "material_diagnostics": collect_diagnostics(store.job_dir(job_id))})
        if not report["case_outcomes"]:
            raise RuntimeError("The native diagnostic produced no case outcome")
        report["diagnostic_completed"] = True
    except Exception as error:
        report["diagnostic_error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        (destination / "report.json").write_text(json.dumps(report, allow_nan=False, indent=2) + "\n")
        print(json.dumps({"report": str(destination / "report.json"), **report}, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
