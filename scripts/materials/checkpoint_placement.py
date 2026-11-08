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


IMAGE = "opencfd/openfoam-run:2606@sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb"
ARCHIVE_SHA256 = "59db43a171f0907a42f921df26783bfaa5647b7f62b75ff8c44f906af9e2e7d2"
MANIFEST_SHA256 = "e0fbf4fd5de7c6449bf2f14f48c8bddd3439fb7d8d47a74f2b68f7c5ebecb566"
START_TIME = "600.8072238981756"
MEASUREMENT_START_TIME = "600.8088772315118"
END_TIME = "600.8105572315147"
START_INDEX = 31550
PRELUDE_STEPS = 62
STEPS = 63
END_STEP = PRELUDE_STEPS + STEPS
FIELDS = ("U", "p", "phi", "k", "omega", "nut")
FOAM_FOOTER = b"// ************************************************************************* //"
BINARY_HASHES = {
    "simpleFoam": "36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e",
    "pimpleFoam": "3153b175918b4f1983e01e27b05b41872c39429e2831a9db8647a2b9295a02c3",
}


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    with Path(path).open("x") as output:
        json.dump(value, output, indent=2, allow_nan=False)
        output.write("\n")


def tree_identity(root):
    root = Path(root)
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Benchmark inputs must contain only ordinary files and directories")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path)
    if not result:
        raise ValueError("Empty benchmark input")
    return result


def quota_cpus(text):
    quota, period = text.split()
    if quota == "max" or int(period) <= 0:
        raise ValueError("A finite three-CPU container quota is required")
    count = int(quota) / int(period)
    if count != 3:
        raise ValueError(f"Expected exactly three quota CPUs, observed {count}")
    return count


def distinct_cores(allowed, topology_root=Path("/sys/devices/system/cpu")):
    selected = []
    seen = set()
    topology = []
    for cpu in sorted(allowed):
        root = topology_root / f"cpu{cpu}" / "topology"
        package = int((root / "physical_package_id").read_text())
        core = int((root / "core_id").read_text())
        siblings = (root / "thread_siblings_list").read_text().strip()
        topology.append({"cpu": cpu, "package": package, "core": core, "siblings": siblings})
        if (package, core) not in seen:
            selected.append(cpu)
            seen.add((package, core))
    if len(selected) < 3:
        raise ValueError("The allowed CPU set has fewer than three physical cores")
    return selected[:3], topology


def time_state(path):
    text = Path(path).read_text()
    result = {}
    for name in ("value", "index", "deltaT", "deltaT0"):
        matched = re.search(r"(?m)^\s*" + name + r"\s+([^;]+);", text)
        if not matched:
            raise ValueError(f"Incomplete checkpoint time state: {name}")
        result[name] = int(matched.group(1)) if name == "index" else float(matched.group(1))
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("Non-finite checkpoint time state")
    return result


def validate_endpoint(state, relative_step=END_STEP):
    if relative_step not in (PRELUDE_STEPS, END_STEP):
        raise ValueError("Only the fixed 62/125-step write boundaries are measurable")
    expected_time = {PRELUDE_STEPS: MEASUREMENT_START_TIME, END_STEP: END_TIME}[relative_step]
    if not math.isfinite(state["value"]) or state["index"] != START_INDEX + relative_step or abs(state["value"] - float(expected_time)) > 1e-10:
        raise ValueError("The arm did not reach the fixed 62/125-step write boundary")


def complete_ascii(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Checkpoint members must be regular files")
    content = path.read_bytes()
    if not content.rstrip().endswith(FOAM_FOOTER):
        raise ValueError("Incomplete OpenFOAM field footer")
    text = content.decode("ascii")
    if not re.search(r"\bformat\s+ascii\s*;", text):
        raise ValueError("Expected the unchanged ASCII output format")
    return text


def foam_body(text):
    text = re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)
    return re.sub(r"FoamFile\s*\{[^{}]*\}", "", text, count=1).strip()


