from __future__ import annotations

import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import time

import pytest


ROOT = Path(__file__).resolve().parents[1]
PRUNE = ROOT / "scripts" / "deploy" / "airfoils-docker-storage-prune"


def _fake_docker(bin_dir: Path) -> Path:
    bin_dir.mkdir()
    log = bin_dir / "docker.log"
    executable = bin_dir / "docker"
    executable.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "${1:-} ${2:-}" in
  "image prune"|"builder prune")
    printf 'Total reclaimed space: 0B\n'
    ;;
  *)
    printf 'unexpected fake docker invocation: %s\n' "$*" >&2
    exit 64
    ;;
esac
"""
    )
    executable.chmod(0o755)
    return log


def _tree(path: Path, label: str) -> Path:
    path.mkdir(parents=True)
    (path / "payload.txt").write_text(label)
    return path


def _age(path: Path, *, hours: int) -> None:
    timestamp = time.time() - hours * 60 * 60
    os.utime(path, (timestamp, timestamp))


def _prune_env(tmp_path: Path, deploy_root: Path, **extra: str) -> dict[str, str]:
    fake_bin = tmp_path / "bin"
    docker_log = _fake_docker(fake_bin)
    docker_root = tmp_path / "docker-root"
    docker_root.mkdir()
    deploy_lock = tmp_path / "deploy.lock"
    deploy_lock.touch(mode=0o444, exist_ok=True)
    deploy_lock.chmod(0o444)
    return os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "DOCKER_LOG": str(docker_log),
        "DOCKER_ROOT_DIR": str(docker_root),
        "DOCKER_PRUNE_LOCK_FILE": str(tmp_path / "cleanup.lock"),
        "AIRFOILS_PRO_DEPLOY_LOCK_FILE": str(deploy_lock),
        "AIRFOILS_PRO_DEPLOY_ROOT": str(deploy_root),
        "AIRFOILS_PRO_APP_DIR": str(deploy_root / "app"),
        "AIRFOILS_PRO_RELEASES_DIR": str(deploy_root / "releases"),
        "DEPLOYMENT_RELEASE_KEEP_COUNT": "3",
        "DEPLOYMENT_STAGING_MAX_AGE_HOURS": "24",
    } | extra


def _run_prune(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(PRUNE)], env=env, text=True, capture_output=True, timeout=15
    )


def test_cleanup_bounds_releases_and_staging_without_touching_live_or_fresh_sources(
    tmp_path: Path,
) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    releases = deploy_root / "releases"
    current = _tree(releases / "current-old", "current")
    newest = _tree(releases / "newest", "newest")
    previous = _tree(releases / "previous", "previous")
    expired = _tree(releases / "expired", "expired")
    partial = _tree(releases / ".materializing-expired", "partial")
    _age(current, hours=120)
    _age(newest, hours=1)
    _age(previous, hours=2)
    _age(expired, hours=3)
    _age(partial, hours=48)
    (deploy_root / "app").symlink_to(current)

    stale_paths = [
        _tree(deploy_root / "deploy-staging" / "old", "old"),
        _tree(deploy_root / "staging" / "old", "old"),
        _tree(deploy_root / "incoming" / "old", "old"),
        _tree(deploy_root / "staging-legacy", "old"),
    ]
    for path in stale_paths:
        _age(path, hours=48)
    fresh = _tree(deploy_root / "deploy-staging" / "fresh", "fresh")
    outside = _tree(tmp_path / "outside", "outside")
    (deploy_root / "staging" / "outside-link").symlink_to(outside)

    env = _prune_env(tmp_path, deploy_root)
    docker_log = Path(env["DOCKER_LOG"])
    completed = _run_prune(env)

    assert completed.returncode == 0, completed.stderr
    assert (deploy_root / "app").resolve() == current
    assert {path.name for path in releases.iterdir()} == {
        current.name,
        newest.name,
        previous.name,
    }
    assert all(not path.exists() for path in stale_paths)
    assert fresh.exists()
    assert outside.exists()
    assert (deploy_root / "staging" / "outside-link").is_symlink()
    commands = docker_log.read_text().splitlines()
    assert commands == [
        "image prune --all --force --filter until=72h",
        "builder prune --all --force --keep-storage 10GB",
    ]
    assert f"docker_root={tmp_path / 'docker-root'}" in completed.stdout
    assert "removed_trees=6" in completed.stdout


def test_exclusive_deployment_skips_all_cleanup(tmp_path: Path) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    current = _tree(deploy_root / "releases" / "current", "current")
    stale = _tree(deploy_root / "deploy-staging" / "old", "old")
    _age(stale, hours=48)
    (deploy_root / "app").symlink_to(current)
    deploy_lock = tmp_path / "deploy.lock"

    env = _prune_env(tmp_path, deploy_root, DOCKER_ROOT_DIR="")
    docker_log = Path(env["DOCKER_LOG"])
    with deploy_lock.open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        completed = _run_prune(env)

    assert completed.returncode == 0, completed.stderr
    assert "A deployment is running" in completed.stdout
    assert stale.exists()
    assert not docker_log.exists()


def test_shared_reader_allows_docker_and_defers_all_source_trees(tmp_path: Path) -> None:
    root = tmp_path / "deploy"
    current = _tree(root / "releases" / "current", "live")
    (root / "app").symlink_to(current)
    expired = [
        _tree(root / path, "expired")
        for path in (
            "staging/old", "deploy-staging/old", "incoming/old", "staging-old",
            "releases/.materializing-old", "releases/previous",
        )
    ]
    for path in expired:
        _age(path, hours=96)
    env = _prune_env(tmp_path, root, DEPLOYMENT_RELEASE_KEEP_COUNT="1")
    with Path(env["AIRFOILS_PRO_DEPLOY_LOCK_FILE"]).open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        run = _run_prune(env)
        assert run.returncode == 0, run.stderr
        assert "state=deferred removed_trees=0 removed_bytes=0" in run.stdout
        assert "Docker storage cleanup complete" in run.stdout
        assert Path(env["DOCKER_LOG"]).read_text().splitlines() == [
            "image prune --all --force --filter until=72h",
            "builder prune --all --force --keep-storage 10GB",
        ]
        assert all((path / "payload.txt").is_file() for path in expired)

    run = _run_prune(env)
    assert run.returncode == 0, run.stderr
    assert "state=complete removed_trees=6" in run.stdout
    assert all(not path.exists() for path in expired)
    assert (root / "app").resolve() == current


@pytest.mark.parametrize("stage", ["image", "builder", "handoff", "source"])
def test_lock_modes_and_single_cleanup_across_processes(tmp_path: Path, stage: str) -> None:
    root = tmp_path / "deploy"
    stale = _tree(root / "staging" / "old", "expired")
    _age(stale, hours=96)
    env = _prune_env(tmp_path, root)
    # Pause immediately before the selected operation. The flock and find
    # shims forward to the real tools; the competing process uses the same inode.
    if stage == "source":
        command, condition = "find", '[ "${!#}" = "-delete" ]'
    elif stage == "handoff":
        command, condition = "flock", '[ "$1" = "-x" ] && [ "${!#}" = 8 ]'
    else:
        command, condition = "docker", f'[ "$1" = "{stage}" ]'
    real_tool = shutil.which(command, path=env["PATH"])
    assert real_tool
    gate_bin = tmp_path / "gate-bin"
    gate_bin.mkdir()
    shim = gate_bin / command
    shim.write_text(
        f'#!/usr/bin/env bash\nset -eu\nif {condition}; then\n'
        '  touch "$PRUNE_TEST_ENTERED"\n  flock -s -w 12 "$PRUNE_TEST_GATE" true\n'
        'fi\nexec "$PRUNE_TEST_TOOL" "$@"\n'
    )
    shim.chmod(0o755)
    gate = tmp_path / "gate"
    entered = tmp_path / "entered"
    env.update(
        PATH=f"{gate_bin}:{env['PATH']}",
        PRUNE_TEST_GATE=str(gate),
        PRUNE_TEST_ENTERED=str(entered),
        PRUNE_TEST_TOOL=real_tool,
    )
    with gate.open("w") as barrier:
        fcntl.flock(barrier, fcntl.LOCK_EX)
        with subprocess.Popen(
            [str(PRUNE)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as first:
            try:
                deadline = time.monotonic() + 8
                while not entered.exists() and time.monotonic() < deadline and first.poll() is None:
                    time.sleep(0.02)
                assert entered.exists(), f"cleanup did not reach {stage}"
                with Path(env["AIRFOILS_PRO_DEPLOY_LOCK_FILE"]).open("rb") as probe:
                    if stage == "handoff":
                        # A real deployment wins the gap after Docker releases its lock.
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    else:
                        with pytest.raises(BlockingIOError):
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if stage == "source":
                            with pytest.raises(BlockingIOError):
                                fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        else:
                            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)

                    second = _run_prune(env)
                    assert second.returncode == 0, second.stderr
                    assert "cleanup is already running" in second.stdout
                    fcntl.flock(barrier, fcntl.LOCK_UN)
                    stdout, stderr = first.communicate(timeout=12)
                    assert first.returncode == 0, stderr
            finally:
                fcntl.flock(barrier, fcntl.LOCK_UN)
                if first.poll() is None:
                    first.kill()
    assert len(Path(env["DOCKER_LOG"]).read_text().splitlines()) == 2
    assert stale.exists() == (stage != "source")
    assert f"state={'complete' if stage == 'source' else 'deferred'}" in stdout


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("DOCKER_PRUNE_RETENTION_HOURS", "0"),
        ("DOCKER_BUILD_CACHE_KEEP_STORAGE", "all"),
        ("DEPLOYMENT_RELEASE_KEEP_COUNT", "0"),
        ("DEPLOYMENT_STAGING_MAX_AGE_HOURS", "0"),
    ],
)
def test_cleanup_rejects_unbounded_or_malformed_settings(
    tmp_path: Path, name: str, value: str
) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    deploy_root.mkdir()

    env = _prune_env(tmp_path, deploy_root, **{name: value})
    docker_log = Path(env["DOCKER_LOG"])
    completed = _run_prune(env)

    assert completed.returncode == 2
    assert "must be" in completed.stderr
    assert not docker_log.exists()


def test_solver_core_soft_limit_is_inherited_and_reversible_for_the_exact_tree(tmp_path: Path) -> None:
    import json
    import resource
    import runpy
    import sys

    policy = runpy.run_path(str(ROOT / "scripts/deploy/solver_core_limits.py"))
    script = """import json,resource,subprocess,sys
