"""One atomic, bounded archive page on the original controller and inventory cursor."""
import concurrent.futures
import hashlib
import json
import re
import time
from pathlib import Path

from closed_worker_report_order import remember_member_size


def qualified_width(args, binding, runtime, peer_hash):
    """Return optional packing limits. A missing/stale tuning receipt leaves ordinary custody available."""
    path = getattr(args, "width_qualification", None)
    expected = getattr(args, "width_qualification_sha256", None)
    if not isinstance(path, Path) or not expected or getattr(args, "page_members", 1) != 4:
        return None
    try:
        with path.open("rb") as file:
            data = file.read(65537)
        if len(data) > 65536 or hashlib.sha256(data).hexdigest() != expected:
            return None
        policy = json.loads(data)
        runtime_hash = hashlib.sha256(json.dumps(runtime, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if (policy["version"] != 1 or policy["binding"] != binding or policy["runtimeSha256"] != runtime_hash
                or policy["peerSha256"] != peer_hash or policy["ordinaryMembers"] != 4 or policy["wideMembers"] != 8
                or type(policy["maxKeysPerInvocation"]) is not int
                or not 8 <= policy["maxKeysPerInvocation"] <= 128
                or args.limit * max(1, getattr(args, "reuse_read_passes", 1)) > policy["maxKeysPerInvocation"]):
            return None
        with Path(policy["qualificationReceipt"]).open("rb") as file:
            evidence = file.read(2 * 1024**2 + 1)
        if len(evidence) > 2 * 1024**2 or hashlib.sha256(evidence).hexdigest() != policy["qualificationReceiptSha256"]:
            return None
        receipt = json.loads(evidence)
        if (receipt["qualifiedSmallEnvelope"] is not True or receipt["scopedSource"] != binding
                or receipt["comparisonGroupBytes"] < policy["maxPageBytes"]
                or not receipt["populationPerGeneration"] or set(receipt["populationPerGeneration"]) != {8}):
            return None
        limits = {k: policy[k] for k in ("maxMemberBytes", "maxPageBytes", "maxPointSources", "maxResultBytes", "maxEnvelopeBytes")}
        member, page, points = (limits[k] for k in ("maxMemberBytes", "maxPageBytes", "maxPointSources"))
        if (any(type(n) is not int for n in limits.values()) or not 0 < member <= page <= 32 * 1024**2
                or not 0 < points <= 512 or not 0 < limits["maxResultBytes"] <= member
                or not 0 < limits["maxEnvelopeBytes"] <= member):
            return None
        return limits
    except (OSError, ValueError, TypeError, KeyError):
        return None


def fits_wide_page(rows, limits, *, prefix=False):
    if len(rows) != (4 if prefix else 8):
        return False
    first = rows[0].get("resultMeta")
    if not isinstance(first, dict) or not isinstance(first.get("sha256"), str) or not re.fullmatch("[0-9a-f]{64}", first["sha256"]):
        return False
    result_bytes = first.get("byteSize")
    if type(result_bytes) is not int or not 0 < result_bytes <= limits["maxResultBytes"]:
        return False
    total = 0
    for row in rows:
        facts = row["source"]["facts"]
        size = facts["byteSize"]
        if (row.get("resultMeta") != first or type(size) is not int or not 0 < size <= limits["maxMemberBytes"]
                or not 0 <= size - result_bytes <= limits["maxEnvelopeBytes"]
                or not 0 < len(facts["points"]) <= limits["maxPointSources"]):
            return False
        total += size
    # Every extra matching member must contain the entire same PostgreSQL result.
    return total + (8 - len(rows)) * result_bytes <= limits["maxPageBytes"]


def dictionary_prefix(rows):
    """Keep indexed results out of unrelated full pages, in the original signed order."""
    if not rows:
        return rows
    first = rows[0]
    for index, row in enumerate(rows[1:], 1):
        if first.get("knownResult"):
            if row["resultMeta"] != first["resultMeta"]:
                return rows[:index]
        elif row.get("knownResult"):
            return rows[:index]
    return rows


def adjacent(stream, limit, validate, allow_gaps=False):
    start = stream.tell()
    entries = []
    try:
        for _ in range(limit):
            line = stream.readline(2049)
            if not line:
                break
            if len(line) > 2048 or not line.endswith(b"\n"):
                raise ValueError("Incomplete inventory line")
            key = json.loads(line)
            validate(key)
            if entries:
                step = key["sequence"] - entries[-1][0]["sequence"]
                if key["executionId"] != entries[0][0]["executionId"] or step <= 0 or (not allow_gaps and step != 1):
                    break
            entries.append((key, stream.tell()))
    finally:
        stream.seek(start)
    return entries


def process_page(args, stream, limit, progress, path, bind, runtime, peer_digest,
                 scope_for, ask, durable, require, width_limits=None):
    pending = progress.get("group")
    # On resume the saved exact member list owns the page, even if the preferred width or grouping changed.
    entries = adjacent(stream, len(pending["items"]) if pending else limit, scope_for,
                       allow_gaps=bool(pending) or getattr(args,"same_execution_pages",False))
    trial = width_limits if width_limits and not pending and len(entries) == 8 else None
    if width_limits and not pending and not trial:
        entries = entries[:4]
    if len(entries) < 2:
        require(not pending, "Pending page is absent from inventory")
        return 0
    scope = scope_for(entries[0][0])
    def rpc(role, op, items, **extra):
        return ask(role, dict(key=items[0]["key"],scope=scope,op=op,items=items,**extra))
    if pending:
        require([k for k,_ in entries] == [i["key"] for i in pending["items"]], "Pending page keys differ")
        items = pending["items"]
    else:
        items=[{"key":k} for k,_ in entries]
        # Most large sources are ineligible for the measured eight-member budget.
        # Authenticate the ordinary prefix first, then read the tail once if it can fit.
        prefix = items[:4] if trial else items
        originals = rpc("worker", "source", prefix)["rows"]
        if trial and fits_wide_page(originals, trial, prefix=True):
            tail = rpc("worker", "source", items[4:])["rows"]
            combined = originals + tail
            if fits_wide_page(combined, trial):
                originals = combined
        if getattr(args, "share_results", False):
            originals = dictionary_prefix(originals)
        if len(originals)<2:
            return 0
        items=[dict(key=i["key"],source=v["source"]) for i,v in zip(items,originals)]
    receipt = path.parent / "receipts" / f"{progress['completed']:08d}.page.json"
    if receipt.exists():
        saved=json.loads(receipt.read_bytes())
        require(pending and saved["binding"]==bind and saved["keys"]==[k for k,_ in entries],
                "Committed page differs from current recovery boundary")
        count=len(entries)
    else:
        hubs=rpc("hub","hub",items)
        if pending:
            require(len(hubs["rows"])==len(items),"Pending page hub eligibility changed")
        elif len(hubs["rows"])<2:
            return 0
        hubs=hubs["rows"]
        if trial and len(hubs) < 8:
            hubs = hubs[:4]
        items=items[:len(hubs)]
        entries=entries[:len(hubs)]
        count=len(items)
        if not pending:
            pending=dict(items=items,initials=originals[:count],end=entries[-1][1],publication=None,
                         shareResults=getattr(args,"share_results",False))
            if trial and count == 8:
                pending["widthQualificationSha256"] = args.width_qualification_sha256
            progress["group"]=pending
            durable(path,progress)
        require(pending["end"]==entries[-1][1],"Pending byte boundary changed")
        if not pending["publication"]:
            for attempt in range(3):
                response=rpc("worker","publish",[dict(i,hub=h) for i,h in zip(items,hubs)],
                             shareResults=pending.get("shareResults",False))
                if "retryableBrokerStatus" not in response:
                    require(len(response["pins"])==count,"Incomplete native page receipt")
                    pending["publication"]=response
                    durable(path,progress)
                    break
                if attempt==2:
                    raise RuntimeError(f"Broker returned {response['retryableBrokerStatus']}; pending page retained")
                time.sleep(5 * 2**attempt)
                fresh=rpc("hub","hub",items)
                require(len(fresh["rows"])==count,"Hub eligibility changed before retry")
                hubs=fresh["rows"]
        publication=pending["publication"]
        batch=[dict(i,pin=p) for i,p in zip(items,publication["pins"])]
        def reads(committed):
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                cloud=pool.submit(rpc,"hub","cloud",batch,hubAccount=args.hub_account_file.read_text().strip())
                native={r:pool.submit(rpc,role,"read",batch,committed=committed,reader=r)
                        for role,r in (("api","api"),("worker","sweeper"))}
                original=cloud.result()
                expected_reads = 2 if batch[0]["pin"].get("archiveFormat")=="worker-result-ref-v1" else 1
                require(original["generationDownloads"]==expected_reads and len(original["rows"])==count,"Incomplete cloud page read")
                results={r:f.result()["rows"] for r,f in native.items()}
                require(all(len(v)==count for v in results.values()),"Incomplete native page read")
                require([r["science"] for r in original["rows"]]==[r["science"] for r in hubs],"Hub scientific evidence changed")
                return {**results,"cloud":original["rows"]}
        before=reads(False)
        if not pending.get("settled"):
            transactions=[dict(i,hub=hubs[n],**{r:b[n] for r,b in before.items()}) for n,i in enumerate(batch)]
            pending["settled"]=rpc("worker","settle",transactions,shareResults=pending.get("shareResults",False))["rows"]
            require(len(pending["settled"])==count,"Incomplete HZ transaction receipt")
            durable(path,progress)
        after=reads(True)
        sizes=[r["storedFieldBytes"] for r in after["api"]]
        require(sizes==[r["storedFieldBytes"] for r in after["sweeper"]],"Committed SQL field sizes differ")
        saved=dict(binding=bind,keys=[i["key"] for i in batch],initials=pending["initials"],publication=publication,settled=pending["settled"],
                   runtimeRevision=args.runtime_revision,installed=runtime,peerSha256=peer_digest,committedStoredFieldBytes=sizes,before=before,after=after)
        if "widthQualificationSha256" in pending:
            saved["widthQualificationSha256"] = pending["widthQualificationSha256"]
        durable(receipt,saved,immutable=True)
    end=entries[-1][1]
    progress.setdefault("archived",progress["completed"]-progress.get("held",0))
    remember_member_size(progress, saved["publication"]["pins"][-1])
    progress.update(after=end,completed=progress["completed"]+count,archived=progress["archived"]+count,group=None)
    durable(path,progress)
    stream.seek(end)
    print(json.dumps(dict(receipt=str(receipt),members=count,generation=saved["publication"]["pins"][0]["generation"],
                          deltaMembers=saved["publication"]["deltaMembers"])),flush=True)
    return count