def mesh_shape(processor):
    mesh = processor / "constant/polyMesh"
    lists = {}
    for name in ("owner", "neighbour"):
        matched = re.fullmatch(r"(\d+)\s*\(([^()]*)\)", foam_body(complete_ascii(mesh / name)), re.S)
        if not matched:
            raise ValueError("Incomplete mesh addressing list")
        values = [int(value) for value in matched.group(2).split()]
        if len(values) != int(matched.group(1)) or any(value < 0 for value in values):
            raise ValueError("Mesh addressing count differs")
        lists[name] = values
    patches = {}
    for matched in re.finditer(r"(\w+)\s*\{([^{}]*)\}", foam_body(complete_ascii(mesh / "boundary")), re.S):
        faces = re.search(r"\bnFaces\s+(\d+)\s*;", matched.group(2))
        if not faces or matched.group(1) in patches:
            raise ValueError("Invalid or duplicate mesh boundary")
        patches[matched.group(1)] = int(faces.group(1))
    if not patches or sum(patches.values()) + len(lists["neighbour"]) != len(lists["owner"]):
        raise ValueError("Mesh internal and boundary face counts differ")
    return {"cells": max(lists["owner"] + lists["neighbour"]) + 1,
            "internalFaces": len(lists["neighbour"]), "patches": patches}


def numeric_array(content, count, width):
    values = [float(value) for value in content.replace("(", " ").replace(")", " ").split()]
    if len(values) != count * width or not all(math.isfinite(value) for value in values):
        raise ValueError("Field count or finite-value proof failed")
    return values


def field_arrays(text, count, width):
    arrays = {}
    pattern = r"(\w+)\s+nonuniform\s+List<(scalar|vector)>\s+(\d+)\s*\((.*?)\)\s*;"
    matches = list(re.finditer(pattern, text, re.S))
    if len(matches) != len(re.findall(r"\bnonuniform\b", text)):
        raise ValueError("Incomplete nonuniform field list")
    for matched in matches:
        name, kind, declared, content = matched.groups()
        actual_width = 3 if kind == "vector" else 1
        if int(declared) != count or actual_width != width or name in arrays:
            raise ValueError("Field list disagrees with mesh cardinality")
        arrays[name] = numeric_array(content, count, width)
    uniform = list(re.finditer(r"(\w+)\s+uniform\s+([^;]+);", text))
    if len(uniform) != len(re.findall(r"\buniform\b", text)):
        raise ValueError("Incomplete uniform field value")
    for matched in uniform:
        if matched.group(1) in arrays:
            raise ValueError("Duplicate field value")
        arrays[matched.group(1)] = numeric_array(matched.group(2), 1, width) * count
    return arrays


def parsed_field(path, shape, field):
    text = complete_ascii(path)
    width = 3 if field == "U" else 1
    count = shape["internalFaces"] if field == "phi" else shape["cells"]
    expected_class = "volVectorField" if field == "U" else "surfaceScalarField" if field == "phi" else "volScalarField"
    if not re.search(r"\bclass\s+" + expected_class + r"\s*;", text):
        raise ValueError("Unexpected physical field class")
    if not re.search(r"\bobject\s+" + re.escape(field) + r"\s*;", text):
        raise ValueError("Unexpected physical field identity")
    body = foam_body(text)
    boundary = re.search(r"\bboundaryField\s*\{(.*)\}\s*\Z", body, re.S)
    dimensions = re.search(r"\bdimensions\s*\[([^]]+)\]\s*;", body)
    if not boundary or not dimensions or body.count("{") != body.count("}"):
        raise ValueError("Incomplete field dictionary")
    internal = field_arrays(body[:boundary.start()], count, width)
    if set(internal) != {"internalField"}:
        raise ValueError("Missing exact internal field")
    patches = {}
    for matched in re.finditer(r"(\w+)\s*\{([^{}]*)\}", boundary.group(1), re.S):
        name, content = matched.groups()
        kind = re.search(r"\btype\s+([^;]+);", content)
        if name not in shape["patches"] or name in patches or not kind:
            raise ValueError("Field boundary differs from the frozen mesh")
        patches[name] = {"type": kind.group(1).strip(), "arrays": field_arrays(content, shape["patches"][name], width)}
    if set(patches) != set(shape["patches"]):
        raise ValueError("Sparse field boundary coverage")
    units = [int(value) for value in dimensions.group(1).split()]
    if len(units) != 7:
        raise ValueError("Incomplete physical field dimensions")
    return {"internal": internal["internalField"], "boundary": patches,
            "dimensions": units, "width": width, "count": count}


