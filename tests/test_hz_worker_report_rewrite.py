"""Run the actual HZ maintenance lifecycle against disposable PostgreSQL."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from uuid import uuid4

import pytest
from test_deploy_sweeper_state import _compaction_harness

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/deploy"
FIXTURE = ROOT / "tests/fixtures/hz-rewrite/runtime.py"


def read_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ops = read_module("hz_operator", SCRIPTS / "rewrite-hz-worker-reports.py")
boundary = read_module("test_rewrite_host", FIXTURE)


def sql(q):
    return subprocess.check_output(
        [
            "psql",
            "-XwqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            os.environ["DATABASE_URL"],
            "-c",
            q,
        ],
        text=True,
    ).strip()


@pytest.fixture(scope="module")
def database():
    if os.environ.get("HZ_REPORT_REWRITE_DISPOSABLE") != "1":
        pytest.skip("requires the hz-worker-report-rewrite disposable PostgreSQL graph")
    if not all(os.environ.get(name) for name in ("PGHOST", "PGPORT", "DATABASE_URL")):
        pytest.fail(
            "The disposable rewrite graph must supply PGHOST, PGPORT and DATABASE_URL"
        )
    if (
        sql(
            "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'"
        )
        != "0"
    ):
        pytest.fail("Expected an empty, isolated PostgreSQL schema")
    sql("""CREATE TABLE progressive_worker_reports (sim_job_id uuid,sequence bigint, report jsonb NOT NULL,
         content_signature text, result_payload_hash text,archive_bundle_id uuid, archived_at timestamptz,
         acknowledged_at timestamptz,PRIMARY KEY(sim_job_id,sequence)) WITH (autovacuum_enabled=false,toast.autovacuum_enabled=false);
         CREATE INDEX fixture_reports_sequence ON progressive_worker_reports(sequence);
         CREATE TABLE progressive_report_result_payloads(content_hash text PRIMARY KEY,result jsonb);
         CREATE TABLE sim_jobs(id uuid primary key,status text,engine_job_id text,request_payload jsonb);
         CREATE TABLE sync_api_settings(id int,instance_id uuid,remote_solver_registered_id uuid,upstream_base_url text,
             remote_solver_enabled boolean,remote_solver_transfer_paused boolean,remote_solver_heartbeat_interval_seconds int);
         INSERT INTO sync_api_settings VALUES(1,gen_random_uuid(),gen_random_uuid(),'https://upstream.invalid',true,false,10);
         CREATE TABLE registered_remote_solvers(id uuid PRIMARY KEY,instance_id uuid,revoked_at timestamptz);
         INSERT INTO registered_remote_solvers SELECT remote_solver_registered_id,instance_id,NULL FROM sync_api_settings;
         CREATE TABLE sync_sweep_promises(id uuid,status text,"expiresAt" timestamptz,registered_solver_id uuid,request_payload jsonb);
         INSERT INTO sync_sweep_promises SELECT gen_random_uuid(),'active',now()+interval '2 days',id,'{}' FROM registered_remote_solvers;
         CREATE TABLE progressive_worker_evidence_delivery_claims(claim_expires_at timestamptz);
         CREATE TABLE sweeper_state(id integer,enabled boolean);
         INSERT INTO sweeper_state VALUES(1,true);
         CREATE TABLE solver_execution_pools(id uuid primary key,enabled boolean);
         INSERT INTO solver_execution_pools VALUES(gen_random_uuid(),true);
         CREATE TABLE progressive_worker_staging_copies(sim_job_id uuid,sequence bigint,source_sequence bigint,PRIMARY KEY(sim_job_id,sequence));""")
    for table in [
        t[0]
        for t in ops.host.SOURCES.values()
        if t[0]
        not in ("progressive_worker_reports", "progressive_report_result_payloads")
    ]:
        sql(f"""CREATE TABLE {table}(id uuid PRIMARY KEY,sim_job_id uuid,result_attempt_id uuid,result_id uuid,
             sequence bigint,source_kind text,member_kind text,point_content_signature text,evidence_payload jsonb,archive_id uuid)""")
    # Real force histories have a JSONB time-series column named t.
    sql("ALTER TABLE force_history ADD COLUMN t jsonb")
    return True


@pytest.fixture
def runtime(tmp_path, monkeypatch, database):
    # The fixture reuses the hub's existing stop/start/error-injection boundary.
    env = _compaction_harness(tmp_path, (True, False, True, False))
    ids = json.loads(env["COMPACTION_IDS"])
    ids["redis"] = "e" * 64
    ids["worker-foundation14"] = "f" * 64
    # The hub Docker stub reserves f*64 as a deliberate conflicting one-off. HZ
    # does not configure this optional service in this fixture.
    del ids["worker-foundation14"]
    env["COMPACTION_IDS"] = json.dumps(ids)
    states = Path(env["COMPACTION_STATES"])
    (states / "redis").write_text(
        json.dumps({"state": "running", "started": "2026-11-09T00:00:00Z"})
    )
    state_dir = Path(env["AIRFOILS_PRO_STATE_DIR"])
    override = state_dir / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n")
    override.chmod(0o600)
    env.update(
        COMPOSE_PROJECT_NAME="hz-solver2",
        COMPOSE_OVERRIDE_FILE=str(override),
        REWRITE_TEST_MOUNT=str(tmp_path),
        REWRITE_TEST_SOURCE=str(SCRIPTS),
        MAINTENANCE_TIMEOUT_SECONDS="90",
        RESTORE_TIMEOUT_SECONDS="60",
        READINESS_TIMEOUT_SECONDS="3",
    )
    env_text = """AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver
