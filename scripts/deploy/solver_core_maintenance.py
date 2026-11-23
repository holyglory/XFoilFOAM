#!/usr/bin/python3
"""Bounded native solver crash-file maintenance; no solver or evidence writes."""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import ExitStack, contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import stat
import sys
import time
import uuid

from solver_core_database import Database
from solver_core_files import CASE, CORE, Held, core_action, file_id, locked_job, manifests, require, subject
from solver_core_host import atomic_json, container, digest_file, docker, load_json, result_volume, worker_limits
from solver_core_processes import open_jobs


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def implementation():
    base=Path(__file__).resolve().parent
    return hashlib.sha256("".join(digest_file(base/name) for name in
        ("solver_core_maintenance.py","solver_core_database.py","solver_core_files.py","solver_core_processes.py")).encode()).hexdigest()


def group_rows(rows):
    groups=defaultdict(list)
    for row in rows:groups[subject(row)[0]].append(row)
    return groups


def native_science(volume, job):
    # Hash scientific outputs and control/log material, not incidental core memory.
    root=volume/"jobs"/job
    digest=hashlib.sha256(); counts=defaultdict(int); samples={}
    for path,dirs,files in os.walk(root,followlinks=False):
        folder=Path(path)
        dirs[:]=sorted(d for d in dirs if d not in {"raw","processor0","polyMesh","VTK","frames","images","meshes"}
                       and not d.startswith("processor") and not d[:1].isdigit())
        for name in sorted(files):
            if name not in ("result.json","status.json","request.json","runtime.json","controlDict","coefficients.dat","coefficient.dat","forceCoeffs.dat") and not (
                "manifest" in name and name.endswith(".json") or name.startswith("log.") or name.endswith((".log",".csv"))):
                continue
            f=folder/name;st=f.lstat()
            require(stat.S_ISREG(st.st_mode), "nonregular scientific source")
            value=digest_file(f);rel=f.relative_to(root).as_posix()
            digest.update(json.dumps([rel,st.st_size,value],separators=(",",":")).encode()+b"\n")
            kind="manifests" if "manifest" in name else "logs" if name.startswith("log.") or name.endswith(".log") else "science"
            counts[kind]+=1
            if rel in ("result.json","status.json","request.json","runtime.json"):samples[rel]=value
    return {"digest":digest.hexdigest(),"counts":dict(counts),"sources":samples}


def gateway_science(api, job):
    code="""import hashlib,json,sys,urllib.request
out={}
for path in ('/jobs/'+sys.argv[1],'/jobs/'+sys.argv[1]+'/result'):
 with urllib.request.urlopen('http://127.0.0.1:8000'+path,timeout=15)as r:
  body=r.read();v=json.loads(body);points=[q for polar in (v.get('polars') or []) for q in (polar.get('points')or [])]
  out[path]={'status':r.status,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'state':v.get('state'),'points':len(points)}
print(json.dumps(out))
"""
    return json.loads(docker("exec",api,"python3","-I","-c",code,job,timeout=35))


def read_roster(path, digest):
    require(path and digest and digest_file(path)==digest,"historical roster digest differs")
    rows=[]
    with path.open()as f:
        header=json.loads(next(f));require("source" in header and "pathScope" in header,"missing roster source binding")
        finished=None;seen=set()
        for line in f:
            item=json.loads(line)
            if "finish" in item:
                require(finished is None,"duplicate census completion");finished=item;continue
            require(finished is None,"data after census completion");subject(item)
            key=item["dev"],item["ino"]
            require(key not in seen,"duplicate inventoried inode");seen.add(key);rows.append(item)
        require(finished and finished.get("errors")==0 and finished.get("verifiedElfCoreFiles")==len(rows),"incomplete exact census")
    return rows


def inventory_page(volume,state,limit=512):
    dirs=sorted(entry.name for entry in os.scandir(volume/"jobs") if entry.is_dir(follow_symlinks=False) and
                len(entry.name)==36 and all(c in "0123456789abcdef-" for c in entry.name))
    cursor=state/"discovery.json";last=load_json(cursor).get("after","") if cursor.is_file() else ""
    page=[j for j in dirs if j>last][:limit];out=[]
    for j in page:
        try:
            require(str(uuid.UUID(j))==j,"invalid native job directory")
            with locked_job(volume,j)as (_,cases,_):
                for name in os.listdir(cases):
                    if not CASE.fullmatch(name):continue
                    fd=os.open(name,os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=cases)
                    try:
                        for n in os.listdir(fd):
                            if not CORE.fullmatch(n):continue
                            st=os.stat(n,dir_fd=fd,follow_symlinks=False)
                            if stat.S_ISREG(st.st_mode) and st.st_nlink==1:
                                out.append(dict(j=j,r=f"cases/{name}/{n}",**file_id(st)))
                    finally:os.close(fd)
        except (Held,OSError,ValueError):continue
    return out, (page[-1] if len(page)==limit else "")


