"""Bounded native proof of an early MPI budget stop; never publishes CFD results.

Run through the march-checkpoint Coordinator graph, not directly on the host.
The source case and all production numerical dictionaries remain byte-identical.
Only the dormant continuation copy changes startFrom to latestTime.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


CASE_SHA256 = "e29190311fe6704bfd0230d58eb8f6a6f20e1279779ab48eb7058ef1a2f6330e"
SOURCE_SHA256 = "d2f4b4a056e38a8d96a268c00492eaa599d34c136965d3eba097560d5816c6d2"
RANKS = 4
WRITE_INTERVAL = 0.003703703703703704
NATIVE_SECONDS = 285
RESTART_FIELDS = ("U", "p", "T", "k", "omega", "nut", "alphat", "phi", "rho")
OPT_IN = ("-opt-switch", "stopAtWriteNowSignal=12")
FROZEN_ROOTS = ("0", "constant", "system")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)


def tree_identity(root):
    root = Path(root)
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Unexpected link in frozen input: {path}")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path)
    return result


def source_identity(root):
    result = {}
    for path in sorted(Path(root).rglob("*")):
        relative = path.relative_to(root)
        if {"__pycache__", ".serena"}.intersection(relative.parts) or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise ValueError("Unexpected link in candidate application source")
        if path.is_file():
            result[relative.as_posix()] = digest(path)
    return result


def positive_times(root, after=0.0):
    result = {}
    for child in Path(root).iterdir():
        try:
            value = float(child.name)
        except ValueError:
            continue
        if child.is_dir() and math.isfinite(value) and value > after:
            if value in result:
                raise ValueError("Ambiguous numeric checkpoint names")
            result[value] = child
    return result


def common_checkpoint(case, after=0.0):
    """Authenticate every required rank field, not just time-directory names."""
    import checkpoint_placement as fields

    roots = [case / f"processor{rank}" for rank in range(RANKS)]
    times = [positive_times(root, after) for root in roots]
    common = set.intersection(*(set(item) for item in times))
    if not common:
        raise ValueError("No common positive checkpoint on all four ranks")
    if any(set(item) != common for item in times):
        raise ValueError("Ranks have incomplete or inconsistent checkpoint times")
    value = max(common)
    receipt = {}
    for rank, root in enumerate(roots):
        directory = times[rank][value]
        shape = fields.mesh_shape(root)
        for name in RESTART_FIELDS:
            fields.parsed_field(directory / name, shape, name)
        fields.complete_ascii(directory / "uniform/time")
        state = fields.time_state(directory / "uniform/time")
        if abs(state["value"] - value) > 1e-11 or state["index"] <= 0:
            raise ValueError("Checkpoint time metadata differs from its directory")
        receipt[str(rank)] = {"timeState": state, "files": tree_identity(directory)}
    states = [row["timeState"] for row in receipt.values()]
    if any(state != states[0] for state in states[1:]):
        raise ValueError("Ranks disagree on checkpoint step/time/deltaT")
    return {"time": value, "ranks": receipt}


def process_identity(pid):
    proc = Path("/proc") / str(pid)
    try:
        stat = (proc / "stat").read_text().split(") ", 1)[1].split()
        return {"pid": pid, "startTicks": int(stat[19]), "state": stat[0],
                "command": (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode().strip(),
                "cwd": str((proc / "cwd").resolve(strict=True))}
    except (FileNotFoundError, ProcessLookupError):
        return None


def rank_entry(case, receipts, opted_in):
    rank = int(os.environ["OMPI_COMM_WORLD_RANK"])
    if int(os.environ["OMPI_COMM_WORLD_SIZE"]) != RANKS or rank not in range(RANKS):
        raise ValueError("Expected exactly four native MPI ranks")
    os.chdir(case)
    write_json(receipts / f"rank-{rank}.json", {"rank": rank, **process_identity(os.getpid())})
    solver = shutil.which("rhoPimpleFoam")
    if solver is None:
        raise ValueError("Native rhoPimpleFoam is unavailable")
    os.execv(solver, [solver, "-parallel", *OPT_IN] if opted_in else [solver, "-parallel"])


def stop_owned(process):
    """Failure containment only; successful clean-stop proof never uses this."""
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)


def finite(command, case, log, deadline, seconds=30):
    remaining = min(seconds, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError("Native verification exhausted its shared wall budget")
    started = time.monotonic()
    with log.open("xb") as output:
        process = subprocess.Popen(command, cwd=case, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            process.wait(timeout=remaining)
        finally:
            stop_owned(process)
    return {"command": command, "returncode": process.returncode, "log": log.name,
            "wallSeconds": time.monotonic() - started}


def coefficients(case, after):
    from airfoilfoam.tasks import coefficient_tail

    result = []
    for path in sorted((case / "postProcessing").rglob("coefficient*.dat")):
        result.extend((t, cl) for t, cl in coefficient_tail(path)
                      if t > after and math.isfinite(t) and math.isfinite(cl))
    return sorted(set(result))


def run_march(case, store, job_id, output, deadline, *, opted_in, after=0.0):
    from airfoilfoam import pipeline, tasks

    started = time.monotonic()
    deadline = min(deadline, started + 75)
    receipts = output / "rank-processes"
    receipts.mkdir(parents=True)
    pipeline.clear_march_markers(case)
    pipeline.write_march_budget_marker(case, end_t=0.06666666666666667,
                                      budget_s=75, wall_start=time.time(), native_write_stop=opted_in)
    command = ["mpirun", "--allow-run-as-root", "--bind-to", "none", "--use-hwthread-cpus", "-np", str(RANKS),
               sys.executable, str(Path(__file__).resolve()), "rank", "--case", str(case),
               "--receipts", str(receipts), *(["--opted-in"] if opted_in else [])]
    log = output / "rhoPimpleFoam.log"
    request = None
    ranks = []
    with log.open("xb") as stdout:
        process = subprocess.Popen(command, cwd=case, stdout=stdout, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            while time.monotonic() < deadline:
                rows = coefficients(case, after)
                if request is None and len(rows) >= 3:
                    if rows[-1][0] >= WRITE_INTERVAL:
                        raise ValueError("Stop trigger arrived after the first scheduled write")
                    if any(positive_times(case / f"processor{rank}", after) for rank in range(RANKS)):
                        raise ValueError("A field checkpoint already existed before the stop trigger")
                    rank_files = sorted(receipts.glob("rank-*.json"))
                    if len(rank_files) != RANKS:
                        raise ValueError("Missing native rank identities")
                    ranks = [json.loads(path.read_text()) for path in rank_files]
                    if ({row["rank"] for row in ranks} != set(range(RANKS))
                            or len({row["pid"] for row in ranks}) != RANKS):
                        raise ValueError("Duplicate or inconsistent native rank identities")
                    observed = [process_identity(row["pid"]) for row in ranks]
                    if any(not row or Path(row["command"].split()[0]).name != "rhoPimpleFoam"
                           or row["cwd"] != str(case) for row in observed):
                        raise ValueError("Rank wrapper did not exec the real native solver")
                    request = {"coefficients": rows, "lastTime": rows[-1][0],
                               "rankProcesses": observed, "beforeFirstScheduledWrite": True}
                    write_json(output / "trigger.json", request)
                    # The real production helper discovers the real ranks through JobStore.
                    tasks._stop_hopeless_case(store, job_id, case, "native verification short-budget stop")
                elif request is not None and process.poll() is None:
                    tasks._stop_hopeless_case(store, job_id, case, "native verification short-budget stop")
                if process.poll() is not None:
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError("Native march did not stop within its 75-second phase limit")
            if request is None:
                raise ValueError("Solver exited before real coefficient history and stop request")
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
            live = [process_identity(row["pid"]) for row in ranks]
            if any(row and row["startTicks"] == original["startTicks"]
                   for row, original in zip(live, ranks)):
                raise ValueError("MPI launcher exited while a native solver rank survived")
            marker = pipeline.read_march_stop_record(case)
            if not marker or not pipeline.read_march_stop(case):
                raise ValueError("Production stop marker was not persisted")
            result = {"command": command, "returncode": process.returncode, "trigger": request,
                      "stopRecord": marker, "allRanksExited": True,
                      "coefficients": coefficients(case, after), "wallSeconds": time.monotonic() - started}
            write_json(output / "march.json", result)
            if opted_in:
                if process.returncode != 0 or marker.get("write_stop", {}).get("phase") != "write_requested":
                    raise ValueError("Native stop escalated or a rank did not exit cleanly")
                if not re.search(r"^End\s*$", log.read_text(), re.M):
                    raise ValueError("Native solver did not report normal completion")
            return result
        finally:
            stop_owned(process)


def reconstruct(case, output, deadline):
    import checkpoint_placement as fields

    checkpoint = common_checkpoint(case)
    result = finite(["reconstructPar", "-newTimes"], case, output / "reconstructPar.log", deadline)
    if result["returncode"] != 0:
        raise ValueError("reconstructPar -newTimes failed")
    directory = positive_times(case)[checkpoint["time"]]
    shape = fields.mesh_shape(case)
    for name in RESTART_FIELDS:
        fields.parsed_field(directory / name, shape, name)
    result.update({"checkpoint": checkpoint, "reconstructedFiles": tree_identity(directory)})
    write_json(output / "reconstruction.json", result)
    return result


def reject_short_history(case):
    """Check the real quality gate; a restart checkpoint is not accepted CFD."""
    from airfoilfoam import pipeline

    paths = pipeline._coeff_files(case)
    history = None
    try:
        history = pipeline.compute_force_history(paths, 90.0, 0.5, 0.0, target_cycles=3, alpha_deg=-4.0)
    except (ValueError, RuntimeError):
        pass  # Insufficient real history is expected, never replaced with a fixture.
    quality = pipeline.evaluate_urans_quality(case, history, 90.0, 0.5, min_cycles=3)
    if quality.ok:
        raise ValueError("Short native checkpoint was incorrectly accepted as a valid URANS result")
    return {"qualityOk": quality.ok, "reason": quality.reason,
            "boundary": "production URANS quality gate; no ingestion or publication requested"}


def native(input_root, output):
    started = time.monotonic()
    deadline = started + NATIVE_SECONDS
    if not all(os.environ.get(key) for key in ("DC2_DEPLOYMENT", "DC2_COMPONENT", "DC2_GENERATION")):
        raise ValueError("Use the declared Coordinator finite Compose fixture")
    if os.environ.get("WM_PROJECT_VERSION") != "v2606":
        raise ValueError("Native verification requires the approved OpenCFD 2606 runtime")
    owner = json.loads((input_root / "owner.json").read_text())
    expected = json.loads((input_root / "files.json").read_text())
    frozen = {name: tree_identity(input_root / "case" / name) for name in FROZEN_ROOTS}
    if source_identity(input_root / "src") != expected["source"]:
        raise ValueError("Candidate production source differs from its staged receipt")
    if tree_identity(input_root / "case") != expected["case"]:
        raise ValueError("Native source case differs from its authenticated receipt")
    if tree_identity(input_root / "driver") != expected["driver"]:
        raise ValueError("Native driver differs from its staged receipt")
    if tree_identity(input_root / "opt") != expected["thermophysics"]:
        raise ValueError("Original thermophysics library differs from its staged receipt")
    library = "xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so"
    if digest(Path("/opt") / library) != expected["thermophysics"][library]:
        raise ValueError("Mounted thermophysics library is not the exact production library")
    from airfoilfoam import pipeline, tasks
    from airfoilfoam.config import Settings
    from airfoilfoam.storage import JobStore

    if any(not Path(module.__file__).resolve().is_relative_to(input_root / "src")
           for module in (pipeline, tasks)):
        raise ValueError("Production helper import came from the old image instead of candidate source")
    if pipeline.MARCH_WRITE_STOP_SIGNAL != 12:
        raise ValueError("Production native stop opt-in changed from the authenticated signal contract")
    store = JobStore(Settings(_env_file=None, data_dir=output / "data", cache_dir=output / "cache"))
    report = {"owner": owner, "passed": False, "acceptedCfd": False, "ranks": RANKS,
              "openfoamVersion": os.environ["WM_PROJECT_VERSION"],
              "caseSha256": CASE_SHA256, "sourcePackageSha256": SOURCE_SHA256,
              "nativeIdentity": {name: {"path": shutil.which(name), "sha256": digest(shutil.which(name))}
                                 for name in ("rhoPimpleFoam", "decomposePar", "reconstructPar")},
              "phases": {}}
    write_json(output / "report.json", report)
    try:
        # Fresh original copies: no fake histories, retuning, or scheduled-write changes.
        for name, opted_in in (("baseline", False), ("clean", True)):
            phase = output / name
            phase.mkdir()
            job_id = f"march-checkpoint-{name}"
            case = store.case_dir(job_id, "c0p5_u90") / "transient_a0"
            case.parent.mkdir(parents=True)
            shutil.copytree(input_root / "case", case)
            decomposition = finite(["decomposePar", "-force"], case, phase / "decomposePar.log", deadline)
            if decomposition["returncode"] != 0:
                raise ValueError("Original four-rank decomposition failed")
            result = run_march(case, store, job_id, phase, deadline, opted_in=opted_in)
            result["decomposition"] = decomposition
            if name == "baseline":
                if any(positive_times(case / f"processor{rank}") for rank in range(RANKS)):
                    raise ValueError("Forced baseline unexpectedly saved a positive checkpoint")
                result["reconstruction"] = finite(["reconstructPar", "-newTimes"], case,
                                                   phase / "reconstructPar.log", deadline)
                if positive_times(case):
                    raise ValueError("Missing-checkpoint baseline unexpectedly reconstructed evolved fields")
                result["missingCheckpointReproduced"] = True
            else:
                result["reconstruction"] = reconstruct(case, phase, deadline)
                result["publicationGate"] = reject_short_history(case)
            for root in FROZEN_ROOTS:
                if tree_identity(case / root) != frozen[root]:
                    raise ValueError(f"Native execution changed original {root} numerical inputs")
            report["phases"][name] = result
            write_json(output / "report.json", report)
        clean = store.case_dir("march-checkpoint-clean", "c0p5_u90") / "transient_a0"
        resume = store.case_dir("march-checkpoint-continuation", "c0p5_u90") / "transient_a0"
        resume.parent.mkdir(parents=True)
        shutil.copytree(clean, resume)
        saved = report["phases"]["clean"]["reconstruction"]["checkpoint"]["time"]
        checkpoint_before = common_checkpoint(resume)
        control = resume / "system/controlDict"
        original = control.read_bytes()
        changed, count = re.subn(rb"\bstartFrom\s+startTime\s*;", b"startFrom       latestTime;", original)
        if count != 1:
            raise ValueError("Cannot select the existing checkpoint in the dormant continuation copy")
        control.write_bytes(changed)  # Solver is not running; never mutate a live dictionary.
        shutil.rmtree(resume / "postProcessing")
        phase = output / "continuation"
        phase.mkdir()
        result = run_march(resume, store, "march-checkpoint-continuation", phase, deadline,
                           opted_in=True, after=saved)
        if common_checkpoint(resume)["time"] <= saved:
            raise ValueError("Continuation did not save a strictly newer real field checkpoint")
        for rank in range(RANKS):
            old = positive_times(resume / f"processor{rank}")[saved]
            if tree_identity(old) != checkpoint_before["ranks"][str(rank)]["files"]:
                raise ValueError("Continuation rewrote its immutable starting checkpoint")
        result["reconstruction"] = reconstruct(resume, phase, deadline)
        result["publicationGate"] = reject_short_history(resume)
        result["startedFromCheckpoint"] = saved
        result["offlineControlChange"] = {"entry": "startFrom", "value": "latestTime",
                                           "beforeSha256": hashlib.sha256(original).hexdigest(),
                                           "afterSha256": digest(control)}
        for root in ("0", "constant"):
            if tree_identity(resume / root) != frozen[root]:
                raise ValueError("Continuation changed initial fields or shared physical/mesh inputs")
        if control.read_bytes() != changed:
            raise ValueError("Live continuation controlDict was modified")
        expected_system = {**frozen["system"], "controlDict": digest(control)}
        if tree_identity(resume / "system") != expected_system:
            raise ValueError("Continuation changed another numerical dictionary")
        report["phases"]["continuation"] = result
        if list((output / "data").rglob("result.json")):
            raise ValueError("Native verification unexpectedly published a solver result")
        report["passed"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        report["wallSeconds"] = time.monotonic() - started
        write_json(output / "report.json", report)
    print(json.dumps({"passed": True, "wallSeconds": report["wallSeconds"], "acceptedCfd": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    run = commands.add_parser("native")
    run.add_argument("--input", type=Path, default=Path("/input"))
    run.add_argument("--output", type=Path, default=Path("/output"))
    rank = commands.add_parser("rank")
    rank.add_argument("--case", required=True, type=Path)
    rank.add_argument("--receipts", required=True, type=Path)
    rank.add_argument("--opted-in", action="store_true")
    args = parser.parse_args()
    if args.action == "rank":
        rank_entry(args.case, args.receipts, args.opted_in)
    else:
        native(args.input, args.output)


if __name__ == "__main__":
    main()
