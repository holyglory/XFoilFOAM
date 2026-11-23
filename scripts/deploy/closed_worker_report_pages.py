"""One atomic, bounded archive page on the original controller and inventory cursor."""
import concurrent.futures
import json
import time


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
                 scope_for, ask, durable, require):
    pending = progress.get("group")
    # On resume the saved exact member list owns the page, even if the preferred width or grouping changed.
    entries = adjacent(stream, len(pending["items"]) if pending else limit, scope_for,
                       allow_gaps=bool(pending) or getattr(args,"same_execution_pages",False))
    if len(entries) < 2:
        require(not pending, "Pending page is absent from inventory")
        return 0
    scope = scope_for(entries[0][0])
    def rpc(role, op, items, **extra):
        return ask(role, dict(key=entries[0][0],scope=scope,op=op,items=items,**extra))
    if pending:
        require([k for k,_ in entries] == [i["key"] for i in pending["items"]], "Pending page keys differ")
        items = pending["items"]
    else:
        items=[{"key":k} for k,_ in entries]
        originals=rpc("worker","source",items)["rows"]
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
        items=items[:len(hubs)]
        entries=entries[:len(hubs)]
        count=len(items)
        if not pending:
            pending=dict(items=items,initials=originals[:count],end=entries[-1][1],publication=None)
            progress["group"]=pending
            durable(path,progress)
        require(pending["end"]==entries[-1][1],"Pending byte boundary changed")
        if not pending["publication"]:
            for attempt in range(3):
                response=rpc("worker","publish",[dict(i,hub=h) for i,h in zip(items,hubs)])
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
                require(original["generationDownloads"]==1 and len(original["rows"])==count,"Incomplete cloud page read")
                results={r:f.result()["rows"] for r,f in native.items()}
                require(all(len(v)==count for v in results.values()),"Incomplete native page read")
                require([r["science"] for r in original["rows"]]==[r["science"] for r in hubs],"Hub scientific evidence changed")
                return {**results,"cloud":original["rows"]}
        before=reads(False)
        if not pending.get("settled"):
            transactions=[dict(i,hub=hubs[n],**{r:b[n] for r,b in before.items()}) for n,i in enumerate(batch)]
            pending["settled"]=rpc("worker","settle",transactions)["rows"]
            require(len(pending["settled"])==count,"Incomplete HZ transaction receipt")
            durable(path,progress)
        after=reads(True)
        sizes=[r["storedFieldBytes"] for r in after["api"]]
        require(sizes==[r["storedFieldBytes"] for r in after["sweeper"]],"Committed SQL field sizes differ")
        saved=dict(binding=bind,keys=[i["key"] for i in batch],initials=pending["initials"],publication=publication,settled=pending["settled"],
                   runtimeRevision=args.runtime_revision,installed=runtime,peerSha256=peer_digest,committedStoredFieldBytes=sizes,before=before,after=after)
        durable(receipt,saved,immutable=True)
    end=entries[-1][1]
    progress.setdefault("archived",progress["completed"]-progress.get("held",0))
    progress.update(after=end,completed=progress["completed"]+count,archived=progress["archived"]+count,group=None)
    durable(path,progress)
    stream.seek(end)
    print(json.dumps(dict(receipt=str(receipt),members=count,generation=saved["publication"]["pins"][0]["generation"],
                          deltaMembers=saved["publication"]["deltaMembers"])),flush=True)
    return count
