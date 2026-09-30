import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from uuid import UUID

from scripts.materials.inspect_cartesian_startup import copy_directory
from scripts.materials.reproduce_blunt_trailing_edge import SOURCE_SHA256
from scripts.materials.reproduce_mach3_failure import authenticate_archives


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    case = str(UUID(args.case))
    status = json.loads(subprocess.check_output([
        "devcoordinator2", "deployment", "status", "--name", "trailing-edge-reproduction", "--client", "codex"], text=True))
    if not status.get("ok") or status["data"]["deployment_id"] != "dd1720d1dfce33e61":
        raise ValueError("The owned SG6051 deployment is unavailable")
    component = next(row for row in status["data"]["components"] if row["name"] == "numerics")
    if any(row["state"] not in {"completed", "failed"} for row in component["services"] if row["name"] != "artifacts"):
        raise ValueError("SG6051 verification requires stopped numerical writers")
    origin = f"http://127.0.0.1:{int(component['port'])}"
    copy_directory(origin + f"/production-fixed/{case}/", args.destination, [536870912])
    report = json.loads((args.destination / "report.json").read_text())
    if report.get("variant") != "production-fixed" or report.get("production_evidence") is not False:
        raise ValueError("The SG6051 proof is not the canonical isolated candidate")
    if hashlib.sha256((args.destination / "source-request.json").read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("The original SG6051 request changed")
    if hashlib.sha256((args.destination / "replay-driver.py").read_bytes()).hexdigest() != report.get("driver_sha256"):
        raise ValueError("The SG6051 execution driver changed")
    points = [row for row in report["outcomes"] if row["collection"] == "points"]
    if {row["alpha"] for row in points} != {-3, 7} or len(points) != 2:
        raise ValueError("The original SG6051 angles are incomplete")
    if any(row.get("error") or not row["converged"] or not row["rans_hold_certificate"] for row in points):
        raise ValueError("The canonical SG6051 repeat did not retain converged force evidence")
    points.sort(key=lambda row: row["alpha"])
    if points[1]["cl"] <= points[0]["cl"]:
        raise ValueError("The reported SG6051 low-angle reversal remains")
    archives = authenticate_archives(args.destination / "data/jobs" / report["local_job"])
    if len(archives) != 2:
        raise ValueError("Both original angles need authenticated raw archives")
    verification = {"case": case, "source_sha256": SOURCE_SHA256, "production_evidence": False,
                    "physical_validation": False, "points": points, "archives": archives}
    (args.destination / "verification.json").write_text(json.dumps(verification, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"case": case, "archive_count": len(archives),
                      "points": [{name: row[name] for name in ("alpha", "cl", "cd", "converged")} for row in points],
                      "physical_validation": False}))


if __name__ == "__main__":
    main()
