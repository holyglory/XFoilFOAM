"""Exercise the host retirement guard with local source files and a fake Compose CLI."""

import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = "scripts/deploy/worker-report-staging-keys.sh"
MANIFEST = "scripts/deploy/deployment-source-manifest.py"
READERS = (
    "apps/sweeper/src/progressive-staging-selection.ts",
    "apps/sweeper/src/progressive-evidence-wake.ts",
    "apps/sweeper/src/progressive-worker-evidence.ts",
    "apps/sweeper/src/progressive-stopped-storage.ts",
    "packages/db/src/worker-staging-key-maintenance.ts",
    "packages/db/migrations/0218_worker_report_staging_keys.sql",
    "packages/db/src/schema.ts",
    "packages/db/migrations/meta/_journal.json",
)


def test_only_the_verified_worker_release_can_reach_index_retirement(tmp_path):
    app, state = tmp_path / "app", tmp_path / "state"
    state.mkdir()
    for relative in (*READERS, WRAPPER, MANIFEST, "scripts/deploy/deployment-compose-profile.sh"):
        dest = app / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, dest)
    revision = "a7" * 20
    subprocess.run(
        [sys.executable, str(app / MANIFEST), "--create", "--root", str(app),
         "--manifest", str(app / ".deployment-source.json"), "--revision", revision],
        check=True, capture_output=True,
    )
    images = tmp_path / "images"
    for name in ("sweeper", "node-api"):
        shutil.copytree(app, images / name)
    settings = state / ".env.deploy"
    override = state / "docker-compose.remote-solver.yml"
    override.touch()
    worker = ("AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver\nCOMPOSE_PROJECT_NAME=hz-solver2\n"
              f"COMPOSE_OVERRIDE_FILE={override}\n")
    settings.write_text(worker)
    calls = tmp_path / "operations"
    lock = tmp_path / "deploy.lock"
    docker = tmp_path / "docker"
    docker.write_text("""#!/usr/bin/env python3
import hashlib, os, pathlib, sys
a=sys.argv[1:]
if a[0]=='compose' and 'ps' in a:
    if a[-1] != os.environ.get('ABSENT'): print(a[-1])
elif a[0]=='exec':
    root=pathlib.Path(os.environ['IMAGES'])/a[a.index('/app')+1]
    for line in sys.stdin:
        digest, name = line.rstrip().split('  ',1)
        if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest: sys.exit(1)
elif a[0]=='compose' and 'exec' in a:
    with open(os.environ['CALLS'],'a') as out:
        out.write(' '.join(a[a.index('packages/db/src/worker-staging-key-maintenance.ts')+1:])+'\\n')
else: sys.exit(2)
""")
    docker.chmod(0o700)
    env = {k: v for k, v in os.environ.items() if k not in
           {"COMPOSE_OVERRIDE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "ABSENT"}}
    env.update(APP_DIR=str(app), ENV_FILE=str(settings), AIRFOILS_PRO_STATE_DIR=str(state),
               LOCK_FILE=str(lock), CALLS=str(calls), IMAGES=str(images),
               PATH=f"{tmp_path}:{env['PATH']}")
    instance = "a1c20000-0000-4000-8000-000000000018"

    def retire(rev=revision, **overrides):
        return subprocess.run([str(app / WRAPPER), "retire", instance, rev],
                              env={**env, **overrides}, capture_output=True, text=True).returncode

    assert retire("1" * 40) != 0
    assert retire(ABSENT="node-api") != 0
    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert retire() == 9
    running = images / "sweeper" / READERS[0]
    running.write_bytes(running.read_bytes() + b"\n")
    assert retire() != 0
    shutil.copy2(app / READERS[0], running)
    settings.write_text("AIRFOILFOAM_DEPLOYMENT_ROLE=hub\nCOMPOSE_PROJECT_NAME=app\n")
    assert retire() != 0
    settings.write_text(worker)
    assert not calls.exists()
    assert retire() == 0
    assert calls.read_text().splitlines() == [f"retire {instance} {revision}"]

if __name__ == "__main__":
    from tempfile import TemporaryDirectory

    with TemporaryDirectory(prefix="worker-staging-key-release-") as temp:
        test_only_the_verified_worker_release_can_reach_index_retirement(Path(temp))
