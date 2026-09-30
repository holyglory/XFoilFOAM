import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.models import PolarRequest
from airfoilfoam.meshing.cartesian2d import Cartesian2DExternalMesh
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.rans_hold import atomic_dictionary, root_entry
from airfoilfoam.openfoam.runner import get_runner
from airfoilfoam.pipeline import _case_builder


def bounded_gradients(schemes, variant):
    if variant not in {"original", "density", "all", "minmod-density", "minmod-all"}:
        raise ValueError("Unsupported saved-state gradient comparison")
    if variant == "original":
        return schemes
    if variant.startswith("minmod-"):
        replacements = {"rho": ("vanLeer", "Minmod")}
        if variant == "minmod-all":
            replacements.update({"T": ("vanLeer", "Minmod"), "U": ("vanLeerV", "MinmodV")})
        for field, (original, replacement) in replacements.items():
            pattern = r"(reconstruct\(" + field + r"\)\s+)" + original + r"(\s*;)"
            schemes, count = re.subn(pattern, lambda matched: matched[1] + replacement + matched[2], schemes)
            if count != 1:
                raise ValueError("The saved precise reconstruction settings changed")
        return schemes
    pattern = r"(gradSchemes\s*\{\s*default\s+)Gauss linear(\s*;)"
    replacement = r"\g<1>cellLimited Gauss linear 1\2" if variant == "all" else r"\g<1>Gauss linear\2\n    grad(rho) cellLimited Gauss linear 1;"
    changed, count = re.subn(pattern, replacement, schemes)
    if count != 1:
        raise ValueError("The saved precise gradient settings changed")
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--variant", choices=["original", "density", "all", "minmod-density", "minmod-all"], required=True)
    parser.add_argument("--integrate", action="store_true")
    parser.add_argument("--pressure-transient", action="store_true")
    args = parser.parse_args()
    if args.pressure_transient and (args.variant != "minmod-all" or not args.integrate):
        raise ValueError("The pressure comparison requires an admissible acoustic-rate probe and physical integration")
    source_report = json.loads((args.source / "report.json").read_text())
    if source_report.get("kind") != "source-bound-production-numerical-replay-v1" or source_report.get("production_evidence") is not False:
        raise ValueError("Expected a retained isolated precise replay")
    if len(source_report.get("initializations", [])) != 1:
        raise ValueError("Expected one exact local initial guess")
    initializer = source_report["initializations"][0]
    if initializer["field_sha256"] != initializer["target_field_sha256"]:
        raise ValueError("Source initial guess did not preserve its fields")
    source_case = Path(initializer["directory"].removesuffix("-local-initialization"))
    if not source_case.resolve().is_relative_to(args.source.resolve()):
        raise ValueError("Saved state escaped its source replay")
    for name, expected in initializer["field_sha256"].items():
        if hashlib.sha256((source_case / "0" / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Saved transient initial field changed")
    destination = args.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "replay-driver.py").write_bytes(Path(__file__).read_bytes())
    case = destination / "case"
    for name in ("0", "constant", "system"):
        shutil.copytree(source_case / name, case / name)
    source_hashes = {path.relative_to(case).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in case.rglob("*") if path.is_file()}
    schemes = case / "system/fvSchemes"
    schemes.write_text(bounded_gradients(schemes.read_text(), args.variant))
    remaining = 900 - max(row["solver_active_seconds"] for row in source_report["case_outcomes"])
    if not 0 < remaining < 900:
        raise ValueError("Saved initialization has no valid shared remaining budget")
    runner = get_runner(Settings())
    request = PolarRequest.model_validate(source_report["effective_request"])
    configure_flow_execution(runner, request)
    probe = runner.application(case, "/canary-output/acoustic-probe-build-r1/bin/xfoilfoamDensityProbe", timeout=60)
    (destination / "probe.stdout").write_text(probe.stdout)
    report = {"kind": "retained-precise-state-comparison-v1", "variant": args.variant,
              "source_report_sha256": hashlib.sha256((args.source / "report.json").read_bytes()).hexdigest(),
              "source_files": source_hashes, "production_evidence": False, "physical_validation": False,
              "probe_returncode": probe.returncode, "remaining_budget_seconds": remaining,
              "early_material_abort": True, "pressure_transient": args.pressure_transient,
              "density": [json.loads(line.removeprefix("XFOILFOAM_DENSITY_RECONSTRUCTION ")) for line in probe.stdout.splitlines()
                          if line.startswith("XFOILFOAM_DENSITY_RECONSTRUCTION ")], "integration": None}
    if args.integrate and probe.ok:
        records = [json.loads(line.removeprefix("XFOILFOAM_ACOUSTIC_STARTUP ")) for line in probe.stdout.splitlines()
                   if line.startswith("XFOILFOAM_ACOUSTIC_STARTUP ")]
        if len(records) != 1:
            raise ValueError("Native preflight lacks its exact timestep")
        control = case / "system/controlDict"
        command = "rhoCentralFoam"
        if args.pressure_transient:
            timing = control.read_text()
            request.solver = request.solver.model_copy(update={"flow_solver_family": "rhoPimpleFoam"})
            configure_flow_execution(runner, request)
            shape = load_airfoil(request.airfoil.name, request.airfoil.coordinates, request.airfoil.points, request.airfoil.format)
            _case_builder(runner, shape, Cartesian2DExternalMesh().patches(request.mesh), request.mesh,
                          request.cases()[0], request.fluid, request.roughness, request.solver).write_transient(
                case, float(root_entry(timing, "startTime")), float(root_entry(timing, "endTime")), records[0]["safe_delta_t"],
                write_interval=float(root_entry(timing, "writeInterval")), max_delta_t=float(root_entry(timing, "maxDeltaT")))
            command = "rhoPimpleFoam"
        for name, checksum in source_hashes.items():
            if name.startswith(("0/", "constant/")) and name != "constant/numericalExecution.json":
                if hashlib.sha256((case / name).read_bytes()).hexdigest() != checksum:
                    raise ValueError("The transport comparison changed a physical input or saved field")
        atomic_dictionary(control, root_entry(control.read_text(), "deltaT", records[0]["safe_delta_t"]))
        result = runner.solver(case, command, 1, timeout=remaining, restart=True)
        (destination / "solver.stdout").write_text(result.stdout)
        failure = material_domain_failure(case, result)
        times = [float(value) for value in re.findall(r"^Time = (\S+)", result.stdout, re.M)]
        report["integration"] = {"returncode": result.returncode, "timed_out": result.timed_out,
                                  "last_time": times[-1] if times else None,
                                  "material_error": str(failure) if failure else None, "accepted_cfd": False}
    (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"report": str(destination / "report.json"), "variant": args.variant,
                      "probe_returncode": probe.returncode, "density": report["density"], "integration": report["integration"]}), flush=True)


if __name__ == "__main__":
    main()