COMPOSE_PROJECT_NAME=hz-solver2
AIRFOILFOAM_EVIDENCE_BUCKET=
AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1
AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10
AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=false
AIRFOILFOAM_CONTROL_PLANE_TOKEN=fixture-private-test-token-longer-than-32-bytes
AIRFOILFOAM_WORKER_CPU_BUDGET=4
AIRFOILFOAM_CASE_CONCURRENCY=4
AIRFOILFOAM_CELERY_CONCURRENCY=4
"""
    env_file = Path(env["ENV_FILE"])
    env_file.write_text(env_text + "COMPOSE_OVERRIDE_FILE=" + str(override) + "\n")
    # The original fixture owns the pod states. Psql cancellation is sent to
    # the real tagged backend and never to the lock holder.
    executable = tmp_path / "bin/docker"
    control = executable.with_name("docker-control")
    executable.rename(control)
    executable.write_text("""#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if args and args[0]=='exec' and 'psql' in args:
 opts=next(x[10:] for x in args if x.startswith('PGOPTIONS='))
 os.environ['PGOPTIONS']=opts;a=args[args.index('psql')+1:]
 i=a.index('-d');a[i+1]=os.environ['DATABASE_URL'];i=a.index('-U');del a[i:i+2]
 os.execv('/usr/bin/psql',['psql',*a])
os.execv(os.path.join(os.path.dirname(sys.argv[0]),'docker-control'),['docker-control',*args])
""")
    executable.chmod(0o700)
    for k in (
        "COMPACTION_IDS",
        "COMPACTION_STATES",
        "REWRITE_TEST_MOUNT",
        "REWRITE_TEST_SOURCE",
    ):
        monkeypatch.setenv(k, env[k])
    env["DATABASE_URL"] = os.environ["DATABASE_URL"]
    host = read_module(
        "bounded_hz_rewrite", SCRIPTS / "hz-worker-report-rewrite-host.py"
    )
    boundary.install(host)
    run = uuid4().hex
    directory = state_dir / "worker-report-rewrite" / run
    directory.mkdir(parents=True, mode=0o700)
    for f in ops.FILES:
        shutil.copyfile(SCRIPTS / f, directory / f)
    (directory / "hz-worker-report-rewrite-host.py").write_text(f"""import runpy
