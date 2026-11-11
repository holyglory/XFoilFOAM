"""Coordinator-owned private lifecycle for the compressible placement benchmark."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from airfoilfoam.evidence_store import extract_verified_evidence_archive
from scripts.materials import checkpoint_placement as common
from scripts.materials import checkpoint_placement_control as lifecycle
from scripts.materials import compressible_checkpoint_placement as benchmark

NAME = 'compressible-placement'
RELATIVE_ROOT = Path('.codex-artifacts/compressible-checkpoint-placement-v2')
INPUT_ROOT = Path('/home/holyglory/XFoilFOAM/.codex-artifacts/slow-job-recovery-20261106/hours-mrc20-846-a3-checkpoint-20261109')
RESTORED = INPUT_ROOT / 'authenticated-compressible-checkpoint-20261111'


def owner():
    required=('DEVCOORDINATOR_RUN_ID','DEVCOORDINATOR_CHECK_NAME','DEVCOORDINATOR_DIAGNOSTIC_FD')
    if not all(os.environ.get(n) for n in required):raise ValueError('Admitted governed check required')
    os.fstat(int(os.environ['DEVCOORDINATOR_DIAGNOSTIC_FD']))
    return {'runId':os.environ['DEVCOORDINATOR_RUN_ID'],'path':str(Path.cwd().resolve()),'name':NAME,
            'driverSha256':common.digest(benchmark.__file__),'helperSha256':common.digest(common.__file__),
            'controllerSha256':common.digest(__file__),'composeSha256':common.digest('compose.compressible-checkpoint.yml')}


def reference(owned):
    return {'path':owned['path'],'name':NAME}


def owned_root(owned):
    root=Path(owned['path'])/RELATIVE_ROOT
    if json.loads((root/'input/owner.json').read_text())!=owned:raise ValueError('Fixture belongs to another source/run')
    return root


def validate_state(state):
    if state['name']!=NAME or state.get('public') or state.get('domain') or state.get('route_port') or state.get('observed_only') or state.get('source')!='worktree':raise ValueError('Unexpected routed or foreign fixture')
    if [c['name'] for c in state['components']]!=['benchmark']:raise ValueError('Unexpected runtime component')


def prepare(owned):
    if lifecycle.coordinator('deployment.status',reference(owned),absent_ok=True) is not None:raise ValueError('Previous owned fixture still exists')
    root=Path(owned['path'])/RELATIVE_ROOT
    if root.exists() or root.is_symlink():raise ValueError('Fresh frozen checkout required; never overwrite evidence')
    archive=INPUT_ROOT/'evidence.tar.zst';manifest=RESTORED/'evidence_manifest.json';library=INPUT_ROOT/'libxfoilfoamThermophysics-20261111.so'
    for path in (archive,manifest,library):
        if path.is_symlink() or not path.is_file():raise ValueError('Inputs must be regular files')
    if archive.stat().st_size!=benchmark.ARCHIVE_BYTES or common.digest(archive)!=benchmark.ARCHIVE_SHA256:raise ValueError('Archive identity differs')
    if common.digest(manifest)!=benchmark.MANIFEST_SHA256:raise ValueError('Manifest identity differs')
    if library.stat().st_size!=benchmark.LIBRARY_BYTES or common.digest(library)!=benchmark.LIBRARY_SHA256:raise ValueError('Thermophysics identity differs')
    restoration=json.loads((INPUT_ROOT/'checkpoint-restoration-20261111.json').read_text())
    native=json.loads((INPUT_ROOT/'current-native-identity-20261111.json').read_text())
    if not restoration['wholeBundleAuthenticated'] or restoration['archiveSha256']!=benchmark.ARCHIVE_SHA256:raise ValueError('Missing supplied archive restoration proof')
    for name,digest in benchmark.BINARY_HASHES.items():
        if not any(Path(x['path']).name==name and x['sha256']==digest for x in native['files']):raise ValueError('Native input identity differs')
    for part in ('input','output','receipt'):(root/part).mkdir(parents=True,exist_ok=False)
    common.write_json(root/'input/owner.json',owned)
    for filename in ('checkpoint-restoration-20261111.json','current-native-identity-20261111.json','download-receipt.json'):
        shutil.copy2(INPUT_ROOT/filename,root/'receipt'/filename)
    shutil.copy2(manifest,root/'receipt/evidence_manifest.json')
    authenticated=root/'authenticated'
    prefixes=('openfoam/transient/system','openfoam/transient/constant',f'time_directories/{benchmark.START_TIME}')
    count=extract_verified_evidence_archive(archive,authenticated,compression='zstd',expected_manifest=manifest.read_bytes(),include_prefixes=prefixes)
    # Streaming extraction authenticates every member, including omitted logs.
    case=root/'input/case';case.mkdir()
    for source,target in [('openfoam/transient/system','system'),('openfoam/transient/constant','constant'),(f'time_directories/{benchmark.START_TIME}',benchmark.START_TIME)]:
        if common.tree_identity(authenticated/source)!=common.tree_identity(RESTORED/source):raise ValueError('Re-extracted checkpoint differs from supplied authenticated restoration')
        shutil.copytree(authenticated/source,case/target)
    state=common.time_state(case/benchmark.START_TIME/'uniform/time')
    if state['index']!=benchmark.START_INDEX or abs(state['value']-float(benchmark.START_TIME))>1e-10 or state['deltaT']!=benchmark.START_DELTAT:raise ValueError('Exact restart index/time/deltaT differs')
    for field,expected in restoration['fields'].items():
        path=case/benchmark.START_TIME/field
        if path.stat().st_size!=expected['bytes'] or common.digest(path)!=expected['sha256']:raise ValueError('Restored field bytes differ')
    shape=common.mesh_shape(case)
    if shape['cells']!=30700:raise ValueError('Wrong global mesh')
    for field in benchmark.FIELDS:common.parsed_field(case/benchmark.START_TIME/field,shape,field)
    (root/'input/library').mkdir();shutil.copy2(library,root/'input/library/libxfoilfoamThermophysics.so')
    adapter=lifecycle.stage_python_adapter(root/'python')
    common.write_json(root/'input/python-adapter.json',adapter)
    common.write_json(root/'receipt/python-adapter.json',adapter)
    files=common.tree_identity(case);common.write_json(root/'input/case-files.json',files)
    common.write_json(root/'receipt/input.json',{'owner':owned,'archiveSha256':benchmark.ARCHIVE_SHA256,'archiveBytes':benchmark.ARCHIVE_BYTES,
        'manifestSha256':benchmark.MANIFEST_SHA256,'wholeBundleAuthenticated':True,'authenticatedMembers':count,
        'checkpoint':state,'fields':restoration['fields'],'caseFiles':files,'librarySha256':benchmark.LIBRARY_SHA256,
        'originalRanks':4,'benchmarkRanks':[4,4,4,4],'armOrder':list(benchmark.ARMS),'acceptedCfd':False})
    print(json.dumps({'prepared':True,'runId':owned['runId'],'wholeBundleAuthenticated':True,'members':count,'ranks':4}))


def apply(owned):
    root=owned_root(owned)
    state=lifecycle.coordinator('deployment.preflight',reference(owned))
    if not state['ready'] or state['blockers']:raise ValueError('Governed fixture preflight blocked')
    if lifecycle.coordinator('deployment.status',reference(owned),absent_ok=True) is not None:raise ValueError('Refusing to replace existing fixture')
    common.write_json(root/'apply-intent.json',owned)
    state=lifecycle.coordinator('deployment.apply',reference(owned),timeout=2750,error_receipt=root/'receipt/apply-error.json')
    validate_state(state);common.write_json(root/'deployment.json',state)
    if state['state']!='completed' or not state.get('current_generation') or any(c['state']!='completed' for c in state['components']):raise ValueError('Native fixture did not complete')
    print(json.dumps({'deploymentId':state['deployment_id'],'generation':state['current_generation'],'state':state['state']}))


def verify(owned):
    root=owned_root(owned);report=json.loads((root/'output/report.json').read_text())
    if report['runId']!=owned['runId'] or report['acceptedCfd'] or report['published'] or report['physicalValidation']:raise ValueError('Incorrect benchmark identity/publication')
    for arm in report['arms']:
        for label,snapshots in arm['snapshots'].items():
            for rank,snapshot in snapshots.items():
                directory=root/'output/snapshots'/arm['arm']/label/f'processor{rank}'
                if common.time_state(directory/'uniform/time')!=snapshot['state']:raise ValueError('Retained checkpoint time changed')
                for field,metadata in snapshot['fields'].items():
                    path=directory/field
                    if common.digest(path)!=metadata['sha256'] or common.value_digest(common.parsed_field(path,snapshot['shape'],field))!=metadata['valueSha256']:raise ValueError('Retained field proof changed')
    result=benchmark.compare(report)
    common.write_json(root/'receipt/comparison.json',{'runId':owned['runId'],'acceptedCfd':False,'published':False,'physicalValidation':False,**result,'report':report})
    print(json.dumps(result))


def cleanup(owned):
    root=Path(owned['path'])/RELATIVE_ROOT
    if not (root/'input/owner.json').exists():print(json.dumps({'cleanup':'no fixture prepared'}));return
    owned_root(owned)
    # Retain diagnostics even after a failed native arm; do not alter originals.
    for path in (root/'output').glob('*'):
        if path.is_file() and path.suffix in ('.json','.log'):
            destination=root/'receipt'/('native-'+path.name)
            if destination.exists():raise ValueError('Refusing to overwrite retained native evidence')
            shutil.copy2(path,destination)
    if not (root/'apply-intent.json').exists():print(json.dumps({'cleanup':'no runtime requested'}));return
    if json.loads((root/'apply-intent.json').read_text())!=owned:raise ValueError('Foreign cleanup intent')
    state=lifecycle.coordinator('deployment.status',reference(owned),absent_ok=True)
    if state is None:print(json.dumps({'cleanup':'already absent'}));return
    validate_state(state);exact={'deployment_id':state['deployment_id']}
    common.write_json(root/'receipt/runtime-status.json',state)
    try:
        logs=lifecycle.coordinator('deployment.logs',{**exact,'component':'benchmark','tail_lines':100},error_receipt=root/'receipt/runtime-log-error.json')
        common.write_json(root/'receipt/runtime-log.json',logs)
    except (RuntimeError,subprocess.TimeoutExpired,ValueError,OSError):pass
    lifecycle.coordinator('deployment.stop',exact)
    removed=lifecycle.coordinator('deployment.remove',{**exact,'delete_data':True})
    if lifecycle.coordinator('deployment.status',exact,absent_ok=True) is not None:raise ValueError('Owned fixture removal not confirmed')
    common.write_json(root/'receipt/cleanup.json',{'deploymentId':state['deployment_id'],'result':removed})
    print(json.dumps({'cleanup':'removed','deploymentId':state['deployment_id']}))


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','apply','verify','cleanup']);a=p.parse_args()
    {'prepare':prepare,'apply':apply,'verify':verify,'cleanup':cleanup}[a.action](owner())

if __name__=='__main__':main()