def checkpoint_directory(processor, relative_step):
    matches = []
    for directory in processor.iterdir():
        if not directory.is_dir() or directory.is_symlink() or not re.fullmatch(r"\d+(?:\.\d+)?", directory.name):
            continue
        path = directory / "uniform/time"
        if not path.is_file():
            continue
        try:
            state = time_state(path)
        except ValueError:
            continue
        if state["index"] == START_INDEX + relative_step:
            validate_endpoint(state, relative_step)
            matches.append(directory)
    if len(matches) != 1:
        raise ValueError("Missing or ambiguous actual written checkpoint")
    return matches[0]


def checkpoint_ready(case, relative_step):
    try:
        for rank in range(3):
            directory = checkpoint_directory(case / f"processor{rank}", relative_step)
            for relative in (*FIELDS, "uniform/time"):
                path = directory / relative
                if path.is_symlink() or not path.is_file():
                    return False
                with path.open("rb") as source:
                    source.seek(max(0, path.stat().st_size - 128))
                    if not source.read().rstrip().endswith(FOAM_FOOTER):
                        return False
        return True
    except (OSError, ValueError):
        return False


def copy_checkpoint(case, destination, relative_step):
    records = {}
    sources = {}
    for rank in range(3):
        processor = case / f"processor{rank}"
        directory = checkpoint_directory(processor, relative_step)
        shape = mesh_shape(processor)
        complete_ascii(directory / "uniform/time")
        state = time_state(directory / "uniform/time")
        fields = {}
        for field in FIELDS:
            parsed = parsed_field(directory / field, shape, field)
            fields[field] = {"sha256": digest(directory / field), "byteSize": (directory / field).stat().st_size,
                             "count": parsed["count"], "width": parsed["width"], "dimensions": parsed["dimensions"]}
        fields["uniform/time"] = {"sha256": digest(directory / "uniform/time"), "byteSize": (directory / "uniform/time").stat().st_size}
        records[str(rank)] = {"state": state, "directory": directory.name, "shape": shape, "files": fields}
        sources[str(rank)] = directory
    if len({record["state"]["value"] for record in records.values()}) != 1:
        raise ValueError("MPI ranks wrote different physical checkpoint times")
    destination.mkdir(parents=True, exist_ok=False)
    for rank, record in records.items():
        for relative, metadata in record["files"].items():
            target = destination / f"processor{rank}" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = sources[rank] / relative
            shutil.copyfile(source, target)
            if digest(target) != metadata["sha256"] or digest(source) != metadata["sha256"]:
                raise ValueError("Written checkpoint changed during its verified copy")
    write_json(destination / "snapshot.json", records)
    return records


def cgroup_cpu():
    values = {row.split()[0]: int(row.split()[1]) for row in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines()}
    if not {"usage_usec", "user_usec", "system_usec", "throttled_usec"}.issubset(values):
        raise ValueError("Incomplete actual cgroup CPU accounting")
    quota_cpus(Path("/sys/fs/cgroup/cpu.max").read_text())
    return values


def capture_boundary(relative_step, physical_time, execution, started, receipts):
    before = time.monotonic()
    ranks = rank_cpu(receipts)
    if len(ranks) != 3 or not math.isfinite(physical_time):
        raise ValueError("Missing three-rank boundary measurement")
    validate_endpoint({"index": START_INDEX + relative_step, "value": physical_time}, relative_step)
    return {"relativeStep": relative_step, "time": physical_time, "elapsedSeconds": before - started,
            "rankCpu": ranks, "cgroupCpu": cgroup_cpu(), "sampleSpanSeconds": time.monotonic() - before,
            "masterExecutionSeconds": float(execution.group(1)), "masterClockSeconds": float(execution.group(2))}


