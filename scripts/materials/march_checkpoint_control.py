"""Stage, run, verify and remove only the governed native checkpoint fixture."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile

from scripts.materials import march_checkpoint as proof


NAME = "march-checkpoint"
ROOT = Path(".codex-artifacts/march-checkpoint-native")
INPUT = Path(".codex-artifacts/march-checkpoint-20261112")
HANDLER = "./usr/lib/openfoam/openfoam2606/src/OSspecific/POSIX/signals/sigStopAtWriteNow.cxx"


def coordinator(operation, params, *, absent_ok=False, timeout=60, error_receipt=None):
    process = subprocess.run(["devcoordinator2", "--client", "codex", "call", operation,
                              "--params", json.dumps(params)], capture_output=True, text=True, timeout=timeout)
    response = json.loads(process.stdout)
    if not response.get("ok"):
        code = response.get("error", {}).get("code")
        if absent_ok and code in ("deployment_not_found", "not_found"):
            return None
        if error_receipt:
            proof.write_json(error_receipt, {"operation": operation, "response": response})
        raise RuntimeError(f"Coordinator {operation} refused: {code}")
    if process.returncode:
        raise RuntimeError(f"Coordinator {operation} exited unsuccessfully")
    return response["data"]


def governed_owner():
    required = ("DEVCOORDINATOR_RUN_ID", "DEVCOORDINATOR_CHECK_NAME", "DEVCOORDINATOR_DIAGNOSTIC_FD")
    if not all(os.environ.get(key) for key in required):
        raise ValueError("Fixture actions require an admitted Coordinator check")
    os.fstat(int(os.environ["DEVCOORDINATOR_DIAGNOSTIC_FD"]))
    return {"runId": os.environ["DEVCOORDINATOR_RUN_ID"], "path": str(Path.cwd().resolve()),
            "name": NAME, "driverSha256": proof.digest(Path(proof.__file__)),
            "controllerSha256": proof.digest(Path(__file__)),
            "composeSha256": proof.digest(Path("compose.march-checkpoint.yml")),
            "source": proof.source_identity(Path("src/airfoilfoam"))}


def reference(owner):
    return {"path": owner["path"], "name": NAME}


def owned_root(owner):
    root = Path(owner["path"]) / ROOT
    if json.loads((root / "input/owner.json").read_text()) != owner:
        raise ValueError("Fixture belongs to another run or candidate source")
    return root


def fixture_state(state):
    if (state["name"] != NAME or state.get("public") or state.get("domain") or state.get("route_port")
            or state.get("source") != "worktree" or state.get("observed_only")
            or [row["name"] for row in state["components"]] != ["native"]):
        raise ValueError("Unexpected native fixture ownership or routing")


def extract_case(archive, destination):
    """Only authenticated regular 0/constant/system/library members are admitted."""
    total = 0
    with tarfile.open(archive, "r:gz") as bundle:
        names = set()
        for member in bundle:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or ".." in name.parts or not name.parts
                    or name.parts[0] not in (*proof.FROZEN_ROOTS, "opt")
                    or member.name in names or not (member.isdir() or member.isfile())):
                raise ValueError("Unexpected member in the exact production case archive")
            names.add(member.name)
            total += member.size
            if total > 268435456:
                raise ValueError("Production input exceeds the bounded fixture size")
            target = destination / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)


def prepare(owner):
    if coordinator("deployment.status", reference(owner), absent_ok=True) is not None:
        raise ValueError("A native fixture already exists; never replace another run")
    source = Path(owner["path"]) / INPUT
    for name, expected in (("native-case.tar.gz", proof.CASE_SHA256), ("source.deb", proof.SOURCE_SHA256)):
        path = source / name
        if path.is_symlink() or proof.digest(path) != expected:
            raise ValueError(f"Exact read-only input changed: {name}")
    root = Path(owner["path"]) / ROOT
    if root.exists():
        # Keep each completed run immutable while allowing a fresh subsequent run.
        previous = json.loads((root / "input/owner.json").read_text())
        if (not (root / "receipt/cleanup.json").is_file()
                or not re.fullmatch(r"[A-Za-z0-9-]+", previous["runId"])
                or previous["path"] != owner["path"] or previous["name"] != NAME):
            raise ValueError("Prior native artifacts lack an exact cleanup receipt")
        history = root.with_name(root.name + "-history") / previous["runId"]
        history.parent.mkdir(exist_ok=True)
        if history.exists():
            raise ValueError("Refusing to replace a historical native proof")
        root.rename(history)
    root.mkdir(mode=0o700)
    for directory in ("input", "output", "receipt"):
        (root / directory).mkdir()
    proof.write_json(root / "input/owner.json", owner)
    extracted = root / "input/extracted"
    extract_case(source / "native-case.tar.gz", extracted)
    case = root / "input/case"
    case.mkdir()
    for name in proof.FROZEN_ROOTS:
        shutil.move(extracted / name, case / name)
    shutil.move(extracted / "opt", root / "input/opt")
    extracted.rmdir()
    control = (case / "system/controlDict").read_text()
    if (not re.search(r"\bapplication\s+rhoPimpleFoam\s*;", control)
            or not re.search(r"\bwriteControl\s+runTime\s*;", control)
            or float(re.search(r"\bwriteInterval\s+([^;]+);", control)[1]) != proof.WRITE_INTERVAL
            or not re.search(r"\bnumberOfSubdomains\s+4\s*;", (case / "system/decomposeParDict").read_text())):
        raise ValueError("The original numerical case/rank/write contract changed")
    shutil.copytree(Path(owner["path"]) / "src/airfoilfoam", root / "input/src/airfoilfoam",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".serena"))
    driver = root / "input/driver"
    driver.mkdir()
    for name in ("march_checkpoint.py", "checkpoint_placement.py"):
        shutil.copy2(Path(__file__).with_name(name), driver / name)
    archive = subprocess.run(["dpkg-deb", "--fsys-tarfile", str(source / "source.deb")],
                             capture_output=True, check=True, timeout=20).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        handler = bundle.extractfile(HANDLER).read()
    if not all(value in handler for value in (b"stopAtWriteNowSignal", b"saWriteNow", b"optimisationSwitch")):
        raise ValueError("Authenticated source package lacks the expected native stop handler")
    (root / "receipt/sigStopAtWriteNow.cxx").write_bytes(handler)
    observation = source / "baseline-observation.json"
    if observation.is_file():
        shutil.copy2(observation, root / "receipt/baseline-observation.json")
    files = {"case": proof.tree_identity(case), "source": proof.tree_identity(root / "input/src"),
             "driver": proof.tree_identity(driver), "thermophysics": proof.tree_identity(root / "input/opt")}
    # Check the source once more after staging so concurrent edits cannot create a mixed candidate.
    staged_source = {key.removeprefix("airfoilfoam/"): value for key, value in files["source"].items()}
    if staged_source != owner["source"]:
        raise ValueError("Production source changed while staging the native candidate")
    proof.write_json(root / "input/files.json", files)
    proof.write_json(root / "receipt/inputs.json", {"owner": owner, "files": files,
                     "caseSha256": proof.CASE_SHA256, "sourcePackageSha256": proof.SOURCE_SHA256,
                     "baselineObservationSha256": proof.digest(observation) if observation.exists() else None})
    print(json.dumps({"prepared": True, "runId": owner["runId"]}))


def apply(owner):
    root = owned_root(owner)
    preflight = coordinator("deployment.preflight", reference(owner))
    if not preflight["ready"] or preflight["blockers"]:
        raise ValueError("Native fixture preflight is not ready")
    if coordinator("deployment.status", reference(owner), absent_ok=True) is not None:
        raise ValueError("Refusing to replace an existing native fixture")
    proof.write_json(root / "apply-intent.json", owner)
    state = coordinator("deployment.apply", reference(owner), timeout=345,
                        error_receipt=root / "receipt/apply-error.json")
    fixture_state(state)
    proof.write_json(root / "receipt/deployment.json", state)
    if state["state"] != "completed" or any(row["state"] != "completed" for row in state["components"]):
        raise ValueError("Finite native fixture did not complete successfully")
    print(json.dumps({"deploymentId": state["deployment_id"], "state": state["state"]}))


def verify(owner):
    root = owned_root(owner)
    report = json.loads((root / "output/report.json").read_text())
    if (report["owner"] != owner or report["passed"] is not True or report["acceptedCfd"] is not False
            or report["ranks"] != proof.RANKS or report["wallSeconds"] >= 300
            or report["caseSha256"] != proof.CASE_SHA256 or report["sourcePackageSha256"] != proof.SOURCE_SHA256
            or set(report["phases"]) != {"baseline", "clean", "continuation"}):
        raise ValueError("Native proof is incomplete, too slow, or belongs to another source")
    baseline, clean, continuation = (report["phases"][name] for name in ("baseline", "clean", "continuation"))
    if baseline["missingCheckpointReproduced"] is not True:
        raise ValueError("Baseline did not reproduce the missing-checkpoint defect")
    for phase in (clean, continuation):
        if (phase["returncode"] != 0 or phase["allRanksExited"] is not True
                or phase["stopRecord"]["write_stop"]["phase"] != "write_requested"
                or phase["reconstruction"]["returncode"] != 0
                or phase["publicationGate"]["qualityOk"] is not False
                or set(phase["reconstruction"]["checkpoint"]["ranks"]) != {"0", "1", "2", "3"}):
            raise ValueError("A native clean stop, reconstruction, or rejection gate did not pass")
    saved = clean["reconstruction"]["checkpoint"]["time"]
    if not 0 < saved < proof.WRITE_INTERVAL or continuation["startedFromCheckpoint"] != saved:
        raise ValueError("Clean stop did not produce the exact early continuation checkpoint")
    if continuation["reconstruction"]["checkpoint"]["time"] <= saved:
        raise ValueError("Real continuation did not evolve from its saved fields")
    proof.write_json(root / "receipt/verification.json", report)
    print(json.dumps({"verified": True, "wallSeconds": report["wallSeconds"],
                      "checkpointTime": saved, "acceptedCfd": False}))


def cleanup(owner):
    root = Path(owner["path"]) / ROOT
    if not (root / "apply-intent.json").exists():
        print(json.dumps({"cleanup": "no_runtime_requested"}))
        return
    owned_root(owner)
    state = coordinator("deployment.status", reference(owner), absent_ok=True)
    if state is None:
        print(json.dumps({"cleanup": "already_absent"}))
        return
    fixture_state(state)
    exact = {"deployment_id": state["deployment_id"]}
    proof.write_json(root / "receipt/runtime-status.json", state)
    try:
        logs = coordinator("deployment.logs", {**exact, "component": "native", "tail_lines": 100},
                           error_receipt=root / "receipt/runtime-log-error.json")
        proof.write_json(root / "receipt/runtime-log.json", logs)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        proof.write_json(root / "receipt/log-observation.json", {"error": str(error)[:1000]})
    coordinator("deployment.stop", exact)
    removed = coordinator("deployment.remove", {**exact, "delete_data": True})
    if coordinator("deployment.status", exact, absent_ok=True) is not None:
        raise ValueError("Native fixture removal was not confirmed")
    proof.write_json(root / "receipt/cleanup.json", {"deploymentId": state["deployment_id"], "result": removed})
    print(json.dumps({"cleanup": "removed", "deploymentId": state["deployment_id"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "apply", "verify", "cleanup"))
    args = parser.parse_args()
    {"prepare": prepare, "apply": apply, "verify": verify, "cleanup": cleanup}[args.action](governed_owner())


if __name__ == "__main__":
    main()
