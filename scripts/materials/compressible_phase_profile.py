"""V2 native phase observation; exact original trajectory remains mandatory."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

try:
    from scripts.materials import compressible_cost_profile as v1
except ModuleNotFoundError:
    import compressible_cost_profile as v1

reference = v1.reference
common = v1.common
BINARY = Path('/opt/phase-profile/bin/xfoilfoamRhoPimplePhaseProfile')
PROOF = Path('/opt/phase-profile/proof')


def build_identity():
    proof = json.loads((PROOF / 'build-proof.json').read_text())
    if common.digest(BINARY) != proof['experimentalBinarySha256']:
        raise ValueError('Experimental instrumentation binary changed')
    original = Path(shutil.which('rhoPimpleFoam'))
    if common.digest(original) != proof['originalBinarySha256'] or proof['originalBinarySha256'] != reference.BINARY_HASHES['rhoPimpleFoam']:
        raise ValueError('Original solver changed')
    if proof['environment']['WM_OPTIONS'] != 'linux64GccDPInt32Opt':
        raise ValueError('Experimental solver changed precision or build mode')
    for name, expected in proof['runtimeBaseDependencySha256'].items():
        if common.digest(name) != expected:
            raise ValueError('Pinned runtime native dependency differs: ' + name)
    proof['runtimeLdd'] = subprocess.check_output(['ldd', str(BINARY)], text=True)
    return proof


def inspect_build(output):
    shutil.copytree(PROOF, output / 'build-proof')
    shutil.copy2(BINARY, output / BINARY.name)
    proof = json.loads((PROOF / 'build-proof.json').read_text())
    actual = {name: common.digest(name) if Path(name).is_file() else None for name in proof['runtimeBaseDependencySha256']}
    mismatches = {name: {'pinnedRuntime': expected, 'runtime': actual[name]} for name, expected in proof['runtimeBaseDependencySha256'].items()
                  if expected != actual[name]}
    common.write_json(output / 'runtime-preflight.json', {'buildProof': proof, 'runtimeDependencySha256': actual,
                      'dependencyMismatches': mismatches, 'experimentalBinarySha256': common.digest(BINARY),
                      'originalBinarySha256': common.digest(shutil.which('rhoPimpleFoam')), 'nativeProfileStarted': False})


def rank_entry(case, receipts, allowed):
    rank = int(os.environ['OMPI_COMM_WORLD_LOCAL_RANK'])
    if int(os.environ['OMPI_COMM_WORLD_SIZE']) != 4 or int(os.environ['OMPI_COMM_WORLD_LOCAL_SIZE']) != 4 or rank not in range(4):
        raise ValueError('Exactly four local ranks required')
    if sorted(os.sched_getaffinity(0)) != allowed:
        raise ValueError('Unexpected MPI binding')
    proof = build_identity()
    stat = Path('/proc/self/stat').read_text().split(') ', 1)[1].split()
    common.write_json(receipts / f'rank-{rank}.json', {'rank': rank, 'pid': os.getpid(), 'startTicks': int(stat[19]),
                      'affinity': allowed, 'experimentalBinarySha256': proof['experimentalBinarySha256']})
    os.chdir(case)
    os.environ['PWD'] = str(case)
    os.execv(BINARY, [str(BINARY), '-parallel', '-case', str(case)])


def native_run(input_root, output):
    owner = json.loads((input_root / 'owner.json').read_text())
    if common.digest(__file__) != owner['phaseDriverSha256']:
        raise ValueError('Phase driver identity changed')
    proof = build_identity()
    sources = json.loads((PROOF / 'source-proof.json').read_text())
    if sources['generatorSha256'] != owner['buildGeneratorSha256']:
        raise ValueError('Build generator differs from frozen source')
    shutil.copytree(PROOF, output / 'build-proof')
    shutil.copy2(BINARY, output / BINARY.name)
    common.write_json(output / 'experimental-binary.json', proof)
    original_identity = reference.native_identity
    original_run_arm = reference.run_arm

    def identity():
        base = original_identity()
        return {**base, 'image': None, 'baseImage': base['image'],
                'experimentalDerivedImage': True, 'experimentalInstrumentation': proof}

    def run_arm(*args, **kwargs):
        return original_run_arm(*args, **kwargs, rank_driver=Path(__file__).resolve())

    reference.native_identity = identity
    reference.run_arm = run_arm
    v1.native_run(input_root, output)
    report = json.loads((output / 'report.json').read_text())
    report['kind'] = 'native-phase-cost-profile-v2'
    report['originalBinaryUnchanged'] = common.digest(shutil.which('rhoPimpleFoam')) == reference.BINARY_HASHES['rhoPimpleFoam']
    common.write_json(output / 'report.json', report)


def verify(root):
    v1.verify(root)
    report = json.loads((root / 'output/report.json').read_text())
    if report['kind'] != 'native-phase-cost-profile-v2' or not report['originalBinaryUnchanged']:
        raise ValueError('Wrong v2 profiling identity')
    proof = json.loads((root / 'output/build-proof/source-proof.json').read_text())
    if proof['algorithmChanged'] or proof['flagsChanged']:
        raise ValueError('Probes changed algorithm or build flags')
    from scripts.materials import build_compressible_phase_profile as builder
    for name, row in proof['files'].items():
        upstream = root / 'output/build-proof/upstream' / name
        changed = root / 'output/build-proof/instrumented' / name
        if common.digest(upstream) != builder.SOURCE_SHA256[name] or common.digest(changed) != row['instrumentedSha256']:
            raise ValueError('Retained source bytes differ from proof')
        if name.endswith(('.C', '.H')) and builder.strip_probes(changed.read_text()) != upstream.read_text():
            raise ValueError('Instrumentation changed original algorithm bytes')
    expected_calls = {'phase.U.assembly': 6000, 'phase.E.assembly': 6000, 'phase.thermo.correct': 6000,
                      'phase.p.preAssembly': 12000, 'phase.p.transonicAssembly': 12000,
                      'phase.p.nonOrthogonalAssembly': 24000, 'phase.p.solveCall': 24000,
                      'phase.turbulence': 2000, 'phase.fullFieldWrite': 2000,
                      'phase.log.timeMarker': 2000, 'phase.log.executionTime': 2000}
    rows = {}
    for rank in range(4):
        entries = {}
        for label in ('start', 'end'):
            file = root / f'output/snapshots/A1/{label}/processor{rank}/uniform/profiling'
            entries[label] = v1.profile_entries(file.read_text())
        actual = {row['description']: row['calls'] - entries['start'][index]['calls']
                  for index, row in entries['end'].items()}
        for name, count in expected_calls.items():
            if actual.get(name) != count:
                raise ValueError(f'Unexpected phase count {rank} {name}: {actual.get(name)}')
        rows[str(rank)] = actual
    common.write_json(root / 'receipt/phase-verification.json', {'rankPhaseCounts': rows, 'sourceProof': proof,
                      'exactTrajectoryPassed': True, 'productionEvidence': False})
    print(json.dumps({'phaseProfileVerified': True, 'ranks': 4, 'exactFieldsAndCoefficients': True}))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['native', 'rank', 'inspect'])
    p.add_argument('--input', type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--case', type=Path)
    p.add_argument('--receipts', type=Path)
    p.add_argument('--arm')
    p.add_argument('--allowed')
    p.add_argument('--bound')
    a = p.parse_args()
    if a.action == 'inspect':
        inspect_build(a.output)
    elif a.action == 'native':
        native_run(a.input, a.output)
    else:
        rank_entry(a.case, a.receipts, list(map(int, a.allowed.split(','))))