def interval_metrics(first, last):
    if (first["relativeStep"], last["relativeStep"]) != (PRELUDE_STEPS, END_STEP):
        raise ValueError("Incomplete 63-step timing interval")
    for boundary in (first, last):
        validate_endpoint({"index": START_INDEX + boundary["relativeStep"], "value": boundary["time"]}, boundary["relativeStep"])
        if any(not math.isfinite(boundary[key]) or boundary[key] < 0 for key in ("elapsedSeconds", "masterExecutionSeconds", "masterClockSeconds")):
            raise ValueError("Invalid native timing sample")
    if last["elapsedSeconds"] <= first["elapsedSeconds"]:
        raise ValueError("Incomplete 63-step timing interval")
    deltas = {}
    if set(first["rankCpu"]) != {"0", "1", "2"} or set(last["rankCpu"]) != set(first["rankCpu"]):
        raise ValueError("Sparse rank CPU samples")
    for rank, initial in first["rankCpu"].items():
        final = last["rankCpu"][rank]
        if any(initial[key] != final[key] for key in ("pid", "startTicks", "affinity")):
            raise ValueError("Rank identity or affinity changed between measured writes")
        values = {key: final[key] - initial[key] for key in ("userSeconds", "systemSeconds")}
        if any(not math.isfinite(value) or value < 0 for value in values.values()):
            raise ValueError("Rank CPU counters regressed")
        deltas[rank] = values
    if set(first["cgroupCpu"]) != set(last["cgroupCpu"]):
        raise ValueError("Sparse cgroup CPU samples")
    cgroup = {key: last["cgroupCpu"][key] - first["cgroupCpu"][key] for key in first["cgroupCpu"]}
    if any(value < 0 for value in cgroup.values()):
        raise ValueError("Cgroup CPU identity reset during measurement")
    if any(last[key] < first[key] for key in ("masterExecutionSeconds", "masterClockSeconds")):
        raise ValueError("Native timing counters regressed")
    return {"steps": STEPS, "wallSeconds": last["elapsedSeconds"] - first["elapsedSeconds"],
            "rankCpu": deltas, "rankCpuSeconds": sum(sum(values.values()) for values in deltas.values()),
            "cgroupCpuDelta": cgroup, "masterExecutionSeconds": last["masterExecutionSeconds"] - first["masterExecutionSeconds"],
            "masterClockSeconds": last["masterClockSeconds"] - first["masterClockSeconds"]}


def native_identity():
    if os.environ.get("WM_PROJECT_VERSION", "").removeprefix("v") != "2606":
        raise ValueError("The native fixture requires OpenCFD2606")
    binaries = {}
    for name in (*BINARY_HASHES, "decomposePar", "checkMesh", "mpirun"):
        executable = shutil.which(name)
        if executable is None:
            raise ValueError(f"Missing native executable: {name}")
        actual = digest(executable)
        if name in BINARY_HASHES and actual != BINARY_HASHES[name]:
            raise ValueError(f"Native executable differs from retained evidence: {name}")
        binaries[name] = {"path": executable, "sha256": actual}
    cpu_max = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    quota_cpus(cpu_max)
    allowed = sorted(os.sched_getaffinity(0))
    selected, topology = distinct_cores(allowed)
    return {"declaredImage": IMAGE, "version": "2606", "binaries": binaries, "cpuMax": cpu_max,
            "python": {"version": sys.version.split()[0], "executableSha256": digest(sys.executable)},
            "allowedCpus": allowed, "boundCpus": selected, "topology": topology, "exclusiveCores": False}


