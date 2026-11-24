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
FILES = ("src/airfoilfoam/api/main.py", "src/airfoilfoam/historical_raw_restore.py", "src/airfoilfoam/working_file_restore.py")
# The W23–W39 journal for the original, never-selected historical reader.
HISTORICAL_TARGET = {FILES[0]: "36eff9406d199fc292fabbe135656b94f4dd9dba96287841bc7c44186dcd3dfb",
                     FILES[1]: "a908d6dd9574de621ddb6cce6675738115e614c6228c0993ea65f98b88872f1f"}
PREVIOUS_CONTROL = "a65d0fc32b88b770c8b250a99fff438fa4275556dc17108fcfb78b0a48da3c7b"
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
names=("src/airfoilfoam/api/main.py","src/airfoilfoam/historical_raw_restore.py","src/airfoilfoam/working_file_restore.py")
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
# Keep the exact original proof representation on the previously captured gateway.
if sources[names[2]] is None: del sources[names[2]]
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


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sync_directory(path):
    fd = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def replace_bytes(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
        sync_directory(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def write(path, value):
    replace_bytes(path, json_bytes(value))


def private_bytes(path, maximum=32768):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as f:
        info = os.fstat(f.fileno())
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_nlink == 1
            and info.st_uid == os.geteuid()
            and not info.st_mode & 0o022
            and 0 < info.st_size <= maximum,
            "unsafe local gateway receipt",
        )
        data = f.read(maximum + 1)
        require(len(data) == info.st_size, "gateway receipt changed during read")
        return data


def private_json(path, maximum=32768):
    return json.loads(private_bytes(path, maximum))


# The reviewed W23 writer emitted these exact fields and this operator-source manifest.
LEGACY_SERVICE_FIELDS = {"id", "image", "imageRef", "project", "running", "service", "startedAt"}
LEGACY_CAPTURE_FIELDS = {
    "version",
    "phase",
    "project",
    "build",
    "base",
    "worker",
    "baseRef",
    "before",
    "candidateRef",
    "workerNumerical",
    "wanted",
    "control",
}
LEGACY_CONTROL_SHA256 = "4a9a574815c6ab1f6628c2938c5645212e100e50bfa2d10e12e534254975516b"


def capture_directory(journal, original_sha):
    require(
        isinstance(original_sha, str) and HEX.fullmatch(original_sha), "invalid original capture digest"
    )
    return journal.with_name(journal.stem + "-capture-" + original_sha)


def check_transition(journal, current):
    original_sha = current["originalCaptureSha256"]
    archive = capture_directory(journal, original_sha)
    info = archive.lstat()
    require(
        stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
        "unsafe capture transition directory",
    )
    require(
        {p.name for p in archive.iterdir()} == {"original.json", "sealed.json", "transition.json"},
        "incomplete capture transition",
    )
    original = private_bytes(archive / "original.json")
    sealed = private_bytes(archive / "sealed.json")
    proof = private_json(archive / "transition.json")
    require(
        hashlib.sha256(original).hexdigest() == original_sha == proof["originalSha256"]
        and hashlib.sha256(sealed).hexdigest() == proof["sealedSha256"],
        "capture transition bytes differ",
    )
    before = json.loads(original)
    after = json.loads(sealed)
    require(
        set(before) == LEGACY_CAPTURE_FIELDS
        and before["phase"] == after["phase"] == "captured"
        and hashlib.sha256(json_bytes(before["control"]).rstrip(b"\n")).hexdigest() == LEGACY_CONTROL_SHA256
        and set(after) == LEGACY_CAPTURE_FIELDS | {"originalCaptureSha256", "captureBindingSha256"}
        and after["originalCaptureSha256"] == original_sha
        and set(proof)
        == {"originalSha256", "sealedSha256", "composeConfigHash", "originalOperatorSha256", "drain"}
        and proof["composeConfigHash"] == after["base"]["configHash"]
        and proof["originalOperatorSha256"] == LEGACY_CONTROL_SHA256
        and hashlib.sha256(json_bytes({k: v for k, v in proof.items() if k != "sealedSha256"})).hexdigest()
        == after["captureBindingSha256"],
        "unrecognized capture predecessor",
    )
    for key in before.keys() - {"control", "base", "worker"}:
        require(before[key] == after[key], "capture transition changed an original field")
    for key in ("base", "worker"):
        require(
            set(before[key]) == LEGACY_SERVICE_FIELDS
            and set(after[key]) == LEGACY_SERVICE_FIELDS | {"configHash", "runtimeContract"}
            and all(after[key][f] == before[key][f] for f in LEGACY_SERVICE_FIELDS),
            "capture transition changed an original service",
        )
    require(
        all(current.get(k) == after[k] for k in after.keys() - {"phase"}),
        "current journal differs from sealed capture",
    )
    return sealed


def publish_transition(archive, original, sealed, proof):
    if archive.exists() or archive.is_symlink():
        # A previous process may have stopped between rename and the directory fsync.
        # Make the published predecessor durable before the caller replaces the journal.
        sync_directory(archive.parent)
        return
    # Rename a fully fsynced directory. A crash cannot publish a partial predecessor or transition.
    with tempfile.TemporaryDirectory(dir=archive.parent, prefix=".gateway-transition-") as tmp:
        stage = Path(tmp) / "record"
        stage.mkdir(mode=0o700)
        replace_bytes(stage / "original.json", original)
        replace_bytes(stage / "sealed.json", sealed)
        write(stage / "transition.json", proof)
        sync_directory(stage)
        os.rename(stage, archive)
        sync_directory(archive.parent)


def legacy_drain_flags(a):
    keys = {
        "PENDING",
        "KIND",
        "PHASE",
        "TARGET_BUILD_ID",
        "SOURCE_REVISION",
        "SOURCE_TREE_SHA256",
        "POOL_2406_WAS_ENABLED",
        "POOL_2606_WAS_ENABLED",
        "POOL_NUMERICS2_WAS_ENABLED",
        "SWEEPER_WAS_RUNNING",
        "MEDIA_REPAIR_WAS_RUNNING",
        "TRANSFER_PAUSED",
    }
    flags = {}
    prefix = "REMOTE_SOLVER2606_DRAIN_"
    require(a.drain_env is not None, "missing captured drain environment")
    with a.drain_env.open(encoding="utf8") as f:
        for line in f:
            name, sep, value = line.rstrip("\n").partition("=")
            if sep and name.startswith(prefix) and name[len(prefix) :] in keys:
                key = name[len(prefix) :]
                require(key not in flags, "ambiguous captured drain controls")
                flags[key] = value
    require(
        set(flags) == keys
        and (flags["PENDING"], flags["KIND"], flags["PHASE"], flags["TARGET_BUILD_ID"])
        == ("1", "historical-raw-gateway", "draining", a.build)
        and re.fullmatch("[0-9a-f]{40}", flags["SOURCE_REVISION"])
        and HEX.fullmatch(flags["SOURCE_TREE_SHA256"]),
        "original capture requires its exact pending drain",
    )
    require(
        a.pool_state == "false|false|false"
        and flags["TRANSFER_PAUSED"] == a.transfer_state in ("true", "false")
        and flags["SWEEPER_WAS_RUNNING"] == a.sweeper_state in ("0", "1")
        and flags["MEDIA_REPAIR_WAS_RUNNING"] == a.media_state in ("0", "1")
        and all(flags[k] in ("true", "false") for k in keys if k.startswith("POOL_")),
        "live pool, transfer or writer state differs from the captured drain",
    )
    return flags


def bind_legacy_capture(a, original, existing, wanted, control, worker):
    require(
        a.action == "bind-original"
        and set(existing) == LEGACY_CAPTURE_FIELDS
        and existing["version"] == 1
        and existing["phase"] == "captured"
        and existing["project"] == a.project
        and existing["build"] == a.build
        and existing["wanted"] == wanted
        and hashlib.sha256(json_bytes(existing["control"]).rstrip(b"\n")).hexdigest()
        == LEGACY_CONTROL_SHA256,
        "unsupported legacy capture or operator source",
    )
    flags = legacy_drain_flags(a)
    gateway = service(a.project + "-api-1", a.project)
    for key, live, role in (("base", gateway, "api"), ("worker", worker, "worker")):
        require(
            set(existing[key]) == LEGACY_SERVICE_FIELDS
            and live["service"] == role
            and {k: live[k] for k in LEGACY_SERVICE_FIELDS} == existing[key]
            and HEX.fullmatch(live["configHash"])
            and HEX.fullmatch(live["runtimeContract"]),
            "original captured gateway or worker was replaced",
        )
    require(
        gateway["configHash"] == a.config_hash
        and gateway["imageRef"] in {a.project + "-api", a.project + "-api:latest"}
        and existing["baseRef"] == a.project + "-raw-reader-base:" + gateway["image"].split(":")[1]
        and existing["candidateRef"]
        == a.project
        + "-raw-reader:"
        + hashlib.sha256(json.dumps([gateway["image"], wanted], sort_keys=True).encode()).hexdigest(),
        "legacy Compose or image binding differs",
    )
    checked_tag(gateway["imageRef"], gateway["image"])
    require(
        exec_python(gateway["id"], PROBE) == existing["before"]
        and existing["before"]["modules"] == {FILES[0]: BASE_MAIN, FILES[1]: None},
        "original gateway application or installed module proof changed",
    )
    require(
        require_worker(gateway, worker, existing["workerNumerical"]["application_source_sha256"], a.build)
        == existing["workerNumerical"],
        "original registered numerical worker proof changed",
    )
    old_sha = hashlib.sha256(original).hexdigest()
    binding = {
        "originalSha256": old_sha,
        "composeConfigHash": a.config_hash,
        "originalOperatorSha256": LEGACY_CONTROL_SHA256,
        "drain": flags,
    }
    updated = {
        **existing,
        "base": gateway,
        "worker": worker,
        "control": control,
        "originalCaptureSha256": old_sha,
        "captureBindingSha256": hashlib.sha256(json_bytes(binding)).hexdigest(),
    }
    sealed = json_bytes(updated)
    archive = capture_directory(a.state, old_sha)
    proof = {**binding, "sealedSha256": hashlib.sha256(sealed).hexdigest()}
    publish_transition(archive, original, sealed, proof)
    require(
        check_transition(a.state, updated) == sealed
        and private_json(archive / "transition.json") == proof
        and service(a.project + "-api-1", a.project) == gateway
        and service(a.project + "-worker-1", a.project) == worker
        and private_bytes(a.state) == original,
        "original capture changed before atomic seal",
    )
    replace_bytes(a.state, sealed)
    return updated


def check_reader_predecessor(journal, current):
    previous_sha = current["previousReaderCaptureSha256"]
    require(HEX.fullmatch(previous_sha), "invalid prior file-reader capture")
    archive = capture_directory(journal, previous_sha)
    st = archive.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid() and not st.st_mode & 0o077
            and {p.name for p in archive.iterdir()} == {"original.json", "sealed.json", "transition.json"},
            "invalid working-file capture predecessor directory")
    prior_bytes = private_bytes(archive / "original.json")
    sealed = private_bytes(archive / "sealed.json")
    record = private_json(archive / "transition.json")
    old, new = json.loads(prior_bytes), json.loads(sealed)
    require(hashlib.sha256(prior_bytes).hexdigest() == previous_sha and record == {
        "kind": "working-file-reader", "previousSha256": previous_sha, "newSha256": hashlib.sha256(sealed).hexdigest()
    } and old["phase"] == new["phase"] == "captured" and old["wanted"] == HISTORICAL_TARGET
        and set(new) == LEGACY_CAPTURE_FIELDS | {"previousReaderCaptureSha256"}
        and new["previousReaderCaptureSha256"] == previous_sha
        and all(new[k] == old[k] for k in LEGACY_CAPTURE_FIELDS - {"wanted", "candidateRef", "control"})
        and all(current.get(k) == new[k] for k in new if k != "phase"),
        "captured working-file reader predecessor differs")
    if "originalCaptureSha256" in old:
        check_transition(journal, old)
    return sealed


