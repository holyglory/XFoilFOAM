"""One observational four-rank replay; never accepted CFD or a speed comparison."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import time

try:
    from scripts.materials import compressible_checkpoint_placement as reference
except ModuleNotFoundError:
    import compressible_checkpoint_placement as reference

common = reference.common
PARALLEL = """    costProfileParallel
    {
        type parProfiling;
        libs (utilityFunctionObjects);
        detail 2;
        executeControl timeStep;
        executeInterval 200;
        writeControl none;
    }
"""


def instrument_control(text):
    if re.search(r'\b(?:profiling|costProfileParallel)\s*\{', text):
        raise ValueError('Refusing to overwrite existing instrumentation')
    result, count = re.subn(r'(\bfunctions\s*\{\s*\n)', lambda m: m[1] + PARALLEL, text)
    if count != 1:
        raise ValueError('Expected one original functions dictionary')
    result += '\nprofiling {}\n'
    if result.removesuffix('\nprofiling {}\n').replace(PARALLEL, '', 1) != text:
        raise ValueError('Instrumentation changed existing dictionary entries')
    return result


def process_counters(pid):
    root = Path('/proc') / str(pid)
    return {
        'io': {k: int(v) for k, v in (line.split(':') for line in (root / 'io').read_text().splitlines())},
        'schedstat': list(map(int, (root / 'schedstat').read_text().split())),
        'status': [line for line in (root / 'status').read_text().splitlines()
                   if line.startswith(('voluntary_ctxt_switches:', 'nonvoluntary_ctxt_switches:'))],
    }


def native_run(input_root, output):
    if not all(os.environ.get(n) for n in ('DC2_DEPLOYMENT', 'DC2_COMPONENT', 'DC2_GENERATION')):
        raise ValueError('Governed private deployment required')
    owner = json.loads((input_root / 'owner.json').read_text())
    for path, key in [(Path(__file__), 'driverSha256'), (Path(reference.__file__), 'referenceSha256'),
                      (Path(common.__file__), 'helperSha256')]:
        if common.digest(path) != owner[key]:
            raise ValueError('Diagnostic source changed')
    expected = json.loads((input_root / 'case-files.json').read_text())
    if common.tree_identity(input_root / 'case') != expected:
        raise ValueError('Authenticated frozen input changed')
    adapter = json.loads((input_root / 'python-adapter.json').read_text())
    import sys
    if common.digest(sys.executable) != adapter['executableSha256'] or common.tree_identity(Path(sys.base_prefix)) != adapter['files']:
        raise ValueError('Portable Python changed')
    identity = reference.native_identity()
    common.write_json(output / 'native-identity.json', identity)
    canonical = output / 'canonical'
    shutil.copytree(input_root / 'case', canonical)
    original = (canonical / 'system/controlDict').read_text()
    (canonical / 'system/controlDict').write_text(instrument_control(original))
    common.write_json(output / 'observational-control.json', {'before': original,
                      'after': (canonical / 'system/controlDict').read_text(),
                      'numericalEntriesChanged': False, 'acceptanceEntriesChanged': False})
    if sum(common.mesh_shape(canonical / f'processor{rank}')['cells'] for rank in range(4)) != 30700:
        raise ValueError('Frozen decomposition lost cells')
    original_boundary = reference.boundary

    def observed_boundary(*args):
        value = original_boundary(*args)
        value['processCounters'] = {rank: process_counters(row['pid']) for rank, row in value['rankCpu'].items()}
        return value

    reference.boundary = observed_boundary
    # A short wall time would not invalidate section attribution; this is no placement comparison.
    reference.MIN_MEASURE_SECONDS = 1
    plan = json.loads((input_root / 'fixed-step-plan.json').read_text())
    started = time.monotonic()
    arm = reference.run_arm(canonical, output, 'A1', identity, plan, started + 600)
    for label, boundary in arm['boundaries'].items():
        for rank in range(4):
            profile = output / 'snapshots/A1' / label / f'processor{rank}/uniform/profiling'
            common.complete_ascii(profile)
    common.write_json(output / 'report.json', {'schemaVersion': 1, 'kind': 'native-cost-profile',
                      'runId': owner['runId'], 'identity': identity, 'arm': arm,
                      'acceptedCfd': False, 'published': False, 'physicalValidation': False,
                      'speedupClaim': False, 'wallSeconds': time.monotonic() - started})
    if common.tree_identity(input_root / 'case') != expected:
        raise ValueError('Original input changed during replay')


def profile_entries(text):
    entries = {}
    for block in re.findall(r'\btrigger\d+\s*\{([^{}]+)\}', text):
        def get(key):
            match = re.search(r'\b' + key + r'\s+("[^"]*"|[^;]+);', block)
            if not match:
                raise ValueError('Incomplete profiling trigger: ' + key)
            return match[1].strip().strip('"')
        number = int(get('id'))
        parent = re.search(r'\bparentId\s+(\d+);', block)
        entries[number] = {'id': number, 'parent': int(parent[1]) if parent else number,
                           'description': get('description'), 'calls': int(get('calls')),
                           'total': float(get('totalTime')), 'child': float(get('childTime'))}
    if not entries or not any(x['parent'] == x['id'] for x in entries.values()):
        raise ValueError('Missing complete profiling hierarchy')
    return entries


def verify(root):
    report = json.loads((root / 'output/report.json').read_text())
    baseline = json.loads((root / 'input/reference-measurement.json').read_text())
    arm = report['arm']
    if report['acceptedCfd'] or report['published'] or report['speedupClaim']:
        raise ValueError('Profiling cannot publish solver evidence or a gain')
    if arm['coefficients'] != baseline['coefficients']:
        raise ValueError('Profiling changed coefficient rows')
    comparison = {}
    profiles = {}
    for label in ('start', 'end'):
        comparison[label] = {}
        profiles[label] = {}
        for rank in range(4):
            actual = arm['snapshots'][label][str(rank)]
            expected = baseline['snapshots'][label][str(rank)]
            if actual['state'] != expected['state'] or actual['shape'] != expected['shape']:
                raise ValueError('Profiling changed endpoint or decomposition')
            for field, metadata in expected['fields'].items():
                if actual['fields'][field]['valueSha256'] != metadata['valueSha256']:
                    raise ValueError('Profiling changed stored field values')
            comparison[label][str(rank)] = list(expected['fields'])
            file = root / f'output/snapshots/A1/{label}/processor{rank}/uniform/profiling'
            profiles[label][str(rank)] = profile_entries(file.read_text())
    common.write_json(root / 'receipt/verification.json', {'allCoefficientRowsIdentical': True,
                      'allSavedFieldValuesIdentical': True, 'fieldsCompared': comparison,
                      'profiles': profiles, 'measurement': arm['measurement'],
                      'acceptedCfd': False, 'speedupClaim': False})
    print(json.dumps({'verified': True, 'steps': arm['measurement']['steps'],
                      'fieldValuesIdentical': True, 'coefficientRowsIdentical': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['native', 'verify'])
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--root', type=Path)
    args = parser.parse_args()
    if args.action == 'native':
        native_run(args.input, args.output)
    else:
        verify(args.root)
