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
    class Endpoints:
        def __init__(self,_):pass
        def close(self):pass
        def send(self,operation,**params):
            if operation=="bound":return dict(high=max(ids),instance=instance,solver=solver)
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
    run("backup",*scope,*apply,"--until-complete")
    assert sent==[ids[1],ids[2],ids[0]] and len(sql)==3
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
    src.write_text(src.read_text()+"\n")
    try:run("inventory",*scope)
    except ValueError:pass
    else:raise AssertionError("changed original scope was accepted")