def advance_unselected_reader(a, raw, old, wanted, control, worker):
    # The shell enters capture before opening its own drain. Never retarget a live
    # or previously selected image, an issued canary, or another operator's phase.
    valid_fields = (LEGACY_CAPTURE_FIELDS, LEGACY_CAPTURE_FIELDS | {"originalCaptureSha256", "captureBindingSha256"})
    require(a.action == "capture" and old["phase"] == "captured"
            and set(old) in valid_fields and old["wanted"] == HISTORICAL_TARGET and old["version"] == 1
            and old["project"] == a.project and old["build"] == a.build and old["worker"] == worker
            and old["base"]["configHash"] == a.config_hash
            and old["before"]["modules"] == {FILES[0]: BASE_MAIN, FILES[1]: None}
            and (hashlib.sha256(json_bytes(old["control"]).rstrip(b"\n")).hexdigest() == PREVIOUS_CONTROL
                 or old["control"] == control), "unrecognized or active original reader candidate")
    gw = service(a.project + "-api-1", a.project)
    checked_tag(old["base"]["imageRef"], old["base"]["image"])
    require(gw == old["base"] and exec_python(gw["id"], PROBE) == old["before"] and
            require_worker(gw, worker, old["workerNumerical"]["application_source_sha256"], a.build) == old["workerNumerical"],
            "capture no longer describes the serving gateway and numerical worker")
    previous_sha = hashlib.sha256(raw).hexdigest()
    updated = {k:old[k] for k in LEGACY_CAPTURE_FIELDS}
    updated.update(previousReaderCaptureSha256=previous_sha, control=control, wanted=wanted,
                   candidateRef=a.project + "-raw-reader:" + hashlib.sha256(json.dumps([gw["image"], wanted], sort_keys=True).encode()).hexdigest())
    sealed = json_bytes(updated)
    publish_transition(capture_directory(a.state, previous_sha), raw, sealed,
                       {"kind":"working-file-reader","previousSha256":previous_sha,"newSha256":hashlib.sha256(sealed).hexdigest()})
    require(check_reader_predecessor(a.state, updated) == sealed and private_bytes(a.state) == raw
            and service(a.project + "-api-1", a.project) == gw and service(a.project + "-worker-1", a.project) == worker,
            "file reader changed before sealing its next target")
    replace_bytes(a.state, sealed)
    return updated