def process_batch(db,volume,state,rows,mode,api, *, survey=open_jobs, local_science=native_science, service_science=gateway_science):
    groups=group_rows(rows);result=[];inodes={(r["dev"],r["ino"]):r["j"]for r in rows}
    def note(r,status,reason=None,**fields):
        result.append(dict(j=r["j"],r=r["r"],dev=r["dev"],ino=r["ino"],state=status,reason=reason,**fields))
    busy=survey(volume,set(groups),inodes);pending=[]
    with ExitStack()as stack:
        native={}
        for j,items in groups.items():
            try:
                require(j not in busy,busy.get(j,"open job"))
                fds=stack.enter_context(locked_job(volume,j));root,cases,_=fds
                names=sorted(n for n in os.listdir(cases) if CASE.fullmatch(n))
                native[j]=(fds,manifests(root,cases,names))
            except (Held,OSError)as e:
                for r in items:note(r,"held",str(e))
        if not native:return result
        proofs=stack.enter_context(db.fence(list(native)))
        for j,(fds,docs) in native.items():
            entry=proofs[j]
            if not entry["closed"]:
                for r in groups[j]:note(r,"held","ambiguous, active, locked, un-ingested, or forensic database owner",owner=entry["owner"])
                continue
            def science():
                return {"database":db.science(j,entry["owner"]["id"]),"files":local_science(volume,j),"gateway":service_science(api,j)}
            baseline=science() if mode=="canary" else None
            def recheck():
                if baseline is not None:require(science()==baseline,"scientific readback changed")
            for r in groups[j]:
                try:
                    item=core_action(volume,state,r,fds,docs,entry["refs"],"stage" if mode=="release" else mode,
                                     holders=(lambda:j in survey(volume,{j},inodes)) if mode=="canary" else (lambda:j in busy),science_check=recheck)
                    if item["state"]=="quarantined":
                        pending.append((r,j))
                    else:
                        note(r,item.pop("state"),**item,**({"scientificProof":baseline} if baseline is not None else {}))
                except (Held,OSError)as e:note(r,"held",str(e))
        if pending:
            # A different reader may have opened the original between the first
            # survey and rename. The inode is now private and all job locks remain held.
            busy=survey(volume,set(native),inodes)
            # Refresh metadata and the database session after every staged batch.
            dbpaths=defaultdict(list)
            try:
                for v in db.references({j:proofs[j]["owner"]["id"]for _,j in pending}):
                    dbpaths[v["native"]].append((v["case"],v["ref"]))
            except Exception:
                for r,j in pending:
                    fds,_=native[j]
                    core_action(volume,state,r,fds,[],[],"restore",holders=lambda:False,science_check=lambda:None)
                raise
            refreshed={}
            for j in {j for _,j in pending}:
                fds,_=native[j]
                try:refreshed[j]=manifests(fds[0],fds[1],sorted(n for n in os.listdir(fds[1]) if CASE.fullmatch(n)))
                except (Held,OSError)as e:busy[j]=str(e)
            for r,j in pending:
                fds,docs=native[j]
                args=(volume,state,r,fds,refreshed.get(j,docs),dbpaths[j])
                try:
                    require(j not in busy,busy.get(j,"open job"))
                    item=core_action(*args,"release",holders=lambda:j in busy,science_check=lambda:None)
                    note(r,item.pop("state"),**item)
                except (Held,OSError)as e:
                    try:core_action(*args,"restore",holders=lambda:False,science_check=lambda:None)
                    except (Held,OSError)as restore:note(r,"held-in-quarantine",f"{e}; restore: {restore}");continue
                    note(r,"held",str(e))
    return result


def summary(rows):
    return {"files":len(rows),"released":sum(r["state"]=="released" for r in rows),"held":sum(r["state"].startswith("held")for r in rows),
            "allocatedBytesReleased":sum(r.get("allocated",0)for r in rows),"apparentBytesReleased":sum(r.get("apparent",0)for r in rows)}