hard=resource.getrlimit(resource.RLIMIT_CORE)[1]
start=min(8388608, hard) if hard>=0 else 8388608
resource.setrlimit(resource.RLIMIT_CORE,(start,hard))
p=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(25)'])
print(json.dumps([p.pid,start]),flush=True)
for line in sys.stdin:
 if line.strip()=='inherit':
  print(subprocess.check_output([sys.executable,'-I','-S','-c','import resource;print(resource.getrlimit(resource.RLIMIT_CORE)[0])'],text=True).strip(),flush=True)
 else:break
p.terminate();p.wait()
"""
    process = subprocess.Popen([sys.executable, "-I", "-S", "-c", script], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, text=True, cwd=tmp_path, env={"PATH": os.defpath})
    assert process.stdin and process.stdout
    try:
        child, initial = json.loads(process.stdout.readline())
        assert initial > 0
        leader, originals = policy["inspect_tree"](process.pid)
        assert {r["pid"] for r in originals} == {process.pid, child}
        own = resource.getrlimit(resource.RLIMIT_CORE)
        actual = policy["change_tree"](process.pid, leader, originals, restore=False)
        assert not actual["held"]
        assert all(item["after"] == 0 for item in actual["verified"])
        process.stdin.write("inherit\n"); process.stdin.flush()
        assert process.stdout.readline().strip() == "0"
        # A stale recorded birth identity cannot authorize changing a new process.
        stale = [{**r, "start": r["start"]-1} for r in originals]
        assert policy["change_tree"](process.pid, leader, stale, restore=True)["verified"] == []
        restored = policy["change_tree"](process.pid, leader, originals, restore=True)
        assert all(item["after"] == initial for item in restored["verified"])
        assert resource.getrlimit(resource.RLIMIT_CORE) == own
        assert policy["inspect_tree"](process.pid)[1] == originals
    finally:
        process.stdin.write("exit\n"); process.stdin.flush(); process.wait(timeout=8)


def test_only_the_solver_compose_services_default_to_no_core_files() -> None:
    import yaml

    for name in ("docker-compose.yml", "docker-compose.deploy.yml"):
        services = yaml.safe_load((ROOT / name).read_text())["services"]
        scoped = {name for name, service in services.items() if "core" in service.get("ulimits", {})}
        assert scoped == {"worker", "worker-foundation14"}
        for name in scoped:
            limits = services[name]["ulimits"]
            assert limits["core"] == {"soft": "${AIRFOILFOAM_SOLVER_CORE_SOFT_BYTES:-0}",
                                      "hard": "${AIRFOILFOAM_SOLVER_CORE_HARD_BYTES:--1}"}
            assert limits["nofile"] == {"soft": 65536, "hard": 524288}


@pytest.fixture(scope="session")
def ordinary_linux_core(tmp_path_factory):
    """A real native process dump, containing only a disposable test process."""
    import resource
    d = tmp_path_factory.mktemp("ordinary-elf-core")
    exe = d / "crash-fixture"
    subprocess.run(["cc", "-x", "c", "-", "-o", str(exe)],
                   input="#include <stdlib.h>\nint main(void){abort();}\n", text=True, check=True)
    def enable_core():
        _, hard = resource.getrlimit(resource.RLIMIT_CORE)
        resource.setrlimit(resource.RLIMIT_CORE, (hard, hard))
    crashed = subprocess.run([str(exe)], cwd=d, env={"PATH":os.defpath}, preexec_fn=enable_core)
    assert crashed.returncode < 0
    dumps = [f for f in d.iterdir() if f.name == "core" or f.name.startswith("core.")]
    if not dumps:
        dump = d / "core.1"
        subprocess.run(["gdb", "-nx", "-batch", "-ex", "run", "-ex", "generate-core-file "+str(dump),
                        "--args", str(exe)], cwd=d, env={"PATH":os.defpath}, check=True, capture_output=True)
        dumps = [dump]
    assert len(dumps) == 1 and dumps[0].read_bytes()[:4] == b"\x7fELF"
    return dumps[0]


@pytest.fixture
def core_case(tmp_path, monkeypatch, ordinary_linux_core):
    import json
    import uuid
    import importlib
    from contextlib import contextmanager
    monkeypatch.syspath_prepend(str(ROOT / "scripts/deploy"))
    m = importlib.import_module("solver_core_maintenance")
    files = importlib.import_module("solver_core_files")
    job = str(uuid.uuid4())
    volume = tmp_path/"volume"/"_data"; root = volume/"jobs"/job; case=root/"cases"/"c1_u30"
    case.mkdir(parents=True); (root/".execute.lock").touch()
    (root/"result.json").write_text(json.dumps({"state":"completed","polars":[{"points":[{"aoa_deg":2,"cl":0.42}]}]}))
    (root/"status.json").write_text('{"state":"completed"}'); (case/"log.simpleFoam").write_text("end of fixture\n")
    dump=case/"core.321";shutil.copyfile(ordinary_linux_core,dump)
    row=dict(j=job,r="cases/c1_u30/core.321",**files.file_id(dump.stat()))
    class Db:
        closed=True
        refs=[]
        @contextmanager
        def fence(self, ids):
            yield {job:{"closed":self.closed,"owner":{"id":job},"refs":list(self.refs)}}
        def references(self, ids):return [{"native":job,"case":c,"ref":v}for c,v in self.refs]
        def science(self,native,owner):return {"owner":owner,"cl":0.42}
    db=Db();state=tmp_path/"state"
    def process(mode, survey=lambda *_:{}):
        return m.process_batch(db,volume,state,[row],mode,None,survey=survey,
             service_science=lambda _,j:json.loads((volume/"jobs"/j/"result.json").read_text()))
    return files,m,job,volume,case,dump,row,state,db,process


def test_core_quarantine_canary_release_and_replay_conserve_the_native_job(core_case):
    import hashlib
    f,m,j,vol,case,dump,row,state,db,process=core_case
    before=m.native_science(vol,j);signature=hashlib.sha256(dump.read_bytes()).hexdigest()
    canary=process("canary")[0]
    assert canary["state"]=="restored" and canary["sha256"]==signature and canary["allocated"]==0
    assert (dump.stat().st_dev,dump.stat().st_ino)==(row["dev"],row["ino"])
    assert hashlib.sha256(dump.read_bytes()).hexdigest()==signature
    assert canary["scientificProof"]["files"]==before
    actual=process("release")[0]
    assert actual["state"]=="released" and actual["allocated"]==row["allocated"] and not dump.exists()
    assert m.native_science(vol,j)==before and process("release")[0]["allocated"]==0


@pytest.mark.parametrize("hold",["db-open","execution-lock","manifest","db-source","diagnostic","forensic","open-fd","hardlink","symlink","wrong-inode","non-elf"])
def test_core_guards_retain_exact_or_replaced_bytes(core_case,hold):
    f,m,j,vol,case,dump,row,state,db,process=core_case
    root=vol/"jobs"/j; lock=None; process_fd=None
    try:
        if hold=="db-open":db.closed=False
        elif hold=="execution-lock":
            lock=(root/".execute.lock").open("r");fcntl.flock(lock,fcntl.LOCK_EX)
        elif hold=="manifest":
            dest=case/"a2"/"evidence";dest.mkdir(parents=True)
            (dest/"evidence_manifest.json").write_text('{"files":[{"sourcePath":"cases/c1_u30/core.321"}]}')
        elif hold=="db-source":db.refs=[("c1_u30",{"file":"/jobs/"+j+"/files/cases/c1_u30/core.321"})]
        elif hold=="diagnostic":(root/".retain-solver-core-dumps").touch()
        elif hold=="forensic":(case/"incomplete_evidence_quarantine.receipt.json").write_text("{}")
        elif hold=="open-fd":
            import sys
            process_fd=subprocess.Popen([sys.executable,"-I","-c","import sys,time;f=open(sys.argv[1],'rb');print('open',flush=True);time.sleep(25)",str(dump)],stdout=subprocess.PIPE,text=True)
            assert process_fd.stdout.readline().strip()=="open"
        elif hold=="hardlink":os.link(dump,case/"also-needed")
        elif hold=="symlink":dump.rename(case/"real");dump.symlink_to("real")
        elif hold=="wrong-inode":row["ino"]+=1
        elif hold=="non-elf":
            dump.write_text("scientific log");row.update(f.file_id(dump.stat()))
        verdict=process("release")[0]
        assert verdict["state"].startswith("held") and dump.exists()
        assert not verdict.get("allocated") and (case/"log.simpleFoam").read_text()=="end of fixture\n"
    finally:
        if lock:lock.close()
        if process_fd:process_fd.terminate();process_fd.wait(timeout=4)


def test_core_name_replacement_during_claim_never_unlinks_the_replacement(core_case):
    f,m,j,volume,case,dump,row,state,db,process=core_case
    def replace():
        dump.rename(case/"raced-original")
        dump.write_bytes(b"valuable new scientific result")
    with f.locked_job(volume,j) as job:
        with pytest.raises(f.Held,match="raced"):
            f.core_action(volume,state,row,job,[],[],"stage",holders=lambda:False,
                          science_check=lambda:None,race_hook=replace)
    assert dump.read_bytes()==b"valuable new scientific result"
    assert (case/"raced-original").stat().st_ino==row["ino"]
    assert not list((volume.parent/".airfoils-solver-core-retirement").glob("*.core"))


def test_core_quarantine_keeps_both_files_when_source_reappears(core_case):
    f,m,j,volume,case,dump,row,state,db,process=core_case
    with f.locked_job(volume,j) as job:
        claim=f.core_action(volume,state,row,job,[],[],"stage",holders=lambda:False,science_check=lambda:None)
        dump.write_bytes(b"different generation")
        with pytest.raises(f.Held,match="replaced"):
            f.core_action(volume,state,row,job,[],[],"release",holders=lambda:False,science_check=lambda:None)
        assert dump.read_bytes()==b"different generation"
        assert (volume.parent/".airfoils-solver-core-retirement"/(claim["key"]+".core")).stat().st_ino==row["ino"]


def test_preexisting_native_reader_holds_the_job_even_for_a_different_file(core_case, tmp_path):
    import sys
    from solver_core_processes import open_jobs
    _,_,j,volume,case,_,row,_,_,process=core_case
    proc_root=tmp_path/"observed-proc";proc_root.mkdir();(proc_root/"self").symlink_to("/proc/self")
    child=subprocess.Popen([sys.executable,"-I","-c","import sys,time;f=open(sys.argv[1]);print(1,flush=True);time.sleep(30)",str(case/"log.simpleFoam")],stdout=subprocess.PIPE,text=True)
    try:
        assert child.stdout.readline().strip()=="1";(proc_root/str(child.pid)).symlink_to("/proc/"+str(child.pid))
        def observed(v,js,ns):return open_jobs(v,js,ns,proc_root)
        assert j in observed(volume,{j},{(row['dev'],row['ino']):j})
        assert process("release",observed)[0]["state"]=="held"
    finally:child.terminate();child.wait(timeout=4)


@pytest.mark.parametrize("explicit_lib", [False, True])
def test_real_top_level_installer_installs_and_validates_the_solver_core_dropin(tmp_path, explicit_lib):
    from shutil import which

    units=tmp_path/"units";sbin=tmp_path/"prefix"/"sbin"
    lib=tmp_path/"private library" if explicit_lib else tmp_path/"prefix"/"lib"/"airfoils-pro"/"solver-core"
    localbin=tmp_path/"commands";localbin.mkdir()
    # Exercise the actual installer and actual systemd parser without contacting
    # the host manager. Every install destination is inside this fixture.
    for cmd,body in {"id":"printf '0\\n'", "systemctl":'printf "%s\\n" "$*" >> "$FIXTURE_CTL_LOG"'}.items():
        tool=localbin/cmd;tool.write_text("#!/bin/sh\n"+body+"\n");tool.chmod(0o755)
    units.mkdir()
    # The real systemd parser must resolve the dependency in the isolated unit load path.
    (units/"docker.service").write_text("[Service]\nExecStart=/bin/true\n")
    env=os.environ|{"PATH":str(localbin)+os.pathsep+os.environ["PATH"],"SBIN_DIR":str(sbin),"SYSTEMD_DIR":str(units),
                    "SYSTEMD_UNIT_PATH":str(units)+":","RUN_INITIAL_CLEANUP":"0","FIXTURE_CTL_LOG":str(tmp_path/"ctl.log")}
    env.pop("SOLVER_CORE_LIB_DIR",None)
    if explicit_lib:env["SOLVER_CORE_LIB_DIR"]=str(lib)
    # The parent service has a production absolute ExecStart. Override only
    # that path for systemd-analyze on test hosts without the installed binary.
    drop=units/"airfoils-docker-storage-prune.service.d";drop.mkdir()
    (drop/"fixture-exec.conf").write_text(f'[Service]\nExecStart=\nExecStart="{sbin}/airfoils-docker-storage-prune"\n')
    run=subprocess.run(["bash",str(ROOT/"scripts/deploy/install-docker-storage-prune-timer.sh")],
                       cwd=ROOT,env=env,text=True,capture_output=True)
    assert run.returncode==0,run.stderr
    assert (drop/"solver-core-maintenance.conf").read_text()==f'[Service]\nExecStartPost="{lib}/solver_core_maintenance.py" auto\n'
    helper=lib/"solver_core_maintenance.py"
    assert os.access(helper,os.X_OK)
    verify=subprocess.run([which("systemd-analyze"),"verify",str(units/"airfoils-docker-storage-prune.service"),
                           str(units/"airfoils-docker-storage-prune.timer")],env=env,text=True,capture_output=True)
    assert verify.returncode==0,verify.stderr
    assert "enable --now airfoils-docker-storage-prune.timer" in (tmp_path/"ctl.log").read_text()


def test_core_inspection_of_an_interrupted_claim_is_strictly_read_only(core_case):
    f,_,j,volume,_,dump,row,state,_,_=core_case
    with f.locked_job(volume,j) as job:
        claim=f.core_action(volume,state,row,job,[],[],"stage",holders=lambda:False,science_check=lambda:None)
        journal=state/"files"/(claim["key"]+".json")
        before=journal.read_bytes()
        view=f.core_action(volume,state,row,job,[],[],"inspect",holders=lambda:False,science_check=lambda:None)
        assert view["state"]=="pending-quarantined" and journal.read_bytes()==before and not dump.exists()
        assert f.core_action(volume,state,row,job,[],[],"restore",holders=lambda:False,science_check=lambda:None)["state"]=="restored"
    assert dump.stat().st_ino==row["ino"]


def test_core_catalog_owner_arms_match_exactly_with_and_without_postgres_indexes(monkeypatch):
    import uuid
    import json
    from collections import Counter
    monkeypatch.syspath_prepend(str(ROOT/"scripts/deploy"))
    from solver_core_database import Database
    url=os.environ.get("DATABASE_URL")
    if not url:pytest.skip("requires the governed disposable PostgreSQL component")
    class Temporary(Database):
        def query(self,sql):return super().query(sql.replace("public.","pg_temp."))
    db=Temporary(["psql",url])
    native,job,other=[str(uuid.uuid4())for _ in range(3)]
    try:
        db.query("BEGIN")
        definitions={
            "solver_evidence_artifacts":"id uuid PRIMARY KEY,sim_job_id uuid,engine_job_id text,engine_case_slug text,storage_key text,engine_url text,metadata jsonb",
            "result_attempts":"id uuid PRIMARY KEY,sim_job_id uuid,engine_job_id text,result_id uuid,engine_case_slug text,evidence_payload jsonb",
            "result_media":"result_id uuid,result_attempt_id uuid,storage_key text",
            "results":"id uuid,sim_job_id uuid",
            "solver_evidence_artifact_members":"artifact_id uuid,member_path text",
            "sim_solver_incidents":"sim_job_id uuid,metadata jsonb",
            "remote_asset_references":"local_kind text,local_row_id uuid,local_storage_key text,result_attempt_id uuid",
        }
        for name,cols in definitions.items():db.query(f"CREATE TEMP TABLE {name} ({cols})")
        for i,(sim,engine) in enumerate([(job,other),(other,native),(job,native),(other,other)]):
            db.query(f"INSERT INTO solver_evidence_artifacts VALUES ('{uuid.uuid4()}','{sim}','{engine}','c1_u30','job/cases/c1_u30/core.{i+1}',NULL,'{{}}')")
        def paths():
            rows=db.references({native:job})
            return Counter((r["native"],r["case"],r["ref"]) for r in rows)
        expected=Counter((native,"c1_u30",f"job/cases/c1_u30/core.{i}")for i in (1,2,3))
        assert paths()==expected
        db.query("CREATE INDEX core_fixture_sim ON solver_evidence_artifacts(sim_job_id) WHERE sim_job_id IS NOT NULL")
        db.query("CREATE INDEX core_fixture_engine ON solver_evidence_artifacts(engine_job_id) WHERE engine_job_id IS NOT NULL")
        assert paths()==expected
    finally:db.query("ROLLBACK");db.close()


def _partial_core_fixture(path):
    """Cut only the last populated PT_LOAD from the real, disposable Linux dump."""
    import struct

    with path.open("r+b") as f:
        ident=f.read(16)
        if ident[4:6]!=b"\x02\x01":pytest.skip("partial canary contract is Linux x86-64 ELF")
        h=struct.unpack("<HHIQQQIHHHHHH",f.read(48))
        if h[1]!=62 or h[5]:pytest.skip("requires a kernel-written x86-64 core, not a debugger section table")
        f.seek(h[4]);headers=list(struct.iter_unpack("<IIQQQQQQ",f.read(h[9]*56)))
        nonempty=[(i,ph) for i,ph in enumerate(headers)if ph[0]==1 and ph[5]]
        index,tail=nonempty[-1];note=next(ph for ph in headers if ph[0]==4)
        assert len(nonempty)>1 and tail[2]>note[2]+note[5]
        off=note[2];pid=None
        while off+12<=note[2]+note[5]:
            f.seek(off);ns,ds,nt=struct.unpack("<III",f.read(12));desc=off+12+(ns+3)//4*4
            if nt==3 and ds>=136:
                f.seek(desc+24);pid=struct.unpack("<i",f.read(4))[0]
            off=desc+(ds+3)//4*4
        assert pid and pid>0
        f.truncate(tail[2])
    return pid,h[4]+index*56,note[2],note[5]


def test_proven_partial_kernel_dump_is_reversible_and_released_only_under_the_same_guards(core_case):
    files,_,_,_,case,dump,row,_,_,process=core_case
    pid,_,_,_=_partial_core_fixture(dump);new=case/f"core.{pid}";dump.rename(new)
    row.update(r="cases/c1_u30/"+new.name,**files.file_id(new.stat()))
    canary=process("canary")[0];assert canary["state"]=="restored" and new.stat().st_ino==row["ino"]
    proof=canary["elf"];assert proof["processId"]==pid and proof["signal"]==6 and proof["trailingPartialLoadSegments"]>0
    actual=process("release")[0];assert actual["allocated"]==row["allocated"] and not new.exists()


@pytest.mark.parametrize("error",["header","program-table","note","ambiguous-machine","wrong-filename","non-load-tail"])
def test_partial_core_with_missing_structural_evidence_is_retained(core_case,error):
    import struct

    files,_,_,_,case,dump,row,_,_,process=core_case
    pid,load_entry,note,size=_partial_core_fixture(dump)
    with dump.open("r+b")as f:
        if error=="header":f.truncate(9)
        elif error=="program-table":f.truncate(65)
        elif error=="note":f.truncate(note+size-1)
        elif error=="ambiguous-machine":f.seek(18);f.write(struct.pack("<H",243))
        elif error=="non-load-tail":f.seek(load_entry);f.write(struct.pack("<I",2))
    new=case/f"core.{pid+(error=='wrong-filename')}";dump.rename(new)
    row.update(r="cases/c1_u30/"+new.name,**files.file_id(new.stat()))
    item=process("release")[0]
    assert item["state"]=="held" and not item.get("allocated") and new.exists()
