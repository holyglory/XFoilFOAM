"""Image and readback operations for rebuild-remote-solver-engine.sh's closed-archive gateway mode.

The shell entry point owns the deployment lock, source validation, admission, queue checks and service lifecycle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

HEX = re.compile(r"[0-9a-f]{64}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
BASE_MAIN = "7b43345c58f22d4a2901eae8a0a3425ed3e79619fc7d2e07c02f4b261e4073d1"
FILES = ("src/airfoilfoam/api/main.py", "src/airfoilfoam/historical_raw_restore.py")
FORMAT = (
    "{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|{{.State.StartedAt}}|"
    '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
)

# Check both the canonical sources shipped in the image and the Python package actually imported.
PROBE = r"""
import hashlib, importlib.util, json
from pathlib import Path
from airfoilfoam.provenance import application_source_files, application_source_sha256, installed_application_source_sha256
from airfoilfoam.config import get_settings
root=Path("/app")
names=("src/airfoilfoam/api/main.py","src/airfoilfoam/historical_raw_restore.py")
digest=lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
sources={n:digest(root/n) for n in names}
package=Path(importlib.util.find_spec("airfoilfoam").origin).parent
loaded={n:digest(package/Path(n).relative_to("src/airfoilfoam")) for n in names}
other=hashlib.sha256()
for path in application_source_files(root):
 name=path.relative_to(root).as_posix()
 if name not in names:
  other.update(name.encode()+b"\0"+path.read_bytes()+b"\0")
installed=hashlib.sha256()
for path in sorted(package.rglob("*")):
 if not path.is_file() or "__pycache__" in path.parts or path.suffix in (".pyc",".pyo"): continue
 name=path.relative_to(package).as_posix()
 if "src/airfoilfoam/"+name not in names:
  installed.update(name.encode()+b"\0"+path.read_bytes()+b"\0")
assert sources==loaded and installed_application_source_sha256()==application_source_sha256(root)
print(json.dumps({"modules":sources,"otherSources":other.hexdigest(),"otherInstalled":installed.hexdigest(),
                  "application":installed_application_source_sha256()}))
"""

# Probe the scheduled worker via the same authenticated queue inspection used for numerical maintenance.
QUEUE = r"""
import json,urllib.request
from airfoilfoam.config import get_settings
req=urllib.request.Request('http://127.0.0.1:8000/queue',headers={'Authorization':'Bearer '+(get_settings().control_plane_token or '')})
with urllib.request.urlopen(req,timeout=24) as r: data=json.load(r)
print(json.dumps({k:data.get(k) for k in ('worker_queues','worker_queues_error','worker_runtime_error','inspection_errors')}))
"""

# This runs in the serving gateway and calls its real HTTP file route. The registered worker and hub
# independently authorize the stable receipt and verify the full object generation.
READ = r"""
import base64,hashlib,json,re,sys,urllib.parse,urllib.request
from airfoilfoam.config import get_settings
doc=json.load(sys.stdin); directory=doc["directory"]; c=doc["receipt"]; sample=doc["member"]
assert re.fullmatch(r"[a-zA-Z0-9._/-]+",directory) and directory.startswith("cases/") and directory.endswith("/evidence")
assert all(p not in ("",".","..") for p in directory.split("/"))
assert re.fullmatch(r"[0-9a-f-]{36}",c["sim_job_id"]) and re.fullmatch(r"[1-9][0-9]{0,19}",c["generation"])
marker=base64.b64encode(json.dumps({"version":1,"directory":directory,"receipt":c},separators=(",",":")).encode()).decode()
assert len(marker)<=8192 and sample["path"].split("/",1)[0] in ("openfoam","time_directories","VTK")
token=get_settings().control_plane_token;assert token
out=[]
for name,sha,size in [("engine_evidence.tar.zst",c["stored_sha256"],c["stored_bytes"]),(sample["path"],sample["sha256"],sample["byteSize"])]:
 assert all(p not in ("",".","..") and "\\" not in p for p in name.split("/"))
 assert re.fullmatch("[0-9a-f]{64}",sha) and type(size) is int and size>=0
 url="http://127.0.0.1:8000/jobs/"+c["sim_job_id"]+"/files/"+urllib.parse.quote(directory+"/"+name,safe="/")
 req=urllib.request.Request(url,headers={"Authorization":"Bearer "+token,"x-historical-raw-preflight":marker,"Accept-Encoding":"identity"})
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args): return None
 with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(req,timeout=300) as response:
  assert response.status==200 and response.headers["x-historical-raw-source"]=="registered-hub"
  assert response.headers["x-gcs-generation"]==c["generation"] and response.headers["x-content-sha256"]==sha
  assert response.headers.get("content-length")==str(size) and not response.headers.get("content-encoding")
  h=hashlib.sha256();n=0
  while block:=response.read(1024**2):
   n+=len(block);assert n<=size;h.update(block)
  assert n==size and h.hexdigest()==sha
  out.append({"path":name,"bytes":n,"sha256":h.hexdigest(),"generation":c["generation"]})
