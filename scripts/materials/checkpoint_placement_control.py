import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess

from airfoilfoam.evidence_store import extract_verified_evidence_archive
from scripts.materials import checkpoint_placement as benchmark


NAME = "checkpoint-placement"
RELATIVE_ROOT = Path(".codex-artifacts/checkpoint-placement")
ARCHIVE_ROOT = Path("/mnt/build-storage/codex/xfoilfoam-verification/archive-placement-6cd159f3-20261108T054038Z")
PYTHON_PREFIX = Path("/home/holyglory/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu")
PYTHON_SHA256 = "9544d2a29138833e6177d45dbc57468d37710b5080c901fbb579d53f251cdd6f"


def governed_owner():
    required = ("DEVCOORDINATOR_RUN_ID", "DEVCOORDINATOR_CHECK_NAME", "DEVCOORDINATOR_DIAGNOSTIC_FD")
    if not all(os.environ.get(name) for name in required):
        raise ValueError("Checkpoint fixture operations require an admitted governed check")
    os.fstat(int(os.environ["DEVCOORDINATOR_DIAGNOSTIC_FD"]))
    experiment = os.environ.get("CHECKPOINT_EXPERIMENT", "placement")
    if experiment not in ("placement", "serial-mpi"):
        raise ValueError("Unknown governed checkpoint experiment")
    return {"runId": os.environ["DEVCOORDINATOR_RUN_ID"], "path": str(Path.cwd().resolve()), "name": NAME,
            "experiment": experiment,
            "driverSha256": benchmark.digest(Path(benchmark.__file__)), "controllerSha256": benchmark.digest(Path(__file__)),
            "composeSha256": benchmark.digest(Path("compose.checkpoint-placement.yml"))}


def coordinator(operation, params, timeout=60, absent_ok=False, error_receipt=None):
    process = subprocess.run(["devcoordinator2", "--client", "codex", "call", operation,
                              "--params", json.dumps(params)], capture_output=True, text=True, timeout=timeout)
    response = json.loads(process.stdout)
    if not response.get("ok"):
        if error_receipt is not None:
            benchmark.write_json(error_receipt, {"operation": operation, "response": response})
        code = response.get("error", {}).get("code")
        if absent_ok and code in ("deployment_not_found", "not_found"):
            return None
        raise RuntimeError(f"Coordinator {operation} refused: {code}")
    if process.returncode != 0:
        raise RuntimeError(f"Coordinator {operation} exited unsuccessfully")
    return response["data"]


def reference(owner):
    return {"path": owner["path"], "name": NAME}


def owned_root(owner):
    root = Path(owner["path"]) / RELATIVE_ROOT
    saved = json.loads((root / "input/owner.json").read_text())
    if saved != owner:
        raise ValueError("Fixture belongs to another governed run or source path")
    return root


def validate_fixture_state(state, owner):
    if state["name"] != NAME or state.get("public") or state.get("domain") or state.get("route_port"):
        raise ValueError("Coordinator returned a different or routed fixture")
    if state.get("source") != "worktree" or state.get("observed_only"):
        raise ValueError("Expected a Coordinator-owned worktree fixture")
    if [component["name"] for component in state["components"]] != ["benchmark"]:
        raise ValueError("Unexpected component ownership in checkpoint fixture")


def stage_python_adapter(destination, prefix=PYTHON_PREFIX):
    prefix = prefix.resolve(strict=True)
    executable = prefix / "bin/python3.12"
    if benchmark.digest(executable) != PYTHON_SHA256:
        raise ValueError("Existing portable Python differs from its approved local identity")
    sources = [executable, *(prefix / "lib").rglob("*")]
    expected = {}
    for path in sources:
        if not path.resolve(strict=True).is_relative_to(prefix):
            raise ValueError("Python adapter contains an external link")
        if path.is_file():
            expected[path.relative_to(prefix).as_posix()] = benchmark.digest(path)
        elif not path.is_dir():
            raise ValueError("Python adapter contains an unsupported file")
    destination.mkdir()
    (destination / "bin").mkdir()
    shutil.copy2(executable, destination / "bin/python3.12")
    shutil.copytree(prefix / "lib", destination / "lib", symlinks=False)
    if benchmark.tree_identity(destination) != expected:
        raise ValueError("Copied Python adapter does not match its source files")
    return {"version": "3.12.13", "executable": "bin/python3.12", "executableSha256": PYTHON_SHA256, "files": expected}


