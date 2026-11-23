#!/usr/bin/env python3
"""Run the versioned closed-job storage proof on HZ through existing operator SSH and docker exec."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = "hz-solver2"
RUNTIME_BASE = "a42f6d62477de2925dd3ed6a359557df516bc137"
DEPLOY_LOCK = "/tmp/airfoils-pro-deploy.lock"
FRAME = 2 * 1024**2
FILES = {
    "host": "scripts/deploy/hz-closed-job-maintenance.py",
    "node": "scripts/deploy/hz-closed-job-node.mjs",
    "engine": "scripts/deploy/hz-closed-job-engine.py",
    "sql": "apps/sweeper/src/closed-progressive-retention.ts",
    "native": "src/airfoilfoam/closed_progressive_retention.py",
}
MEDIA_READERS = ("apps/api/src/media-store.ts", "apps/api/src/routes.ts", "apps/api/src/services/sim.ts")
HISTORICAL_NODE_READERS = ("apps/api/src/historical-worker-restore.ts", "apps/api/src/historical-raw-archive.ts",
                          "apps/api/src/media-store.ts", "packages/db/src/registered-worker-archive-owner.ts",
                          "packages/core/src/registered-archive-read.ts")
HISTORICAL_GATEWAY_MODULES = {"api.main": "src/airfoilfoam/api/main.py",
                              "historical_raw_restore": "src/airfoilfoam/historical_raw_restore.py"}
ENGINE_MODULES = ("retention", "evidence_store", "evidence_runtime", "config", "jobs", "tasks")
NODE_FILES = ("apps/sweeper/src/progressive-archive-reclaim.ts", "apps/sweeper/src/config.ts",
              "packages/core/src/remote-hub-url.ts", "packages/db/src/progressive-evidence-custody.ts",
              "packages/db/src/client.ts", "apps/sweeper/src/retention.ts", "pnpm-lock.yaml", "package.json",
              "packages/db/package.json", "packages/core/package.json", "packages/engine-client/package.json", "apps/sweeper/package.json")
SHA = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
SSH = ("ssh", "-T", "-C", "-oBatchMode=yes", "-oForwardAgent=no", "-oClearAllForwardings=yes",
       "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10", "-oServerAliveInterval=15", "-oServerAliveCountMax=3")
BOOT = """import hashlib,json,sys
data=sys.stdin.buffer.read(2097153)
if len(data)>2097152 or hashlib.sha256(data).hexdigest()!=sys.argv[1]:raise SystemExit("maintenance package mismatch")
package=json.loads(data)
scope={"__name__":"_hz_operator"}
exec(compile(package["sources"]["host"],"<versioned operator>","exec"),scope)
scope["host_main"](package)
"""
INSPECT = ('{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}|'
           '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|'
           '{{range .Mounts}}{{if eq .Destination "/data/airfoilfoam"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}')
WORKER_PROBE = """import hashlib,importlib.util,importlib.metadata,json,os,stat,sys
from pathlib import Path
from airfoilfoam.config import get_settings
req=json.load(sys.stdin)
for name,sha in req["engineHashes"].items():
 p=Path(importlib.util.find_spec("airfoilfoam."+name).origin)
 if hashlib.sha256(p.read_bytes()).hexdigest()!=sha:raise SystemExit("worker retention source mismatch: "+name)
s=get_settings()
job=s.job_dir(req["id"])
if job.resolve()!=job or job.parent!=s.data_dir/"jobs" or str(s.data_dir)!="/data/airfoilfoam":raise SystemExit("worker job root mismatch")
packages={}
for name in ("zstandard","google-crc32c","pydantic","pydantic-settings"):
 d=importlib.metadata.distribution(name);record=d.read_text("RECORD")
 if not record:raise SystemExit("installed engine wheel identity unavailable: "+name)
 packages[name]=[d.version,hashlib.sha256(record.encode()).hexdigest()]
binary=hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
out={"pythonPackages":hashlib.sha256(json.dumps([sys.version,binary,packages],sort_keys=True).encode()).hexdigest()}
for key,p,kind in [("jobsInode",job.parent,stat.S_ISDIR),("jobInode",job,stat.S_ISDIR),("lockInode",job/".execute.lock",stat.S_ISREG)]:
 try:st=p.lstat()
 except FileNotFoundError:
  print(json.dumps({"refused":"job directory or execution lock is absent"}));sys.exit(0)
 if not kind(st.st_mode):
  print(json.dumps({"refused":"worker lock path has unexpected type"}));sys.exit(0)
 out[key]=[st.st_dev,st.st_ino]