print(json.dumps(out))
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args, data=None, timeout=60):
    command = subprocess.run(
        args, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout
    )
    if command.returncode:
        # The remote reader may handle a private token. Expose neither its invocation nor raw diagnostics.
        raise RuntimeError(f"{args[0]} {args[1]} failed with exit {command.returncode}")
    return command.stdout.strip()


def write(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as f:
        tmp = Path(f.name)
        try:
            json.dump(value, f, sort_keys=True, separators=(",", ":"))
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def private_json(path, maximum=32768):
    info = path.lstat()
    require(
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and info.st_uid == os.geteuid()
        and not info.st_mode & 0o022
        and 0 < info.st_size <= maximum,
        "unsafe local gateway receipt",
    )
    return json.loads(path.read_bytes())


def service(name, project):
    value = run("docker", "inspect", "--format", FORMAT, name).split("|")
    require(
        len(value) == 7
        and HEX.fullmatch(value[0])
        and IMAGE.fullmatch(value[1])
        and value[3] == "true"
        and value[5] == project
        and value[6] in ("api", "worker"),
        "gateway or worker is outside the running Compose project",
    )
    return dict(zip(("id", "image", "imageRef", "running", "startedAt", "project", "service"), value))


def exec_python(container, code, data=None, timeout=70):
    return json.loads(
        run("docker", "exec", "-i", container, "python", "-IB", "-c", code, data=data, timeout=timeout)
    )


def compare_candidate(base, candidate, wanted):
    require(
        candidate["modules"] == wanted
        and candidate["otherSources"] == base["otherSources"]
        and candidate["otherInstalled"] == base["otherInstalled"]
        and candidate["application"] != base["application"],
        "gateway image changed outside the two reviewed modules",
    )


def checked_tag(ref, image):
    require(
        run("docker", "image", "inspect", "--format", "{{.Id}}", ref) == image,
        "local gateway image reference changed",
    )


def rollback_image_holder(old, project, *, create):
    # The host prunes unused images by age. A never-started, networkless
    # container retains the exact old image during a lost-response recovery.
    name = project + "-historical-reader-rollback-" + old["id"][:20]
    ids = run(
        "docker",
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "name=^/" + name + "$",
        "--format",
        "{{.ID}}",
    )
    if not ids and create:
        ids = run(
            "docker",
            "container",
            "create",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--label",
            "com.docker.compose.project=" + project + "-reader-rollback",
            "--label",
            "com.docker.compose.service=rollback-hold",
            "--label",
            "airfoilfoam.rollback-gateway=" + old["id"],
            "--entrypoint",
            "python",
            old["image"],
            "-V",
        )
    if not ids:
        return None
    require(HEX.fullmatch(ids), "ambiguous rollback image holder")
    form = (
        "{{.Id}}|{{.Image}}|{{.State.Status}}|{{.HostConfig.NetworkMode}}|{{len .Mounts}}|"
        '{{index .Config.Labels "airfoilfoam.rollback-gateway"}}'
    )
    got = run("docker", "container", "inspect", "--format", form, name).split("|")
    require(got == [ids, old["image"], "created", "none", "0", old["id"]], "rollback image holder changed")
    return ids


def require_worker(gateway, worker, expected_hash, build):
    import runpy

    verify = runpy.run_path(str(Path(__file__).with_name("verify-numerics2-workers.py")))["verify"]
    actual = run("docker", "exec", worker["id"], "cat", "/etc/airfoilfoam-application-source-sha256")
    require(
        actual == expected_hash and HEX.fullmatch(actual),
        "physical worker source differs from the captured numerical build",
    )
    return verify(exec_python(gateway["id"], QUEUE), build, actual, 1)


def operate(a):
    state_file, app = a.state, a.app
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    wanted = {name: digest(app / name) for name in FILES}
    control = {
        name: digest(Path(__file__).with_name(name))
        for name in (
            "hz-historical-raw-gateway.py",
            "historical-raw-gateway.Dockerfile",
            "historical-raw-gateway-maintenance.sh",
            "rebuild-remote-solver-engine.sh",
            "openfoam_process_guard.py",
            "verify-numerics2-workers.py",
            "validate-remote-solver-compose.py",
            "numerics2-maintenance.sh",
        )
    }
    worker = service(a.project + "-worker-1", a.project)
    require(worker["service"] == "worker", "missing original solver worker")
    existing = private_json(state_file) if state_file.exists() else None
    if a.action == "capture" and existing and existing["phase"] == "restored":
        # Preserve the first attempt and its exact recovery before taking a new baseline.
        recovered = existing["restoredGateway"]
        require(
            service(a.project + "-api-1", a.project) == recovered, "recovered gateway no longer matches"
        )
        history = state_file.with_name(state_file.stem + "-restored-" + recovered["id"] + ".json")
        if history.exists():
            require(private_json(history) == existing, "different retained recovery receipt")
        else:
            write(history, existing)
        existing = None
    if a.action == "capture" and existing is None:
        gateway = service(a.project + "-api-1", a.project)
        require(
            gateway["service"] == "api"
            and gateway["imageRef"] in {a.project + "-api", a.project + "-api:latest"},
            "serving gateway is outside its canonical Compose image reference",
        )
        checked_tag(gateway["imageRef"], gateway["image"])
        before = exec_python(gateway["id"], PROBE)
        require(
            before["modules"] == {FILES[0]: BASE_MAIN, FILES[1]: None},
            "unqualified original gateway source",
        )
        whash = run("docker", "exec", worker["id"], "cat", "/etc/airfoilfoam-application-source-sha256")
        numerical = require_worker(gateway, worker, whash, a.build)
        base_ref = a.project + "-raw-reader-base:" + gateway["image"].split(":")[1]
        candidate_ref = (
            a.project
            + "-raw-reader:"
            + hashlib.sha256(json.dumps([gateway["image"], wanted], sort_keys=True).encode()).hexdigest()
        )
        existing = {
            "version": 1,
            "phase": "captured",
            "build": a.build,
            "project": a.project,
            "base": gateway,
            "worker": worker,
            "workerNumerical": numerical,
            "baseRef": base_ref,
            "before": before,
            "wanted": wanted,
            "control": control,
            "candidateRef": candidate_ref,
        }
        write(state_file, existing)
    require(
        existing
        and existing["version"] == 1
        and existing["project"] == a.project
        and existing["build"] == a.build
        and existing["worker"] == worker
        and existing["wanted"] == wanted
        and existing["control"] == control,
        "maintenance state, reviewed reader or original worker changed",
    )
    old = existing["base"]
    if a.action == "build" and not existing.get("candidate"):
        gateway = service(a.project + "-api-1", a.project)
        require(gateway == old, "original gateway changed before image preparation")
        checked_tag(old["imageRef"], old["image"])
        require_worker(gateway, worker, existing["workerNumerical"]["application_source_sha256"], a.build)
        base_ref, candidate_ref, before = (
            existing["baseRef"],
            existing["candidateRef"],
            existing["before"],
        )
        run("docker", "image", "tag", gateway["image"], base_ref)
        with tempfile.TemporaryDirectory(prefix="historical-raw-gateway-") as tmp:
            root = Path(tmp)
            shutil.copyfile(
                Path(__file__).with_name("historical-raw-gateway.Dockerfile"), root / "Dockerfile"
            )
            for name in FILES:
                shutil.copyfile(app / name, root / Path(name).name)
            run(
                "docker",
                "build",
                "--pull=false",
                "--network=none",
                "--build-arg",
                "GATEWAY_BASE=" + base_ref,
                "-t",
                candidate_ref,
                str(root),
                timeout=600,
            )
        candidate = run("docker", "image", "inspect", "--format", "{{.Id}}", candidate_ref)
        require(IMAGE.fullmatch(candidate) and candidate != gateway["image"], "candidate image unavailable")
        qualified = json.loads(
            run(
                "docker",
                "run",
                "--rm",
                "--network=none",
                "--read-only",
                "--entrypoint",
                "python",
                candidate,
                "-IB",
                "-c",
                PROBE,
            )
        )
        compare_candidate(before, qualified, wanted)
        existing.update(phase="built", reader=qualified, candidate=candidate)
        write(state_file, existing)
    if existing.get("candidate") and a.action not in (
        "capture",
        "original",
        "phase",
        "restore-tag",
        "verify-original",
        "release-holder",
    ):
        checked_tag(existing["baseRef"], old["image"])
        checked_tag(existing["candidateRef"], existing["candidate"])
    if a.action in ("bind-canary", "verify"):
        canary = private_json(a.canary)
        c = canary["receipt"]
        member = canary["member"]
        require(
            isinstance(c, dict)
            and HEX.fullmatch(c["stored_sha256"])
            and HEX.fullmatch(c["manifest_sha256"])
            and re.fullmatch(r"[0-9a-f-]{36}", c["sim_job_id"])
            and re.fullmatch("[1-9][0-9]{0,19}", c["generation"])
            and type(c["stored_bytes"]) is int
            and 0 < c["stored_bytes"] <= 1024**3
            and HEX.fullmatch(member["sha256"])
            and type(member["byteSize"]) is int
            and member["byteSize"] >= 0
            and member["path"].split("/", 1)[0] in ("openfoam", "time_directories", "VTK")
            and re.fullmatch(r"cases/[a-zA-Z0-9._/-]+/evidence", canary["directory"])
            and all(
                p not in ("", ".", "..") and "\\" not in p
                for name in (canary["directory"], member["path"])
                for p in name.split("/")
            ),
            "invalid registered canary identity",
        )
        canary_digest = hashlib.sha256(
            json.dumps(canary, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if a.action == "bind-canary" and not existing.get("canarySha256"):
            existing["canarySha256"] = canary_digest
            write(state_file, existing)
        require(
            existing.get("canarySha256") == canary_digest,
            "registered canary differs from the pre-switch source",
        )
    if a.action in ("capture", "original"):
        current = service(a.project + "-api-1", a.project)
        require(current == old, "original file gateway changed before switch")
        checked_tag(old["imageRef"], old["image"])
        require_worker(current, worker, existing["workerNumerical"]["application_source_sha256"], a.build)
    elif a.action in ("select", "restore-tag"):
        tag = run("docker", "image", "inspect", "--format", "{{.Id}}", old["imageRef"])
        require(tag in (old["image"], existing["candidate"]), "serving tag belongs to a different release")
        target = existing["candidate"] if a.action == "select" else old["image"]
        if a.action == "select":
            existing["rollbackHolder"] = rollback_image_holder(old, a.project, create=True)
        existing["phase"] = "switching" if a.action == "select" else "rolling-back"
        write(state_file, existing)
        run("docker", "image", "tag", target, old["imageRef"])
        checked_tag(old["imageRef"], target)
    elif a.action in ("verify", "attest", "verify-original"):
        current = service(a.project + "-api-1", a.project)
        target = old["image"] if a.action == "verify-original" else existing["candidate"]
        require(
            current["service"] == "api"
            and current["image"] == target
            and current["imageRef"] == old["imageRef"],
            "serving gateway image differs",
        )
        checked_tag(old["imageRef"], target)
        actual = exec_python(current["id"], PROBE)
        require(
            actual == (existing["before"] if a.action == "verify-original" else existing["reader"]),
            "serving module identity differs",
        )
        require_worker(current, worker, existing["workerNumerical"]["application_source_sha256"], a.build)
        if a.action == "verify":
            readback = exec_python(current["id"], READ, json.dumps(canary), timeout=750)
            require(len(readback) == 2, "incomplete registered archive readback")
            existing.update(phase="verified", gateway=current, readback=readback)
        elif a.action == "attest":
            require(
                existing["phase"] == "verified"
                and existing["gateway"] == current
                and len(existing["readback"]) == 2,
                "serving gateway differs from the completed registered read",
            )
        else:
            existing.update(phase="restored", restoredGateway=current)
        write(state_file, existing)
    if a.action == "release-holder":
        holder = rollback_image_holder(old, a.project, create=False)
        if holder:
            require(existing.get("rollbackHolder", holder) == holder, "recorded rollback container differs")
            current = service(a.project + "-api-1", a.project)
            target = existing["candidate"] if existing["phase"] == "verified" else old["image"]
            require(
                current["image"] == target
                and existing["phase"] in ("captured", "built", "restored", "verified"),
                "gateway recovery is incomplete",
            )
            run("docker", "container", "rm", holder)
    if a.action == "phase":
        print(existing["phase"])
        return
    print(
        json.dumps(
            {
                "phase": existing["phase"],
                "workerId": worker["id"],
                "originalImage": old["image"],
                "qualifiedImage": existing.get("candidate"),
                "readback": existing.get("readback"),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "capture",
            "bind-canary",
            "build",
            "original",
            "select",
            "restore-tag",
            "verify",
            "attest",
            "verify-original",
            "release-holder",
            "phase",
        ),
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--canary", type=Path)
    args = parser.parse_args()
    try:
        operate(args)
    except (OSError, KeyError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise SystemExit("Historical file gateway refused: " + str(exc)[:300])