def prepare(owner):
    if coordinator("deployment.status", reference(owner), absent_ok=True) is not None:
        raise ValueError("A prior checkpoint deployment still exists; do not reuse or replace it")
    root = Path(owner["path"]) / RELATIVE_ROOT
    if root.exists() or root.is_symlink():
        raise ValueError("Use a fresh frozen checkout; checkpoint output must not be overwritten")
    archive = ARCHIVE_ROOT / "archive.tar.zst"
    manifest = ARCHIVE_ROOT / "evidence_manifest.json"
    for path in (archive, manifest):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Expected an ordinary authenticated input file")
    if archive.stat().st_size != 617148462 or benchmark.digest(archive) != benchmark.ARCHIVE_SHA256:
        raise ValueError("The source archive differs from its generation-pinned proof")
    if benchmark.digest(manifest) != benchmark.MANIFEST_SHA256:
        raise ValueError("The source manifest differs from its exact proof")
    root.mkdir(parents=True, mode=0o700)
    (root / "input").mkdir()
    (root / "output").mkdir()
    (root / "receipt").mkdir()
    benchmark.write_json(root / "input/owner.json", owner)
    adapter = stage_python_adapter(root / "python")
    benchmark.write_json(root / "input/python-adapter.json", adapter)
    benchmark.write_json(root / "receipt/python-adapter.json", adapter)
    authenticated = root / "authenticated"
    count = extract_verified_evidence_archive(archive, authenticated, compression="zstd",
        expected_manifest=manifest.read_bytes(), include_prefixes=("openfoam/transient/system", "openfoam/transient/constant",
        f"time_directories/{benchmark.START_TIME}"))
    case = root / "input/case"
    case.mkdir()
    shutil.copytree(authenticated / "openfoam/transient/system", case / "system")
    shutil.copytree(authenticated / "openfoam/transient/constant", case / "constant")
    shutil.copytree(authenticated / "time_directories" / benchmark.START_TIME, case / benchmark.START_TIME)
    state = benchmark.time_state(case / benchmark.START_TIME / "uniform/time")
    if state["index"] != benchmark.START_INDEX or abs(state["value"] - float(benchmark.START_TIME)) > 1e-10:
        raise ValueError("Archived checkpoint time/index does not match the measured case")
    for field in benchmark.FIELDS:
        if not (case / benchmark.START_TIME / field).is_file():
            raise ValueError("Checkpoint is missing a required physical field")
    identity = benchmark.tree_identity(case)
    benchmark.write_json(root / "input/case-files.json", identity)
    benchmark.write_json(root / "receipt/input.json", {"owner": owner, "archiveSha256": benchmark.ARCHIVE_SHA256,
        "manifestSha256": benchmark.MANIFEST_SHA256, "authenticatedMembers": count, "checkpoint": state,
        "caseFiles": identity, "originalRanks": 1,
        "benchmarkRanks": [1, 3, 1] if owner.get("experiment") == "serial-mpi" else [3, 3, 3], "acceptedCfd": False})
    print(json.dumps({"prepared": True, "runId": owner["runId"], "authenticatedMembers": count}))


def apply(owner):
    root = owned_root(owner)
    readiness = coordinator("deployment.preflight", reference(owner))
    if not readiness["ready"] or readiness["blockers"]:
        raise ValueError("Coordinator fixture preflight is not ready")
    if coordinator("deployment.status", reference(owner), absent_ok=True) is not None:
        raise ValueError("Refusing to replace an existing fixture")
    benchmark.write_json(root / "apply-intent.json", owner)
    state = coordinator("deployment.apply", reference(owner), timeout=1250,
                        error_receipt=root / "receipt/apply-error.json")
    validate_fixture_state(state, owner)
    benchmark.write_json(root / "deployment.json", state)
    if not state.get("current_generation") or state["state"] != "completed" or any(component["state"] != "completed" for component in state["components"]):
        raise ValueError("Finite native fixture did not complete successfully")
    print(json.dumps({"deploymentId": state["deployment_id"], "generation": state["current_generation"], "state": state["state"]}))


