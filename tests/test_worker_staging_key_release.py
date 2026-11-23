"""Exercise the public staging and deployment wrappers with real host locks."""

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import select
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


@contextmanager
def paused_command(command, env, expected_marker, expected_exit):
    with subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as process:
        try:
            assert select.select([process.stdout], [], [], 8)[0], "Command did not reach its lock boundary"
            assert process.stdout.readline().strip() == expected_marker
            yield
        finally:
            _, error = process.communicate(input="release\n", timeout=8)
        assert process.returncode == expected_exit, error


def test_staging_operator_and_deployment_lock_boundaries(tmp_path):
    app, state = tmp_path / "app", tmp_path / "state"
    state.mkdir()
    promotion_files = (
        "deployment-compose-profile.sh", "promote-and-redeploy.sh", "vps-redeploy.sh",
        "source-rsync-excludes.txt", "atomic-release-switch.py", "fsync-release.py",
        "deployment-env-preflight.py", "bootstrap-opencfd-env.py", "opencfd2606_cutover_state.py",
        "remote-solver2606-cutover-state.py",
    )
    for relative in (*READERS, WRAPPER, MANIFEST, *("scripts/deploy/" + name for name in promotion_files)):
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
    if os.environ.get('PAUSE_OPERATOR'):
        print('operator entered',flush=True)
        assert sys.stdin.readline().strip()=='release'
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

    metadata = [("start", instance), ("backfill", instance, "128"), ("verify",),
                ("enable", instance), ("disable", instance), ("stop", instance)]
    command = str(app / WRAPPER)
    with lock.open("r") as archive_reader:
        fcntl.flock(archive_reader, fcntl.LOCK_SH | fcntl.LOCK_NB)
        for args in metadata:
            result = subprocess.run([command, *args], env=env, capture_output=True, text=True, timeout=5)
            assert result.returncode == 0, (args[0], result.stderr)
        assert retire() == 9
        assert subprocess.run([command, "restore", instance], env=env, capture_output=True).returncode == 9
    assert calls.read_text().splitlines()[1:] == [" ".join(args) for args in metadata]

    # Stop the actual promotion just after its exclusive flock, before the
    # first deployment directory or service can change.
    install = tmp_path / "install"
    install.write_text("#!/bin/sh\necho 'deployment entered'\nread -r release\nexit 73\n")
    install.chmod(0o700)
    promote = ["/bin/bash", str(app / "scripts/deploy/promote-and-redeploy.sh")]
    deploy_env = {**env, "STAGING_DIR": str(app), "APP_DIR": str(tmp_path / "current"),
                  "DEPLOY_ROOT": str(tmp_path), "RELEASES_DIR": str(tmp_path / "releases"),
                  "SHARED_ENV_FILE": str(settings), "EXPECTED_SOURCE_REVISION": revision}
    before = calls.read_bytes()
    with paused_command(promote, deploy_env, "deployment entered", 73):
        for args in [*metadata, ("restore", instance), ("retire", instance, revision)]:
            assert subprocess.run([command, *args], env=env, capture_output=True, timeout=5).returncode == 9
    assert calls.read_bytes() == before

    with paused_command([command, "backfill", instance, "128"], {**env, "PAUSE_OPERATOR": "1"},
                        "operator entered", 0):
        with lock.open("r") as archive_reader:
            fcntl.flock(archive_reader, fcntl.LOCK_SH | fcntl.LOCK_NB)
        assert subprocess.run([command, "verify"], env=env, capture_output=True, timeout=5).returncode == 0
        blocked = subprocess.run(promote, env=deploy_env, capture_output=True, text=True, timeout=5)
        assert blocked.returncode == 9 and "deploy is already running" in blocked.stderr
    print("Shared archive readers admitted all six metadata operations; exclusive deployment and index maintenance guards verified.")

if __name__ == "__main__":
    from tempfile import TemporaryDirectory

    with TemporaryDirectory(prefix="worker-staging-key-release-") as temp:
        test_staging_operator_and_deployment_lock_boundaries(Path(temp))
