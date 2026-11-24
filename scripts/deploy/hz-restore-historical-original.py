#!/usr/bin/env python3
"""Repatriate one missing, registered historical tar.zst through its existing HZ read proxy.

Input JSON is a private, digest-pinned packet with the historical receipt, original evidence directory,
and all three completed ordinary reclaim sidecar hashes. Publish is no-replace, under the job lock.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace

SHA = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
SIDECARS = ("brokered_hub_binding.database.json", "brokered_local_reclaim.intent.json", "brokered_local_reclaim.json")
ARCHIVE = "engine_evidence.tar.zst"


def require(value, message):
    if not value:
        raise ValueError(message)


def read_regular(path, limit):
    require(path.resolve(strict=True) == path, "original source metadata is linked")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        st = os.fstat(file.fileno())
        require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and 0 < st.st_size <= limit, "invalid original metadata")
        data = file.read(st.st_size + 1)
        require(len(data) == st.st_size and st.st_ctime_ns == path.lstat().st_ctime_ns, "source metadata changed")
    return data


def pinned_sidecars(folder, packet):
    require(set(packet["ordinarySidecarSha256"]) == set(SIDECARS), "expected exact ordinary reclaim sidecars")
    rows = []
    for name in SIDECARS:
        raw = read_regular(folder / name, 1024 * 1024)
        require(hashlib.sha256(raw).hexdigest() == packet["ordinarySidecarSha256"][name], "ordinary reclaim ledger changed")
        rows.append(json.loads(raw))
    ack, intent, done = rows
    source = packet["receipt"]
    auth = ack["authorization"]
    receipt = auth["receipt"]
    require(ack["state"] == "hub_progressive_custody" and done["state"] == "complete"
            and intent["authorization"] == done["authorization"] == auth
            and done["intentSha256"] == hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            and ARCHIVE in done["deletedPaths"] and receipt["brokeredUploadId"] == packet["ordinaryUpload"]
            and receipt["source"]["engineJobId"] == source["sim_job_id"]
            and receipt["source"]["promiseId"] == source["promise_id"] and receipt["source"]["solverId"] == source["solver_id"]
            and receipt["source"]["engineCaseSlug"] == PurePosixPath(packet["directory"]).parts[1]
            and receipt["remote"]["storedSha256"] == source["stored_sha256"]
            and receipt["remote"]["storedByteSize"] == source["stored_bytes"]
            and receipt["remote"]["generation"] == source["generation"]
            and receipt["remote"]["manifestSha256"] == source["manifest_sha256"]
            and receipt["remote"]["tarSha256"] == source["tar_sha256"]
            and receipt["remote"]["tarByteSize"] == source["tar_bytes"]
            and receipt["remote"]["crc32c"] == source["crc32c"], "ordinary and historical original identities differ")


def sha_and_crc(path):
    import google_crc32c
    h, crc = hashlib.sha256(), google_crc32c.Checksum()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        st = os.fstat(file.fileno())
        require(stat.S_ISREG(st.st_mode), "original path is not a regular file")
        for block in iter(lambda: file.read(1024 * 1024), b""):
            h.update(block)
            crc.update(block)
        require(st.st_ctime_ns == path.lstat().st_ctime_ns, "original changed during read")
    return h.hexdigest(), base64.b64encode(crc.digest()).decode(), st


def recover(volume, packet, token, apply):
    from airfoilfoam import historical_raw_restore as historical
    from airfoilfoam.automatic_retention import named_owner
    from airfoilfoam.evidence_store import manifest_bundle_member_set_sha256, verify_local_archive_manifest_members

    row = packet["receipt"]
    job = row["sim_job_id"]
    require(isinstance(job, str) and UUID.fullmatch(job) and UUID.fullmatch(packet["ordinaryUpload"])
            and re.fullmatch(r"cases/[A-Za-z0-9][A-Za-z0-9_.-]*/a[0-9]+/evidence", packet["directory"])
            and isinstance(token, str) and token, "invalid registered original selector")
    root = volume / "jobs" / job
    folder = root / packet["directory"]
    destination = folder / ARCHIVE
    require(folder.resolve(strict=True) == folder and folder.is_dir(), "native evidence directory changed")
    expected = (row["stored_sha256"], row["crc32c"], row["stored_bytes"])
    def original():
        digest, crc, st = sha_and_crc(destination)
        require((digest, crc, st.st_size) == expected, "a different original occupies the target")
        return {"device": st.st_dev, "inode": st.st_ino, "allocatedBytes": st.st_blocks * 512, "mtimeNs": st.st_mtime_ns}
    def authority():
        pinned_sidecars(folder, packet)
        status = json.loads(read_regular(root / "status.json", 2 * 1024**2))
        require(status.get("job_id") == job and status.get("state") in ("completed", "cancelled", "failed"),
                "native job is not terminal")
        raw = read_regular(folder / "evidence_manifest.json", 8 * 1024**2)
        require(len(raw) == row["manifest_bytes"] and hashlib.sha256(raw).hexdigest() == row["manifest_sha256"],
                "native manifest changed")
        return raw
    with named_owner(root, None, True) as owner:
        manifest = authority()
        if destination.exists() or destination.is_symlink():
            return {"state": "already-present", "source": original(), "published": False}
        held_dir = (folder.stat().st_dev, folder.stat().st_ino)
    forced = base64.b64encode(json.dumps({"version":1,"directory":packet["directory"],"receipt":row},
                                         separators=(",", ":")).encode()).decode()
    proof = historical.original_scope(root, destination, forced)
    require(proof is not None and proof[2] == manifest, "historical source coverage is unavailable")
    _, directory, _, pointer, member = proof
    require(member == ARCHIVE and manifest_bundle_member_set_sha256(manifest) == (row["bundled_file_count"]+1, row["manifest_set_sha256"]),
            "historical bundled membership changed")
    scratch = volume / ".historical-original-recovery"
    scratch.mkdir(mode=0o700, exist_ok=True)
    require(scratch.resolve(strict=True) == scratch and scratch.stat().st_dev == held_dir[0]
            and scratch.stat().st_uid == os.geteuid() and not (scratch.stat().st_mode & 0o077),
            "private restore workspace is unavailable")
    with tempfile.TemporaryDirectory(dir=scratch) as td:
        verified = Path(td) / ARCHIVE
        # Existing local engine credential, fixed local adapter, immutable registered owner and exact generation.
        historical._download(row, directory, pointer, SimpleNamespace(control_plane_token=token), verified)
        got, crc, st = sha_and_crc(verified)
        record, count = verify_local_archive_manifest_members(verified, expected_manifest=manifest, level=pointer.zstd_level)
        require((got, crc, st.st_size)==expected and record.tar_sha256==pointer.tar_sha256 and record.tar_size==pointer.tar_size
                and record.stored_sha256==pointer.stored_sha256 and count==row["bundled_file_count"],
                "full original archive verification failed")
        result = {"job":job,"directory":directory,"generation":str(pointer.generation),"sha256":got,"storedBytes":st.st_size,
                  "crc32c":crc,"tarSha256":record.tar_sha256,"tarBytes":record.tar_size,"memberCountIncludingManifest":count+1,
                  "nativeOwner":owner,"published":False}
        if not apply:
            return {**result,"state":"verified-only"}
        with named_owner(root, owner, True):
            require(authority() == manifest and (folder.stat().st_dev, folder.stat().st_ino)==held_dir, "owner changed during restore")
            if destination.exists() or destination.is_symlink():
                return {**result,"state":"already-present","source":original()}
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            fd = os.open(folder, flags)
            try:
                require(os.path.samestat(os.fstat(fd),folder.lstat()),"original directory moved before publication")
                # Expose only completely verified bytes. A competing publisher cannot be overwritten.
                with verified.open("rb") as file:
                    os.fchmod(file.fileno(), 0o200 | (stat.S_IMODE((folder/"evidence_manifest.json").stat().st_mode) & 0o444))
                    os.fsync(file.fileno())
                try:
                    os.link(verified, ARCHIVE, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    return {**result,"state":"already-present","source":original()}
                os.fsync(fd)
                result.update(state="restored", published=True, source={"device":st.st_dev,"inode":st.st_ino,"allocatedBytes":st.st_blocks*512})
            finally:
                os.close(fd)
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["verify","restore"])
    parser.add_argument("packet",type=Path)
    parser.add_argument("--sha256",required=True)
    parser.add_argument("--sweeper",required=True,help="Full installed HZ sweeper container ID")
    parser.add_argument("--revision",required=True,help="Serving HZ deployment source revision")
    args=parser.parse_args()
    require(SHA.fullmatch(args.sweeper) and re.fullmatch("[a-f0-9]{40}",args.revision) and SHA.fullmatch(args.sha256),
            "invalid deployment pins")
    raw=read_regular(args.packet,32768);require(hashlib.sha256(raw).hexdigest()==args.sha256,"recovery packet changed")
    packet=json.loads(raw);repo=Path(__file__).resolve().parents[2]
    files={"recovery":Path(__file__).resolve().relative_to(repo),"historical":Path("src/airfoilfoam/historical_raw_restore.py")}
    sources={}
    for k,path in files.items():
        data=subprocess.check_output(["git","-C",str(repo),"show","HEAD:"+str(path)])
        require(data==(repo/path).read_bytes(),"operator must match its committed source")
        sources[k]=data.decode()
    boot="""import json,os,sys,types
