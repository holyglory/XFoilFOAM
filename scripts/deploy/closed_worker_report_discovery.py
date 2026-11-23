"""Discover and drain future closed report keys using the same scope owner as the sealed input."""
import copy
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

ZERO = {"executionId":"00000000-0000-0000-0000-000000000000","sequence":0}


def snapshot(file, keys, compact):
    data=b"".join(compact(k)+b"\n" for k in keys)
    if file.exists():
        if file.read_bytes()!=data:
            raise ValueError("Discovered inventory differs from saved digest")
    else:
        with tempfile.NamedTemporaryFile(dir=file.parent,delete=False) as f:
            tmp=Path(f.name)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(tmp,file)
        finally:
            tmp.unlink(missing_ok=True)
        fd=os.open(file.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return hashlib.sha256(data).hexdigest()


def discovery_step(args, seed_runner, shared, ask, durable, compact, require):
    # Caller holds the original controller.lock throughout discovery and its subordinate page.
    frozen, ranges, bind, _runtime, _program = shared
    directory=args.state/"discovery"
    directory.mkdir(mode=0o700,exist_ok=True)
    path=directory/"cursor.json"
    cursor=json.loads(path.read_bytes()) if path.exists() else {
        "binding":bind,"pass":1,"after":ZERO,"scanned":0,"archived":0,"held":0,"page":None,"notBefore":0,
    }
    require(cursor["binding"]==bind,"Future discovery belongs to another source scope")
    if cursor["notBefore"]>time.time():
        return
    page=cursor["page"]
    if not page:
        scope={"sourceInstance":frozen["sourceInstance"],"solverId":frozen["solverId"],"sha256":args.frozen_sha256}
        result=ask("worker",dict(op="discover-worker",scope=scope,after=cursor["after"],limit=args.scan_rows))
        scanned=result["scanned"]
        require(0<=scanned<=args.scan_rows and len(result["keys"])<=scanned,"Invalid bounded worker scan")
        if not scanned:
            require(not result["keys"] and result["last"] is None,"Missing discovery boundary")
            durable(directory/f"pass-{cursor['pass']:06d}.json",cursor,immutable=True)
            cursor.update(after=ZERO,scanned=0,**{"pass":cursor["pass"]+1,"notBefore":time.time()+args.discovery_interval})
            durable(path,cursor)
            return
        def loc(k):
            return k["executionId"],k["sequence"]
        require(loc(result["last"])>loc(cursor["after"]),"Discovery cursor did not advance")
        candidates=[]
        last=loc(cursor["after"])
        for k in result["keys"]:
            require(last<loc(k)<=loc(result["last"]),"Overlapping discovery keys")
            last=loc(k)
            f=ranges.get(k["executionId"])
            if not f or not f.get("reportAfter",0)<k["sequence"]<=f["reportHighWater"]:
                candidates.append(k)
        ready=ask("hub",dict(op="discover-hub",scope=scope,keys=candidates))["keys"] if candidates else []
        approved={tuple((k[n] for n in ("executionId","sequence","signature"))) for k in candidates}
        require(ready==sorted(ready,key=loc) and len(set(map(loc,ready)))==len(ready)
                and all((k["executionId"],k["sequence"],k["signature"]) in approved for k in ready),"Hub selected another source")
        if not ready:
            cursor.update(after=result["last"],scanned=cursor["scanned"]+scanned)
            durable(path,cursor)
            return
        # The file name binds its immutable contents. Repeating a discovery after a crash can safely find newer eligibility.
        keyhash=hashlib.sha256(b"".join(compact(k)+b"\n" for k in ready)).hexdigest()
        folder=directory/f"pass-{cursor['pass']:06d}-{cursor['scanned']:010d}-{keyhash}"
        folder.mkdir(mode=0o700,exist_ok=True)
        require(snapshot(folder/"keys.jsonl",ready,compact)==keyhash,"Discovery inventory hashing differs")
        page={"folder":folder.name,"sha256":keyhash,"count":len(ready),"through":result["last"],"scanned":scanned}
        cursor["page"]=page
        durable(path,cursor)
    folder=directory/page["folder"]
    sub=copy.copy(args)
    sub.keys=folder/"keys.jsonl";sub.state=folder/"state";sub.keys_sha256=page["sha256"];sub.discover_after_seed=False
    seed_runner(sub)
    done=json.loads((sub.state/"progress.json").read_bytes())
    if done["after"]!=sub.keys.stat().st_size or done.get("pending") or done.get("group"):
        return
    require(done["completed"]==page["count"],"Discovered page count differs")
    cursor.update(after=page["through"],page=None,scanned=cursor["scanned"]+page["scanned"],
                  archived=cursor["archived"]+done.get("archived",0),held=cursor["held"]+done.get("held",0))
    durable(path,cursor)
