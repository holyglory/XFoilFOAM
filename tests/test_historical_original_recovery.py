from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
from pathlib import Path
import runpy
import threading

import google_crc32c
import pytest

from airfoilfoam import historical_raw_restore
from airfoilfoam.evidence_store import create_tar_zst, manifest_bundle_member_set_sha256

recover = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/hz-restore-historical-original.py"))["recover"]

def test_atomic_registered_original_recovery_preserves_completed_reclaim_and_foreground(tmp_path, monkeypatch):
    job="7fd42905-29e4-44cf-b98b-3cd6588a03c3"
    upload="dcbdeef2-21c6-4da6-bd99-0b87760005c0"
    volume=tmp_path/"volume";root=volume/"jobs"/job;name="cases/c1_u30/a0/evidence"
    folder=root/name;folder.mkdir(parents=True)
    put=lambda p,v:p.write_text(json.dumps(v,sort_keys=True,separators=(",",":")))
    h=lambda b:sha256(b).hexdigest()
    put(root/"status.json",{"job_id":job,"state":"cancelled"});(root/".execute.lock").touch()
    member=b"Time Cl Cd\n0.1 0.364 0.02\n";(folder/"openfoam").mkdir();(folder/"openfoam/force.dat").write_bytes(member)
    put(folder/"evidence_manifest.json",{"schemaVersion":2,"files":[{"path":"openfoam/force.dat","sha256":h(member),"byteSize":len(member)}],"bundleExcludes":[]})
    dest=folder/"engine_evidence.tar.zst";manifest=(folder/"evidence_manifest.json").read_bytes()
    record=create_tar_zst(folder,dest,level=10);body=dest.read_bytes();dest.unlink()
    crc=base64.b64encode(google_crc32c.Checksum(body).digest()).decode()
    row={"sim_job_id":job,"sequence":4,"point_content_signature":"a"*64,"report_signature":"b"*64,"assignment_signature":"c"*64,
         "stop_signature":"d"*64,"solver_id":job,"promise_id":upload,"source_instance_id":job,"manifest_sha256":h(manifest),
         "manifest_bytes":len(manifest),"manifest_set_sha256":manifest_bundle_member_set_sha256(manifest)[1],"tar_sha256":record.tar_sha256,
         "tar_bytes":record.tar_size,"stored_sha256":h(body),"stored_bytes":len(body),"generation":"18446744073709551614",
         "crc32c":crc,"bucket":"test","object_key":f"solver-evidence/v1/sha256/{h(body)[:2]}/{h(body)}.tar.zst",
         "zstd_level":10,"bundled_file_count":1,"verified_at":"2026-11-24T10:00:00Z"}
    auth={"jobId":job,"caseSlug":"c1_u30","evidenceBase":"a0/evidence","receipt":{"brokeredUploadId":upload,
      "source":{"engineJobId":job,"engineCaseSlug":"c1_u30","solverId":job,"promiseId":upload},
      "remote":{"storedSha256":h(body),"storedByteSize":len(body),"tarSha256":record.tar_sha256,"tarByteSize":record.tar_size,
                "manifestSha256":h(manifest),"generation":row["generation"],"crc32c":crc}}}
    sidecars=["brokered_hub_binding.database.json","brokered_local_reclaim.intent.json","brokered_local_reclaim.json"]
    intent={"authorization":auth,"plannedPathCount":1,"paths":[{"name":dest.name}]}
    put(folder/sidecars[0],{"authorization":auth,"state":"hub_progressive_custody"})
    put(folder/sidecars[1],intent)
    put(folder/sidecars[2],{"authorization":auth,"state":"complete","deletedPaths":[dest.name],
                            "intentSha256":h((folder/sidecars[1]).read_bytes())})
    saved={k:(folder/k).read_bytes()for k in sidecars};packet={"receipt":row,"directory":name,"ordinaryUpload":upload,
             "ordinarySidecarSha256":{k:h(body)for k,body in saved.items()}}
    at_first=threading.Event();send_rest=threading.Event();fault=["generation"];calls=[]
    class Hub(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            assert self.headers["authorization"]=="Bearer isolated-local-engine" and row["generation"] in self.path
            b=body if fault[0]!="bytes" else body[:-1]+bytes([body[-1]^1])
            self.send_response(200);self.send_header("content-type","application/zstd");self.send_header("content-length",len(b))
            self.send_header("x-content-sha256",h(body));self.send_header("x-gcs-generation","1" if fault[0]=="generation"else row["generation"]);self.end_headers()
            self.wfile.write(b[:8]);self.wfile.flush()
            if fault[0]=="wait":at_first.set();assert send_rest.wait(8)
            self.wfile.write(b[8:])
        def log_message(self,*_):pass
    server=ThreadingHTTPServer(("127.0.0.1",0),Hub);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setattr(historical_raw_restore,"WORKER_GATEWAY",f"http://127.0.0.1:{server.server_port}")
    def restore(apply=True):return recover(volume,packet,"isolated-local-engine",apply)
    try:
        for v in ("generation","bytes"):
            fault[0]=v
            with pytest.raises((ValueError,OSError,RuntimeError)):restore()
            assert not dest.exists()
        fault[0]="valid";assert restore(False)["state"]=="verified-only" and not dest.exists()
        fault[0]="wait"
        with ThreadPoolExecutor(max_workers=1)as pool:
            fut=pool.submit(restore);assert at_first.wait(5);assert not dest.exists()
            # A foreign publisher cannot be overwritten even when it races a valid, fully checked source.
            dest.write_bytes(b"retained different original");send_rest.set()
            with pytest.raises(ValueError,match="different original"):fut.result()
        assert dest.read_bytes()==b"retained different original";dest.unlink()
        fault[0]="valid";answer=restore();assert answer["published"] and answer["memberCountIncludingManifest"]==2 and dest.read_bytes()==body
        hit=len(calls);assert restore()["state"]=="already-present" and len(calls)==hit
        assert all((folder/k).read_bytes()==v for k,v in saved.items())
    finally:send_rest.set();server.shutdown();thread.join();server.server_close()