def aligned_coefficients(first, second):
    if len(first) != benchmark.STEPS or len(second) != benchmark.STEPS:
        raise ValueError("The pair has sparse step coverage")
    first_times = [row["time"] for row in first]
    second_times = [row["time"] for row in second]
    if first_times != second_times or any(last <= initial for initial, last in zip(first_times, first_times[1:])):
        raise ValueError("The pair has misaligned physical step times")
    if not all(math.isfinite(row[name]) for rows in (first, second) for row in rows for name in ("time", "Cl", "Cd", "Cm")):
        raise ValueError("The measured coefficient interval diverged")
    return {name: max(abs(initial[name] - last[name]) for initial, last in zip(first, second)) for name in ("Cl", "Cd", "Cm")}


def field_delta(first, second, shape, field):
    comparison = benchmark.field_comparison(first, second, shape, field)
    return {key: comparison[key] for key in ("internal", "boundary")}


def verify(owner):
    root = owned_root(owner)
    report = json.loads((root / "output/report.json").read_text())
    if report["runId"] != owner["runId"] or report["acceptedCfd"] or report["published"] or report["fixedSteps"] != 63:
        raise ValueError("Unexpected publication or run identity in benchmark report")
    arms = {arm["arm"]: arm for arm in report["arms"]}
    experiment = owner.get("experiment", "placement")
    if report.get("experiment", "placement") != experiment or list(arms) != ["A1", "B", "A2"]:
        raise ValueError("Missing arm or changed frozen decomposition")
    if experiment == "serial-mpi":
        proof = report.get("initialReconstruction")
        if not proof or proof.get("valuesIdentical") is not True or set(proof["fields"]) != set(benchmark.FIELDS):
            raise ValueError("Missing exact global initial reconstruction proof")
        if any(value["originalValueSha256"] != value["candidateValueSha256"] for value in proof["fields"].values()):
            raise ValueError("Initial reconstructed values changed")
        for name, arm in arms.items():
            if arm["ranks"] != (3 if name == "B" else 1) or arm["inputSha256"] != report["inputIdentities"]["parallel" if name == "B" else "global"]:
                raise ValueError("Rank-count arm differs from its approved inputs")
    elif experiment != "placement" or len({arm["inputSha256"] for arm in arms.values()}) != 1:
        raise ValueError("Missing arm or changed frozen decomposition")
    comparisons = {}
    for baseline in ("A1", "A2"):
        left, right = arms[baseline], arms["B"]
        differences = aligned_coefficients(left["coefficients"], right["coefficients"])
        fields = {}
        value_hashes = {}
        identical = True
        for label in ("start", "end"):
            if left["boundaries"][label]["time"] != right["boundaries"][label]["time"]:
                raise ValueError("The pair has different written physical endpoints")
            for rank in (["global"] if experiment == "serial-mpi" else ["0", "1", "2"]):
                directory = "global" if rank == "global" else f"processor{rank}"
                original = left["snapshots"][label][rank]
                candidate = right["snapshots"][label][rank]
                if original["shape"] != candidate["shape"] or original["state"] != candidate["state"]:
                    raise ValueError("The pair has different written mesh/time states")
                for field in benchmark.FIELDS:
                    first = root / "output/snapshots" / baseline / label / directory / field
                    second = root / "output/snapshots/B" / label / directory / field
                    if benchmark.digest(first) != original["files"][field]["sha256"] or benchmark.digest(second) != candidate["files"][field]["sha256"]:
                        raise ValueError("A validated endpoint copy changed")
                    comparison = benchmark.field_comparison(first, second, original["shape"], field)
                    fields[f"{label}/{directory}/{field}"] = {key: comparison[key] for key in ("internal", "boundary")}
                    value_hashes[f"{label}/{directory}/{field}"] = {key: comparison[key] for key in ("originalValueSha256", "candidateValueSha256")}
                    identical = identical and original["files"][field]["sha256"] == candidate["files"][field]["sha256"]
        comparisons[baseline] = {"baselineWallSeconds": left["measurement"]["wallSeconds"],
            "boundWallSeconds": right["measurement"]["wallSeconds"],
            "wallRatio": left["measurement"]["wallSeconds"] / right["measurement"]["wallSeconds"],
            "baselineRankCpuSeconds": left["measurement"]["rankCpuSeconds"], "boundRankCpuSeconds": right["measurement"]["rankCpuSeconds"],
            "baselinePrelude": left["prelude"], "boundPrelude": right["prelude"],
            "maxAbsoluteCoefficientDelta": differences, "maxAbsoluteFieldDeltaAtBothWrites": fields,
            "fieldBytesIdentical": identical, "fieldValueHashes": value_hashes,
            "fieldValuesIdentical": all(value["originalValueSha256"] == value["candidateValueSha256"] for value in value_hashes.values())}
        if experiment == "serial-mpi":
            comparisons[baseline]["parallelWallSeconds"] = comparisons[baseline].pop("boundWallSeconds")
            comparisons[baseline]["parallelRankCpuSeconds"] = comparisons[baseline].pop("boundRankCpuSeconds")
            comparisons[baseline]["parallelPrelude"] = comparisons[baseline].pop("boundPrelude")
            comparisons[baseline]["parallelToSerialCpuCostRatio"] = right["measurement"]["rankCpuSeconds"] / left["measurement"]["rankCpuSeconds"]
            comparisons[baseline]["idealThreeCoreParallelEfficiency"] = comparisons[baseline]["wallRatio"] / 3
    report["comparisons"] = comparisons
    report["numericalEquivalence"] = "identical" if all(item["fieldValuesIdentical"] and not any(item["maxAbsoluteCoefficientDelta"].values()) for item in comparisons.values()) else "requires_review"
    benchmark.write_json(root / "receipt/comparison.json", report)
    print(json.dumps({"kind": report["kind"], "numericalEquivalence": report["numericalEquivalence"], "acceptedCfd": False}))