print(json.dumps(out))
"""


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def encoded(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def selection(mode, job, plan):
    require(isinstance(job, str) and UUID.fullmatch(job), "invalid stable job UUID")
    require(mode in ("proof", "verify", "reclaim") and (plan is None and mode == "proof" or
            isinstance(plan, str) and SHA.fullmatch(plan)), "reclaim requires the expected plan SHA-256")
    return {"id": job, "plan": plan, "mode": mode}


def command(argv, data=None, timeout=30):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Never emit a packet, credential, or command line in a receipt.
        raise RuntimeError(f"{argv[0]} failed ({result.returncode}): " +
                           result.stderr.decode(errors="replace").strip().split("\n")[-1][:300])
    return result.stdout


def containers(include_media=False):
    found = {}
    services = ("sweeper", "api", "worker", "node-api") if include_media else ("sweeper", "api", "worker")
    for service in services:
        row = command(["docker", "inspect", "--format", INSPECT, f"{ROOT}-{service}-1"]).decode().strip().split("|")
        require(len(row) == 9 and SHA.fullmatch(row[0]) and row[2] == "true" and row[4:9] ==
                [ROOT, service, "volume", ROOT + "_results", "false" if service == "node-api" else "true"],
                f"{service} container/volume identity differs")
        found[service] = {"id": row[0], "image": row[1], "startedAt": row[3]}
    return found


def validate_sources(package):
    hashes = {k: digest(v.encode()) for k, v in package["sources"].items()}
    require(set(hashes) == set(FILES) and hashes == package["hashes"], "helper files differ")
    require(set(package["nodeHashes"]) == set(NODE_FILES) and set(package["engineHashes"]) == set(ENGINE_MODULES),
            "incomplete runtime dependency identity")
    require(set(package["mediaReaderHashes"]) == set(MEDIA_READERS) and
            all(SHA.fullmatch(h) for h in package["mediaReaderHashes"].values()), "incomplete media reader identity")
    require(set(package["historicalNodeHashes"]) == set(HISTORICAL_NODE_READERS) and
            set(package["historicalGatewayHashes"]) == set(HISTORICAL_GATEWAY_MODULES) and
            all(SHA.fullmatch(h) for h in (*package["historicalNodeHashes"].values(),
                                           *package["historicalGatewayHashes"].values())), "incomplete historical reader identity")
    return digest(encoded({"helpers": hashes, "engine": package["engineHashes"], "node": package["nodeHashes"],
                           "mediaReaders": package["mediaReaderHashes"], "historicalNode": package["historicalNodeHashes"],
                           "historicalGateway": package["historicalGatewayHashes"]}))


def send_frame(pipe, value):
    frame = encoded(value)
    require(len(frame) <= FRAME, "oversized maintenance frame")
    pipe.write(frame + b"\n")
    pipe.flush()


def host_job(package):
    target = package["target"]
    scope = selection(target["mode"], target["id"], target["plan"])
    scope.update(helper=validate_sources(package), nonce=secrets.token_hex(32), expectedScience=target.get("science"),dependencies=target.get("dependencies"),nodePackages=target.get("nodePackages"))
    require(scope["expectedScience"] is None or SHA.fullmatch(scope["expectedScience"]), "invalid scientific source digest")
    if target.get("historicalRaw"):
        require(target["historicalRaw"] is True,"invalid historical source mode")
        scope["historicalRaw"] = True
    if target.get("keepMedia"):
        require(target["keepMedia"] is True, "invalid keep-media selection")
        scope["keepMedia"] = True
        scope["expectedMedia"] = target.get("media")
        require(scope["expectedMedia"] is None or SHA.fullmatch(scope["expectedMedia"]), "invalid media proof digest")
        require(scope["mode"] != "reclaim" or scope["expectedMedia"] is not None, "keep-media removal needs the served-media proof")
    lock_fd = os.open(DEPLOY_LOCK, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(lock_fd, "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        deploy_identity=[os.fstat(lock_fd).st_dev,os.fstat(lock_fd).st_ino]
        require(stat.S_ISREG(os.fstat(lock_fd).st_mode) and os.path.samestat(os.fstat(lock_fd), os.stat(DEPLOY_LOCK)),
                "deployment lock identity changed")
        keep_media = scope.get("keepMedia") is True
        historical = scope.get("historicalRaw") is True
        if historical and scope["mode"] == "reclaim":
            # The gateway may be returning to its previous image until its reader
            # proof and exact control-plane restoration have both completed.
            state = Path("/opt/airfoils-pro/state/.env.deploy")
            flags = {key: value.strip().strip("\"'") for line in state.read_text().splitlines()
                     if "=" in line for key, value in [line.split("=", 1)]
                     if key in {"REMOTE_SOLVER2606_DRAIN_KIND", "REMOTE_SOLVER2606_DRAIN_PENDING"}}
            require(flags.get("REMOTE_SOLVER2606_DRAIN_KIND") != "historical-raw-gateway" or
                    flags.get("REMOTE_SOLVER2606_DRAIN_PENDING") != "1", "file gateway cutover or recovery is pending")
        include_node = keep_media or historical
        topology = containers(include_node)
        if historical:
            rows = command(["docker", "exec", "-w", "/app", topology["node-api"]["id"],
                            "sha256sum", *HISTORICAL_NODE_READERS]).decode().splitlines()
            actual = {name: sha for sha, name in (row.split(None, 1) for row in rows)}
            require(actual == package["historicalNodeHashes"], "installed closed-owner Node reader differs")
        if keep_media:
            rows = command(["docker", "exec", "-w", "/app", topology["node-api"]["id"], "sha256sum", *MEDIA_READERS]).decode().splitlines()
            actual = {name: sha for sha, name in (row.split(None, 1) for row in rows)}
            require(actual == package["mediaReaderHashes"], "installed media read or public point module differs")
        images={s:v["image"] for s,v in topology.items()}
        if target.get("images") and target["images"]!=images:
            return {"status":"runtime-changed","observedImages":images,"job":scope["id"]}
        pinned = {s: v["id"] for s, v in topology.items()}
        observed = json.loads(command(["docker", "exec", "-i", pinned["worker"], "python", "-IB", "-c", WORKER_PROBE],
                                      encoded({"id": scope["id"], "engineHashes": package["engineHashes"]})))
        if "refused" in observed:
            return {"status": "refused", "job": scope["id"], "reason": observed["refused"]}
        gateway_hashes = dict(package["engineHashes"])
        if historical:
            gateway_hashes.update(package["historicalGatewayHashes"])
        api_observed=json.loads(command(["docker","exec","-i",pinned["api"],"python","-IB","-c",WORKER_PROBE],
                                 encoded({"id":scope["id"],"engineHashes":gateway_hashes})))
        if "refused" in api_observed:
            return {"status":"refused","job":scope["id"],"reason":api_observed["refused"]}
        require(all(observed[k]==api_observed[k] for k in ("jobsInode","jobInode","lockInode")),"worker and gateway execution paths differ")
        native_packages={"worker":observed.pop("pythonPackages"),"gateway":api_observed["pythonPackages"]}
        require(not target.get("nativePackages") or target["nativePackages"]==native_packages,"installed Python dependency fingerprint changed")
        scope.update(observed)
        if "proof" in target:
            earlier=target["proof"]
            require(earlier["helper"]==scope["helper"] and earlier["containers"]==topology and earlier["deployLockInode"]==deploy_identity and
                    all(earlier[k]==scope[k] for k in ("lockInode","jobInode","jobsInode")),
                    "runtime or lock changed since the pinned proof; re-prove this job")
        marker = json.loads(Path("/opt/airfoils-pro/app/.deployment-source.json").read_bytes())
        require(re.fullmatch("[0-9a-f]{40}", marker["sourceRevision"]), "invalid deployed revision")
        node_argv = ["docker", "exec", "-i", "-w", "/app", "-e", "TSX_DISABLE_CACHE=1", "-e", "NODE_DISABLE_COMPILE_CACHE=1",
                     pinned["sweeper"], "node", "--import", "tsx", "--input-type=module", "-e", package["sources"]["node"]]
        # stdout contains signed engine frames. Only the final safe receipt is returned over SSH.
        with subprocess.Popen(node_argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
            try:
                send_frame(proc.stdin, {"scope": scope, "nodeHashes": package["nodeHashes"], "sql": package["sources"]["sql"],
                                        "sqlSha": package["hashes"]["sql"]})
                count = 0
                while True:
                    line = proc.stdout.readline(FRAME + 1)
                    require(line.endswith(b"\n") and len(line) <= FRAME, "lost or oversized maintenance peer frame")
                    msg = json.loads(line)
                    if msg["type"] in ("result", "refusal","fault"):
                        break
                    count += 1
                    require(msg["type"] == "engine" and msg["step"] == count and
                            (count == 1 or count == 2 and scope["mode"] == "reclaim"), "unexpected native call")
                    require(containers(include_node) == topology, "runtime changed during maintenance")
                    boot = {"scope": scope, "packet": msg["packet"], "native": package["sources"]["native"],
                            "nativeSha": package["hashes"]["native"], "engineHashes": package["engineHashes"]}
                    answer = command(["docker", "exec", "-i", pinned["api"], "python", "-IB", "-c", package["sources"]["engine"]],
                                     encoded(boot), timeout=15*60+30)
                    require(len(answer) <= FRAME, "oversized engine response")
                    send_frame(proc.stdin, json.loads(answer))
                proc.stdin.close()
                code = proc.wait(timeout=30)
                if msg["type"] == "fault":
                    raise RuntimeError(str(msg["reason"])[:400])
                if msg["type"] == "refusal":
                    return {"status": "refused", "reason": str(msg["reason"])[:400], "job": scope["id"]}
                receipt = msg["value"]
                if scope["mode"] in ("proof","verify"):
                    require(count == 1 and receipt["status"] == ("proved" if scope["mode"]=="proof" else "verified") and receipt["databaseReadOnly"] is True and
                            receipt["settled"] is False, "proof peer returned an invalid receipt")
                elif receipt["status"] == "already-settled":
                    require(count == 0 and receipt["record"]["planSha256"] == scope["plan"], "settled receipt changed")
                else:
                    require(receipt["status"] == "settled" and receipt["settled"] is True and
                            receipt["plan"]["plan"] == scope["plan"] and count == (2 if receipt["plan"]["files"] else 1),
                            "apply peer returned an invalid receipt")
                require(code == 0 and containers(include_node) == topology, "runtime changed or receipt lost; repeat the same pinned plan")
            finally:
                if proc.poll() is None:
                    proc.stdin.close()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.terminate()
        return {"job": scope["id"], "helperRevision": package["revision"], "helperSha256": scope["helper"],
                "deployedRevision": marker["sourceRevision"], "deployLockInode":deploy_identity,"nativePackages":native_packages, "containers": topology, "jobsInode": scope["jobsInode"],
                "jobInode": scope["jobInode"], "lockInode": scope["lockInode"], **msg["value"]}


def host_main(package):
    try:
        signal.alarm(55*60)
        print(json.dumps(host_job(package)), flush=True)
    except Exception as exc:
        print("Closed job maintenance refused: " + str(exc)[:400], file=sys.stderr)
        raise SystemExit(1)
    finally:
        signal.alarm(0)


def source_package(repo):
    def git(*args):
        return command(["git", "-C", str(repo), *args])
    revision = git("rev-parse", "HEAD").decode().strip()
    def source(ref, path):
        return git("show", ref + ":" + path)
    sources = {k: source(revision, path).decode() for k, path in FILES.items()}
    require(Path(__file__).read_bytes() == sources["host"].encode(), "run the operator from its committed checkout")
    return {"revision": revision, "sources": sources, "hashes": {k: digest(v.encode()) for k,v in sources.items()},
            "mediaReaderHashes": {p: digest(source(revision, p)) for p in MEDIA_READERS},
            "historicalNodeHashes": {p: digest(source(revision, p)) for p in HISTORICAL_NODE_READERS},
            "historicalGatewayHashes": {n: digest(source(revision, p)) for n,p in HISTORICAL_GATEWAY_MODULES.items()},
            "nodeHashes": {p: sorted({digest(source(ref, p)) for ref in (RUNTIME_BASE, revision)}) for p in NODE_FILES},
            "engineHashes": {n: digest(source(RUNTIME_BASE, f"src/airfoilfoam/{n}.py")) for n in ENGINE_MODULES}}


def run_remote(package, target):
    data = encoded({**package, "target": target})
    remote = shlex.join(["python3", "-IB", "-c", BOOT, digest(data)])
    return json.loads(command([*SSH, ROOT, remote], data, timeout=56*60))


def atomic_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".receipt-", delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(encoded(value) + b"\n")
            f.flush()
            os.fsync(f.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            tmp.unlink(missing_ok=True)


def read_json(path):
    return json.loads(path.read_bytes())


def confirm_reclaim(package, target, effect, qualified=None):
    prior = effect.get("record", {})
    science = effect.get("scientificSha256") or prior.get("scientificSha256")
    require(isinstance(science, str) and SHA.fullmatch(science), "completed job lacks its pre-removal scientific signature")
    check = {**selection("verify", target["id"], target["plan"]), "science": science}
    if target.get("historicalRaw"):
        require(effect.get("historicalRaw") is True, "result belongs to another custody mode")
        check["historicalRaw"] = True
    kept = effect.get("mediaSha256") or prior.get("mediaSha256")
    if target.get("keepMedia"):
        require(isinstance(kept, str) and SHA.fullmatch(kept), "completed keep-set lacks a served-media signature")
        check.update(keepMedia=True, media=kept)
    after = qualified(check) if qualified is not None else run_remote(package, {**check,
        "dependencies":effect.get("dependenciesSha256"), "nodePackages":effect.get("nodePackagesSha256"),
        "nativePackages":effect.get("nativePackages")})
    require(after["status"]=="verified" and after["databaseReadOnly"] is True and after["plan"].get("replayed") is True and
            after["scientificSha256"]==science and after["readbacks"] and after["points"],
            "post-operation point, native receipt or GCS verification refused: "+str(after.get("reason","missing proof"))[:300])
    if target.get("keepMedia"):
        require(after.get("mediaSha256")==kept, "media bytes, served links or legend changed after removal")
    if effect["status"]=="settled":
        identity = lambda rows: sorted((r.get("brokeredUploadId",""),r.get("historicalPointSignature",""),r["generation"],r["storedSha256"],r["storedByteSize"],
                                        json.dumps(r.get("verifiedMember"),sort_keys=True)) for r in rows)
        require(effect["points"]==after["points"] and identity(effect["readbacks"])==identity(after["readbacks"]),
                "scientific evidence or archived original changed after removal")
    return after


def totals_add(status, receipt):
    status["examined"]+=1
    if receipt["outcome"]=="deferred":
        status["deferred"]+=1
        return
    status["verified"]+=1
    after=receipt["after"]
    status["logicalBytes"]+=after["plan"]["bytes"]
    status["files"]+=after["plan"]["files"]
    allocation=receipt["effect"].get("allocation") or receipt["effect"].get("record",{}).get("allocation")
    if allocation is None:
        status["unmeasuredJobs"]+=1
    else:
        status["fileAllocatedBytes"]+=allocation["fileAllocatedBytes"]
        status["netAttributedAllocatedBytes"]+=allocation["netAttributedAllocatedBytes"]


def run_inventory(package, inventory, expected_sha, state, apply, runtime_proof):
    require(apply and state.is_absolute(), "inventory reclaim requires --apply and an absolute private state directory")
    data=inventory.read_bytes()
    require(digest(data)==expected_sha, "private inventory digest differs")
    targets=[selection("reclaim",row["id"],row["plan"]) for row in map(json.loads,data.splitlines())]
    require(targets and len({r["id"] for r in targets})==len(targets),"empty or duplicate inventory")
    state.mkdir(parents=True,exist_ok=True,mode=0o700)
    require(not state.is_symlink() and state.stat().st_uid==os.getuid() and state.stat().st_mode & 0o077==0,
            "controller state directory must be private to the operator")
    contract={"helperRevision":package["revision"],"helperSha256":validate_sources(package),
              "inventorySha256":expected_sha,"total":len(targets),"host":ROOT}
    canary=runtime_proof
    require(canary.get("status")=="verified" and canary.get("databaseReadOnly") is True and
            canary.get("helperSha256")==contract["helperSha256"] and canary["plan"].get("replayed") is True and
            canary.get("readbacks") and SHA.fullmatch(canary.get("nodePackagesSha256","")) and
            all(SHA.fullmatch(canary.get("nativePackages",{}).get(s,"")) for s in ("worker","gateway")) and
            SHA.fullmatch(canary.get("dependenciesSha256","")) and SHA.fullmatch(canary.get("scientificSha256","")),
            "runtime pin requires a read-only post-canary receipt from this exact helper")
    contract["dependenciesSha256"]=canary["dependenciesSha256"]
    contract["nodePackages"]=canary["nodePackagesSha256"]
    contract["nativePackages"]=canary["nativePackages"]
    contract["runtimeCanary"]={"id":canary["job"],"plan":canary["plan"]["plan"],"science":canary["scientificSha256"]}
    contract["initialImages"]={s:v["image"] for s,v in canary["containers"].items()}
    with (state/"operator.lock").open("a+b") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        manifest=state/"manifest.json"
        if manifest.exists():
            require(read_json(manifest)==contract,"resume requires the same pinned helper and inventory")
        else:
            atomic_json(manifest,contract)
        runtime_file=state/"runtime.json"
        runtime=read_json(runtime_file) if runtime_file.exists() else {"images":contract["initialImages"],"dependencies":contract["dependenciesSha256"]}
        def qualified(target):
            nonlocal runtime
            packages={"nodePackages":contract["nodePackages"],"nativePackages":contract["nativePackages"]}
            pin={"images":runtime["images"],"dependencies":runtime["dependencies"],**packages}
            effect=run_remote(package,{**target,**pin})
            if effect["status"]=="runtime-changed":
                # The host returned before opening the job. Requalify an already settled canary
                # read-only, using the original dependency and scientific fingerprints.
                anchor=contract["runtimeCanary"]
                fresh=run_remote(package,{**selection("verify",anchor["id"],anchor["plan"]),
                    "science":anchor["science"],**packages})
                require(fresh["status"]=="verified" and fresh["scientificSha256"]==anchor["science"] and
                        fresh["nodePackagesSha256"]==contract["nodePackages"] and fresh["nativePackages"]==contract["nativePackages"] and
                        fresh["plan"].get("replayed") is True,
                        "changed runtime did not reproduce the qualified scientific and storage proof")
                runtime={"images":{s:v["image"] for s,v in fresh["containers"].items()},"dependencies":fresh["dependenciesSha256"],"revalidation":fresh}
                atomic_json(runtime_file,runtime)
                effect=run_remote(package,{**target,"dependencies":runtime["dependencies"],"images":runtime["images"],**packages})
            require(effect["status"]!="runtime-changed","runtime changed again during requalification")
            return effect
        status={**contract,"examined":0,"verified":0,"deferred":0,"logicalBytes":0,"files":0,
                "fileAllocatedBytes":0,"netAttributedAllocatedBytes":0,"unmeasuredJobs":0}
        def publish(phase, **extra):
            atomic_json(state/"status.json",{**status,**extra,"phase":phase,"updatedAt":datetime.now(timezone.utc).isoformat()})
        for index,target in enumerate(targets):
            key=f"{index:05d}-{target['id']}.json"
            done=state/"receipts"/key
            pending=state/"pending"/key
            if done.exists():
                saved=read_json(done)
                require(saved["target"]==target and saved["index"]==index,"private receipt no longer matches inventory")
                totals_add(status,saved)
                continue
            publish("checking",index=index,job=target["id"])
            try:
                if pending.exists():
                    entry=read_json(pending)
                    require(entry["target"]==target and entry["index"]==index,"pending job identity changed")
                else:
                    entry={"index":index,"target":target,"startedAt":datetime.now(timezone.utc).isoformat()}
                    atomic_json(pending,entry)
                if "effect" not in entry:
                    entry["effect"]=qualified(target)
                    atomic_json(pending,entry)
                effect=entry["effect"]
                if effect["status"]=="refused":
                    entry["outcome"]="deferred"
                else:
                    require(effect["status"] in ("settled","already-settled"),"unrecognized storage outcome")
                    publish("verifying",index=index,job=target["id"])
                    entry["after"]=confirm_reclaim(package,target,effect,qualified)
                    entry["outcome"]="verified"
                entry["finishedAt"]=datetime.now(timezone.utc).isoformat()
                atomic_json(done,entry)
                pending.unlink(missing_ok=True)
                totals_add(status,entry)
                publish("running",nextOffset=index+1)
                print(json.dumps({"index":index,"outcome":entry["outcome"],"netAllocated":status["netAttributedAllocatedBytes"]}),flush=True)
            except Exception as exc:
                publish("attention",index=index,job=target["id"],reason=str(exc)[:450])
                raise
        publish("complete",nextOffset=len(targets))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    for name in ("proof", "verify", "reclaim"):
        sub = modes.add_parser(name)
        sub.add_argument("job")
        sub.add_argument("--historical-raw",action="store_true",help="verify historical physical custody and retire only the exact original bundle and its authenticated unpacked raw members")
        sub.add_argument("--keep-media", action="store_true", help="retain all proven instantaneous PNGs and verify stable, legacy and engine reads")
        sub.add_argument("plan", nargs="?" if name == "proof" else None)
        if name=="reclaim":
            sub.add_argument("--proof-receipt", type=Path, help="pin an earlier current read-only canary proof")
    batch = modes.add_parser("batch")
    batch.add_argument("inventory", type=Path)
    batch.add_argument("--sha256", help="expected SHA-256 of the candidate JSONL")
    batch.add_argument("--offset", type=int, default=0)
    batch.add_argument("--limit", type=int, default=1, choices=range(1,9))
    batch.add_argument("--apply", action="store_true", help="apply only the plans pinned in the selected rows")
    full=modes.add_parser("run-inventory",help="resume one serial proof, reclaim and verification run")
    full.add_argument("inventory",type=Path)
    full.add_argument("--sha256",required=True)
    full.add_argument("--state",type=Path,required=True)
    full.add_argument("--runtime-proof",type=Path,required=True,help="private completed-canary verification receipt")
    full.add_argument("--apply",action="store_true")
    args = parser.parse_args()
    package = source_package(Path(__file__).resolve().parents[2])
    if args.mode=="run-inventory":
        return run_inventory(package,args.inventory,args.sha256,args.state,args.apply,read_json(args.runtime_proof))
    offset = 0
    if args.mode == "batch":
        data = args.inventory.read_bytes()
        require(args.offset >= 0 and (not args.sha256 or digest(data) == args.sha256), "inventory offset or digest differs")
        rows = data.splitlines()
        require(args.offset <= len(rows), "offset is past the inventory")
        offset = args.offset
        items = [selection("reclaim" if args.apply else "proof", r["id"], r["plan"])
                 for r in map(json.loads, rows[offset:offset + args.limit])]
    else:
        item=selection(args.mode, args.job, args.plan)
        if args.historical_raw:
            item["historicalRaw"] = True
            require(args.mode != "reclaim" or args.proof_receipt is not None, "historical raw removal needs the live original-file restore proof")
        if args.keep_media:
            item["keepMedia"] = True
            require(args.mode != "reclaim" or args.proof_receipt is not None,
                    "use the prior served-media proof receipt for a keep-media removal")
        if getattr(args, "proof_receipt", None):
            proof=json.loads(args.proof_receipt.read_bytes())
            require(proof["status"]=="proved" and proof["databaseReadOnly"] is True and proof["settled"] is False and
                    proof["job"]==args.job and proof["plan"]["plan"]==args.plan and proof["plan"]["bytes"]>0 and
                    proof["readbacks"] and SHA.fullmatch(proof["scientificSha256"]), "invalid pinned pre-removal proof")
            require(bool(proof.get("historicalRaw")) == args.historical_raw, "proof belongs to another custody mode")
            require(bool(proof.get("mediaSha256")) == bool(args.keep_media), "proof belongs to another retention mode")
            if args.keep_media:
                require(SHA.fullmatch(proof["mediaSha256"]), "invalid keep-media proof")
                item["media"] = proof["mediaSha256"]
            item["science"]=proof["scientificSha256"]
            item["proof"]={"helper":proof["helperSha256"], "containers":proof["containers"],
                           **{key:proof[key] for key in ("lockInode","jobInode","jobsInode","deployLockInode")}}
        items=[item]
    refused = False
    for n, target in enumerate(items, offset):
        result = run_remote(package, target)
        if target["mode"]=="reclaim" and result["status"] in ("settled","already-settled"):
            result["after"]=confirm_reclaim(package,target,result)
        refused |= result["status"] == "refused"
        print(json.dumps({"checkedAt": datetime.now(timezone.utc).isoformat(), "offset": n, "nextOffset": n + 1,
                          **result}, separators=(",", ":")), flush=True)
    return int(refused)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Closed job maintenance stopped: {exc}", file=sys.stderr)
        raise SystemExit(2)
