#!/usr/bin/env python3
"""Bounded controller for original HZ 0207 copies. Only metadata goes into SQLite."""
import argparse
from collections import Counter
from contextlib import closing, contextmanager
from pathlib import Path
import fcntl
import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
ZERO = "00000000-0000-0000-0000-000000000000"
NATIVE_LIMIT = 32 * 1024**2
stopping = False

def json_text(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True)

def file_identity(st):
    return [st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]

def digest_file(db,path):
    with path.open("rb") as source:
        stamp=file_identity(os.fstat(source.fileno()))
        memo=get(db,"scopeDigest")
        if memo and memo["stamp"]==stamp:return memo["sha"]
        digest=hashlib.file_digest(source,"sha256").hexdigest()
        if file_identity(os.fstat(source.fileno()))!=stamp:raise ValueError("Scope changed while hashing")
        with db:save(db,"scopeDigest",dict(stamp=stamp,sha=digest))
        return digest

def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Invalid source identifier")
    return value

@contextmanager
def state(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "originals.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with closing(sqlite3.connect(directory / "originals.sqlite3")) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS originals(
                  id TEXT PRIMARY KEY,pin TEXT NOT NULL,history INTEGER NOT NULL,source_bytes INTEGER NOT NULL,
                  stored INTEGER NOT NULL,matched INTEGER NOT NULL,hub TEXT,settled INTEGER NOT NULL,prior INTEGER NOT NULL,
                  state TEXT NOT NULL,archive TEXT,generation TEXT,packed INTEGER,created INTEGER,remote_proof TEXT);
                CREATE INDEX IF NOT EXISTS original_priority ON originals(state,settled DESC,matched DESC,history DESC,id);
                CREATE TABLE IF NOT EXISTS excluded(reason TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
            """)
            yield db

def get(db, key, default=None):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default

def save(db, key, value):
    db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key,json_text(value)))

class RelayError(Exception):
    def __init__(self, category, retryable=False):
        self.category = category
        self.retryable = retryable
        super().__init__(category)

class Relay:
    def __init__(self, args):
        self.args = args
        self.proc = None

    def close(self):
        if self.proc is not None:
            proc, self.proc = self.proc, None
            try:
                proc.stdin.close()
                proc.wait(8)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait()
            proc.stdout.close()

    def send(self, operation, **params):
        if self.proc is None:
            self.proc = subprocess.Popen(
                ["node","--import","tsx","apps/sweeper/src/hz-attempt-original-relay.ts"],
                cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            cfg = dict(hzHost=self.args.hz_host, hzContainer=self.args.hz_container,
                       hubHost=self.args.hub_host, hubContainer=self.args.hub_container,
                       bucket=self.args.bucket, accountFile=str(self.args.hub_account_file) if self.args.hub_account_file else None,
                       apply=self.args.apply)
            self.proc.stdin.write(json_text(cfg)+"\n")
        key = str(uuid.uuid4())
        try:
            self.proc.stdin.write(json_text(dict(id=key,operation=operation,**params))+"\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline(2*1024**2)
            if not line.endswith("\n"):
                raise RelayError("unavailable")
            reply = json.loads(line)
        except (OSError, ValueError) as error:
            raise RelayError("unavailable") from error
        if reply.get("id") != key:
            raise RelayError("integrity")
        if "error" in reply:
            err=reply["error"]
            raise RelayError(err["category"] if err.get("category") in {"transport","deployment_busy","integrity","input","denied","local_io"} else "integrity",
                             err.get("retryable") is True and err.get("category") in {"transport","deployment_busy"})
        return reply["result"]

def summary(db):
    counts=[dict(r) for r in db.execute("""SELECT state,matched,settled,count(*) AS attempts,coalesce(sum(history),0) AS historyBytes,
        coalesce(sum(source_bytes),0) AS sourceBytes,coalesce(sum(packed),0) AS measuredPackedBytes,
        coalesce(sum(created),0) AS observedNewCatalogRows,coalesce(sum(prior),0) AS cataloguedAtInventory FROM originals GROUP BY state,matched,settled ORDER BY state,matched DESC,settled DESC""")]
    return dict(inventory=get(db,"scan"),rows=counts,excluded={r[0]:r[1] for r in db.execute("SELECT * FROM excluded")},
                sourceAttemptPayloadWrites=False)

def scope_page(path, offset, count, stamp):
    with path.open("rb") as src:
        if file_identity(os.fstat(src.fileno()))!=stamp:raise ValueError("Frozen scope changed")
        src.seek(offset)
        out=[]
        for _ in range(count):
            buf=src.readline(2048)
            if not buf:break
            if not buf.endswith(b"\n"): raise ValueError("Invalid scope line")
            r=json.loads(buf)
            identifier(r["attemptId"])
            sha=r["sourceSha256"]
            if not isinstance(sha,str) or len(sha)!=64 or any(c not in "0123456789abcdef" for c in sha) or not 0<r["sourceByteSize"]<=NATIVE_LIMIT:
                raise ValueError("Invalid scope identity")
            out.append(r)
        if file_identity(os.fstat(src.fileno()))!=stamp:raise ValueError("Frozen scope changed")
        return out,src.tell()

def bind(db,args,b,sig):
    key=[1,args.hz_host,args.hz_container,args.hub_host,args.hub_container,b["instance"],b["solver"],sig]
    prior=get(db,"binding")
    if prior is not None and key!=prior:raise ValueError("Originals checkpoint binding differs")
    if prior is None:
        with db:
            save(db,"binding",key)
            save(db,"scan",dict(after=ZERO,high=b["high"],offset=0,complete=False,scanned=0))
    if args.apply:
        dest=[args.bucket,hashlib.sha256(args.hub_account_file.read_bytes().strip()).hexdigest()]
        if get(db,"destination",dest)!=dest:raise ValueError("Originals destination binding differs")
        with db:save(db,"destination",dest)

def inventory_page(db,args,relay,b):
    scan=get(db,"scan")
    refs=None
    if args.scope:
        refs,offset=scope_page(args.scope,scan["offset"],args.limit,get(db,"scopeDigest")["stamp"])
        selector={"ids":[r["attemptId"] for r in refs]}
    else:
        offset=scan["offset"]
        selector=dict(after=scan["after"],high=scan["high"],limit=args.limit)
    rows=relay.send("inventory",binding=b,selection=selector) if refs is None or refs else []
    if refs is not None:
        seen={r["id"]:r for r in rows}
        if len(seen)!=len(refs) or any(q["attemptId"] not in seen or seen[q["attemptId"]]["sha"]!=q["sourceSha256"]
                                       or seen[q["attemptId"]]["bytes"]!=q["sourceByteSize"] for q in refs):
            raise ValueError("Frozen source differs")
    elif len(rows)>args.limit or any(not scan["after"]<r["id"]<=scan["high"] for r in rows) or [r["id"] for r in rows]!=sorted({r["id"] for r in rows}):
        raise ValueError("Invalid source cursor")
    excluded=Counter()
    with db:
        for r in rows:
            if r["history"] is None or r["sha"] is None:
                excluded["source-unavailable-or-over-native-bound"]+=1
                continue
            if not r["history"]:
                excluded["no-inventoried-series"]+=1
                continue
            pin={k:r[k] for k in ("id","result","job","sha","bytes","history")}
            status="pending" if r["owned"] else "owner-unproven"
            present=db.execute("SELECT pin,state,archive,remote_proof FROM originals WHERE id=?",(r["id"],)).fetchone()
            if present and present["pin"]!=json_text(pin):raise ValueError("Stored original changed within snapshot")
            if present and present["state"]=="verified":
                if present["archive"] == r["archive"]: status="verified"
                elif not r["archive"] and present["remote_proof"] and r["owned"]: status="uploaded"
                else: raise ValueError("Previously verified HZ catalog binding changed")
            if present and refs is not None:raise ValueError("Duplicate entry in frozen source")
            db.execute("""INSERT INTO originals(id,pin,history,source_bytes,stored,matched,hub,settled,prior,state,archive)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET matched=excluded.matched,hub=excluded.hub,
                settled=excluded.settled,state=excluded.state,
                archive=coalesce(excluded.archive,originals.archive)""",
                (r["id"],json_text(pin),r["history"],r["bytes"],r["stored"],int(r["match"] is not None),json_text(r["match"]),int(bool(r["settled"])),int(bool(r["archive"])),status,r["archive"]))
        for reason,n in excluded.items():
            db.execute("INSERT INTO excluded VALUES(?,?) ON CONFLICT(reason) DO UPDATE SET attempts=attempts+excluded.attempts",(reason,n))
        scan.update(complete=len(rows)<args.limit or (refs is None and rows and rows[-1]["id"]==scan["high"]),
                    offset=offset,after=rows[-1]["id"] if rows else scan["after"],scanned=scan["scanned"]+len(rows))
        save(db,"scan",scan)
        if scan["complete"]:save(db,"lastCompleteInventory",time.time())
    return not scan["complete"]

def backup_page(db,args,relay,b):
    if not get(db,"scan")["complete"]:raise ValueError("Finish inventory before priority copy")
    # A durable pinned generation always takes precedence over new uploads.
    recovering = db.execute("SELECT 1 FROM originals WHERE state='uploaded' LIMIT 1").fetchone() is not None
    phase = "uploaded" if recovering else "pending"
    rows=list(db.execute("""SELECT id,pin,source_bytes,remote_proof FROM originals WHERE state=?
                          ORDER BY settled DESC,matched DESC,history DESC,id LIMIT ?""",(phase,args.limit)))
    if not rows:return False
    pins=[];uploads=[];total=0
    for r in rows:
        if r["source_bytes"]>args.page_bytes:
            if pins:break
            raise ValueError("Frozen original needs a larger page byte limit")
        if total+r["source_bytes"]>args.page_bytes:break
        pin=json.loads(r["pin"]);pins.append(pin);total+=r["source_bytes"]
        if recovering:uploads.append(dict(pin=pin,identity=json.loads(r["remote_proof"])))
    if not recovering:
        result=relay.send("upload",binding=b,pins=pins,budget=args.page_bytes)
        uploads=result["uploads"];deferred=result["deferred"]
        if len(uploads)+len(deferred)!=len(pins) or (set(deferred)|{x["pin"]["id"] for x in uploads})!={p["id"] for p in pins}:
            raise ValueError("Incomplete GCS readback")
        with db:
            for x in uploads:
                proof=x["identity"]
                db.execute("""UPDATE originals SET state='uploaded',generation=?,remote_proof=? WHERE id=? AND state='pending'""",
                           (proof["generation"],json_text(proof),x["pin"]["id"]))
            for id_ in deferred:db.execute("UPDATE originals SET state='deferred' WHERE id=?",(id_,))
    if uploads:
        receipts=relay.send("register",binding=b,uploads=uploads,budget=args.page_bytes)
        if len(receipts)!=len(uploads) or {r["id"] for r in receipts}!={x["pin"]["id"] for x in uploads}:
            raise ValueError("Incomplete HZ catalogue receipt")
        with db:
            for r in receipts:
                result=db.execute("""UPDATE originals SET state='verified',archive=?,packed=?,created=?
                    WHERE id=? AND state='uploaded' AND generation=?""",(r["archive"],r["packedBytes"],int(r["created"]),r["id"],r["generation"]))
                if result.rowcount!=1:raise ValueError("Catalogue acknowledged a different generation")
    return True

def parse(argv):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode",choices=["inventory","backup","status","cycle"])
    ap.add_argument("--directory",required=True,type=Path)
    ap.add_argument("--scope",type=Path,help="Frozen JSONL with attemptId, sourceSha256 and sourceByteSize")
    ap.add_argument("--hz-host",default="hz-solver2");ap.add_argument("--hz-container",default="hz-solver2-sweeper-1")
    ap.add_argument("--hub-host",default="airfoils.pro");ap.add_argument("--hub-container",default="app-sweeper-1")
    ap.add_argument("--bucket");ap.add_argument("--hub-account-file",type=Path)
    ap.add_argument("--limit",type=int,default=32);ap.add_argument("--page-bytes",type=int,default=16*1024**2)
    ap.add_argument("--slice-seconds",type=int,help="For cycle, yield after this many seconds at a page boundary")
    ap.add_argument("--refresh-seconds",type=int,help="For cycle, revisit completed inventory or deferred frozen sources after this interval")
    ap.add_argument("--pages",type=int,default=1);ap.add_argument("--until-complete",action="store_true")
    ap.add_argument("--apply",action="store_true")
    ap.add_argument("--retry-deferred",action="store_true");ap.add_argument("--refresh",action="store_true")
    a=ap.parse_args(argv)
    if not 1<=a.limit<=64 or not 1<=a.page_bytes<=NATIVE_LIMIT or a.pages<1 or a.apply!=(a.mode in ('backup','cycle')) or (a.apply and (not a.bucket or not a.hub_account_file)):
        ap.error("Check copy bounds and write options")
    if a.refresh and (a.scope or a.mode!='inventory') or a.retry_deferred and not a.apply:ap.error("Invalid refresh or retry scope")
    if ((a.slice_seconds is not None or a.refresh_seconds is not None) and a.mode!="cycle") or any(v is not None and v<1 for v in (a.slice_seconds,a.refresh_seconds)):
        ap.error("Invalid cycle timing")
    return a

def main(argv=None,relay_factory=Relay):
    args=parse(argv);os.umask(0o077)
    if args.mode=="status":
        uri=(args.directory/"originals.sqlite3").resolve().as_uri()+"?mode=ro"
        with closing(sqlite3.connect(uri,uri=True)) as db:
            db.row_factory=sqlite3.Row
            print(json_text(summary(db)))
        return
    with state(args.directory) as db:
        relay=relay_factory(args)
        try:
            b=relay.send("bound");sig=digest_file(db,args.scope) if args.scope else None
            bind(db,args,b,sig)
            # A fixed file never admits a new identity. An unscoped watch
            # revisits random UUIDs behind its high-water mark after its drain.
            due=(args.mode=="cycle" and args.refresh_seconds and get(db,"scan")["complete"] and
                 time.time()-get(db,"lastCompleteInventory",0)>=args.refresh_seconds and
                 not db.execute("SELECT 1 FROM originals WHERE state IN ('pending','uploaded') LIMIT 1").fetchone())
            if args.refresh or (due and not args.scope):
                if not get(db,"scan")["complete"] or db.execute("SELECT 1 FROM originals WHERE state='uploaded' LIMIT 1").fetchone():
                    raise ValueError("Finish inventory and pending generation registration before refresh")
                with db:
                    save(db,"scan",dict(after=ZERO,high=b["high"],offset=0,complete=False,scanned=0))
                    db.execute("DELETE FROM excluded")
            if args.retry_deferred or (due and args.scope):
                with db:
                    db.execute("UPDATE originals SET state='pending' WHERE state='deferred'")
                    if due:save(db,"lastCompleteInventory",time.time())
            batch=0;backoff=1
            deadline=time.monotonic()+args.slice_seconds if args.slice_seconds else None
            while not stopping and (deadline is None or batch==0 or time.monotonic()<deadline) and (args.until_complete or batch<args.pages):
                try:
                    scan=not get(db,"scan")["complete"]
                    if args.mode=="inventory" and not scan:break
                    if args.mode=="backup" and scan:raise ValueError("Source inventory incomplete")
                    more=inventory_page(db,args,relay,b) if scan else backup_page(db,args,relay,b)
                    batch+=1;backoff=1
                    if not more and (args.mode!="cycle" or not scan):break
                except RelayError as e:
                    if not e.retryable or not args.until_complete:raise
                    relay.close()
                    for _ in range(backoff*4):
                        if stopping or (deadline and time.monotonic()>=deadline):break
                        time.sleep(0.25)
                    if deadline and time.monotonic()>=deadline:break
                    backoff=min(30,backoff*2)
            if args.mode=="cycle" and args.slice_seconds:
                pending=db.execute("SELECT 1 FROM originals WHERE state IN ('pending','uploaded') LIMIT 1").fetchone()
                print(json_text(dict(pages=batch,inventoryComplete=get(db,"scan")["complete"],copyPending=pending is not None,
                                     sourceAttemptPayloadWrites=False)))
            else:print(json_text(summary(db)))
        finally:relay.close()

def stop(*_):
    global stopping
    stopping=True

if __name__=="__main__":
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try: main()
    except (ValueError,TypeError,KeyError,OSError,sqlite3.Error,RelayError,subprocess.SubprocessError) as e:
        print(json_text({"operation":"hz_originals","category":e.category if isinstance(e,RelayError) else "input_or_integrity"}),file=sys.stderr)
        sys.exit(1)