@contextmanager
def deploy_guard():
    f=Path("/tmp/airfoils-pro-deploy.lock")
    require(f.is_file() and not f.is_symlink(),"canonical deployment lock missing")
    with f.open("rb")as fd:
        fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
        yield


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action",choices=["auto","inspect","canary","release","limits-inspect","limits-disable","limits-restore"])
    ap.add_argument("--project");ap.add_argument("--roster",type=Path);ap.add_argument("--roster-sha256")
    ap.add_argument("--job");ap.add_argument("--relative");ap.add_argument("--offset",type=int,default=0)
    ap.add_argument("--jobs",type=int,default=16);ap.add_argument("--hold-jobs",type=Path)
    args=ap.parse_args()
    if args.project:project=args.project
    else:
        lines=Path("/opt/airfoils-pro/state/.env.deploy").read_text().splitlines()
        vals=[s.split("=",1)[1].strip().strip("'\"")for s in lines if s.startswith("COMPOSE_PROJECT_NAME=")]
        require(len(vals)==1,"no unique configured deployment project");project=vals[0]
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}",project),"invalid deployment project")
    require(os.geteuid()==0,"host root visibility is required for complete open-file inspection")
    state=Path("/var/lib/airfoils-pro/solver-core-retention")/project
    require(state.resolve()==state,"operator state path differs")
    state.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (state/"operator.lock").open("a")as lock, deploy_guard():
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.action.startswith("limits-"):
            print(json.dumps(worker_limits(project,state,args.action.removeprefix("limits-"))));return
        worker=container(project,"worker");api=container(project,"api");pg=container(project,"postgres")
        volume=result_volume(worker);require(volume==result_volume(api),"worker and gateway results mount differ")
        if args.action=="auto":
            limits=worker_limits(project,state,"disable")
            if limits.get("state")=="explicit-diagnostic-policy":print(json.dumps(limits));return
        require(not any(l["Name"]=="core" and l["Soft"]!=0 for l in worker["ulimits"]or []),"explicit diagnostic core policy")
        hold_path=args.hold_jobs or state/"active-owner-holds.json"
        holds=set(load_json(hold_path))if hold_path.exists()else set()
        binding={"project":project,"volume":str(volume),"device":volume.stat().st_dev,"inode":volume.stat().st_ino,"implementation":implementation()}
        mode=args.action
        if mode=="auto":
            rows,next_cursor=inventory_page(volume,state,limit=4096)
            # A move may have reached private quarantine before its process
            # exited. Such sources no longer appear in directory discovery.
            in_flight={}
            for receipt in (state/"files").glob("*.json"):
                prior=load_json(receipt)
                if prior["state"] in ("intent","quarantined","restore-intent","release-intent"):
                    row=prior["source"];in_flight[(row["j"],row["r"],row["ino"])]=row
            in_flight.update({(r["j"],r["r"],r["ino"]):r for r in rows})
            rows=list(in_flight.values())
            if not rows:
                atomic_json(state/"discovery.json",{"after":next_cursor});print(json.dumps({"state":"scanned","after":next_cursor}));return
            mode="release" if (state/"qualified.json").is_file() and load_json(state/"qualified.json")["binding"]==binding else "canary"
        else:
            rows=read_roster(args.roster,args.roster_sha256);next_cursor=None
        if args.job:rows=[r for r in rows if r["j"]==str(uuid.UUID(args.job))]
        if args.relative:rows=[r for r in rows if r["r"]==args.relative]
        if mode=="release":
            require((state/"qualified.json").is_file() and load_json(state/"qualified.json")["binding"]==binding,"missing reversible same-volume canary for this implementation")
        groups=group_rows(rows)
        require(0<args.jobs<=128 and args.offset>=0,"invalid bounded job window")
        keys=sorted(groups)[args.offset:args.offset+args.jobs] if args.action!="auto" else sorted(groups)
        if args.action=="auto" and len(keys)>16:
            keys=keys[:16];next_cursor=keys[-1]
        db=Database(["docker","exec","-i",pg["id"],"psql","-U","aerodb","-d","aerodb"])
        results=[]
        try:
            active=[j for j in keys if j not in holds]
            for j in set(keys)&holds:
                results.extend(dict(j=j,r=r["r"],state="held",reason="coordinated owner hold",allocated=0)for r in groups[j])
            width=1 if mode=="canary" else 128
            for i in range(0,len(active),width):
                jobs=active[i:i+width]
                batch=[r for j in jobs for r in (groups[j][:1] if mode=="canary" else groups[j])]
                part=process_batch(db,volume,state,batch,mode,api["id"])
                results.extend(part)
                if mode=="canary" and any(x["state"]=="restored" and x.get("scientificProof")for x in part):
                    proof={"at":utc(),"binding":binding,"proof":part}
                    key=next(x["key"] for x in part if x["state"]=="restored" and x.get("scientificProof"))
                    atomic_json(state/"canaries"/(key+"-"+binding["implementation"]+".json"),proof)
                    atomic_json(state/"qualified.json",proof);break
        finally:db.close()
        if args.action=="auto" and mode=="release":atomic_json(state/"discovery.json",{"after":next_cursor})
        output={"at":utc(),"binding":binding,"mode":mode,"offset":args.offset,"throughOwnerOffset":args.offset+len(keys),
                "rosterSha256":args.roster_sha256,"rows":results,**summary(results)}
        print(json.dumps(output,separators=(",",":")))
        if mode=="canary" and not any(r.get("scientificProof") and r["state"]=="restored"for r in results):sys.exit(3)


if __name__=="__main__":
    try:main()
    except BlockingIOError:
        print(json.dumps({"state":"busy","allocatedBytesReleased":0}))
        sys.exit(0 if len(sys.argv)>1 and sys.argv[1]=="auto" else 75)
