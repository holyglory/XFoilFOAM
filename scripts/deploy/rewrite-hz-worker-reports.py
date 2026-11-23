#!/usr/bin/env python3
"""One maintenance window for the HZ worker outbox. Default is a read-only plan."""

from contextlib import contextmanager
import argparse
import fcntl
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
HOST = "hz-solver2"
HUB = "airfoils.pro"
REMOTE = "/opt/airfoils-pro/state/worker-report-rewrite"
FILES = (
    "compact-progressive-remote-reports.sh",
    "hz-worker-report-rewrite-host.py",
    "worker-report-reclamation.py",
    "deployment-compose-profile.sh",
    "deployment-env-preflight.py",
)
PATTERNS = (
    "airfoils-hz-attempt-*",
    "airfoils-hz-point-history-*",
    "airfoils-hz-worker-report-*",
    "airfoils-hz-closed-job-*",
    "airfoils-historical-report-sharing-*",
    "airfoils-report-0209-*",
    "airfoils-report-migration-*",
    "hz-closed-progressive-maintenance*",
    "airfoils-closed-progressive-*",
)
GIB = 1024**3
CONTROL = Path.home() / ".local/state/airfoils-pro/report-rewrite"
spec = importlib.util.spec_from_file_location("hz_rewrite_host", HERE / FILES[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
audit = host.load_audit()


def ssh(machine, args, text=None, seconds=30):
    if machine not in (HOST, HUB):
        raise ValueError("Unknown maintenance endpoint")
    return host.command(
        [
            "ssh",
            "-T",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "-oUpdateHostKeys=no",
            "-oForwardAgent=no",
            "-oConnectTimeout=6",
            "-oServerAliveInterval=5",
            "-oServerAliveCountMax=3",
            machine,
            shlex.join(args),
        ],
        text=text,
        seconds=seconds,
    )


def ctl(*args):
    env = dict(os.environ)
    runtime = f"/run/user/{os.getuid()}"
    env.setdefault("XDG_RUNTIME_DIR", runtime)
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + runtime + "/bus")
    p = subprocess.run(
        ["systemctl", "--user", *args],
        text=True,
        capture_output=True,
        timeout=20,
        env=env,
    )
    if p.returncode:
        raise RuntimeError(f"operator systemctl {args[0]} failed: {p.stderr[-250:]}")
    return p.stdout.strip()


def inventory(extra=()):
    units = set(extra)
    for line in ctl(
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--type=service,timer",
    ).splitlines():
        name = line.split()[0]
        if any(fnmatch.fnmatchcase(name, p) for p in PATTERNS):
            units.add(name)
    return read_units(units)


def read_units(names):
    result = {}
    for name in sorted(names):
        if not re.fullmatch(r"[a-zA-Z0-9_.@:-]+\.(service|timer)", name):
            raise ValueError("Invalid report maintenance unit name")
        props = "LoadState,ActiveState,SubState,FreezerState,FragmentPath,UnitFileState,InvocationID,MainPID,ControlGroup"
        try:
            row = dict(
                x.split("=", 1)
                for x in ctl("show", name, "--property=" + props).splitlines()
            )
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            result[name] = {
                "captureRefusal": f"Could not inspect operator unit {name}: {exc}"
            }
            continue
        if row.get("LoadState") != "loaded" or row.get("ActiveState") not in (
            "active",
            "inactive",
            "failed",
        ):
            row["captureRefusal"] = (
                f"Cannot pause operator unit {name} in "
                f"{row.get('LoadState', 'unknown')} {row.get('ActiveState', 'unknown')}/{row.get('SubState', 'unknown')}"
            )
        elif row["ActiveState"] == "active" and name.endswith(".service"):
            if (
                row.get("FreezerState") not in ("running", "frozen")
                or not row.get("ControlGroup")
                or not row.get("InvocationID")
            ):
                row["captureRefusal"] = f"Cannot reversibly freeze {name}"
        elif row["ActiveState"] == "active" and name.endswith(".timer"):
            if (
                not Path(row.get("FragmentPath", "")).is_file()
                or row.get("UnitFileState") == "transient"
            ):
                row["captureRefusal"] = (
                    f"Cannot restore the prior timer definition for {name}"
                )
        result[name] = row
    return result


def same_unit(prior, current, *, paused):
    if current is None or current.get("captureRefusal") or prior.get("captureRefusal"):
        return False
    if (
        prior["FragmentPath"] != current["FragmentPath"]
        or prior["UnitFileState"] != current["UnitFileState"]
    ):
        return False
    if prior["ActiveState"] != "active":
        return all(
            prior[k] == current[k] for k in ("ActiveState", "SubState", "FreezerState")
        )
    if prior["SubState"] == "waiting":  # timer
        return current["ActiveState"] == ("inactive" if paused else "active")
    return (
        prior["ActiveState"] == current["ActiveState"]
        and prior["SubState"] == current["SubState"]
        and prior["InvocationID"] == current["InvocationID"]
        and prior["MainPID"] == current["MainPID"]
        and current["FreezerState"] == ("frozen" if paused else prior["FreezerState"])
    )


def operator_cgroups():
    return [
        line.split(":", 2)[2]
        for line in Path("/proc/self/cgroup").read_text().splitlines()
    ]


def freeze_units(state, save, discover=inventory, control=ctl):
    prior = state["units"]
    original = discover(state["extraUnits"])
    if set(original) != set(prior) or not all(
        same_unit(row, original.get(name), paused=False) for name, row in prior.items()
    ):
        raise RuntimeError("An operator unit changed before the pause")
    own_groups = operator_cgroups()
    for name, row in prior.items():
        if not name.endswith(".service") or row["ActiveState"] != "active":
            continue
        parent = row["ControlGroup"]
        if parent and any(
            group == parent or group.startswith(parent.rstrip("/") + "/")
            for group in own_groups
        ):
            raise RuntimeError(
                f"Run the operator outside {name} so it can restore that service"
            )
    # Stop triggering timers first. Freeze services without unloading a transient
    # unit, losing its checkpoint, changing enablement or replacing its process.
    for name in sorted(prior, key=lambda n: not n.endswith(".timer")):
        row = prior[name]
        if row["ActiveState"] != "active" or row["FreezerState"] == "frozen":
            continue
        state["touched"].append(name)
        save()
        control("stop" if name.endswith(".timer") else "freeze", name)
    check_units(state, True, discover)


def check_units(state, paused, discover=inventory):
    now = discover(state["extraUnits"])
    for row in now.values():
        if refusal := row.get("captureRefusal"):
            raise RuntimeError(refusal)
    for name, row in state["units"].items():
        if not same_unit(row, now.get(name), paused=paused):
            raise RuntimeError("Unexpected operator unit state: " + name)
    if any(
        row["ActiveState"] == "active"
        for name, row in now.items()
        if name not in state["units"]
    ):
        raise RuntimeError("Another report maintenance unit became active")


def restore_units(state, save, discover=None, control=ctl):
    # Release each captured process independently even when a different writer
    # is restarting or systemd cannot enumerate the full inventory.
    lookup = read_units if discover is None else discover
    failures = []
    for name in reversed(state["touched"][:]):
        prior = state["units"][name]
        try:
            now = lookup([name]).get(name)
            if not same_unit(prior, now, paused=False):
                if not same_unit(prior, now, paused=True):
                    raise RuntimeError("Unit identity or state changed")
                control("start" if name.endswith(".timer") else "thaw", name)
                if not same_unit(prior, lookup([name]).get(name), paused=False):
                    raise RuntimeError("Prior state was not restored")
            state["touched"].remove(name)
            save()
        except Exception as exc:
            failures.append(f"{name}: {exc}")
    if failures:
        raise RuntimeError("Operator recovery incomplete: " + "; ".join(failures))
    check_units(state, False, discover or inventory)


PROBE = """
import json,sys,types
package=json.load(sys.stdin)
a=types.ModuleType("worker_report_audit");a.__file__="<worker-report-reclamation>"
exec(compile(package["audit"],a.__file__,"exec"),a.__dict__)
h=types.ModuleType("hz_rewrite_probe");h.__file__="<hz-worker-report-rewrite>"
exec(compile(package["host"],h.__file__,"exec"),h.__dict__)
h.load_audit=lambda:a
print(json.dumps(h.measured(h.PG,census=package["census"],sample=package["sample"])))
"""


def worker(census=False, sample=False):
    package = {
        "audit": (HERE / FILES[2]).read_text(),
        "host": (HERE / FILES[1]).read_text(),
        "census": census,
        "sample": sample,
    }
    return json.loads(
        ssh(
            HOST,
            ["python3", "-B", "-c", PROBE],
            json.dumps(package),
            120 if census else 45,
        )
    )


def authoritative(facts):
    reg = str(uuid.UUID(facts["database"]["registration"]))
    instance = str(uuid.UUID(facts["database"]["instance"]))
    q = f"""SELECT jsonb_build_object('at',clock_timestamp(),'registration',s.id,'instance',s.instance_id,
     'active',count(p.id),'remainingSeconds',min(extract(epoch FROM (p."expiresAt"-clock_timestamp()))),
     'soonest',min(p."expiresAt")) FROM registered_remote_solvers s
     LEFT JOIN sync_sweep_promises p ON (p.registered_solver_id=s.id OR (p.registered_solver_id IS NULL AND p.request_payload->>'solverId'=s.id::text)) AND p.status='active' AND p."expiresAt">clock_timestamp()
     WHERE s.id='{reg}'::uuid AND s.instance_id='{instance}' AND s.revoked_at IS NULL GROUP BY s.id,s.instance_id"""
    result = audit.query("hub", q + ";")
    if len(result) != 1:
        raise RuntimeError("Missing exact upstream HZ registration")
    return result[0]


def make_plan(args):
    measured_at = time.time()
    f = worker(args.replacement_bytes is not None, args.sample_identity)
    hub = authoritative(f)
    cfg = dict(
        replacement=args.replacement_bytes,
        wal=args.wal_bytes,
        growth=args.growth_bytes or 0,
        floor=args.stop_free_bytes,
    )
    space = host.budget(f, cfg)
    reasons = space["refusals"][:]
    try:
        units = inventory(args.unit)
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        units = {}
        reasons.append(f"Operator unit inventory unavailable: {exc}")
    reasons.extend(
        row["captureRefusal"] for row in units.values() if "captureRefusal" in row
    )
    if args.growth_bytes is None:
        reasons.append("Specify the reviewed external growth allowance for this pause")
    # Retain time for client shutdown, readiness, a normal heartbeat and the
    # interrupted local units. No promise or job is renewed by this command.
    reserve = 300 + max(30, int(f["database"]["heartbeatSeconds"] or 30))
    maintenance = args.rewrite_seconds + 2 * args.identity_seconds + 300
    ttl = [
        float(x["remainingSeconds"])
        for x in (hub, f["database"]["leases"])
        if x["remainingSeconds"] is not None
    ]
    plan = {
        "target": host.TABLE,
        "role": "remote-solver",
        "identity": host.identity(f),
        "worker": f,
        "authority": hub,
        "units": units,
        "extraUnits": args.unit,
        "touched": [],
        "budget": cfg,
        "workspace": space,
        "sqlSeconds": args.rewrite_seconds,
        "identitySeconds": args.identity_seconds,
        "allReportBytes": args.all_report_bytes,
        "maintenanceSeconds": maintenance,
        "restoreReserve": reserve,
        "remainingWorkSeconds": maintenance + reserve,
        "verificationMode": "every report byte"
        if args.all_report_bytes
        else "all signed report identities and full scientific records",
        "availableForReplacementBytes": space["maximumAffordableReplacementBytes"],
        "leaseDeadline": measured_at + min(ttl) if ttl else None,
    }
    if ttl and min(ttl) - (time.time() - measured_at) <= plan["remainingWorkSeconds"]:
        reasons.append(
            "Earliest live local/upstream HZ promise cannot cover both identity scans, rewrite and restoration"
        )
    plan["refusals"] = reasons
    return plan


STAGE = """
import hashlib,json,os,pathlib,sys
os.umask(0o077)
p=pathlib.Path(sys.argv[1]);v=json.load(sys.stdin)
p.parent.mkdir(mode=0o700,exist_ok=True);p.mkdir(mode=0o700)
for name,data in v["files"].items():
 if name not in v["plan"]["fileHashes"] or "/" in name or hashlib.sha256(data.encode()).hexdigest()!=v["plan"]["fileHashes"][name]:raise ValueError("package digest mismatch")
 with (p/name).open("x") as f:f.write(data)
with (p/"plan.json").open("x") as f:json.dump(v["plan"],f)
"""

STATUS = """
import json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);u=sys.argv[2]
r=subprocess.run(["systemctl","show",u,"--property=ActiveState,LoadState,SubState","--no-pager"],text=True,capture_output=True,timeout=5)
if r.returncode and "not-found" not in r.stdout:raise ValueError("Unknown server unit state")
o=dict(x.split("=",1) for x in r.stdout.splitlines() if "=" in x)
o["snapshot"]=(p/"prior-state.tsv").is_file()
log=p/"progress.jsonl";o["lastProgress"]=None
if log.is_file():
 with log.open("rb") as fp:
  fp.seek(max(0,log.stat().st_size-8192))
  for l in reversed(fp.read().splitlines()):
   try:o["lastProgress"]=json.loads(l);break
   except (ValueError,UnicodeDecodeError):pass
o["result"]=dict(x.split("=",1) for x in (p/"result").read_text().splitlines()) if (p/"result").exists() else None
o["recovered"]=dict(x.split("=",1) for x in (p/"recovery-result").read_text().splitlines()) if (p/"recovery-result").is_file() else None
o["committed"]=True if (p/"rewrite-commit.json").is_file() else None
if o["committed"] is None and (p/"resumed.json").is_file() and (p/"quiesced.json").is_file():
 b=json.loads((p/"quiesced.json").read_text());a=json.loads((p/"resumed.json").read_text())
 if a["oid"]==b["oid"] and a["serverStartedAt"]==b["serverStartedAt"]:o["committed"]=a["relfilenode"]!=b["relfilenode"]
print(json.dumps(o))
"""


def location(state):
    run = state["run"]
    if not re.fullmatch("[a-f0-9]{32}", run):
        raise ValueError("Invalid run key")
    return REMOTE + "/" + run, "airfoils-hz-report-rewrite-" + run + ".service"


def read_host(args):
    for attempt in range(3):
        try:
            return ssh(HOST, args, seconds=12)
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(1 << attempt)


def status(state):
    directory, unit = location(state)
    return json.loads(read_host(["python3", "-B", "-c", STATUS, directory, unit]))


def launch(state, restore=False):
    directory, unit = location(state)
    return ssh(
        HOST,
        [
            "env",
            "APP_DIR=/opt/airfoils-pro/app",
            "AIRFOILS_PRO_STATE_DIR=/opt/airfoils-pro/state",
            "MAINTENANCE_TIMEOUT_SECONDS=" + str(state["maintenanceSeconds"]),
            "COMPACTION_TIMEOUT_SECONDS=" + str(state["sqlSeconds"]),
            "RESTORE_TIMEOUT_SECONDS=300",
            "bash",
            directory + "/" + FILES[0],
            "--execute",
            "--hz-worker-session",
            *(["--restore-worker-state"] if restore else []),
            "--server-run",
        ],
    )


def stopped(s):
    return s["ActiveState"] in ("inactive", "failed") and s["SubState"] in (
        "dead",
        "failed",
    )


def cancel(state):
    directory, unit = location(state)
    # A persistent request is also seen by the HZ monitor. systemd delivers
    # TERM to the shell, whose existing trap cancels only this run's SQL tag.
    ssh(HOST, ["touch", directory + "/cancel"])
    if not stopped(status(state)):
        ssh(HOST, ["systemctl", "--no-block", "stop", unit])


def await_host(state, seconds, guard=False):
    deadline = time.monotonic() + seconds
    next_lease = 0
    while time.monotonic() < deadline:
        s = status(state)
        if stopped(s):
            return s
        if guard:
            check_units(state, True)
            if time.monotonic() >= next_lease:
                h = authoritative(state["worker"])
                ttl = h["remainingSeconds"]
                if ttl is not None and float(ttl) <= state["restoreReserve"]:
                    raise RuntimeError(
                        "Authoritative lease has reached its restoration margin"
                    )
                next_lease = time.monotonic() + 20
        time.sleep(2)
    raise TimeoutError("Server maintenance exceeded its bounded window")


def collect(state, directory):
    remote, _ = location(state)
    # Small, explicit allowlist. Keep the longer progress journal on HZ.
    names = (
        "prior-state.tsv",
        "result",
        "recovery-result",
        "readiness.tsv",
        "quiesced.json",
        "identity-before.json",
        "identity-after.json",
        "rewrite-commit.json",
        "after.json",
        "resumed.json",
        "space-result.json",
    )
    script = """import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); receipts={}
for name in sys.argv[2:]:
 f=p/name
 if f.exists():
  if f.stat().st_size>2097152: raise ValueError('Unexpected receipt size')
  receipts[name]=f.read_text()
print(json.dumps(receipts))"""
    bundle = json.loads(read_host(["python3", "-B", "-c", script, remote, *names]))
    for name in names:
        if name in bundle:
            (directory / name).write_text(bundle[name])


def recovery_ok(receipt):
    return bool(
        receipt
        and receipt.get("recovery_failed") == "false"
        and receipt.get("readiness_failed") == "false"
    )


def recover_host(state):
    s = status(state)
    if not s["result"] or not stopped(s):
        cancel(state)
        s = await_host(state, 330)
    if s["snapshot"] and not (recovery_ok(s["result"]) or recovery_ok(s["recovered"])):
        launch(state, restore=True)
        s = await_host(state, 330)
    if s["snapshot"] and not (recovery_ok(s["result"]) or recovery_ok(s["recovered"])):
        raise RuntimeError(
            "HZ control-plane recovery is incomplete; inspect the original receipt"
        )
    return s


@contextmanager
def cleanup_signals():
    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in signals}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def verify_collection(state, directory):
    resumed = directory / "resumed.json"
    if not resumed.is_file():
        return
    f = json.loads(resumed.read_text())
    target = state["worker"]["database"]
    quiesced = directory / "quiesced.json"
    initial = (
        json.loads(quiesced.read_text())["collection"]
        if quiesced.exists()
        else state["worker"]["collection"]
    )
    # Only actual outbox sequences establish resumed collection. A quiet engine
    # or an intentionally stopped sweeper is recorded with its observed state.
    if (
        not any(
            row["state"] == "running" for row in state["worker"]["services"]["sweeper"]
        )
        or not target["remoteEnabled"]
    ):
        dump = {"state": "previously-inactive"}
    elif not initial["samples"]:
        dump = {"state": "no-active-sampled-execution", "observed": f["collection"]}
    else:
        samples = {
            entry["id"]: int(entry["sequence"] or 0) for entry in initial["samples"]
        }
        ids = ",".join("'%s'::uuid" % uuid.UUID(k) for k in samples)
        until = time.monotonic() + 90
        while True:
            q = f"""SELECT jsonb_build_object('at',clock_timestamp(),'samples',jsonb_agg(to_jsonb(x))) FROM
                (SELECT j.id,j.status,(SELECT max(sequence) FROM progressive_worker_reports r WHERE r.sim_job_id=j.id) AS sequence
                FROM sim_jobs j WHERE j.id IN ({ids}))x"""
            obs = audit.query("worker", q + ";")[0]
            advanced = [
                x["id"]
                for x in obs["samples"] or []
                if int(x["sequence"] or 0) > samples[x["id"]]
            ]
            if advanced or time.monotonic() >= until:
                break
            time.sleep(3)
        dump = {
            "state": "observed-new-report"
            if advanced
            else "services-restored-no-new-sampled-report",
            "advanced": advanced,
            "observed": obs,
        }
    host.dump(directory / "collection.json", dump)
    hub = authoritative(f)
    host.dump(directory / "authority-after.json", hub)


