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
    sub.keys=folder/"keys.jsonl";sub.state=folder/"state";sub.keys_sha256=page["sha256"];sub.discover_after_seed=False;sub.recheck_held_index=None;sub.recheck_held_through=None
    seed_runner(sub)
    done=json.loads((sub.state/"progress.json").read_bytes())
    if done["after"]!=sub.keys.stat().st_size or done.get("pending") or done.get("group"):
        return
    require(done["completed"]==page["count"],"Discovered page count differs")
    cursor.update(after=page["through"],page=None,scanned=cursor["scanned"]+page["scanned"],
                  archived=cursor["archived"]+done.get("archived",0),held=cursor["held"]+done.get("held",0))
    durable(path,cursor)

def revisit_held(args, index, bind, run, durable, compact, require):
    # Revisit an old scientific hold under the original writer lock. Its first receipt stays immutable.
    prior_file=args.state/"receipts"/f"{index:08d}.json"
    prior=json.loads(prior_file.read_bytes())
    require(prior["binding"]==bind and prior["settled"]["outcome"]=="held","Recheck requires an exact held receipt")
    prior_sha=hashlib.sha256(prior_file.read_bytes()).hexdigest()
    directory=args.state/"rechecks"/prior_sha
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    resolution=directory/"resolution.json"
    if resolution.exists():
        saved=json.loads(resolution.read_bytes())
        file=Path(saved["receipt"])
        require(file.is_relative_to(args.state/"rechecks") and saved["priorSha256"]==prior_sha and saved["key"]==prior["key"] and saved["receiptSha256"]==hashlib.sha256(file.read_bytes()).hexdigest(),
                "Recheck receipt identity changed")
        return False
    sub=copy.copy(args);sub.keys=directory/"keys.jsonl";sub.state=directory/"state"
    sub.keys_sha256=snapshot(sub.keys,[prior["key"]],compact)
    sub.recheck_held_index=None;sub.recheck_held_through=None;sub.discover_after_seed=False;sub.limit=1
    run(sub)
    file=sub.state/"receipts/00000000.json"
    new=json.loads(file.read_bytes())
    require(new["key"]==prior["key"] and new["settled"]["outcome"] in ("held","retired","already_retired"),"Missing verified recheck")
    durable(resolution,dict(priorSha256=prior_sha,key=new["key"],outcome=new["settled"]["outcome"],receipt=str(file),
                            receiptSha256=hashlib.sha256(file.read_bytes()).hexdigest()),immutable=True)
    return True

def revisit_prefix(args, through, progress, bind, run, durable, compact, require):
    """Reconcile all holds from a previous custody rule, retaining its immutable signed receipts."""
    require(0 < through <= progress["completed"],"Recheck boundary must have been visited")
    folder=args.state/"rechecks"/f"through-{through:09d}"
    folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=folder/"cursor.json"
    cursor=json.loads(path.read_bytes()) if path.exists() else dict(binding=bind,through=through,after=0,page=None,archived=0,held=0,alreadyResolved=0)
    require(cursor["binding"]==bind and cursor["through"]==through,"Recheck cursor scope changed")
    if cursor["after"]>=through:
        return False
    page=cursor["page"]
    if page is None:
        after=cursor["after"]; keys=[]; prior=[]; already=0
        for _ in range(128):
            if after>=through:break
            scalar=args.state/"receipts"/f"{after:08d}.json"
            if not scalar.exists():
                group=args.state/"receipts"/f"{after:08d}.page.json"
                saved=json.loads(group.read_bytes())
                require(saved["binding"]==bind and len(saved["keys"])==len(saved["settled"])>0 and
                        all(v["outcome"] in ("retired","already_retired") for v in saved["settled"]),"Unverified historical page")
                after+=len(saved["keys"])
                continue
            data=scalar.read_bytes();saved=json.loads(data)
            require(saved["binding"]==bind,"Historical receipt has another owner")
            if saved["settled"]["outcome"]=="held":
                sha=hashlib.sha256(data).hexdigest();resolution=args.state/"rechecks"/sha/"resolution.json"
                previous=json.loads(resolution.read_bytes()) if resolution.exists() else None
                if previous and previous["outcome"] in ("retired","already_retired"):
                    require(previous["priorSha256"]==sha and previous["key"]==saved["key"] and
                            hashlib.sha256(Path(previous["receipt"]).read_bytes()).hexdigest()==previous["receiptSha256"],"Resolved hold receipt differs")
                    already+=1
                else:
                    keys.append(saved["key"]);prior.append(sha)
            after+=1
        cursor["alreadyResolved"]+=already
        if not keys:
            cursor["after"]=after
            durable(path,cursor)
            return cursor["after"]<through
        segment=folder/f"from-{cursor['after']:09d}";segment.mkdir(mode=0o700,exist_ok=True)
        digest=snapshot(segment/"keys.jsonl",keys,compact)
        page=dict(folder=segment.name,sha256=digest,end=after,prior=prior)
        cursor["page"]=page
        durable(path,cursor)
    segment=folder/page["folder"]
    sub=copy.copy(args);sub.keys=segment/"keys.jsonl";sub.state=segment/"state";sub.keys_sha256=page["sha256"]
    sub.recheck_held_index=None;sub.recheck_held_through=None;sub.discover_after_seed=False
    run(sub)
    subprogress=json.loads((sub.state/"progress.json").read_bytes())
    if subprogress["after"]!=sub.keys.stat().st_size or subprogress.get("pending") or subprogress.get("group"):return True
    keys=[json.loads(l) for l in sub.keys.read_bytes().splitlines()]
    require(subprogress["completed"]==len(keys)==len(page["prior"]),"Incomplete held cohort")
    pos=0
    while pos<len(keys):
        file=sub.state/"receipts"/f"{pos:08d}.json"
        if file.exists():
            receipt=json.loads(file.read_bytes());members=[(receipt["key"],receipt["settled"])]
        else:
            file=sub.state/"receipts"/f"{pos:08d}.page.json";receipt=json.loads(file.read_bytes())
            require(len(receipt["keys"])==len(receipt["settled"])>0,"Incomplete grouped hold proof")
            members=list(zip(receipt["keys"],receipt["settled"]))
        digest=hashlib.sha256(file.read_bytes()).hexdigest()
        for key,status in members:
            require(key==keys[pos] and status["outcome"] in ("retired","already_retired","held"),"Recheck key changed")
            sha=page["prior"][pos];resolved=args.state/"rechecks"/sha;resolved.mkdir(mode=0o700,exist_ok=True)
            if status["outcome"]!="held":
                result=dict(priorSha256=sha,key=key,outcome=status["outcome"],receipt=str(file),receiptSha256=digest)
                # Older inconclusive rechecks remain documented in their original signed cohort.
                existing=resolved/"resolution.json"
                if existing.exists() and json.loads(existing.read_bytes())["outcome"]=="held":
                    durable(resolved/"prior-held.json",json.loads(existing.read_bytes()),immutable=True)
                durable(existing,result)
            pos+=1
    cursor.update(after=page["end"],page=None,archived=cursor["archived"]+subprogress.get("archived",0),held=cursor["held"]+subprogress.get("held",0))
    durable(path,cursor)
    return True
