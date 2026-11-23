"""Generate a real, small archived source and replay the normal point-level receipt for the sweeper test."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

import google_crc32c
import zstandard

from airfoilfoam.evidence_runtime import BrokeredRemoteEvidenceReclaim, reclaim_brokered_remote_evidence

volume, job, action = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
root = volume / "jobs" / job
case = root / "cases/foil"
post = case / "transient_a0"
evidence = case / "a0/evidence"

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

def sha(data):
    return hashlib.sha256(data).hexdigest()

if action == "bind":
    signed = json.load(sys.stdin)
    result = reclaim_brokered_remote_evidence(root, evidence, BrokeredRemoteEvidenceReclaim(
        job_id=job, case_slug="foil", evidence_base="a0/evidence",
        receipt=signed["receipt"], receipt_hmac=signed["receiptHmac"]))
    assert result.state in {"complete","no_local_bytes"}
    assert not (evidence/"engine_evidence.tar.zst").exists()
    print(json.dumps({"state":result.state}))
else:
    assert action in {"good", "bad-member"}
    write(root/".execute.lock", b"")
    write(root/"request.json", json.dumps({"execution_id":job}).encode())
    archived = {
        "openfoam/postProcessing/forceCoeffs/0/coefficient.dat": b"# Time Cl Cd Cm\n0.01 0.42 0.02 -0.03\n0.02 0.43 0.018 -0.03\n",
        "openfoam/logs/transient_a0/log.pimpleFoam": b"Time = 0.02\nsolver stopped with finite non-converged evidence\n",
    }
    for name,data in archived.items():
        write(evidence/name,data)
    write(post/"postProcessing/forceCoeffs/0/coefficient.dat", next(iter(archived.values())))
    write(post/"log.pimpleFoam", archived["openfoam/logs/transient_a0/log.pimpleFoam"])
    write(post/"0.5/U", b"unarchived original field")
    write(post/"1/U", b"latest velocity")
    write(post/"1/p", b"latest pressure")
    manifest = {"schemaVersion":2,"methodKey":"openfoam.urans","unsteady":True,"casePath":str(case),"postPath":str(post),
                "files":[{"path":n,"byteSize":len(b),"sha256":sha(b)} for n,b in archived.items()],
                "bundleExcludes":["frames"],"media":{"instantaneous":{},"mean":{},"video":{}}}
    raw = json.dumps(manifest,sort_keys=True).encode()
    write(evidence/"evidence_manifest.json",raw)
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload,mode="w") as tar:
        for name,body in {"evidence_manifest.json":raw,**archived}.items():
            if action=="bad-member" and name.endswith("coefficient.dat"):
                body=b"x"*len(body)  # the signed outer bytes are authentic; the inner manifest is wrong
            info=tarfile.TarInfo(name)
            info.size=len(body)
            tar.addfile(info,io.BytesIO(body))
    tar_bytes=payload.getvalue()
    compressed=zstandard.ZstdCompressor(level=10).compress(tar_bytes)
    write(evidence/"engine_evidence.tar.zst",compressed)
    write(volume/(job+".tar.zst"),compressed)
    artifacts=[{"kind":"manifest","path":"a0/evidence/evidence_manifest.json","sha256":sha(raw),"byte_size":len(raw)},
               {"kind":"engine_bundle","path":"a0/evidence/engine_evidence.tar.zst","sha256":sha(compressed),"byte_size":len(compressed)}]
    write(root/"status.json",json.dumps({"job_id":job,"state":"cancelled","completed_cases":1}).encode())
    write(root/"result.json",json.dumps({"job_id":job,"state":"cancelled","polars":[{"attempts":[{"case_slug":"foil",
          "aoa_deg":0,"cl":0.43,"cd":0.018,"cm":-0.03,"converged":False,"images":{},"evidence_artifacts":artifacts}]}]}).encode())
    print(json.dumps({"bucket":"fixture-bucket","objectKey":"solver-evidence/v1/"+sha(compressed)+".tar.zst",
                      "generation":"18446744073709551614","storedSha256":sha(compressed),"storedByteSize":len(compressed),
                      "tarSha256":sha(tar_bytes),"tarByteSize":len(tar_bytes),"manifestSha256":sha(raw),"manifestByteSize":len(raw),
                      "crc32c":base64.b64encode(google_crc32c.Checksum(compressed).digest()).decode(),"zstdLevel":10,
                      "bundledFileCount":len(archived)}))