from pathlib import Path
sys.path.insert(0,'/app/src')
import airfoilfoam
q=json.load(sys.stdin)
if os.environ.get('AIRFOILFOAM_DEPLOYMENT_ROLE')!='remote-solver':raise SystemExit('Registered HZ worker required')
m=types.ModuleType('airfoilfoam.historical_raw_restore');m.__package__='airfoilfoam'
sys.modules[m.__name__]=m;setattr(airfoilfoam,'historical_raw_restore',m)
exec(compile(q['sources']['historical'],'<versioned historical read>','exec'),m.__dict__)
a={'__name__':'_closed_source_recovery'};exec(compile(q['sources']['recovery'],'<versioned original recovery>','exec'),a)
print(json.dumps(a['recover'](Path('/data/airfoilfoam'),q['packet'],os.environ.get('ENGINE_CONTROL_PLANE_TOKEN'),q['apply'])))"""
    host="""import json,sys,subprocess,fcntl
from pathlib import Path
cid,rev=sys.argv[1:];payload=sys.stdin.buffer.read(2*1024**2+1)
with open('/tmp/airfoils-pro-deploy.lock','rb')as lock:
 fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
 if json.loads(Path('/opt/airfoils-pro/app/.deployment-source.json').read_bytes()).get('sourceRevision')!=rev:raise SystemExit('HZ deployment changed')
 view=json.loads(subprocess.check_output(['docker','inspect','hz-solver2-sweeper-1']))[0]
 assert view['Id']==cid and view['State']['Running'] and view['Config']['Labels']['com.docker.compose.service']=='sweeper'
 assert any(m['Destination']=='/data/airfoilfoam' and m['RW'] for m in view['Mounts']) and len(payload)<=2*1024**2
 q=json.loads(payload);subprocess.run(['docker','exec','-i','-w','/app',cid,'nice','-n','15','/opt/airfoilfoam-retention/bin/python','-IB','-c',q.pop('boot')],input=json.dumps(q).encode(),check=True,timeout=1500)"""
    cli=["ssh","-T","-oBatchMode=yes","-oForwardAgent=no","-oStrictHostKeyChecking=yes","-oClearAllForwardings=yes",
         "-oConnectTimeout=8","hz-solver2",shlex.join(["python3","-IB","-c",host,args.sweeper,args.revision])]
    subprocess.run(cli,input=json.dumps({"sources":sources,"boot":boot,"packet":packet,"apply":args.mode=="restore"}).encode(),check=True,timeout=1550)


if __name__=="__main__":
    main()
