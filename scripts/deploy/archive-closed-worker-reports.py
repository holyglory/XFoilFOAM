#!/usr/bin/env python3
"""Archive exact closed HZ source members from a sealed JSONL inventory, one at a time."""
import argparse
import base64
import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PEER = ROOT / "apps/sweeper/src/closed-worker-report-peer.mjs"
RUNTIME = (
    "apps/sweeper/src/config.ts", "apps/sweeper/src/hz-attempt-transfer-fence.ts",
    "apps/sweeper/src/registered-worker-report-read.ts", "apps/sweeper/src/registered-worker-report-hub.ts",
    "apps/sweeper/src/report-archive-broker-client.ts", "apps/sweeper/src/worker-report-volume.ts",
    "apps/sweeper/src/progressive-report-archive-store.ts", "apps/api/src/progressive-report-archive-reader.ts",
    "apps/api/src/report-archive-broker.ts", "packages/db/src/progressive-report-reader.ts",
    "packages/db/src/progressive-report-archive.ts", "packages/db/src/progressive-remote-execution.ts",
    "packages/db/src/retained-solver-reports.ts", "packages/db/src/client.ts",
    "packages/db/src/registered-worker-archive-owner.ts", "packages/db/src/progressive-remote-report.ts",
    "packages/db/package.json", "apps/sweeper/package.json", "apps/api/package.json", "pnpm-lock.yaml",
)
SHA = re.compile(r"[a-f0-9]{64}")
UUID = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def durable(path, value, immutable=False):
    data = compact(value) + b"\n"
    if immutable and path.exists():
        require(path.read_bytes() == data, "Conflicting immutable receipt")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink()
            raise
    try:
        if immutable:
            os.link(tmp, path)
        else:
            os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def check_key(key, ranges):
    require(set(key) == {"executionId", "sequence", "signature"} and UUID.fullmatch(key["executionId"])
            and type(key["sequence"]) is int and 0 < key["sequence"] < 2**53
            and SHA.fullmatch(key["signature"]), "Invalid exact report key")
    entry = ranges.get(key["executionId"])
    require(not entry or not entry.get("reportAfter", 0) < key["sequence"] <= entry["reportHighWater"],
            "Selected sequence belongs to the frozen operator")
    return entry


def run_peer(args, role, message, source):
    host, container = {
        "hub": (args.hub_host, args.hub_sweeper),
        "api": (args.hz_host, args.hz_api),
        "worker": (args.hz_host, args.hz_sweeper),
    }[role]
    argv = ["docker", "exec", "-i", "-w", "/app/apps/sweeper/src", container,
            "node", "--import", "tsx", "--input-type=module", "-"]
    # The source marker and the installed reader files are both checked. The
    # mutating host command holds the same deployment lock across check and use.
    guard = ("import json,os,sys; "
             "p='/opt/airfoils-pro/app/.deployment-source.json'; "
             "sys.exit(75) if json.load(open(p))['sourceRevision']!=sys.argv[1] else os.execvp(sys.argv[2],sys.argv[2:])")
    argv = ["python3", "-I", "-c", guard, args.runtime_revision, *argv]
    if message["op"] in ("publish", "settle"):
        require(args.apply and role == "worker", "Mutation requires the original native writer")
        argv = ["flock", "-s", "-w", "15", "-E", "75", "/tmp/airfoils-pro-deploy.lock", *argv]
    wire = base64.b64encode(compact(message)).decode()
    # The program travels through stdin. No file or service in the running image is replaced.
    program = source + "\nconst request=JSON.parse(Buffer.from('" + wire + "','base64'));\n" + """
try { const receipt=await invokeClosedReport(request); console.log(JSON.stringify(receipt)); }
catch (e) { console.error(e.name, e.cause?.code ?? e.code ?? "", e.cause?.routine ?? "");
  if (e.code === "ERR_ASSERTION" && !String(e.message).includes("\\n")) console.error(String(e.message).slice(0,170));
  process.exitCode=1; }
"""
    cmd = ["ssh", "-T", "-C", "-oBatchMode=yes", "-oForwardAgent=no", "-oClearAllForwardings=yes",
           "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10", host, shlex.join(argv)]
    process = subprocess.run(cmd, input=program, text=True, capture_output=True, timeout=170)
    if process.returncode:
        raise RuntimeError(f"{role} {message['op']} refused ({process.returncode}): {process.stderr[-340:]}")
    require(len(process.stdout) < 2 * 1024**2, "Oversized peer response")
    return json.loads(process.stdout)