def transaction(state, directory, *, recovery=False):
    save = lambda: host.dump(directory / "operator.json", state)
    CONTROL.mkdir(parents=True, mode=0o700, exist_ok=True)
    marker = CONTROL / "active-rewrite.json"
    with (CONTROL / ".operator.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (
            marker.exists()
            and json.loads(marker.read_text()).get("run") != state["run"]
        ):
            raise RuntimeError(
                "Recover the previous operator run before starting another: "
                + str(marker)
            )
        if recovery:
            if state.get("submissionIntent"):
                recover_host(state)
            restore_units(state, save)
            marker.unlink(missing_ok=True)
            if state.get("submissionIntent"):
                collect(state, directory)
            verify_collection(state, directory)
            return
        save()
        files = {n: (HERE / n).read_text() for n in FILES}
        state["fileHashes"] = {
            k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()
        }
        remote, _ = location(state)
        ssh(
            HOST,
            ["python3", "-B", "-c", STAGE, remote],
            json.dumps({"plan": state, "files": files}),
        )
        save()
        host.dump(marker, {"run": state["run"], "directory": str(directory)})
        try:
            if (directory / "operator-cancel.json").exists():
                raise InterruptedError("Cancelled before pause")
            freeze_units(state, save)
            if (directory / "operator-cancel.json").exists():
                raise InterruptedError("Cancelled before submission")
            state["submissionIntent"] = True
            save()
            launch(state)
            s = await_host(state, state["maintenanceSeconds"] + 330, guard=True)
            if not s["result"] or s["result"].get("exit") != "0":
                raise RuntimeError("The server rewrite did not finish successfully")
        finally:
            with cleanup_signals():
                # If SSH is unavailable the remote unit retains its independent
                # deadline. Its original container restoration must be confirmed
                # before releasing external writers. The marker names recovery.
                if state.get("submissionIntent"):
                    recover_host(state)
                try:
                    restore_units(state, save)
                    marker.unlink(missing_ok=True)
                finally:
                    if state.get("submissionIntent"):
                        collect(state, directory)
                        if not state["touched"]:
                            verify_collection(state, directory)
        if not (directory / "space-result.json").exists():
            raise RuntimeError("Missing verified post-rewrite physical result")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--execute", action="store_true")
    mode.add_argument("--recover", type=Path, metavar="RUN_DIR")
    mode.add_argument("--cancel", type=Path, metavar="RUN_DIR")
    mode.add_argument("--status", type=Path, metavar="RUN_DIR")
    parser.add_argument(
        "--run-dir", type=Path, help="new private directory for an authorized execution"
    )
    parser.add_argument(
        "--output", type=Path, help="local JSON for read-only feasibility"
    )
    parser.add_argument(
        "--unit",
        action="append",
        default=[],
        help="additional operator user service/timer which writes to HZ",
    )
    parser.add_argument(
        "--all-report-bytes",
        action="store_true",
        help="also rehash every complete inline report body during both proofs; budget these additional reads",
    )
    parser.add_argument(
        "--sample-identity",
        action="store_true",
        help="time exact row hashing on a bounded worker heap sample",
    )
    parser.add_argument(
        "--replacement-bytes",
        type=int,
        help="reviewed packed replacement bound including indexes; also measures live report sizes",
    )
    parser.add_argument(
        "--wal-bytes",
        type=int,
        help="additional retained WAL budget on the same volume",
    )
    parser.add_argument(
        "--growth-bytes",
        type=int,
        help="reviewed other filesystem consumption during this pause",
    )
    parser.add_argument(
        "--stop-free-bytes",
        type=int,
        default=8 * GIB,
        help="minimum operating/cancellation reserve",
    )
    parser.add_argument("--rewrite-seconds", type=int, default=5400)
    parser.add_argument(
        "--identity-seconds",
        type=int,
        default=1800,
        help="deadline for each full scientific fingerprint",
    )
    args = parser.parse_args()
    os.umask(0o077)
    if args.cancel or args.recover or args.status:
        path = (args.cancel or args.recover or args.status).resolve()
        state = json.loads((path / "operator.json").read_text())
        if args.status:
            print(
                json.dumps(
                    {
                        "server": status(state),
                        "operatorPaused": state["touched"],
                        "run": state["run"],
                    }
                )
            )
        elif args.cancel:
            host.dump(path / "operator-cancel.json", {"requestedAt": time.time()})
            if state.get("submissionIntent"):
                cancel(state)
        else:
            transaction(state, path, recovery=True)
        return
    if not (
        1 <= args.rewrite_seconds <= 86400
        and 1 <= args.identity_seconds <= 86400
        and args.stop_free_bytes > 0
        and (args.growth_bytes is None or args.growth_bytes >= 0)
        and all(x is None or x > 0 for x in (args.replacement_bytes, args.wal_bytes))
    ):
        parser.error("Invalid rewrite, space or time bounds")
    if args.execute != bool(args.run_dir) or (args.execute and args.output):
        parser.error("--execute requires a new --run-dir; --output is for dry runs")
    state = make_plan(args)
    if args.output:
        with args.output.open("x") as f:
            json.dump(state, f, indent=2)
            f.write("\n")
    print(
        json.dumps(
            {
                "mode": "execute" if args.execute else "read-only",
                "table": host.TABLE,
                "workspace": state["workspace"],
                "authority": state["authority"],
                "localLeases": state["worker"]["database"]["leases"],
                "pauseSeconds": state["remainingWorkSeconds"],
                "identitySample": state["worker"].get("identitySample"),
                "solverProcesses": state["worker"]["solverProcesses"],
                "ingress": state["worker"]["ingress"],
                "operatorUnits": len(state["units"]),
                "refusals": state["refusals"],
            }
        ),
        flush=True,
    )
    if not args.execute:
        return
    if state["refusals"]:
        raise SystemExit("Preflight refused before the pause")
    directory = args.run_dir.resolve()
    directory.mkdir(mode=0o700)
    state["run"] = uuid.uuid4().hex
    transaction(state, directory)


if __name__ == "__main__":

    def interrupted(*_):
        raise KeyboardInterrupt("Operator interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    main()