runpy.run_path({str(FIXTURE)!r})['stage_entry']()
""")
    sql(
        "TRUNCATE "
        + ",".join(dict.fromkeys(t[0] for t in host.SOURCES.values()))
        + ", progressive_worker_staging_copies,sim_jobs"
    )
    job, result, attempt = str(uuid4()), str(uuid4()), str(uuid4())
    sql(f"""INSERT INTO sim_jobs VALUES('{job}','running','physical-fixture','{{"remoteProgressiveExecution":{{}}}}');
      INSERT INTO progressive_worker_reports(sim_job_id,sequence,report,content_signature)
      SELECT '{job}',i,b,encode(sha256(convert_to(b::text,'UTF8')),'hex') FROM generate_series(1,400) i
      CROSS JOIN LATERAL (SELECT jsonb_build_object('sequence',i,'result',jsonb_build_object('unknown',9007199254740993123.00,
      'samples',string_agg(md5(i::text||':'||j::text),'' ORDER BY j))) b FROM generate_series(1,512) j) x;
      DELETE FROM progressive_worker_reports WHERE sequence%4<>1;
      INSERT INTO progressive_report_result_payloads SELECT encode(sha256(convert_to('null','UTF8')),'hex'),'null';
      UPDATE progressive_worker_reports SET report='{{"sequence":1,"result":null}}',result_payload_hash=(SELECT content_hash FROM progressive_report_result_payloads) WHERE sequence=1;
      INSERT INTO result_attempts(id,result_id,sim_job_id,evidence_payload) VALUES('{attempt}','{result}','{job}','{{"channel":[1.00,null,9007199254740993]}}');
      INSERT INTO results(id,result_attempt_id) VALUES('{result}','{attempt}');
      INSERT INTO progressive_worker_evidence_attempts(id,sim_job_id,sequence,result_attempt_id,point_content_signature) VALUES(gen_random_uuid(),'{job}',1,'{attempt}','fixture');
      INSERT INTO progressive_worker_staging_copies VALUES('{job}',5,1)""")
    for table in [
        "progressive_worker_evidence_receipts",
        "progressive_worker_hub_receipts",
        "progressive_worker_report_conflicts",
        "progressive_report_archive_members",
        "progressive_report_archive_bundles",
        "result_classifications",
        "force_history",
    ]:
        sql(
            f"INSERT INTO {table}(id,result_attempt_id,sim_job_id,sequence,source_kind,member_kind,point_content_signature) VALUES(gen_random_uuid(),'{attempt}','{job}',1,'worker','report','fixture')"
        )
    sql("""UPDATE progressive_worker_reports SET archive_bundle_id=(SELECT id FROM progressive_report_archive_bundles),
           archived_at=now(),report='{"sequence":9,"storage":"archive"}' WHERE sequence=9;
           UPDATE progressive_report_archive_members SET sequence=9;
           UPDATE force_history SET t='[0.000,0.005]';""")
    # Direct job ownership also protects science before the staging receipt.
    sql(f"""WITH newer AS (INSERT INTO results(id,sim_job_id) VALUES(gen_random_uuid(),'{job}') RETURNING id)
            INSERT INTO result_attempts(id,sim_job_id,result_id) SELECT gen_random_uuid(),'{job}',id FROM newer;
            INSERT INTO result_attempts(id,sim_job_id) VALUES(gen_random_uuid(),gen_random_uuid());""")
    measured = host.measured(ids["postgres"])
    plan = {
        "run": run,
        "worker": measured,
        "identity": host.identity(measured),
        "remainingWorkSeconds": 120,
        "leaseDeadline": time.time() + 3600,
        "restoreReserve": 60,
        "identitySeconds": 30,
        "sqlSeconds": 30,
        "allReportBytes": False,
        "budget": {"floor": 4096, "replacement": None, "wal": 30 << 20, "growth": 4096},
    }
    host.dump(directory / "plan.json", plan)
    prior = {k: (states / k).read_bytes() for k in ids}
    return env, directory, host, prior


def shell(env, directory, *args):
    return subprocess.run(
        [
            "bash",
            str(directory / ops.FILES[0]),
            "--execute",
            "--hz-worker-session",
            *args,
        ],
        env=env,
        text=True,
        capture_output=True,
        timeout=90,
    )


def restored(env, prior):
    p = Path(env["COMPACTION_STATES"])
    for name, raw in prior.items():
        old = json.loads(raw)
        new = json.loads((p / name).read_text())
        assert old["state"] == new["state"], name
        if name not in ("node-api", "web", "sweeper", "media-repair"):
            assert old == new, name
    assert (
        sql(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'hz_rewrite_%' AND state='active'"
        )
        == "0"
    )


def test_full_shell_rewrites_only_the_worker_relation_and_restores(runtime, capsys):
    env, directory, host, prior = runtime
    # Stat actual main/TOAST/index files on the disposable PG server. These
    # small relations have one segment per fork.
    file_sizes = """WITH roots AS (
        SELECT oid FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass
        UNION ALL SELECT reltoastrelid FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass),
      relations AS (SELECT oid FROM roots UNION ALL SELECT indexrelid FROM pg_index WHERE indrelid IN (SELECT oid FROM roots)),
      files AS (SELECT pg_relation_filepath(oid)||suffix AS path FROM relations CROSS JOIN (VALUES (''),('_vm'),('_fsm')) forks(suffix))
      SELECT jsonb_object_agg(path,coalesce((pg_stat_file(path,true)).size,0)) FROM files"""
    old_files = json.loads(sql(file_sizes))
    res = shell(env, directory)
    assert res.returncode == 0, res.stdout + res.stderr
    before = json.loads((directory / "identity-before.json").read_text())
    assert before == json.loads((directory / "identity-after.json").read_text())
    assert (
        before["reports"]["rows"] == 100
        and before["staged-attempts"]["rows"] == 1
        and before["staging-copies"]["rows"] == 1
    )
    assert (
        before["shared-results"]["rows"] == 1 and before["force_history"]["rows"] == 1
    )
    assert before["result-attempts"]["rows"] == before["selected-results"]["rows"] == 2
    space = json.loads((directory / "space-result.json").read_text())
    new_files = json.loads(sql(file_sizes))
    assert sum(old_files.values()) == space["beforeAllocation"]
    assert sum(new_files.values()) == space["afterAllocation"]
    retired = sorted(set(old_files) - set(new_files))
    assert retired and sum(old_files[p] for p in retired) > 0
    assert (
        sql(
            "SELECT sum(coalesce((pg_stat_file(p,true)).size,0)) FROM jsonb_array_elements_text('"
            + json.dumps(retired)
            + "'::jsonb) f(p)"
        )
        == "0"
    )
    with capsys.disabled():
        print("Disposable report allocation", json.dumps(space, sort_keys=True))
    assert space["relationBytesReturned"] > 2 * 1024**2, space
    assert (directory / "rewrite-commit.json").is_file()
    assert "exit=0" in (directory / "result").read_text()
    assert json.loads((directory / "resumed.json").read_text())["solverProcesses"] == {
        "pimpleFoam": 1
    }
    restored(env, prior)


@pytest.mark.parametrize(
    ("fault", "committed"),
    [
        ("space-before", False),
        ("wal-growth", False),
        ("changed-body", True),
        ("changed-science", True),
    ],
)
def test_refusal_and_postcommit_mismatch_preserve_services(runtime, fault, committed):
    env, directory, _, prior = runtime
    before = sql("SELECT pg_relation_filenode('progressive_worker_reports'::regclass)")
    env["REWRITE_TEST_FAULT"] = fault
    res = shell(env, directory)
    assert res.returncode != 0, res.stdout + res.stderr
    assert (directory / "rewrite-commit.json").is_file() == committed
    assert (
        sql("SELECT pg_relation_filenode('progressive_worker_reports'::regclass)")
        != before
    ) == committed
    if committed:
        assert "fingerprint mismatch" in res.stderr
        assert not (directory / "space-result.json").exists()
    elif fault == "space-before":
        assert "Insufficient available" in res.stderr
        assert not (directory / "entered-identity-before").exists()
    else:
        assert "WAL directory exceeded" in res.stderr
    restored(env, prior)


def test_real_access_exclusive_wait_cancel_does_not_cancel_unrelated_transaction(
    runtime,
):
    env, directory, h, prior = runtime
    tag = "hz_rewrite_" + directory.name
    lock = subprocess.Popen(
        ["psql", "-XwqAt", "-d", env["DATABASE_URL"]],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        lock.stdin.write(
            "BEGIN; LOCK TABLE public.progressive_worker_reports IN ACCESS SHARE MODE; SELECT 'held';\n"
        )
        lock.stdin.flush()
        assert lock.stdout.readline().strip() == "held"
        calls = []

        def watch():
            if not calls:
                calls.append("prelaunch")
                return
            wait = sql(
                f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{tag}' AND wait_event_type='Lock'"
            )
            assert int(wait) == 1
            plan = json.loads((directory / "plan.json").read_text())
            disk = plan["worker"]["disk"]
            # Use a real filesystem reading and move the test floor up to
            # that reading. The production guard must cancel the waiting SQL.
            vfs = os.statvfs(disk["mount"])
            calls.append("low-space")
            h.check_phase_space(
                plan["worker"], {"floor": (vfs.f_bavail + 65536) * vfs.f_frsize}
            )

        def cancel():
            sql(
                f"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='{tag}' AND pid<>pg_backend_pid()"
            )

        before = sql(
            "SELECT pg_relation_filenode('progressive_worker_reports'::regclass)"
        )
        with pytest.raises(RuntimeError, match="Low-space cancellation"):
            argv = h.pg_command("", tag, 15, True)
            argv[1] = argv[1].replace("lock_timeout=3000", "lock_timeout=12000")
            h.run_phase(argv, h.VACUUM, 15, watch, cancel)
        assert (
            calls
            and sql(
                "SELECT pg_relation_filenode('progressive_worker_reports'::regclass)"
            )
            == before
        )
        lock.stdin.write("SELECT 'untouched'; ROLLBACK;\\q\n")
        lock.stdin.flush()
        assert lock.stdout.readline().strip() == "untouched"
    finally:
        lock.terminate()
        lock.wait(timeout=4)
    restored(env, prior)


def units_fixture():
    def unit(state, sub, pid, freezer="running"):
        return dict(
            LoadState="loaded",
            ActiveState=state,
            SubState=sub,
            MainPID=pid,
            FreezerState=freezer,
            FragmentPath="/etc/systemd/user/existing-unit",
            UnitFileState="enabled",
            InvocationID="original",
            ControlGroup=f"/fixture.slice/maintenance-{pid}.service",
        )

    return {
        "airfoils-hz-bulk.service": unit("active", "running", "44"),
        "airfoils-hz-maint.service": unit("active", "running", "42", "frozen"),
        "airfoils-hz-failed.service": unit("failed", "failed", "0"),
        "airfoils-hz-maint.timer": unit("active", "waiting", "0"),
        "airfoils-hz-idle.service": unit("inactive", "dead", "0"),
    }


def test_operator_cancel_releases_real_wait_and_restores_original_containers(
    runtime, monkeypatch
):
    env, directory, _, prior = runtime
    state = {"run": directory.name}
    remote, unit = ops.location(state)
    holder = subprocess.Popen(
        ["psql", "-XwqAt", "-d", env["DATABASE_URL"]],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    server = None
    try:
        holder.stdin.write(
            "BEGIN; LOCK TABLE progressive_worker_reports IN ACCESS SHARE MODE; SELECT 'held';\n"
        )
        holder.stdin.flush()
        assert holder.stdout.readline().strip() == "held"
        server = subprocess.Popen(
            ["bash", str(directory / ops.FILES[0]), "--execute", "--hz-worker-session"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 45
        query = (
            "SELECT count(*) FROM pg_stat_activity WHERE application_name='hz_rewrite_"
            + directory.name
            + "' AND wait_event_type='Lock'"
        )
        while sql(query) != "1":
            assert server.poll() is None and time.monotonic() < deadline
            time.sleep(0.1)

        def transport(machine, args):
            assert machine == ops.HOST
            if args == ["touch", remote + "/cancel"]:
                (directory / "cancel").touch()
            else:
                assert args == ["systemctl", "--no-block", "stop", unit]
                server.send_signal(signal.SIGTERM)

        monkeypatch.setattr(ops, "ssh", transport)
        monkeypatch.setattr(
            ops, "status", lambda _: {"ActiveState": "active", "SubState": "running"}
        )
        ops.cancel(state)
        stdout, stderr = server.communicate(timeout=40)
        assert server.returncode != 0, stdout + stderr
        assert "recovery_failed=false" in (directory / "result").read_text()
        assert not (directory / "rewrite-commit.json").exists()
        holder.stdin.write("SELECT 'still held'; ROLLBACK;\\q\n")
        holder.stdin.flush()
        assert holder.stdout.readline().strip() == "still held"
        restored(env, prior)
    finally:
        holder.terminate()
        holder.wait(timeout=5)
        if server and server.poll() is None:
            server.terminate()
            server.wait(timeout=40)


def test_operator_releases_only_its_captured_units_after_partial_control_failure():
    original = units_fixture()
    live = json.loads(json.dumps(original))
    state = {"units": original, "touched": [], "extraUnits": []}
    calls = []

    def control(action, name):
        calls.append((action, name))
        if action in ("stop", "start"):
            live[name].update(
                ActiveState="inactive" if action == "stop" else "active",
                SubState="dead" if action == "stop" else "waiting",
            )
        else:
            live[name]["FreezerState"] = "frozen" if action == "freeze" else "running"
            if action == "freeze":
                raise RuntimeError("client disconnected after freezing")

    discover = lambda _: live
    with pytest.raises(RuntimeError, match="disconnected"):
        ops.freeze_units(state, lambda: None, discover, control)
    assert state["touched"] == ["airfoils-hz-maint.timer", "airfoils-hz-bulk.service"]
    ops.restore_units(state, lambda: None, discover, control)
    assert live == original and state["touched"] == []
    assert calls == [
        ("stop", "airfoils-hz-maint.timer"),
        ("freeze", "airfoils-hz-bulk.service"),
        ("thaw", "airfoils-hz-bulk.service"),
        ("start", "airfoils-hz-maint.timer"),
    ]


def test_operator_will_not_thaw_a_replacement_or_start_an_originally_failed_unit():
    previous = units_fixture()
    now = json.loads(json.dumps(previous))
    now["airfoils-hz-bulk.service"].update(
        InvocationID="replacement", FreezerState="frozen"
    )
    s = {"units": previous, "touched": ["airfoils-hz-bulk.service"], "extraUnits": []}
    with pytest.raises(RuntimeError, match="recovery incomplete"):
        ops.restore_units(
            s,
            lambda: None,
            lambda _: now,
            lambda *_: pytest.fail("mutated a replacement"),
        )
    assert s["touched"]


def test_operator_refuses_to_freeze_itself_before_stopping_any_timer(monkeypatch):
    units = units_fixture()
    obs = "/fixture-control/bulk"
    units["airfoils-hz-bulk.service"]["ControlGroup"] = obs
    monkeypatch.setattr(ops, "operator_cgroups", lambda: [obs + "/child"])
    state = {"units": units, "touched": [], "extraUnits": []}
    with pytest.raises(RuntimeError, match="Run the operator outside"):
        ops.freeze_units(
            state,
            lambda: None,
            lambda _: units,
            lambda *_: pytest.fail("paused a unit"),
        )
    assert state["touched"] == []


def test_restarting_operator_writer_reports_budget_and_does_not_strand_prior_units(
    runtime, tmp_path, monkeypatch
):
    env, directory, host, prior = runtime
    writer = "airfoils-report-migration-fixture.service"
    recheck = "airfoils-report-0209-recheck-fixture.service"
    examples = units_fixture()
    units = {
        writer: examples["airfoils-hz-bulk.service"],
        recheck: examples["airfoils-hz-idle.service"],
    }
    calls = []

    def ctl(action, *args):
        if action == "list-units":
            return "\n".join(units)
        name = args[0]
        if action == "show":
            return "\n".join(f"{k}={v}" for k, v in units[name].items())
        assert name == writer and action in ("freeze", "thaw")
        calls.append((action, name))
        units[name]["FreezerState"] = "frozen" if action == "freeze" else "running"

    monkeypatch.setattr(ops, "ctl", ctl)
    initial = ops.inventory()
    monkeypatch.setattr(ops, "worker", lambda *_: host.measured(host.PG))
    monkeypatch.setattr(
        ops.audit,
        "query",
        lambda role, q: [
            json.loads(x)
            for x in sql("BEGIN READ ONLY;\n" + q + "\nCOMMIT;").splitlines()
        ],
    )
    monkeypatch.setattr(
        ops,
        "ssh",
        lambda *_a, **_kw: pytest.fail("staged or submitted a refused rewrite"),
    )

    # Real long-lived operator service shape between its restart attempts.
    def restarting():
        units[recheck].update(
            ActiveState="activating",
            SubState="auto-restart",
            MainPID="0",
            ControlGroup="",
        )

    restarting()
    output = tmp_path / "plan.json"
    monkeypatch.setattr(
        sys,
        "argv",
        ["rewrite", "--dry-run", "--growth-bytes", "0", "--output", str(output)],
    )
    ops.main()
    plan = json.loads(output.read_text())
    assert plan["workspace"]["availableBytes"] > 0 and plan["authority"]["active"] == 1
    assert (
        plan["units"][recheck]["MainPID"] == "0"
        and "activating/auto-restart" in plan["refusals"][0]
    )
    run_dir = tmp_path / "refused"
    monkeypatch.setattr(
        sys,
        "argv",
        ["rewrite", "--execute", "--growth-bytes", "0", "--run-dir", str(run_dir)],
    )
    with pytest.raises(SystemExit, match="before the pause"):
        ops.main()
    assert not run_dir.exists() and not calls
    # A transition after a different service was frozen must first release
    # that exact process, then report the independent inventory discrepancy.
    units[recheck] = dict(initial[recheck])
    state = {"units": initial, "extraUnits": [], "touched": []}
    ops.freeze_units(state, lambda: None, control=ctl)
    restarting()
    with pytest.raises(RuntimeError, match="activating/auto-restart"):
        ops.check_units(state, True)
    with pytest.raises(RuntimeError, match="activating/auto-restart"):
        ops.restore_units(state, lambda: None, control=ctl)
    assert calls == [("freeze", writer), ("thaw", writer)]
    assert state["touched"] == [] and units[writer] == initial[writer]
    restored(env, prior)


def test_short_lease_refuses_before_pausing_any_service(runtime):
    env, directory, _, prior = runtime
    p = directory / "plan.json"
    plan = json.loads(p.read_text())
    plan["leaseDeadline"] = time.time() + 15
    p.write_text(json.dumps(plan))
    res = shell(env, directory)
    assert res.returncode and "lease window" in res.stderr
    assert not (directory / "entered-quiesced").exists()
    restored(env, prior)


def test_shell_restore_after_command_error_and_orphan_recovery_preserves_original_result(
    runtime,
):
    env, directory, _, prior = runtime
    env["COMPACTION_STOP_ERROR"] = "node-api"
    env["COMPACTION_START_ERROR"] = "node-api"
    broken = shell(env, directory)
    assert broken.returncode == 18
    previous = (directory / "result").read_bytes()
    assert (
        b"recovery_failed=true" in previous
        and not (directory / "rewrite-commit.json").exists()
    )
    del env["COMPACTION_STOP_ERROR"], env["COMPACTION_START_ERROR"]
    recovered = shell(env, directory, "--restore-worker-state")
    assert recovered.returncode == 0, recovered.stderr
    assert (directory / "result").read_bytes() == previous
    assert b"recovery_failed=false" in (directory / "recovery-result").read_bytes()
    restored(env, prior)


def test_full_body_mode_and_forks_on_same_device(runtime):
    env, directory, h, prior = runtime
    f = h.measured(json.loads(env["COMPACTION_IDS"])["postgres"], census=True)
    config = dict(
        replacement=f["totalBytes"] - 1, wal=None, floor=1048576, growth=524288
    )
    assert not h.budget(f, config)["refusals"]
    mismatched = dict(f, allFilesOnVolume=False)
    assert h.budget(mismatched, config)["refusals"]
    low = dict(config, replacement=1)
    assert h.budget(f, low)["refusals"]
    retaining = dict(f, wal=dict(f["wal"], slots=1))
    assert h.budget(retaining, config)["additionalWalBytes"] >= config["replacement"]
    p = directory / "plan.json"
    plan = json.loads(p.read_text())
    plan["allReportBytes"] = True
    p.write_text(json.dumps(plan))
    r = shell(env, directory)
    assert r.returncode == 0, r.stdout + r.stderr
    space = json.loads((directory / "space-result.json").read_text())
    assert (
        0 < space["afterAllocation"] <= h.budget(f, config)["modeledReplacementBytes"]
    )
    assert (directory / "identity-before.json").read_bytes() == (
        directory / "identity-after.json"
    ).read_bytes()
    restored(env, prior)


@pytest.mark.parametrize("lose_submission_reply", [False, True])
def test_operator_recovers_the_same_rewrite_and_witnesses_collection(
    runtime, tmp_path, monkeypatch, lose_submission_reply
):
    env, remote, host, prior = runtime
    run_dir = tmp_path / "operator-run"
    monkeypatch.setattr(ops, "CONTROL", tmp_path / "operator-control")
    run_id = ops.uuid.UUID(remote.name)
    monkeypatch.setattr(ops.uuid, "uuid4", lambda: run_id)
    monkeypatch.setattr(ops, "worker", lambda *args: host.measured(host.PG))
    original = units_fixture()
    units = json.loads(json.dumps(original))
    freeze, thaw = ops.freeze_units, ops.restore_units
    discover = lambda extra=(): json.loads(json.dumps(units))
    submitted = []
    checks = []

    def control(action, name):
        if name.endswith(".timer"):
            units[name].update(
                ActiveState="active" if action == "start" else "inactive",
                SubState="waiting" if action == "start" else "dead",
            )
        else:
            units[name]["FreezerState"] = "frozen" if action == "freeze" else "running"
        if action == "thaw" and not checks:
            # A later, independent producer observation while ordinary collection
            # is back. The operator must witness this sequence through its SELECT.
            sql("""INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
                SELECT sim_job_id,s,encode(sha256(convert_to(body::text,'UTF8')),'hex'),body
                FROM (SELECT sim_job_id,max(sequence)+1 s FROM progressive_worker_reports GROUP BY sim_job_id) x
                CROSS JOIN LATERAL (SELECT jsonb_build_object('status','running','sequence',s) body) b""")
            checks.append("new-report")

    monkeypatch.setattr(ops, "inventory", discover)
    monkeypatch.setattr(
        ops, "freeze_units", lambda s, save: freeze(s, save, discover, control)
    )
    monkeypatch.setattr(
        ops, "restore_units", lambda s, save: thaw(s, save, discover, control)
    )

    def query(role, q):
        assert role in ("hub", "worker")
        return [
            json.loads(line)
            for line in sql("BEGIN READ ONLY;\n" + q + "\nCOMMIT;").splitlines()
        ]

    monkeypatch.setattr(ops.audit, "query", query)
    systemctl = Path(env["PATH"].split(os.pathsep)[0]) / "systemctl"
    systemctl.write_text(
        "#!/bin/sh\nprintf '%s\\n' LoadState=not-found ActiveState=inactive SubState=dead\n"
    )
    systemctl.chmod(0o700)

    def transport(machine, args, text=None, seconds=30):
        assert machine == ops.HOST
        if args[0] == "env":
            assert "--server-run" in args and "--restore-worker-state" not in args
            assert not submitted
            submitted.append("rewrite")
            assert units["airfoils-hz-bulk.service"]["FreezerState"] == "frozen"
            result = shell(env, remote)
            assert result.returncode == 0, result.stderr
            if lose_submission_reply:
                raise RuntimeError("SSH reply lost after submission")
            return ""
        assert args[:3] == ["python3", "-B", "-c"]
        script = args[3]
        if script == ops.STAGE:
            stage = tmp_path / "staged" / remote.name
            subprocess.run(
                [sys.executable, "-B", "-c", script, str(stage)],
                input=text,
                text=True,
                check=True,
            )
            assert all(
                (stage / n).read_bytes() == (SCRIPTS / n).read_bytes()
                for n in ops.FILES
            )
            shutil.copyfile(stage / "plan.json", remote / "plan.json")
            return ""
        return subprocess.check_output(
            [sys.executable, "-B", "-c", script, str(remote), *args[5:]],
            env=env,
            text=True,
        )

    monkeypatch.setattr(ops, "ssh", transport)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "rewrite",
            "--execute",
            "--run-dir",
            str(run_dir),
            "--growth-bytes",
            "4096",
            "--stop-free-bytes",
            "4096",
            "--identity-seconds",
            "30",
            "--rewrite-seconds",
            "30",
        ],
    )
    if lose_submission_reply:
        with pytest.raises(RuntimeError, match="reply lost"):
            ops.main()
    else:
        ops.main()
    assert submitted == ["rewrite"] and units == original
    assert not (ops.CONTROL / "active-rewrite.json").exists()
    assert json.loads((run_dir / "operator.json").read_text())["touched"] == []
    assert (
        json.loads((run_dir / "collection.json").read_text())["state"]
        == "observed-new-report"
    )
    assert json.loads((run_dir / "authority-after.json").read_text())["active"] == 1
    assert (run_dir / "rewrite-commit.json").read_bytes() == (
        remote / "rewrite-commit.json"
    ).read_bytes()
    assert (
        json.loads((run_dir / "space-result.json").read_text())["relationBytesReturned"]
        > 0
    )
    restored(env, prior)
