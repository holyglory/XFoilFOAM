"""Discover and drain future closed report keys using the same scope owner as the sealed input."""
import copy
from bisect import bisect_right
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

from closed_worker_report_sessions import DiscoveryQueryCancelled

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


def outside_seed(args, candidates, directory, cursor, durable, require):
    """Exclude exact primary source keys during an interleaved scan, including holes and old holds."""
    if not candidates:
        return candidates
    path = directory / "seed-membership.json"
    expected = cursor.get("seedMembershipSha256")
    raw = path.read_bytes() if expected and path.is_file() else None
    if raw is not None and hashlib.sha256(raw).hexdigest() == expected:
        index = json.loads(raw)
    else:
        # A derived index of inclusive integer ranges, with no work or progress
        # ownership. Rebuild even if an installation lost its local copy.
        owners = {}
        digest = hashlib.sha256()
        with args.keys.open("rb") as seed:
            for line in seed:
                digest.update(line)
                key = json.loads(line)
                runs = owners.setdefault(key["executionId"], [])
                seq = key["sequence"]
                if runs and runs[-1][1] + 1 == seq:
                    runs[-1][1] = seq
                else:
                    runs.append([seq, seq])
        require(digest.hexdigest() == args.keys_sha256, "Discovery seed membership differs from the signed inventory")
        for job, runs in owners.items():
            ordered = []
            for lo, hi in sorted(runs):
                if ordered and lo <= ordered[-1][1] + 1:
                    ordered[-1][1] = max(ordered[-1][1], hi)
                else:
                    ordered.append([lo, hi])
            owners[job] = ordered
        index = {"inventory": args.keys_sha256, "owners": owners}
        durable(path, index)
        cursor["seedMembershipSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    require(index["inventory"] == args.keys_sha256, "Discovery seed index has a different owner")
    fresh = []
    for key in candidates:
        runs = index["owners"].get(key["executionId"], [])
        seq = key["sequence"]
        at = bisect_right(runs, seq, key=lambda bounds: bounds[0]) - 1
        if at < 0 or seq > runs[at][1]:
            fresh.append(key)
    return fresh


def discovery_step(args, seed_runner, shared, ask, durable, compact, require, *, before_seed_end=False):
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
        budget = cursor.get("scanBudget", {})
        width = args.scan_rows
        if (budget.get("release"), budget.get("configured")) == (args.runtime_revision, width):
            width = min(width, budget["width"])
        require(1 <= width <= args.scan_rows, "Invalid saved discovery read budget")

        def retry_scan(role):
            # These two queries only select candidate keys. Keep the scan boundary
            # and all saved receipts, and give the primary inventory its next turn.
            cursor["scanBudget"] = dict(release=args.runtime_revision, configured=args.scan_rows,
                                        width=max(1, width // 2), cancelledRole=role, sqlstate="57014")
            if width == 1:
                cursor["notBefore"] = time.time() + args.discovery_interval
            durable(path, cursor)

        try:
            result=ask("worker",dict(op="discover-worker",scope=scope,after=cursor["after"],limit=width))
        except DiscoveryQueryCancelled:
            retry_scan("worker")
            return
        scanned=result["scanned"]
        require(0<=scanned<=width and len(result["keys"])<=scanned,"Invalid bounded worker scan")
        if not scanned:
            require(not result["keys"] and result["last"] is None,"Missing discovery boundary")
            durable(directory/f"pass-{cursor['pass']:06d}.json",cursor,immutable=True)
            cursor.pop("scanBudget", None)
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
        if before_seed_end:
            candidates = outside_seed(args, candidates, directory, cursor, durable, require)
        try:
            ready=ask("hub",dict(op="discover-hub",scope=scope,keys=candidates))["keys"] if candidates else []
        except DiscoveryQueryCancelled:
            retry_scan("hub")
            return
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
    sub.priority_turn=None
    sub.keys=folder/"keys.jsonl";sub.state=folder/"state";sub.keys_sha256=page["sha256"];sub.discover_after_seed=False;sub.recheck_held_index=None;sub.recheck_held_through=None
    sub.discover_every_seed_members = 0
    if getattr(args, "discover_every_seed_members", 0):
        # The primary turn's explicit owner-range selection covers only its seed.
        sub.share_results = False
    sub.discovery_result_hint = cursor.get("lastVerifiedResult")
    seed_runner(sub)
    child_progress = sub.state / "progress.json"
    if not child_progress.exists() and getattr(args, "pause_file", None) and args.pause_file.exists():
        return True
    done=json.loads(child_progress.read_bytes())
    if done["after"]!=sub.keys.stat().st_size or done.get("pending") or done.get("group"):
        return True
    require(done["completed"]==page["count"],"Discovered page count differs")
    cursor.update(after=page["through"],page=None,scanned=cursor["scanned"]+page["scanned"],
                  archived=cursor["archived"]+done.get("archived",0),held=cursor["held"]+done.get("held",0))
    if done.get("lastVerifiedResult"):
        cursor["lastVerifiedResult"] = done["lastVerifiedResult"]
    else:
        cursor.pop("lastVerifiedResult", None)
    durable(path,cursor)
    return True

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
    sub.priority_turn=None
    sub.discover_every_seed_members = 0
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
    sub.priority_turn=None
    sub.discover_every_seed_members = 0
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
