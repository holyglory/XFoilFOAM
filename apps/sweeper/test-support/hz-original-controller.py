"""Exercise the real SQLite cursor and receipts across a lost registration reply."""
from pathlib import Path
from tempfile import TemporaryDirectory
from importlib.util import module_from_spec, spec_from_file_location
from contextlib import redirect_stdout
import io
import json
import sqlite3
import uuid

script=Path(__file__).resolve().parents[3]/"scripts/deploy/hz-attempt-originals.py"
spec=spec_from_file_location("hz_originals",script);operator=module_from_spec(spec);spec.loader.exec_module(operator)
with TemporaryDirectory() as tmp:
    root=Path(tmp)
    ids=sorted(str(uuid.uuid4()) for _ in range(4))
    solver,instance=str(uuid.uuid4()),str(uuid.uuid4())
    mapping={"hubInstance":str(uuid.uuid4()),"hubAttempt":ids[1],"hubResult":str(uuid.uuid4())}
    signatures=[format(i+1,"064x") for i in range(4)]
    entries=[dict(id=id_,result=str(uuid.uuid4()),job=None,sha=signatures[i],bytes=10000,history=[9000,7000,2000,3000][i],
                  stored=1200,owned=True,settled=i!=3,archive=None,ack=None,match=mapping if i in (1,2) else None) for i,id_ in enumerate(ids)]
    src=root/"frozen.jsonl"
    src.write_text("".join(json.dumps(dict(attemptId=r["id"],sourceSha256=r["sha"],sourceByteSize=r["bytes"]))+"\n" for r in entries))
    acct=root/"account";acct.write_text("expected-account")
    objects={};sql={};sent=[];failed=set()
    version_ops=[]
    fences=[]
    class Endpoints:
        def __init__(self,_):pass
        def close(self):pass
        def send(self,operation,**params):
            if fences and operation==fences[0]:
                fences.pop(0);raise operator.RelayError("transfer_paused",True)
            if operation=="bound":return dict(high=max(ids),instance=instance,solver=solver)
            if operation in ("version_put","version_read"):
                version_ops.append(operation)
                pin=params["pin"]
                identity=dict(sourceInstance=instance,attemptId=pin["id"],resultId=pin["result"],simJobId=pin["job"],
                              sourceSha256=pin["sha"],sourceByteSize=pin["bytes"],storedByteSize=750,generation="9007199254749999")
                if operation=="version_read":
                    assert params["identity"]==identity
                    return dict(identity=identity,current=True)
                return dict(identity=identity)
            if operation=="inventory":
                return [x for x in entries if x["id"] in params["selection"]["ids"]]
            if operation=="upload":
                uploads=[];deferred=[]
                for pin in params["pins"]:
                    i=ids.index(pin["id"])
                    if not entries[i]["settled"]:deferred.append(pin["id"]);continue
                    sent.append(pin["id"])
                    obj=objects.setdefault(pin["id"],dict(generation=str(9007199254741000+i),sha=pin["sha"]))
                    uploads.append(dict(pin=pin,identity=obj))
                return dict(uploads=uploads,deferred=deferred)
            if operation=="register":
                out=[]
                for x in params["uploads"]:
                    k=x["pin"]["id"];created=k not in sql
                    ar=sql.setdefault(k,str(uuid.uuid4()))
                    if not failed:
                        failed.add(k);raise operator.RelayError("transport",True)
                    out.append(dict(id=k,archive=ar,generation=objects[k]["generation"],packedBytes=710,created=created))
                return out
            raise AssertionError(operation)
    def run(*args):
        out=io.StringIO()
        with redirect_stdout(out):operator.main([args[0],"--directory",str(root/"job"),*args[1:]],Endpoints)
        return json.loads(out.getvalue())
    scope=["--scope",str(src),"--limit","1"]
    apply=["--apply","--bucket","fixture","--hub-account-file",str(acct)]
    r=run("inventory",*scope,"--pages","2");assert not r["inventory"]["complete"] and r["inventory"]["scanned"]==2
    r=run("inventory",*scope,"--until-complete");assert r["inventory"]["complete"] and r["inventory"]["scanned"]==4
    try:run("backup",*scope,*apply)
    except operator.RelayError:pass
    else:raise AssertionError("wanted lost confirmation")
    r=run("status");assert any(x["state"]=="uploaded" and x["attempts"]==1 for x in r["rows"])
    fences.extend(["bound","register"])
    run("backup",*scope,*apply,"--until-complete")
    assert not fences
    assert sent==[ids[1],ids[2],ids[0]] and len(sql)==3
    # A version-only receipt cannot move the deferred source into registered custody.
    run("versions",*scope,*apply,"--pages","1")
    assert run("status")["versionOnly"][0]["state"]=="uploaded" and ids[3] not in sql
    fences.append("version_read")
    result=run("versions",*scope,*apply,"--until-complete")
    assert result["versionOnly"]==[dict(state="verified-current",attempts=1,sourceBytes=10000,compressedBytes=750)]
    assert version_ops==["version_put","version_read"] and ids[3] not in sql
    assert sum(x["attempts"] for x in result["rows"] if x["state"]=="deferred")==1
    run("versions",*scope,*apply,"--until-complete")
    assert version_ops==["version_put","version_read"]
    entries[3]["settled"]=True
    r=run("backup",*scope,*apply,"--retry-deferred","--until-complete")
    assert sum(x["attempts"] for x in r["rows"] if x["state"]=="verified")==4 and len(sql)==4
    assert not r["sourceAttemptPayloadWrites"]
    with sqlite3.connect(root/"job"/"originals.sqlite3") as db:
        assert db.execute("SELECT generation FROM originals WHERE id=?",(ids[1],)).fetchone()[0]==str(9007199254741001)
    # The same watch can yield between bounded copy pages without restarting
    # a frozen scan or recomputing the full aggregate in each time slice.
    summary=run("cycle",*scope,*apply,"--until-complete","--slice-seconds","1","--refresh-seconds","60")
    assert summary["inventoryComplete"] and not summary["copyPending"] and sent.count(ids[1])==1
    # A live scan contains previously archived rows, new mutable originals,
    # and exclusions split across pages. Its one writer honors durable
    # uploaded generations before processing more candidates.
    for row in entries[:3]:
        row["archive"]=sql[row["id"]]
    entries[3]["settled"]=False
    del sql[ids[3]]
    empty=[dict(entries[0],id=str(uuid.UUID(int=i)),history=0) for i in range(1,6)]
    live_rows=sorted(empty+entries,key=lambda x:x["id"])
    live_ops=[]
    class LiveEndpoints(Endpoints):
        def send(self,operation,**params):
            if operation=="bound":return dict(high=live_rows[-1]["id"],instance=instance,solver=solver)
            if operation=="inventory":
                selection=params["selection"]
                return [r for r in live_rows if selection["after"]<r["id"]<=selection["high"]][:selection["limit"]]
            if operation in ("upload","version_put","version_read"):
                live_ops.append((operation,params["pins"][0]["id"] if operation=="upload" else params["pin"]["id"]))
            return super().send(operation,**params)
    def live(*args):
        output=io.StringIO()
        with redirect_stdout(output):
            operator.main([args[0],"--directory",str(root/"live"),*args[1:]],LiveEndpoints)
        return json.loads(output.getvalue())
    first=live("inventory","--limit","2","--until-complete")
    assert first["excludedCountsVerified"] and first["excluded"]=={"no-inventoried-series":5}
    capture=["--capture-live-versions","--limit","1",*apply]
    first=live("backup",*capture,"--pages","1")
    assert live_ops==[("upload",ids[3])] and any(r["state"]=="deferred" for r in first["rows"])
    pending=live("backup",*capture,"--pages","1")
    assert pending["versionOnly"][0]["state"]=="uploaded" and ids[3] not in sql
    fences.append("version_read")
    verified=live("backup",*capture,"--until-complete")
    assert live_ops.count(("version_put",ids[3]))==1 and live_ops.count(("version_read",ids[3]))==2
    assert verified["versionOnly"][0]["state"]=="verified-current" and ids[3] not in sql
    assert sum(r["attempts"]for r in verified["rows"]if r["state"]=="verified")==3
    with sqlite3.connect(root/"live"/"originals.sqlite3") as db:
        db.execute("DELETE FROM meta WHERE key='exclusionCounterVersion'")
        db.execute("UPDATE excluded SET attempts=?",(float("inf"),))
    old=live("status")
    assert not old["excludedCountsVerified"] and old["excluded"]=={"no-inventoried-series":None}
    refreshed=live("inventory","--refresh","--limit","1","--until-complete")
    assert refreshed["excludedCountsVerified"] and refreshed["excluded"]==first["excluded"]
    src.write_text(src.read_text()+"\n")
    try:run("inventory",*scope)
    except ValueError:pass
    else:raise AssertionError("changed original scope was accepted")
