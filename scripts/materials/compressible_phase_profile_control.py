"""Governed v2 fixture; first-profile artifacts remain immutable."""
import argparse
import json
import os
from pathlib import Path
import shutil

from scripts.materials import checkpoint_placement_control as lifecycle
from scripts.materials import compressible_cost_profile as driver
from scripts.materials import compressible_phase_profile as phase_driver
from scripts.materials import build_compressible_phase_profile as source_builder

common = driver.common
reference = driver.reference
NAME = 'compressible-phase-profile-v2'
RELATIVE_ROOT = Path('.codex-artifacts/compressible-phase-profile-v2')
RETAINED = Path('/mnt/build-storage/codex/xfoilfoam-verification/compressible-checkpoint-placement-20261111/.codex-artifacts/compressible-checkpoint-placement-v2')
ARCHIVE_ROOT = Path('/home/holyglory/XFoilFOAM/.codex-artifacts/slow-job-recovery-20261106/hours-mrc20-846-a3-checkpoint-20261109')


def owner():
    for name in ('DEVCOORDINATOR_RUN_ID', 'DEVCOORDINATOR_CHECK_NAME', 'DEVCOORDINATOR_DIAGNOSTIC_FD'):
        if not os.environ.get(name):
            raise ValueError('Admitted governed check required')
    os.fstat(int(os.environ['DEVCOORDINATOR_DIAGNOSTIC_FD']))
    return {'runId': os.environ['DEVCOORDINATOR_RUN_ID'], 'path': str(Path.cwd().resolve()),
            'buildGeneratorSha256': common.digest(source_builder.__file__),
            'dockerfileSha256': common.digest('docker/Dockerfile.compressible-phase-profile'),
            'phaseDriverSha256': common.digest(phase_driver.__file__), 'driverSha256': common.digest(driver.__file__), 'referenceSha256': common.digest(reference.__file__),
            'helperSha256': common.digest(common.__file__), 'controllerSha256': common.digest(__file__),
            'composeSha256': common.digest('compose.compressible-phase-profile-v2.yml')}


def ref(owned):
    return {'path': owned['path'], 'name': NAME}


def owned_root(owned):
    root = Path(owned['path']) / RELATIVE_ROOT
    if json.loads((root / 'input/owner.json').read_text()) != owned:
        raise ValueError('Fixture belongs to another source or run')
    return root


def validate(state):
    if state['name'] != NAME or state.get('public') or state.get('domain') or state.get('route_port') or state.get('observed_only') or state.get('source') != 'worktree':
        raise ValueError('Unexpected fixture ownership or exposure')
    if [c['name'] for c in state['components']] != ['profile']:
        raise ValueError('Unexpected component')