def run_finite(command, cwd, output, timeout):
    with Path(output).open("xb") as stream:
        subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def rank_entry(case, receipts, arm, cpus):
    rank = int(os.environ["OMPI_COMM_WORLD_LOCAL_RANK"])
    if int(os.environ["OMPI_COMM_WORLD_SIZE"]) != 3 or int(os.environ["OMPI_COMM_WORLD_LOCAL_SIZE"]) != 3 or rank not in range(3):
        raise ValueError("Expected exactly three local MPI ranks")
    if arm == "B":
        if cpus[rank] not in os.sched_getaffinity(0):
            raise ValueError("Selected core is outside the actual allowed CPU set")
        os.sched_setaffinity(0, {cpus[rank]})
    stat = Path("/proc/self/stat").read_text().split(") ", 1)[1].split()
    write_json(receipts / f"rank-{rank}.json", {"rank": rank, "pid": os.getpid(), "startTicks": int(stat[19]),
               "affinity": sorted(os.sched_getaffinity(0))})
    executable = shutil.which("pimpleFoam")
    os.execv(executable, [executable, "-parallel", "-case", str(case)])


def rank_cpu(receipts):
    values = {}
    for path in sorted(receipts.glob("rank-*.json")):
        try:
            identity = json.loads(path.read_text())
            text = Path(f"/proc/{identity['pid']}/stat").read_text()
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        stat = text.split(") ", 1)[1].split()
        if int(stat[19]) != identity["startTicks"]:
            raise ValueError("A rank PID was replaced during measurement")
        if sorted(os.sched_getaffinity(identity["pid"])) != identity["affinity"]:
            raise ValueError("A rank affinity changed during measurement")
        values[str(identity["rank"])] = {**identity, "userSeconds": int(stat[11]) / os.sysconf("SC_CLK_TCK"),
            "systemSeconds": int(stat[12]) / os.sysconf("SC_CLK_TCK"), "currentCpu": int(stat[36])}
    return values


def stop_owned(process):
    if process.poll() is None:
        try:
            if os.getpgid(process.pid) != process.pid:
                raise ValueError("Refusing to signal an unexpected process group")
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait(timeout=10)
            return
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)


def coefficient_trace(case, start=float(MEASUREMENT_START_TIME), end=float(END_TIME), expected_steps=STEPS):
    rows = {}
    for path in sorted(case.glob("postProcessing/forceCoeffs*/*/coefficient.dat")):
        header = []
        for line in path.read_text().splitlines():
            if line.startswith("#"):
                tokens = line.lstrip("#").split()
                if "Cl" in tokens and "Cd" in tokens:
                    header = tokens
                continue
            if not line.strip():
                continue
            parts = line.split()
            if not header or header[0] != "Time":
                raise ValueError("Force coefficients have no exact time column")
            clock = float(parts[0])
            if not math.isfinite(clock):
                raise ValueError("Non-finite coefficient time")
            if not (clock > start + 1e-10 and clock <= end + 1e-10):
                continue
            values = [float(value) for value in parts]
            if len(values) != len(header) or not all(math.isfinite(value) for value in values):
                raise ValueError("Incomplete or non-finite new force-coefficient row")
            item = dict(zip(header, values))
            if clock > start + 1e-10 and clock <= end + 1e-10:
                moment = item.get("CmPitch", item.get("Cm"))
                if moment is None or clock in rows:
                    raise ValueError("Missing moment or overlapping coefficient output")
                rows[clock] = {"time": clock, "Cl": item["Cl"], "Cd": item["Cd"], "Cm": moment}
    result = [rows[clock] for clock in sorted(rows)]
    if len(result) != expected_steps or not result or abs(result[-1]["time"] - end) > 1e-10:
        raise ValueError(f"Expected {expected_steps} actual coefficient steps ending at the written boundary")
    return result


