"""Private same-four-rank placement experiment; never campaign evidence."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import sys
import time
import subprocess

try:
    from scripts.materials import checkpoint_placement as common
except ModuleNotFoundError:  # The same reviewed helper is mounted beside this driver.
    import checkpoint_placement as common

IMAGE = common.IMAGE
ARCHIVE_SHA256 = "842732185df27bafd3a8ed8fd498a996a531d3d25c1bfb4c2c6ebfb258159836"
ARCHIVE_BYTES = 208222218
MANIFEST_SHA256 = "75eae16599ff54f3cad85ea85f8db98df30788785f86fbbd0ed8d03fe8ccb543"
LIBRARY_SHA256 = "f1b3f194cf09e221ded3ab9ddc75a862fee615d928b2323652c1ab3373c8ced7"
LIBRARY_BYTES = 493056
LIBRARY_PATH = Path("/opt/xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so")
BINARY_HASHES = {
    "rhoPimpleFoam": "94e8a1a8f14f4e7dace8c3734302669441629f9b14f865fcb3485a4457658949",
    "decomposePar": "f37c728205e47769fce19d9cfab9b9bfb8f2f44a219493271c8636b79b72c53a",
    "reconstructPar": "68cd25cc320e7910c7314efd75f42133a6411e5b7325ec8acbfd4393f7c56176",
}
START_TIME = "0.188755373918"
START_INDEX = 311319
START_DELTAT = 6.02776512141e-7
RANKS = 4
QUOTA_CPUS = 5  # Same four solver ranks plus accounting/output headroom in every arm.
FIELDS = ("T", "U", "alphat", "k", "nut", "omega", "p", "phi", "rho")
ARMS = ("A1", "B1", "B2", "A2")
WRITE_STEPS = 200
WARMUP_SECONDS = 15
MEASURE_SECONDS = 120
MIN_MEASURE_SECONDS = 90
ARM_TIMEOUT = 600
NATIVE_TIMEOUT = 2550
WRITE_WAIT = 5

# Only restart/output policy is overridden, offline and identically for all arms.
CONTROL_OVERRIDES = {"startFrom": "latestTime", "writeControl": "timeStep", "writeInterval": str(WRITE_STEPS)}


def replace_top_level(text, replacements):
    lines = text.splitlines(keepends=True)
    depth = 0
    found = set()
    for index, line in enumerate(lines):
        clean = re.sub(r"//.*", "", line)
        match = re.match(r"^(\s*)(\w+)(\s+)([^;]+);(.*)$", clean.rstrip("\n"))
        if depth == 0 and match and match[2] in replacements:
            key = match[2]
            if key in found:
                raise ValueError("Duplicate top-level control entry")
            found.add(key)
            lines[index] = f"{match[1]}{key}{match[3]}{replacements[key]};{match[5]}\n"
        depth += clean.count("{") - clean.count("}")
    if found != set(replacements):
        raise ValueError("Missing exact restart/output control entry")
    return "".join(lines)


def prepare_control(text):
    if not re.search(r"application\s+rhoPimpleFoam\s*;", text):
        raise ValueError("Not the compressible transient solver")
    result = replace_top_level(text, CONTROL_OVERRIDES)
    if replace_top_level(text, {key: "<benchmark-control>" for key in CONTROL_OVERRIDES}) != replace_top_level(result, {key: "<benchmark-control>" for key in CONTROL_OVERRIDES}):
        raise ValueError("Numerical control settings changed")
    return result


def distinct_cores(allowed, topology_root=Path("/sys/devices/system/cpu")):
    selected, seen, topology = [], set(), []
    for cpu in sorted(allowed):
        root = topology_root / f"cpu{cpu}/topology"
        key = (int((root / "physical_package_id").read_text()), int((root / "core_id").read_text()))
        topology.append({"cpu": cpu, "package": key[0], "core": key[1], "siblings": (root / "thread_siblings_list").read_text().strip()})
        if key not in seen:
            selected.append(cpu)
            seen.add(key)
    if len(selected) < RANKS:
        raise ValueError("Fewer than four distinct allowed physical cores")
    return selected[:RANKS], topology


def cpu_stats():
    quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
    if quota == "max" or int(period) <= 0 or int(quota) / int(period) != QUOTA_CPUS:
        raise ValueError("Changed bounded fixture CPU quota")
    result = {k: int(v) for k, v in (line.split() for line in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines())}
    if not {"usage_usec", "user_usec", "system_usec", "throttled_usec", "nr_throttled"} <= result.keys():
        raise ValueError("Incomplete cgroup accounting")
    return result


def cpu_delta(before, after):
    if before.keys() != after.keys():
        raise ValueError("Changed cgroup accounting")
    values = {k: after[k] - before[k] for k in before}
    if any(v < 0 for v in values.values()):
        raise ValueError("Cgroup accounting regressed")
    return values


def native_identity():
    if os.environ.get("WM_PROJECT_VERSION", "").removeprefix("v") != "2606":
        raise ValueError("Expected OpenCFD2606")
    binaries = {}
    for name, expected in BINARY_HASHES.items():
        path = shutil.which(name)
        if not path or common.digest(path) != expected:
            raise ValueError(f"Native executable identity differs: {name}")
        binaries[name] = {"path": path, "sha256": expected}
    if LIBRARY_PATH.stat().st_size != LIBRARY_BYTES or common.digest(LIBRARY_PATH) != LIBRARY_SHA256:
        raise ValueError("Custom thermophysics library differs")
    if not any(str(LIBRARY_PATH) in line and ' ro,' in line for line in Path('/proc/self/mountinfo').read_text().splitlines()):
        raise ValueError("Thermophysics library must be a read-only mount")
    allowed = sorted(os.sched_getaffinity(0))
    selected, topology = distinct_cores(allowed)
    return {"image": IMAGE, "binaries": binaries, "librarySha256": LIBRARY_SHA256,
            "allowedCpus": allowed, "boundCpus": selected, "topology": topology,
            "cpuMax": Path("/sys/fs/cgroup/cpu.max").read_text().strip(), "cgroup": cpu_stats(),
            "exclusiveCores": False, "ranks": RANKS, "pythonSha256": common.digest(sys.executable)}


def rank_entry(case, receipts, arm, allowed, bound):
    rank = int(os.environ["OMPI_COMM_WORLD_LOCAL_RANK"])
    if int(os.environ["OMPI_COMM_WORLD_SIZE"]) != RANKS or int(os.environ["OMPI_COMM_WORLD_LOCAL_SIZE"]) != RANKS or rank not in range(RANKS):
        raise ValueError("Expected exactly four local MPI ranks")
    if sorted(os.sched_getaffinity(0)) != allowed:
        raise ValueError("MPI unexpectedly bound an ordinary rank")
    if arm.startswith("B"):
        if len(bound) != RANKS or len(set(bound)) != RANKS or bound[rank] not in allowed:
            raise ValueError("Invalid four-core placement")
        os.sched_setaffinity(0, {bound[rank]})
    stat = Path('/proc/self/stat').read_text().split(') ', 1)[1].split()
    common.write_json(receipts / f'rank-{rank}.json', {"rank": rank, "pid": os.getpid(), "startTicks": int(stat[19]),
                     "affinity": sorted(os.sched_getaffinity(0))})
    os.chdir(case)
    os.environ['PWD'] = str(case)
    executable = shutil.which('rhoPimpleFoam')
    os.execv(executable, [executable, '-parallel', '-case', str(case)])


def field_names(directory):
    names = set()
    for path in directory.iterdir():
        if path.is_file() and re.search(rb'\bclass\s+(?:volScalarField|volVectorField|surfaceScalarField)\s*;', path.read_bytes()[:2048]):
            names.add(path.name)
    if not set(FIELDS) <= names:
        raise ValueError(f"Missing compressible fields: {sorted(set(FIELDS) - names)}")
    return sorted(names)


def written_checkpoint(case, index, physical_time):
    result = {}
    for rank in range(RANKS):
        processor = case / f'processor{rank}'
        found = []
        for path in processor.iterdir():
            try: value = float(path.name)
            except ValueError: continue
            if not path.is_dir() or abs(value - physical_time) > 1e-10:
                continue
            state_path = path / 'uniform/time'
            try:
                common.complete_ascii(state_path)
                state = common.time_state(state_path)
                if state['index'] != index or abs(state['value'] - physical_time) > 1e-10:
                    continue
                names = field_names(path)
                for name in names:
                    with (path / name).open('rb') as source:
                        source.seek(max(0, (path / name).stat().st_size - 128))
                        if not source.read().rstrip().endswith(common.FOAM_FOOTER):
                            raise ValueError('Incomplete field write')
                found.append((path, state, names))
            except (OSError, ValueError):
                continue
        if len(found) != 1:
            return None
        result[str(rank)] = found[0]
    states = [x[1] for x in result.values()]
    if any(state != states[0] for state in states):
        raise ValueError('MPI ranks have different exact time states')
    if any(x[2] != result['0'][2] for x in result.values()):
        raise ValueError('MPI ranks have different field coverage')
    return result


def snapshot(case, destination, index, physical_time):
    written = written_checkpoint(case, index, physical_time)
    if not written:
        raise ValueError('No complete four-rank checkpoint at measured boundary')
    proofs = {}
    for rank, (directory, state, names) in written.items():
        shape = common.mesh_shape(case / f'processor{rank}')
        fields = {}
        for name in names:
            values = common.parsed_field(directory / name, shape, name)
            fields[name] = {'sha256': common.digest(directory / name), 'valueSha256': common.value_digest(values),
                            'bytes': (directory / name).stat().st_size, 'count': values['count'], 'dimensions': values['dimensions']}
        proofs[rank] = {'directory': directory.name, 'state': state, 'shape': shape, 'fields': fields}
        target = destination / f'processor{rank}'
        shutil.copytree(directory, target)
        for name, metadata in fields.items():
            if common.digest(target / name) != metadata['sha256']:
                raise ValueError('Snapshot changed during copy')
    common.write_json(destination / 'snapshot.json', proofs)
    return proofs


def boundary(step, physical_time, match, started, receipts):
    ranks = common.rank_cpu(receipts)
    if set(ranks) != {str(i) for i in range(RANKS)}:
        raise ValueError('Incomplete four-rank timing sample')
    return {'step': step, 'index': START_INDEX + step, 'time': physical_time, 'monotonicSeconds': time.monotonic() - started,
            'masterExecutionSeconds': float(match[1]), 'masterClockSeconds': float(match[2]),
            'rankCpu': ranks, 'cgroupCpu': cpu_stats()}


def interval(first, last):
    if last['step'] <= first['step'] or last['time'] <= first['time']:
        raise ValueError('Non-increasing real step window')
    wall = last['monotonicSeconds'] - first['monotonicSeconds']
    if not math.isfinite(wall) or wall < MIN_MEASURE_SECONDS:
        raise ValueError('Measured interval is too short for a placement conclusion')
    rank_deltas = {}
    if set(first['rankCpu']) != {str(i) for i in range(RANKS)} or first['rankCpu'].keys() != last['rankCpu'].keys():
        raise ValueError('Missing four-rank measurements')
    for rank, old in first['rankCpu'].items():
        new = last['rankCpu'][rank]
        if any(old[k] != new[k] for k in ('pid', 'startTicks', 'affinity')):
            raise ValueError('Rank identity or affinity changed')
        rank_deltas[rank] = new['userSeconds'] + new['systemSeconds'] - old['userSeconds'] - old['systemSeconds']
        if rank_deltas[rank] < 0:
            raise ValueError('Rank CPU accounting regressed')
    cpu = cpu_delta(first['cgroupCpu'], last['cgroupCpu'])
    if cpu['throttled_usec'] or cpu['nr_throttled']:
        raise ValueError('Resource throttling invalidates placement timing')
    return {'steps': last['step'] - first['step'], 'wallSeconds': wall, 'rankCpuSeconds': sum(rank_deltas.values()),
            'rankCpuDeltas': rank_deltas, 'cgroupCpuDelta': cpu,
            'masterClockSeconds': last['masterClockSeconds'] - first['masterClockSeconds'],
            'integerLogQuantizationFraction': 2 / wall}


def invalid_native_line(line):
    # OpenFOAM prints these configured startup notices before any equations.
    # Preserve them in the full log; neither describes a material/solver fault.
    if line.strip() == "trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).":
        return False
    if line.strip() == "--> FOAM Warning : allowSystemOperations : Allowing user-supplied system call operations.":
        return False
    return bool(re.search(r'FOAM FATAL|FOAM Warning|[Tt]emperature.*(?:out of|limit)|[Cc]annot load|undefined symbol|[Ff]loating point exception', line))


def run_arm(canonical, output, arm, identity, plan, deadline):
    case = output / arm
    frozen = common.tree_identity(canonical)
    shutil.copytree(canonical, case)
    if common.tree_identity(case) != frozen:
        raise ValueError('Arm did not restore identical inputs')
    receipt_dir = output / f'{arm}-ranks'; receipt_dir.mkdir()
    command = ['mpirun', '--allow-run-as-root', '--bind-to', 'none', '--use-hwthread-cpus', '-np', '4',
               sys.executable, str(Path(__file__).resolve()), 'rank', '--case', str(case), '--receipts', str(receipt_dir),
               '--arm', arm, '--allowed', ','.join(map(str, identity['allowedCpus'])), '--bound', ','.join(map(str, identity['boundCpus']))]
    log = output / f'{arm}.log'
    started, initial_cpu = time.monotonic(), cpu_stats()
    limit = min(deadline, started + ARM_TIMEOUT)
    step, physical_time, pending = 0, None, None
    boundaries, steps, warnings = {}, [], []
    with log.open('xb') as stream:
        process = subprocess.Popen(command, cwd=case, env={**os.environ, "PWD": str(case)},
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            with log.open() as reader:
                while time.monotonic() < limit:
                    position = reader.tell(); line = reader.readline()
                    if line and not line.endswith('\n'):
                        reader.seek(position); line = ''
                    if invalid_native_line(line):
                        warnings.append(line.strip())
                        raise ValueError('Native/material warning invalidates arm: ' + line.strip()[:300])
                    if line.startswith('Time = '):
                        physical_time = float(line.split('=', 1)[1])
                    match = re.match(r'^ExecutionTime = ([0-9.eE+-]+) s\s+ClockTime = ([0-9.eE+-]+) s', line)
                    if match:
                        step += 1
                        steps.append({'step': step, 'time': physical_time})
                        if not math.isfinite(physical_time):
                            raise ValueError('Nonfinite physical step')
                        target = (plan and step in (plan['start']['step'], plan['end']['step']))
                        # Observe only scheduled writes; never edit a live dictionary.
                        candidate = target or (not plan and (START_INDEX + step) % WRITE_STEPS == 0)
                        if candidate:
                            sample = boundary(step, physical_time, match, started, receipt_dir)
                            label = 'start' if 'start' not in boundaries else 'end'
                            if plan or (label == 'start' and sample['monotonicSeconds'] >= WARMUP_SECONDS) or (label == 'end' and sample['monotonicSeconds'] - boundaries['start']['monotonicSeconds'] >= MEASURE_SECONDS):
                                pending = (label, sample, time.monotonic() + WRITE_WAIT)
                    if pending:
                        label, sample, write_limit = pending
                        ready = written_checkpoint(case, sample['index'], sample['time']) is not None
                        if ready and label == 'end':
                            try:
                                common.coefficient_trace(case, boundaries['start']['time'], sample['time'],
                                                         expected_steps=sample['step']-boundaries['start']['step'])
                            except (OSError, ValueError):
                                ready = False
                        if ready:
                            boundaries[label] = sample
                            common.write_json(output / f'{arm}-{label}-timing.json', sample)
                            pending = None
                            if label == 'end':break
                        elif time.monotonic() >= write_limit or step > sample['step'] + 2:
                            raise ValueError('Missing actual scheduled four-rank write')
                    if not line:
                        if process.poll() is not None:raise ValueError('Solver exited before complete measurement')
                        time.sleep(0.01)
                else:raise TimeoutError('Bounded arm did not reach its complete write endpoint')
        finally:
            common.stop_owned(process)
    if set(boundaries) != {'start', 'end'}:raise ValueError('Missing measured boundaries')
    if common.tree_identity(canonical) != frozen:raise ValueError('Frozen decomposition changed')
    if common.tree_identity(case / 'system') != common.tree_identity(canonical / 'system') or common.tree_identity(case / 'constant') != common.tree_identity(canonical / 'constant'):
        raise ValueError('Physics or mesh changed during arm')
    for label, sample in boundaries.items():
        if plan and any(sample[k] != plan[label][k] for k in ('step','index','time')):
            raise ValueError('Different physical step endpoint')
    snapshots = {label: snapshot(case, output / 'snapshots' / arm / label, sample['index'], sample['time']) for label,sample in boundaries.items()}
    first,last = boundaries['start'],boundaries['end']
    measured = interval(first,last)
    all_cpu = cpu_delta(initial_cpu,last['cgroupCpu'])
    if all_cpu['throttled_usec'] or all_cpu['nr_throttled']:raise ValueError('Arm warm-up was throttled')
    coefficients = common.coefficient_trace(case, first['time'], last['time'], expected_steps=measured['steps'])
    expected_times = [x['time'] for x in steps if first['step'] < x['step'] <= last['step']]
    if [x['time'] for x in coefficients] != expected_times:raise ValueError('Coefficient rows differ from actual step trace')
    result={'arm':arm,'ranks':RANKS,'inputSha256':common.value_digest(frozen),'boundaries':boundaries,'measurement':measured,
            'preludeSeconds':first['monotonicSeconds'],'snapshots':snapshots,'coefficients':coefficients,'warnings':warnings,
            'nativeExitCode':process.returncode,'stopReason':'owned benchmark endpoint; not solver completion','postEndpointSteps':step-last['step']}
    common.write_json(output / f'{arm}-measurement.json',result)
    print(json.dumps({'arm':arm,'seconds':measured['wallSeconds'],'steps':measured['steps'],'acceptedCfd':False}),flush=True)
    return result


def compare(report):
    arms=report['arms']
    if [a['arm'] for a in arms] != list(ARMS) or any(a['ranks'] != RANKS for a in arms):raise ValueError('Missing bracketed four-rank arm')
    if len({a['inputSha256'] for a in arms}) != 1:raise ValueError('Nonidentical restored inputs')
    reference=arms[0]
    for arm in arms:
        interval(arm['boundaries']['start'],arm['boundaries']['end'])
        if arm['warnings']:raise ValueError('Native warnings')
        if arm['coefficients'] != reference['coefficients']:raise ValueError('Numerical coefficient divergence at identical steps')
        for label in ('start','end'):
            if any(arm['boundaries'][label][k] != reference['boundaries'][label][k] for k in ('step','index','time')):raise ValueError('Different real endpoints')
            for rank in map(str,range(RANKS)):
                a=arm['snapshots'][label][rank];b=reference['snapshots'][label][rank]
                if a['state'] != b['state'] or a['shape'] != b['shape'] or set(a['fields']) != set(b['fields']):raise ValueError('Different field/time/mesh coverage')
                if not set(FIELDS) <= set(a['fields']):raise ValueError('Missing compressible fields')
                if any(a['fields'][f]['valueSha256'] != b['fields'][f]['valueSha256'] for f in a['fields']):raise ValueError('Numerical field divergence')
    a=[arms[i]['measurement']['wallSeconds'] for i in (0,3)];b=[arms[i]['measurement']['wallSeconds'] for i in (1,2)]
    stable=max(a)/min(a)<=1.10 and max(b)/min(b)<=1.10
    gain=stable and min(a)/max(b)>=1.05
    return {'numericalEquivalence':'identical','repeatableGain':gain,'bracketStableWithin10Percent':stable,
            'meanWallSpeedup':statistics.mean(a)/statistics.mean(b),'conservativeWallSpeedup':min(a)/max(b),
            'unboundSeconds':a,'boundSeconds':b,'productionAdoption':False,
            'conclusion':'review placement candidate' if gain else 'no repeatable gain; keep production unchanged'}


def native_run(input_root, output):
    if not all(os.environ.get(n) for n in ('DC2_DEPLOYMENT','DC2_COMPONENT','DC2_GENERATION')):raise ValueError('Governed private deployment required')
    owner=json.loads((input_root/'owner.json').read_text())
    if common.digest(__file__) != owner['driverSha256'] or common.digest(common.__file__) != owner['helperSha256']:raise ValueError('Driver identity changed')
    adapter=json.loads((input_root/'python-adapter.json').read_text())
    if common.digest(sys.executable)!=adapter['executableSha256'] or common.tree_identity(Path(sys.base_prefix))!=adapter['files']:raise ValueError('Python adapter changed')
    expected=json.loads((input_root/'case-files.json').read_text())
    if common.tree_identity(input_root/'case') != expected:raise ValueError('Authenticated case changed')
    started=time.monotonic();identity=native_identity();common.write_json(output/'native-identity.json',identity)
    canonical=output/'canonical';shutil.copytree(input_root/'case',canonical)
    original=(canonical/'system/controlDict').read_text();(canonical/'system/controlDict').write_text(prepare_control(original))
    common.write_json(output/'restart-output-overrides.json',{'original':original,'benchmark':(canonical/'system/controlDict').read_text(),'allowlist':CONTROL_OVERRIDES})
    if not re.search(r'numberOfSubdomains\s+4\s*;', (canonical/'system/decomposeParDict').read_text()):raise ValueError('Archived rank count differs')
    shape=common.mesh_shape(canonical)
    if shape['cells'] != 30700:raise ValueError('Archived mesh size differs')
    for field in FIELDS:common.parsed_field(canonical/START_TIME/field,shape,field)
    common.run_finite(['decomposePar','-case',str(canonical),'-latestTime','-copyUniform'],canonical,output/'decomposePar.log',120)
    for rank in range(RANKS):
        if common.time_state(canonical/f'processor{rank}'/START_TIME/'uniform/time') != common.time_state(canonical/START_TIME/'uniform/time'):raise ValueError('Decomposition changed time state')
    if sum(common.mesh_shape(canonical/f'processor{rank}')['cells'] for rank in range(RANKS))!=30700:raise ValueError('Decomposition lost cells')
    frozen=common.tree_identity(canonical);common.write_json(output/'frozen-decomposition.json',frozen)
    arms=[];plan=None
    for name in ARMS:
        arm=run_arm(canonical,output,name,identity,plan,started+NATIVE_TIMEOUT);arms.append(arm)
        if plan is None:plan=arm['boundaries'];common.write_json(output/'fixed-step-plan.json',plan)
    report={'schemaVersion':1,'kind':'private-compressible-placement-benchmark','runId':owner['runId'],'identity':identity,
            'checkpointTime':START_TIME,'checkpointIndex':START_INDEX,'meshCells':30700,'arms':arms,
            'acceptedCfd':False,'published':False,'physicalValidation':False,'wallSeconds':time.monotonic()-started}
    common.write_json(output/'report.json',report)
    result=compare(report);common.write_json(output/'comparison.json',result)
    if common.tree_identity(input_root/'case')!=expected:raise ValueError('Original authenticated input changed')
    print(json.dumps(result),flush=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['native','rank']);p.add_argument('--input',type=Path);p.add_argument('--output',type=Path)
    p.add_argument('--case',type=Path);p.add_argument('--receipts',type=Path);p.add_argument('--arm',choices=ARMS);p.add_argument('--allowed');p.add_argument('--bound');a=p.parse_args()
    if a.action=='native':native_run(a.input,a.output)
    else:rank_entry(a.case,a.receipts,a.arm,list(map(int,a.allowed.split(','))),list(map(int,a.bound.split(','))))

if __name__=='__main__':
    main()