def prepare(owned):
    if lifecycle.coordinator('deployment.status', ref(owned), absent_ok=True) is not None:
        raise ValueError('Previous fixture exists')
    root = Path(owned['path']) / RELATIVE_ROOT
    if root.exists() or root.is_symlink():
        raise ValueError('Fresh artifact destination required')
    archive = ARCHIVE_ROOT / 'evidence.tar.zst'
    library = ARCHIVE_ROOT / 'libxfoilfoamThermophysics-20261111.so'
    manifest = ARCHIVE_ROOT / 'authenticated-compressible-checkpoint-20261111/evidence_manifest.json'
    if archive.stat().st_size != reference.ARCHIVE_BYTES or common.digest(archive) != reference.ARCHIVE_SHA256:
        raise ValueError('Archive identity differs')
    if library.stat().st_size != reference.LIBRARY_BYTES or common.digest(library) != reference.LIBRARY_SHA256 or common.digest(manifest) != reference.MANIFEST_SHA256:
        raise ValueError('Material library or manifest identity differs')
    frozen = json.loads((RETAINED / 'output/frozen-decomposition.json').read_text())
    if common.tree_identity(RETAINED / 'output/canonical') != frozen:
        raise ValueError('Retained four-rank decomposition differs from its sealed proof')
    original = (ARCHIVE_ROOT / 'authenticated-compressible-checkpoint-20261111/openfoam/transient/system/controlDict').read_text()
    if (RETAINED / 'output/canonical/system/controlDict').read_text() != reference.prepare_control(original):
        raise ValueError('Prior control override is outside restart/output allowlist')
    authenticated = ARCHIVE_ROOT / 'authenticated-compressible-checkpoint-20261111/openfoam/transient'
    for directory in ('system', 'constant'):
        for file in (authenticated / directory).rglob('*'):
            if not file.is_file() or file.name == 'controlDict':
                continue
            if common.digest(file) != common.digest(RETAINED / 'output/canonical' / file.relative_to(authenticated)):
                raise ValueError('Original physical/numerical dictionaries or mesh changed')
    for part in ('input', 'output', 'receipt'):
        (root / part).mkdir(parents=True, exist_ok=False)
    common.write_json(root / 'input/owner.json', owned)
    shutil.copytree(RETAINED / 'output/canonical', root / 'input/case')
    (root / 'input/library').mkdir()
    shutil.copy2(library, root / 'input/library/libxfoilfoamThermophysics.so')
    for source, target in [('fixed-step-plan.json', 'fixed-step-plan.json'), ('A1-measurement.json', 'reference-measurement.json')]:
        shutil.copy2(RETAINED / 'output' / source, root / 'input' / target)
    common.write_json(root / 'input/case-files.json', frozen)
    adapter = lifecycle.stage_python_adapter(root / 'python')
    common.write_json(root / 'input/python-adapter.json', adapter)
    common.write_json(root / 'receipt/input.json', {'archiveSha256': reference.ARCHIVE_SHA256,
                      'librarySha256': reference.LIBRARY_SHA256, 'decompositionSha256': common.value_digest(frozen),
                      'originalRanks': 4, 'cells': 30700, 'acceptedCfd': False,
                      'restartOutputOverrides': reference.CONTROL_OVERRIDES})
    print(json.dumps({'prepared': True, 'runId': owned['runId'], 'ranks': 4, 'meshCells': 30700}))


def apply(owned):
    root = owned_root(owned)
    ready = lifecycle.coordinator('deployment.preflight', ref(owned))
    if not ready['ready'] or ready['blockers']:
        raise ValueError('Governed fixture preflight blocked')
    common.write_json(root / 'apply-intent.json', owned)
    state = lifecycle.coordinator('deployment.apply', ref(owned), timeout=2400, error_receipt=root / 'receipt/apply-error.json')
    validate(state)
    common.write_json(root / 'deployment.json', state)
    if state['state'] != 'completed' or any(c['state'] != 'completed' for c in state['components']):
        raise ValueError('Native profile did not complete')
    print(json.dumps({'deploymentId': state['deployment_id'], 'state': state['state']}))


def cleanup(owned):
    root = Path(owned['path']) / RELATIVE_ROOT
    if not (root / 'input/owner.json').exists():
        return
    owned_root(owned)
    for path in (root / 'output').glob('*'):
        if path.is_file() and path.suffix in ('.json', '.log'):
            shutil.copy2(path, root / 'receipt' / ('native-' + path.name))
    if (root / 'output/build-proof').exists():
        shutil.copytree(root / 'output/build-proof', root / 'receipt/build-proof')
    binary = root / 'output/xfoilfoamRhoPimplePhaseProfile'
    if binary.exists():
        shutil.copy2(binary, root / 'receipt' / binary.name)
    if not (root / 'apply-intent.json').exists():
        return
    state = lifecycle.coordinator('deployment.status', ref(owned), absent_ok=True)
    if state is None:
        return
    validate(state)
    exact = {'deployment_id': state['deployment_id']}
    common.write_json(root / 'receipt/runtime-status.json', state)
    lifecycle.coordinator('deployment.stop', exact)
    removed = lifecycle.coordinator('deployment.remove', {**exact, 'delete_data': True})
    if lifecycle.coordinator('deployment.status', exact, absent_ok=True) is not None:
        raise ValueError('Fixture removal not confirmed')
    common.write_json(root / 'receipt/cleanup.json', {'deploymentId': state['deployment_id'], 'result': removed})
    print(json.dumps({'cleanup': 'removed', 'deploymentId': state['deployment_id']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'apply', 'verify', 'cleanup'])
    args = parser.parse_args()
    owned = owner()
    if args.action == 'verify':
        phase_driver.verify(owned_root(owned))
    else:
        {'prepare': prepare, 'apply': apply, 'cleanup': cleanup}[args.action](owned)
