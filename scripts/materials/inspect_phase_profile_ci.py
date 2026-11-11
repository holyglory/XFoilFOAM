"""Public-source image inspection only, restricted to GitHub-hosted CI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
    raise SystemExit('This source-only diagnostic is restricted to the authorized GitHub-hosted runner')

image = sys.argv[1]
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)

def run(name, command, timeout=60):
    result = subprocess.run(command, capture_output=True, timeout=timeout)
    (out / (name + '.stdout.log')).write_bytes(result.stdout)
    (out / (name + '.stderr.log')).write_bytes(result.stderr)
    return result

container = None
try:
    made = run('create-for-copy', ['docker', 'create', '--network', 'none', image])
    made.check_returncode()
    container = made.stdout.decode().strip()
    copied = run('copy-build-proof', ['docker', 'cp', container + ':/opt/phase-profile/proof', str(out / 'build-proof')])
    copied.check_returncode()
finally:
    if container:
        removed = run('remove-copy-container', ['docker', 'rm', container])
        removed.check_returncode()

proof = json.loads((out / 'build-proof/build-proof.json').read_text())
original = '/usr/lib/openfoam/openfoam2606/platforms/linux64GccDPInt32Opt/bin/rhoPimpleFoam'
experimental = '/opt/phase-profile/bin/xfoilfoamRhoPimplePhaseProfile'
paths = list(proof['runtimeBaseDependencySha256']) + [original, experimental]
hashes = run('runtime-hashes', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image, *paths])
hashes.check_returncode()
actual = {line.split(None, 1)[1].strip(): line.split(None, 1)[0] for line in hashes.stdout.decode().splitlines()}
mismatches = {path: {'pinnedRuntime': expected, 'runtime': actual.get(path)} for path, expected in proof['runtimeBaseDependencySha256'].items()
              if expected != actual.get(path)}
build_differences = {path: {'build': expected, 'pinnedRuntime': actual.get(path)} for path, expected in proof['dependencySha256'].items()
                     if expected != actual.get(path)}
help_result = run('experimental-help', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'bash', image, '-lc',
    'source /usr/lib/openfoam/openfoam2606/etc/bashrc && exec /opt/phase-profile/bin/xfoilfoamRhoPimplePhaseProfile -help'])
image_id = run('image-identity', ['docker', 'image', 'inspect', image, '--format', '{{.Id}}'])
image_id.check_returncode()
summary = {'sourceCommit': os.environ['GITHUB_SHA'], 'imageId': image_id.stdout.decode().strip(),
    'buildProof': proof, 'runtimeDependencySha256': actual, 'dependencyMismatches': mismatches,
    'buildStageDifferences': build_differences,
    'experimentalHelpExit': help_result.returncode, 'privateCheckpointUsed': False,
    'solverWindowStarted': False, 'productionCredentialsUsed': False, 'imagePublished': False,
    'coordinatorProof': False, 'trajectoryProof': False}
(out / 'source-only-preflight.json').write_text(json.dumps(summary, indent=2))
manifest = {str(p.relative_to(out)): {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in out.rglob('*') if p.is_file()}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'dependencyMismatches': mismatches, 'experimentalHelpExit': help_result.returncode,
                  'solverWindowStarted': False, 'trajectoryProof': False}))
if mismatches or help_result.returncode:
    raise SystemExit(1)