def run(args):
    require(re.fullmatch(r"[0-9a-f]{40}", args.runtime_revision), "Expected deployed source revision")
    for host in (args.hub_host, args.hz_host, args.hub_sweeper, args.hz_sweeper, args.hz_api):
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", host), "Invalid existing SSH target")
    require(args.hub_host != args.hz_host and args.hz_api != args.hz_sweeper, "Independent role subjects required")
    require(1 <= args.limit <= 128, "Expected 1 to 128 bounded operations")
    s = json.loads(args.frozen_scope.read_bytes())
    require(s["version"] == 1 and digest(compact(s)) == args.frozen_sha256 and s["executions"], "Frozen scope changed")
    ranges = {r["executionId"]: r for r in s["executions"]}
    require(len(ranges) == len(s["executions"]), "Ambiguous frozen ranges")
    runtime = {f:digest(subprocess.check_output(["git", "-C", ROOT, "show", f"{args.runtime_revision}:{f}"])) for f in RUNTIME}
    peer = PEER.read_text()
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_dir = args.state / "receipts"
    receipt_dir.mkdir(mode=0o700, exist_ok=True)
    with (args.state / "controller.lock").open("a+b") as lock, args.keys.open("rb") as keys:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(hashlib.file_digest(keys,"sha256").hexdigest() == args.keys_sha256, "Private signed-key inventory changed")
        bind = dict(version=1, frozen=args.frozen_sha256, inventory=args.keys_sha256, source=s["sourceInstance"], solver=s["solverId"],
                    hz=[args.hz_host,args.hz_sweeper,args.hz_api], hub=[args.hub_host,args.hub_sweeper])
        path = args.state / "progress.json"
        progress = json.loads(path.read_bytes()) if path.exists() else dict(binding=bind, after=0, completed=0, pending=None)
        require(progress["binding"] == bind, "Controller scope or role binding changed")
        keys.seek(progress["after"])
        for _ in range(args.limit):
            line = keys.readline(2049)
            if not line:
                require(not progress["pending"], "Saved operation missing from inventory")
                break
            require(len(line) <= 2048 and line.endswith(b"\n"), "Incomplete or oversized inventory key")
            key = json.loads(line)
            entry = check_key(key,ranges)
            scope = dict(sourceInstance=s["sourceInstance"],solverId=s["solverId"],sha256=args.frozen_sha256,range=entry)
            def rpc(role, op, **fields):
                return run_peer(args, role, dict(scope=scope,key=key,runtime=runtime,op=op,**fields), peer)
            state = progress["pending"]
            receipt = receipt_dir / f"{progress['completed']:08d}.json"
            if receipt.exists():
                done = json.loads(receipt.read_bytes())
                require(done["key"] == key and done["binding"] == bind, "Saved receipt scope changed")
                if not args.apply:
                    print(json.dumps({"key":key,"status":"verified"}))
                    return
            else:
                if state:
                    require(state["key"] == key, "Pending source changed")
                else:
                    initial = rpc("worker","source")
                    require(not initial["archivedBundle"], "Use the existing native receipt")
                    state = dict(key=key, initial=initial, pin=None)
                    if args.apply:
                        progress["pending"] = state
                        durable(path,progress)
                source = state["initial"]["source"]
                hub = rpc("hub","hub",source=source)
                if not args.apply:
                    print(json.dumps(dict(key=key,stored=state["initial"]["stored"],facts=source["facts"],earlier=len(hub["science"]["earlier"]))))
                    return
                if not state["pin"]:
                    state["pin"] = rpc("worker","publish",source=source,hub=hub)
                    durable(path, progress)
                pin = state["pin"]
                def reads(committed):
                    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                        cloud = pool.submit(rpc,"hub","cloud",source=source,pin=pin)
                        api = pool.submit(rpc,"api","read",source=source,pin=pin,reader="api",committed=committed)
                        worker = pool.submit(rpc,"worker","read",source=source,pin=pin,reader="sweeper",committed=committed)
                        return dict(cloud=cloud.result(),api=api.result(),sweeper=worker.result())
                before = reads(False)
                require(hub["science"] == before["cloud"]["science"], "Hub science changed")
                if not state.get("settled"):
                    state["settled"] = rpc("worker","settle",source=source,pin=pin,hub=hub,**before)
                    durable(path,progress)
                after = reads(True)
                require(after["cloud"]["science"] == hub["science"], "Post-retirement hub science changed")
                done = dict(binding=bind,key=key,runtimeRevision=args.runtime_revision,installed=runtime,peerSha256=digest(peer.encode()),
                            initial=state["initial"],pin=pin,settled=state["settled"],before=before,after=after)
                durable(receipt,done,immutable=True)
            progress.update(after=keys.tell(), completed=progress["completed"]+1, pending=None)
            durable(path,progress)
            print(json.dumps(dict(receipt=str(receipt),sequence=key["sequence"],settled=done["settled"])),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for opt in ("frozen-scope","keys","state"):
        parser.add_argument("--"+opt,required=True,type=Path)
    for opt in ("frozen-sha256","keys-sha256","runtime-revision","hub-host","hz-host","hub-sweeper","hz-sweeper","hz-api"):
        parser.add_argument("--"+opt,required=True)
    parser.add_argument("--limit",type=int,default=1)
    parser.add_argument("--apply",action="store_true")
    try:
        run(parser.parse_args())
    except (ValueError,RuntimeError,OSError,subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