def run_arm(canonical, output, arm, identity, deadline):
    case = output / arm
    shutil.copytree(canonical, case)
    frozen = tree_identity(canonical)
    if tree_identity(case) != frozen:
        raise ValueError("Arm input differs from the frozen decomposition")
    receipts = output / f"{arm}-ranks"
    receipts.mkdir()
    command = ["mpirun", "--allow-run-as-root", "--bind-to", "none", "--use-hwthread-cpus", "-np", "3",
               sys.executable, str(Path(__file__).resolve()), "rank", "--case", str(case), "--receipts", str(receipts),
               "--arm", arm, "--cpus", ",".join(map(str, identity["boundCpus"]))]
    log = output / f"{arm}.log"
    started = time.monotonic()
    initial_cgroup = cgroup_cpu()
    limit = min(deadline, started + 300)
    completed_steps = 0
    last_time = None
    boundaries = {}
    write_deadline = None
    with log.open("xb") as stdout:
        process = subprocess.Popen(command, stdout=stdout, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            with log.open() as reader:
                while time.monotonic() < limit:
                    position = reader.tell()
                    line = reader.readline()
                    if line and not line.endswith("\n"):
                        reader.seek(position)
                        line = ""
                    if line.startswith("Time = "):
                        last_time = float(line.split("=", 1)[1])
                    execution = re.match(r"^ExecutionTime = ([0-9.eE+-]+) s\s+ClockTime = ([0-9.eE+-]+) s", line)
                    if execution:
                        completed_steps += 1
                        if completed_steps in (PRELUDE_STEPS, END_STEP):
                            label = "start" if completed_steps == PRELUDE_STEPS else "end"
                            boundaries[label] = capture_boundary(completed_steps, last_time, execution, started, receipts)
                            write_json(output / f"{arm}-boundary-{label}.json", boundaries[label])
                            if label == "end":
                                write_deadline = min(limit, time.monotonic() + 2)
                        if completed_steps == PRELUDE_STEPS + 1 and not checkpoint_ready(case, PRELUDE_STEPS):
                            raise ValueError("Actual first scheduled write is incomplete; refusing further work")
                    if "end" in boundaries:
                        if checkpoint_ready(case, END_STEP):
                            break
                        if completed_steps > END_STEP + 2 or time.monotonic() >= write_deadline:
                            raise ValueError("Actual second scheduled write is incomplete; refusing further work")
                    if not line:
                        if process.poll() is not None:
                            raise ValueError("Native solver exited before a complete endpoint")
                        time.sleep(0.02)
                else:
                    raise TimeoutError("Benchmark arm did not finish its fixed interval")
        finally:
            stop_owned(process)
    if set(boundaries) != {"start", "end"}:
        raise ValueError("Missing both measured write boundaries")
    if tree_identity(canonical) != frozen:
        raise ValueError("The shared frozen decomposition was modified")
    snapshot_start = time.monotonic()
    snapshots = {label: copy_checkpoint(case, output / "snapshots" / arm / label, step)
                 for label, step in (("start", PRELUDE_STEPS), ("end", END_STEP))}
    first, last = boundaries["start"], boundaries["end"]
    prelude = {"steps": PRELUDE_STEPS, "wallSeconds": first["elapsedSeconds"],
               "rankCpuSeconds": sum(row["userSeconds"] + row["systemSeconds"] for row in first["rankCpu"].values()),
               "cgroupCpuDelta": {key: first["cgroupCpu"][key] - initial_cgroup[key] for key in initial_cgroup},
               "masterExecutionSeconds": first["masterExecutionSeconds"], "masterClockSeconds": first["masterClockSeconds"],
               "includesRankStartup": True}
    total_logged = sum(line.startswith("ExecutionTime = ") for line in log.read_text().splitlines())
    result = {"arm": arm, "boundaries": boundaries, "prelude": prelude, "measurement": interval_metrics(first, last),
              "inputSha256": hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest(),
              "snapshots": snapshots, "coefficients": coefficient_trace(case, first["time"], last["time"]),
              "preludeCoefficients": coefficient_trace(case, float(START_TIME), first["time"], PRELUDE_STEPS),
              "checkpointValidationAndCopySeconds": time.monotonic() - snapshot_start, "totalLoggedSteps": total_logged,
              "postEndpointLoggedSteps": total_logged - END_STEP, "nativeExitCode": process.returncode,
              "stopReason": "benchmark_checkpoint_not_solver_completion", "log": log.name}
    write_json(output / f"{arm}-measurement.json", result)
    return result


def native_run(input_root, output):
    started = time.monotonic()
    if not all(os.environ.get(name) for name in ("DC2_DEPLOYMENT", "DC2_COMPONENT", "DC2_GENERATION")):
        raise ValueError("Native execution requires the declared Coordinator fixture")
    owner = json.loads((input_root / "owner.json").read_text())
    if digest(Path(__file__)) != owner["driverSha256"]:
        raise ValueError("The native driver differs from the governed source snapshot")
    adapter = json.loads((input_root / "python-adapter.json").read_text())
    if sys.version_info < (3, 11) or digest(sys.executable) != adapter["executableSha256"]:
        raise ValueError("Native Python adapter identity/version differs from its staged proof")
    if tree_identity(Path(sys.base_prefix)) != adapter["files"]:
        raise ValueError("Read-only Python adapter files differ from their staged proof")
    expected = json.loads((input_root / "case-files.json").read_text())
    if tree_identity(input_root / "case") != expected:
        raise ValueError("Authenticated checkpoint input changed before native startup")
    identity = native_identity()
    write_json(output / "native-identity.json", identity)
    canonical = output / "canonical"
    shutil.copytree(input_root / "case", canonical)
    with (canonical / "system/decomposeParDict").open("x") as dictionary:
        dictionary.write("FoamFile { version 2.0; format ascii; class dictionary; object decomposeParDict; }\nnumberOfSubdomains 3;\nmethod scotch;\ndistributed no;\nroots ();\n")
    run_finite(["checkMesh", "-case", str(canonical)], canonical, output / "checkMesh.log", 90)
    help_path = output / "decomposePar-help.log"
    run_finite(["decomposePar", "-help"], canonical, help_path, 15)
    if "-copyUniform" not in help_path.read_text():
        raise ValueError("Pinned decomposePar does not advertise required copyUniform support")
    run_finite(["decomposePar", "-case", str(canonical), "-latestTime", "-copyUniform"], canonical, output / "decomposePar.log", 120)
    frozen = tree_identity(canonical)
    write_json(output / "frozen-decomposition.json", frozen)
    arms = [run_arm(canonical, output, arm, identity, started + 1140) for arm in ("A1", "B", "A2")]
    if len({arm["inputSha256"] for arm in arms}) != 1:
        raise ValueError("Paired arms did not use identical decomposed inputs")
    if tree_identity(input_root / "case") != expected:
        raise ValueError("Read-only source checkpoint changed")
    report = {"schemaVersion": 1, "kind": "checkpoint-placement-benchmark-only", "runId": owner["runId"],
              "acceptedCfd": False, "published": False, "hzGainClaimed": False, "exclusiveCores": False,
              "fixedSteps": STEPS, "preludeSteps": PRELUDE_STEPS, "totalRequestedSteps": END_STEP,
              "sourcePhysicalStart": START_TIME, "physicalStart": MEASUREMENT_START_TIME, "physicalEnd": END_TIME, "identity": identity,
              "arms": arms, "wallSeconds": time.monotonic() - started,
              "acceptance": {"status": "incomplete", "reason": "One output interval is not a new accepted CFD window; production acceptance rules are unchanged."}}
    write_json(output / "report.json", report)
    print(json.dumps({"kind": report["kind"], "runId": report["runId"], "arms": [arm["arm"] for arm in arms], "acceptedCfd": False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("native", "rank"))
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", type=Path)
    parser.add_argument("--receipts", type=Path)
    parser.add_argument("--arm", choices=("A1", "B", "A2"))
    parser.add_argument("--cpus")
    args = parser.parse_args()
    if args.action == "rank":
        rank_entry(args.case, args.receipts, args.arm, [int(value) for value in args.cpus.split(",")])
    else:
        native_run(args.input, args.output)


if __name__ == "__main__":
    main()