def cleanup(owner):
    root = Path(owner["path"]) / RELATIVE_ROOT
    if not (root / "apply-intent.json").exists():
        print(json.dumps({"cleanup": "no_runtime_requested"}))
        return
    owned_root(owner)
    if json.loads((root / "apply-intent.json").read_text()) != owner:
        raise ValueError("Cleanup intent belongs to another run")
    state = coordinator("deployment.status", reference(owner), absent_ok=True)
    if state is None:
        print(json.dumps({"cleanup": "already_absent"}))
        return
    validate_fixture_state(state, owner)
    exact = {"deployment_id": state["deployment_id"]}
    benchmark.write_json(root / "receipt/runtime-status.json", state)
    try:
        logs = coordinator("deployment.logs", {**exact, "component": "benchmark", "tail_lines": 200},
                           error_receipt=root / "receipt/runtime-log-error.json")
        benchmark.write_json(root / "receipt/runtime-log.json", logs)
    except (RuntimeError, subprocess.TimeoutExpired, ValueError, OSError) as error:
        if not (root / "receipt/runtime-log-error.json").exists():
            benchmark.write_json(root / "receipt/runtime-log-error.json", {"observationError": type(error).__name__,
                                 "detail": str(error)[:1000]})
    coordinator("deployment.stop", exact)
    removed = coordinator("deployment.remove", {**exact, "delete_data": True})
    if coordinator("deployment.status", exact, absent_ok=True) is not None:
        raise ValueError("Coordinator did not confirm exact fixture removal")
    benchmark.write_json(root / "receipt/cleanup.json", {"deploymentId": state["deployment_id"], "result": removed})
    print(json.dumps({"cleanup": "removed", "deploymentId": state["deployment_id"]}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "apply", "verify", "cleanup"))
    args = parser.parse_args()
    {"prepare": prepare, "apply": apply, "verify": verify, "cleanup": cleanup}[args.action](governed_owner())


if __name__ == "__main__":
    main()
