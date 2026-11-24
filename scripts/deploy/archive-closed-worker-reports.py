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
import time
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from closed_worker_report_pages import process_page, qualified_width
from closed_worker_report_sessions import ReadPeerStopped, ReportReadSessions, ROLE_READS
from closed_worker_report_discovery import discovery_step, revisit_held, revisit_prefix
from closed_worker_report_order import OrderedInventory, ordered_inventory, remember_member_size

ROOT = Path(__file__).resolve().parents[2]
PEER = ROOT / "apps/sweeper/src/closed-worker-report-peer.mjs"
RUNTIME = (
    "apps/sweeper/src/config.ts", "apps/sweeper/src/hz-attempt-transfer-fence.ts", "apps/sweeper/src/hub-workload-gcs.ts",
    "apps/sweeper/src/registered-worker-report-read.ts", "apps/sweeper/src/registered-worker-report-hub.ts",
    "apps/sweeper/src/worker-result-archive.ts", "apps/sweeper/src/shared-report-objects.ts",
    "apps/sweeper/src/report-archive-broker-client.ts", "apps/sweeper/src/worker-report-volume.ts",
    "apps/sweeper/src/progressive-report-archive-store.ts", "apps/api/src/progressive-report-archive-reader.ts",
    "apps/api/src/report-archive-broker.ts", "packages/db/src/progressive-report-reader.ts",
    "packages/db/src/progressive-report-archive.ts", "packages/db/src/progressive-remote-execution.ts",
    "packages/db/src/retained-solver-reports.ts", "packages/db/src/legacy-report-signature.ts", "packages/db/src/client.ts",
    "packages/db/src/registered-worker-archive-owner.ts", "packages/db/src/progressive-remote-report.ts",
    "packages/core/src/point-history-protocol.ts", "packages/core/package.json",
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
    started = time.monotonic()
    sessions = getattr(args,"read_sessions",None)
    if sessions and message["op"] in ROLE_READS[role]:
        try:
            record = sessions.ask(args,role,message,source)
        except ReadPeerStopped as error:
            if message["op"] in ("hub", "cloud", "read"):
                error.keys = [item["key"] for item in message.get("items", [message])]
            raise
    else:
        record = single_request(args,role,message,source)
    value = record.pop("value")
    if args.measure_rpc:
        items=message.get("items") or []
        observed=message.get("pin") or (items[0].get("pin") if items else None) or value.get("pin") or (value.get("pins") or [value])[0]
        record.update(role=role,op=message["op"],sequence=(message.get("key") or {}).get("sequence"),members=len(items or message.get("keys") or [message.get("key")]),committed=message.get("committed"),
                      generation=observed.get("generation"), pinnedReads=value.get("generationDownloads"),
                      storedBytes=observed.get("storedByteSize"),deltaMembers=value.get("deltaMembers"),
                      busy=value.get("retryableBrokerStatus"),wallMs=round((time.monotonic()-started)*1000,2))
        fd=os.open(args.measure_rpc, os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
        try:
            os.write(fd,compact(record)+b"\n")
        finally:
            os.close(fd)
    return value



def single_request(args, role, message, source):
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
const bootMs=performance.now(), cpu=process.cpuUsage();
function send(value) {
  const used=process.cpuUsage(cpu);
  console.log(JSON.stringify({value,bootMs,workMs:performance.now()-bootMs,cpuMs:(used.user+used.system)/1000,peakRssKiB:process.resourceUsage().maxRSS}));
}
try { send(await invokeClosedReport(request)); }
catch (e) {
  const status = /^Worker report archive upload failed [(](429|502|503|504)[)]$/.exec(e.message);
  if (["source","hub"].includes(request.op) && e.name === "ClosedReportHeld") {
    send({held:e.message});
  } else if (request.op === "publish" && status) {
    send({retryableBrokerStatus:Number(status[1])});
  } else {
  console.error(e.name, e.cause?.code ?? e.code ?? "", e.cause?.routine ?? "");
  if (e.code === "ERR_ASSERTION" && !String(e.message).includes("\\n")) console.error(String(e.message).slice(0,170));
  process.exitCode=1; } }
"""
    cmd = ["ssh", "-T", "-C", "-oBatchMode=yes", "-oForwardAgent=no", "-oClearAllForwardings=yes",
           "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10", host, shlex.join(argv)]
    process = subprocess.run(cmd, input=program, text=True, capture_output=True, timeout=170)
    if process.returncode:
        raise RuntimeError(f"{role} {message['op']} refused ({process.returncode}): {process.stderr[-340:]}")
    require(len(process.stdout) < 2 * 1024**2, "Oversized peer response")
    return json.loads(process.stdout)


def inputs(args):
    require(re.fullmatch(r"[0-9a-f]{40}", args.runtime_revision), "Expected deployed source revision")
    for host in (args.hub_host, args.hz_host, args.hub_sweeper, args.hz_sweeper, args.hz_api):
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", host), "Invalid existing SSH target")
    require(args.hub_host != args.hz_host and args.hz_api != args.hz_sweeper, "Independent role subjects required")
    require(1 <= getattr(args,"page_members",1) <= 8, "Page membership must be between one and eight")
    if getattr(args,"page_members",1)>1 or getattr(args,"share_results",False):
        require(args.hub_account_file and args.hub_account_file.is_file(),"Expected existing hub workload account file")
    require(1 <= args.limit <= 128, "Expected 1 to 128 bounded operations")
    s = json.loads(args.frozen_scope.read_bytes())
    require(s["version"] == 1 and digest(compact(s)) == args.frozen_sha256 and s["executions"], "Frozen scope changed")
    ranges = {r["executionId"]: r for r in s["executions"]}
    require(len(ranges) == len(s["executions"]), "Ambiguous frozen ranges")
    runtime = {f:digest(subprocess.check_output(["git", "-C", ROOT, "show", f"{args.runtime_revision}:{f}"])) for f in RUNTIME}
    bind = dict(version=1, frozen=args.frozen_sha256, inventory=args.keys_sha256, source=s["sourceInstance"], solver=s["solverId"],
                hz=[args.hz_host,args.hz_sweeper,args.hz_api], hub=[args.hub_host,args.hub_sweeper])
    return s,ranges,bind,runtime,PEER.read_text()


def run(args):
    shared=inputs(args)
    s,ranges,bind,runtime,peer=shared
    if getattr(args,"pause_file",None) and args.pause_file.exists():
        return
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_dir = args.state / "receipts"
    receipt_dir.mkdir(mode=0o700, exist_ok=True)
    with (args.state / "controller.lock").open("a+b") as lock, args.keys.open("rb") as keys:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(hashlib.file_digest(keys,"sha256").hexdigest() == args.keys_sha256, "Private signed-key inventory changed")

        path = args.state / "progress.json"
        saved = path.read_bytes() if path.exists() else None
        expected = getattr(args, "retry_checkpoint_sha256", None)
        if expected:
            require(saved is not None and digest(saved) == expected, "Committed report retry checkpoint changed")
        progress = json.loads(saved) if saved is not None else dict(binding=bind, after=0, completed=0, pending=None)
        keys = ordered_inventory(args, keys, progress, bind, path, durable, lambda key: check_key(key, ranges))
        index = getattr(args,"recheck_held_index",None)
        if index is not None and args.apply and not progress.get("pending") and not progress.get("group"):
            require(0 <= index < progress["completed"],"Recheck requires a visited held source")
            if revisit_held(args,index,bind,run,durable,compact,require):
                return
        through=getattr(args,"recheck_held_through",None)
        if through is not None and args.apply and not progress.get("pending") and not progress.get("group"):
            if revisit_prefix(args,through,progress,bind,run,durable,compact,require):
                return
        if (getattr(args,"discover_after_seed",False) and args.apply and progress["after"]==os.fstat(keys.fileno()).st_size
                and not progress.get("pending") and not progress.get("group")):
            require(1<=args.scan_rows<=1024 and args.discovery_interval>=1,"Invalid bounded discovery parameters")
            return discovery_step(args,run,shared,
                lambda role,msg:run_peer(args,role,{**msg,"runtime":runtime},peer),durable,compact,require)
        keys.seek(progress["after"])
        def advance(receipt, done):
            outcome = done["settled"]["outcome"]
            column = "held" if outcome == "held" else "archived"
            # Early receipts used completed for the verified-only prefix.
            progress.setdefault("archived", progress["completed"] - progress.get("held", 0))
            progress[column] = progress.get(column, 0) + 1
            remember_member_size(progress, done.get("pin"))
            progress.update(after=keys.tell(), completed=progress["completed"]+1, pending=None)
            durable(path,progress)
            print(json.dumps(dict(receipt=str(receipt),sequence=done["key"]["sequence"],settled=done["settled"])),flush=True)

        def scope_for(key):
            entry=check_key(key,ranges)
            return dict(sourceInstance=s["sourceInstance"],solverId=s["solverId"],sha256=args.frozen_sha256,range=entry)
        def ask(role, message):
            return run_peer(args,role,{"shareResults":getattr(args,"share_results",False),**message,"runtime":runtime},peer)
        # The invocation budget and mutation owner do not change when two normal
        # four-member windows share one authenticated generation.
        peer_hash = digest(peer.encode())
        limits = qualified_width(args, bind, runtime, peer_hash)
        max_members = 8 if limits else getattr(args, "page_members", 1)
        left = args.limit
        while left>0:
            if getattr(args,"pause_file",None) and args.pause_file.exists():
                return
            page_limit = min(max_members, left)
            if isinstance(keys, OrderedInventory) and not progress.get("group"):
                page_limit = keys.page_limit(page_limit, progress.get("lastPriorityMember"))
            if args.apply and not progress.get("pending") and (progress.get("group") or page_limit > 1):
                used=process_page(args, keys, page_limit, progress, path, bind, runtime, peer_hash,
                                  scope_for, ask, durable, require, limits)
                if used:
                    left-=used
                    continue
            left-=1
            line = keys.readline(2049)
            if not line:
                require(not progress["pending"], "Saved operation missing from inventory")
                break
            require(len(line) <= 2048 and line.endswith(b"\n"), "Incomplete or oversized inventory key")
            key = json.loads(line)
            scope = scope_for(key)
            def rpc(role, op, **fields):
                return run_peer(args, role, dict({"shareResults":getattr(args,"share_results",False)},scope=scope,key=key,runtime=runtime,op=op,**fields), peer)
            state = progress["pending"]
            receipt = receipt_dir / f"{progress['completed']:08d}.json"
            def hold(proof):
                # Once any upload may have begun, keep its exact pending intent until reconciliation.
                require(not (state and (state.get("publishing") or state.get("pin") or state.get("settled"))), "Eligibility changed with a pending archive; retain intent")
                held = dict(binding=bind,key=key,runtimeRevision=args.runtime_revision,peerSha256=digest(peer.encode()),
                            settled={"outcome":"held","reason":proof["held"]})
                if args.apply:
                    durable(receipt, held, immutable=True)
                    advance(receipt, held)
                else:
                    print(json.dumps(held))
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
                    if "held" in initial:
                        hold(initial)
                        if args.apply:
                            continue
                        return
                    require(not initial["archivedBundle"], "Use the existing native receipt")
                    state = dict(key=key, initial=initial, pin=None, shareResults=getattr(args,"share_results",False))
                    if args.apply:
                        progress["pending"] = state
                        durable(path,progress)
                source = state["initial"]["source"]
                hub = rpc("hub","hub",source=source)
                if "held" in hub:
                    hold(hub)
                    if args.apply:
                        continue
                    return
                if not args.apply:
                    print(json.dumps(dict(key=key,stored=state["initial"]["stored"],facts=source["facts"],earlier=len(hub["science"]["earlier"]))))
                    return
                if not state["pin"]:
                    state["publishing"] = True
                    durable(path, progress)
                    for attempt in range(3):
                        candidate = rpc("worker","publish",source=source,hub=hub,shareResults=state.get("shareResults",False))
                        status = candidate.get("retryableBrokerStatus")
                        if status is None:
                            state["pin"] = candidate
                            durable(path, progress)
                            break
                        require(status in (429,502,503,504), "Unexpected broker refusal")
                        if attempt == 2:
                            raise RuntimeError(f"Broker returned {status}; exact pending source retained for retry")
                        time.sleep(5 * (2**attempt))
                        hub = rpc("hub","hub",source=source)
                        require("held" not in hub, "Hub eligibility changed with a pending upload")
                pin = state["pin"]
                def reads(committed):
                    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                        account = {"hubAccount": args.hub_account_file.read_text().strip()} if pin.get("archiveFormat")=="worker-result-ref-v1" else {}
                        cloud = pool.submit(rpc,"hub","cloud",source=source,pin=pin,**account)
                        api = pool.submit(rpc,"api","read",source=source,pin=pin,reader="api",committed=committed)
                        worker = pool.submit(rpc,"worker","read",source=source,pin=pin,reader="sweeper",committed=committed)
                        return dict(cloud=cloud.result(),api=api.result(),sweeper=worker.result())
                before = reads(False)
                require(hub["science"] == before["cloud"]["science"], "Hub science changed")
                if not state.get("settled"):
                    state["settled"] = rpc("worker","settle",source=source,pin=pin,hub=hub,shareResults=state.get("shareResults",False),**before)
                    durable(path,progress)
                after = reads(True)
                require(after["cloud"]["science"] == hub["science"], "Post-retirement hub science changed")
                check_size = after["api"]["storedFieldBytes"]
                require(check_size == after["sweeper"]["storedFieldBytes"], "Committed PG field size changed across normal readers")
                done = dict(binding=bind,key=key,runtimeRevision=args.runtime_revision,installed=runtime,peerSha256=digest(peer.encode()),
                            committedStoredFieldBytes=check_size,
                            initial=state["initial"],pin=pin,settled=state["settled"],before=before,after=after)
                durable(receipt,done,immutable=True)
            advance(receipt, done)


def committed_read_retry(args, error):
    if not args.apply or not error.keys:
        return None
    path = args.state / "progress.json"
    if not path.is_file():
        return None
    saved = path.read_bytes()
    progress = json.loads(saved)
    group, single = progress.get("group"), progress.get("pending")
    if group and not single:
        keys = [item["key"] for item in group["items"]]
        pins = (group.get("publication") or {}).get("pins", [])
        settlements = group.get("settled") or []
    elif single and not group:
        keys, pins, settlements = [single["key"]], [single.get("pin")], [single.get("settled")]
    else:
        return None
    if keys != error.keys or not (len(keys) == len(pins) == len(settlements)):
        return None
    for key, pin, result in zip(keys, pins, settlements):
        if (not pin or not result or result.get("outcome") not in ("retired", "already_retired")
                or not pin.get("generation") or not pin.get("storedSha256")
                or (key["executionId"], key["sequence"], key["signature"])
                != (pin.get("executionId"), pin.get("sequence"), pin.get("signature"))):
            return None
    return argparse.Namespace(**(vars(args) | {"limit": len(keys), "retry_checkpoint_sha256": digest(saved)}))


def wait_for_read_peer(pause_file, delay):
    deadline = time.monotonic() + delay
    while not pause_file.exists():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return True
        time.sleep(min(1, remaining))
    return False


def run_invocations(args):
    passes = args.reuse_read_passes
    require(0 <= passes <= 4, "Expected zero to four bounded read-session passes")
    if not passes:
        return run(args)
    # Release role sockets and DB handles after a finite number of original-size chunks.
    # Pause markers are also checked after every durable member/page and before each new pass.
    require(args.pause_file and args.pause_file.is_absolute(), "Read reuse needs the existing controller pause path")
    args.read_sessions=ReportReadSessions()
    try:
        for _ in range(passes):
            if args.pause_file.exists():
                break
            current, delay = args, 10
            while True:
                try:
                    run(current)
                    break
                except ReadPeerStopped as error:
                    args.read_sessions.close()
                    retry = committed_read_retry(current, error)
                    if retry is None:
                        raise
                    previous = getattr(current, "retry_checkpoint_sha256", None)
                    require(not previous or previous == retry.retry_checkpoint_sha256,
                            "Committed report retry checkpoint changed")
                    print(json.dumps({"waitingForReadPeer": error.role, "settledMembers": retry.limit,
                                      "retrySeconds": delay}), flush=True)
                    if not wait_for_read_peer(args.pause_file, delay):
                        return
                    current, delay = retry, min(60, delay * 2)
            if current is not args:
                return
            if not args.apply:
                break
    finally:
        args.read_sessions.close()


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for opt in ("frozen-scope","keys","state"):
        parser.add_argument("--"+opt,required=True,type=Path)
    for opt in ("frozen-sha256","keys-sha256","runtime-revision","hub-host","hz-host","hub-sweeper","hz-sweeper","hz-api"):
        parser.add_argument("--"+opt,required=True)
    parser.add_argument("--recheck-held-through",type=int,help="Automatically revisit all historical held keys before this verified cursor")
    parser.add_argument("--recheck-held-index",type=int,help="Recheck one immutable held receipt under the original writer lock")
    parser.add_argument("--discover-after-seed",action="store_true")
    parser.add_argument("--priority-turn", type=Path, help="Optional finite signed-key range in the existing inventory")
    parser.add_argument("--priority-turn-sha256", help="Exact digest of the private priority hint")
    parser.add_argument("--scan-rows",type=int,default=512)
    parser.add_argument("--discovery-interval",type=int,default=900)
    parser.add_argument("--reuse-read-passes",type=int,default=0)
    parser.add_argument("--pause-file",type=Path)
    parser.add_argument("--width-qualification", type=Path, help="Optional measured eight-member budget for the exact ordinary four-member scope")
    parser.add_argument("--width-qualification-sha256", help="SHA-256 of that local qualification")
    parser.add_argument("--share-results",action="store_true",help="Use a verified same-execution worker dictionary for matching closed reports")
    parser.add_argument("--same-execution-pages",action="store_true",help="Pack consecutive inventory keys from one execution across sequence gaps")
    parser.add_argument("--page-members",type=int,default=1)
    parser.add_argument("--hub-account-file",type=Path,help="Confirmed workload identity for independent grouped GCS reads on the hub")
    parser.add_argument("--measure-rpc",type=Path,help="Append per-operation timing and generation metadata for a bounded measurement")
    parser.add_argument("--limit",type=int,default=1)
    parser.add_argument("--apply",action="store_true")
    try:
        run_invocations(parser.parse_args())
    except (ValueError,RuntimeError,OSError,subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