def runtime_contract(container):
    # Hash effective settings on the deployment host. Values, including server
    # credentials, are never written to a receipt or diagnostic.
    cfg, host, mounts = (
        json.loads(line)
        for line in run(
            "docker",
            "inspect",
            "--format",
            "{{json .Config}}\n{{json .HostConfig}}\n{{json .Mounts}}",
            container,
        ).splitlines()
    )
    config = {
        k: cfg.get(k)
        for k in (
            "Entrypoint",
            "Cmd",
            "User",
            "WorkingDir",
            "Healthcheck",
            "ExposedPorts",
            "Volumes",
            "StopSignal",
            "StopTimeout",
            "Tty",
            "OpenStdin",
        )
    }
    config["Env"] = sorted(cfg.get("Env") or [])
    resources = {
        k: host.get(k)
        for k in (
            "NetworkMode",
            "PortBindings",
            "RestartPolicy",
            "ReadonlyRootfs",
            "Ulimits",
            "CapAdd",
            "CapDrop",
            "SecurityOpt",
            "Privileged",
            "PidsLimit",
            "NanoCpus",
            "CpuQuota",
            "CpuPeriod",
            "CpusetCpus",
            "Memory",
            "MemorySwap",
            "Binds",
            "Devices",
            "Tmpfs",
        )
    }
    volumes = sorted(
        (
            {k: m.get(k) for k in ("Type", "Source", "Destination", "Name", "RW", "Propagation")}
            for m in mounts
        ),
        key=lambda m: m["Destination"],
    )
    return hashlib.sha256(
        json.dumps([config, resources, volumes], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


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
    result = dict(zip(("id", "image", "imageRef", "running", "startedAt", "project", "service"), value))
    result["configHash"] = run(
        "docker",
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.config-hash"}}',
        result["id"],
    )
    require(HEX.fullmatch(result["configHash"]), "missing Compose service identity")
    result["runtimeContract"] = runtime_contract(result["id"])
    return result


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
        "gateway image changed outside the reviewed file-reader modules",
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


def working_canary(value):
    w = value.get("workingFile")
    require(isinstance(w, dict) and set(w) == {"job", "path", "byteSize", "sha256", "generation", "planSha256"}
            and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", w["job"])
            and re.fullmatch(r"cases/[A-Za-z0-9][A-Za-z0-9_.+-]*(?:/[A-Za-z0-9][A-Za-z0-9_.+-]*){2,}", w["path"])
            and w["job"] != (value.get("receipt") or {}).get("sim_job_id") and HEX.fullmatch(w["planSha256"])
            and not any(q.lower() in {"evidence","frames","images","polymesh","meshes"} or q.startswith(("processor","core."))
                        for q in w["path"].split("/")[2:])
            and type(w["byteSize"]) is int and 0 < w["byteSize"] <= 128 * 1024**2
            and HEX.fullmatch(w["sha256"]) and re.fullmatch(r"[1-9][0-9]{0,19}", w["generation"])
            and int(w["generation"]) < 2**64, "invalid original working-file canary")
    return w


WORKING_READ = r"""
import hashlib,json,sys,urllib.request,urllib.parse
from pathlib import Path
v=json.load(sys.stdin)
job=v['job'];path=v['path'];target=Path('/data/airfoilfoam/jobs')/job/path
assert not target.exists() and not target.is_symlink()
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*_):return None
q='/'.join(urllib.parse.quote(s,safe='')for s in path.split('/'))
rows=[]
for origin,url in [('engine','http://127.0.0.1:8000/jobs/'+job+'/files/'+q),('node-api','http://node-api:4000/api/media/jobs/'+job+'/'+q)]:
 with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(url,timeout=300)as s:
  assert s.status==200 and int(s.headers['content-length'])==v['byteSize']
  if origin=='engine':assert s.headers['x-gcs-generation']==v['generation'] and s.headers['x-content-sha256']==v['sha256'] and s.headers['x-working-file-plan']==v['planSha256']
  h=hashlib.sha256();n=0
  while part:=s.read(1024*1024):
   n+=len(part);assert n<=v['byteSize'];h.update(part)
  assert n==v['byteSize'] and h.hexdigest()==v['sha256'];rows.append({'route':origin,'bytes':n,'sha256':h.hexdigest()})
assert not target.exists();print(json.dumps({'generation':v['generation'],'routes':rows}))
"""


def operate(a):
    if a.action == "check-working-canary":
        value = private_json(a.canary)
        working_canary(value)
        require("receipt" in value and "member" in value, "original historical canary is also required")
        return
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
    original = private_bytes(state_file) if state_file.exists() or state_file.is_symlink() else None
    existing = json.loads(original) if original is not None else None
    if a.action == "bind-original":
        require(
            existing and existing.get("phase") == "captured",
            "original identity binding requires a captured gateway",
        )
        legacy_drain_flags(a)
    if existing and (
        set(existing["base"]) == LEGACY_SERVICE_FIELDS or set(existing["worker"]) == LEGACY_SERVICE_FIELDS
    ):
        verified_target = HISTORICAL_TARGET if existing.get("wanted") == HISTORICAL_TARGET else wanted
        existing = bind_legacy_capture(a, original, existing, verified_target, control, worker)
    if existing and "originalCaptureSha256" in existing:
        check_transition(state_file, existing)
    if existing and existing.get("wanted") == HISTORICAL_TARGET and existing["phase"] == "captured":
        if a.action == "capture":
            existing = advance_unselected_reader(a, private_bytes(state_file), existing, wanted, control, worker)
        elif a.action in ("phase", "bind-original", "original"):
            # An old capture can still establish its original identity or recover. No image selection.
            wanted = HISTORICAL_TARGET
            if hashlib.sha256(json_bytes(existing["control"]).rstrip(b"\n")).hexdigest() == PREVIOUS_CONTROL:
                control = existing["control"]
    if existing and "previousReaderCaptureSha256" in existing:
        check_reader_predecessor(state_file, existing)
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
        require(
            gateway["configHash"] == a.config_hash, "running gateway has a different Compose specification"
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
    require(
        old["configHash"] == a.config_hash,
        "canonical Compose gateway configuration differs from the original",
    )
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
    if a.action in ("select", "build") and existing.get("candidate"):
        checked_tag(existing["baseRef"], old["image"])
        checked_tag(existing["candidateRef"], existing["candidate"])
    if a.action in ("bind-canary", "verify"):
        canary = private_json(a.canary)
        c = canary["receipt"]
        member = canary["member"]
        if getattr(a, "new_working_reader", False) or "workingFile" in canary:
            working_canary(canary)
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
    if a.action in ("capture", "original", "bind-original"):
        current = service(a.project + "-api-1", a.project)
        require(current == old, "original file gateway changed before switch")
        checked_tag(old["imageRef"], old["image"])
        require(
            require_worker(
                current, worker, existing["workerNumerical"]["application_source_sha256"], a.build
            )
            == existing["workerNumerical"],
            "original numerical worker proof differs",
        )
        if a.action == "bind-original":
            require(
                exec_python(current["id"], PROBE) == existing["before"],
                "sealed original gateway proof differs",
            )
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
            and current["imageRef"] == old["imageRef"]
            and current["runtimeContract"] == old["runtimeContract"]
            and current["configHash"] == old["configHash"],
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
            if "workingFile" in canary:
                readback["workingFile"] = exec_python(current["id"], WORKING_READ, json.dumps(working_canary(canary)), timeout=750)
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
            "bind-original",
            "bind-canary",
            "check-working-canary",
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
    parser.add_argument("--config-hash", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--canary", type=Path)
    parser.add_argument("--new-working-reader", action="store_true")
    parser.add_argument("--drain-env", type=Path)
    parser.add_argument("--pool-state")
    parser.add_argument("--transfer-state")
    parser.add_argument("--sweeper-state")
    parser.add_argument("--media-state")
    args = parser.parse_args()
    try:
        operate(args)
    except (OSError, KeyError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise SystemExit("Historical file gateway refused: " + str(exc)[:300])
