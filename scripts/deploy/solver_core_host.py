"""Role and policy binding for the managed solver core-file operator."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def atomic_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(obj, out, separators=(",", ":"), sort_keys=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        Path(name).unlink(missing_ok=True)


def load_json(path):
    return json.loads(Path(path).read_bytes())


def digest_file(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def docker(*args, input=None, timeout=30):
    return subprocess.run(["docker", *args], input=input, capture_output=True,
                          text=True, timeout=timeout, check=True).stdout.strip()


def container(project, service):
    ids = docker("ps", "--no-trunc", "--filter", f"label=com.docker.compose.project={project}",
                 "--filter", f"label=com.docker.compose.service={service}", "--format", "{{.ID}}").splitlines()
    if len(ids) != 1 or not re.fullmatch("[0-9a-f]{64}", ids[0]):
        raise RuntimeError(f"no unique running {service} for the configured project")
    # Select only infrastructure metadata; never log environment or credentials.
    item = json.loads(docker("inspect", "--format",
        '{"id":{{json .Id}},"image":{{json .Image}},"started":{{json .State.StartedAt}},"pid":{{.State.Pid}},'
        '"pidMode":{{json .HostConfig.PidMode}},"ulimits":{{json .HostConfig.Ulimits}},'
        '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
        '"service":{{json (index .Config.Labels "com.docker.compose.service")}},"mounts":{{json .Mounts}}}', ids[0]))
    if item["project"] != project or item["service"] != service or item["id"] != ids[0]:
        raise RuntimeError("container ownership changed")
    return item


def result_volume(worker):
    volumes = [m for m in worker["mounts"] if m["Destination"] == "/data/airfoilfoam"]
    if len(volumes) != 1 or not volumes[0]["RW"]:
        raise RuntimeError("no exact writable native results mount")
    volume = Path(volumes[0]["Source"])
    if volume == Path("/") or not volume.is_absolute() or volume.resolve(strict=True) != volume:
        raise RuntimeError("native results mount changed")
    return volume


def worker_limits(project, state, action, service="worker"):
    if service not in ("worker", "worker-foundation14"):
        raise ValueError("only a solver worker may change core limits")
    worker = container(project, service)
    if worker["pidMode"] not in ("", "private"):
        raise RuntimeError("worker must have a private PID namespace")
    native_pattern = Path("/proc/sys/kernel/core_pattern").read_text().strip()
    program = Path(__file__).with_name("solver_core_limits.py").read_text()
    def inside(request):
        return json.loads(docker("exec", "-i", worker["id"], "python3", "-I", "-",
                                 json.dumps(request, separators=(",", ":")), input=program, timeout=45))
    now = inside({"action": "inspect"})
    explicit = next((l for l in worker["ulimits"] or [] if l["Name"] == "core"), None)
    binding = {k: worker[k] for k in ("id", "image", "started", "project", "service", "pid")}
    result = {"worker": binding, "kernelPattern": native_pattern, "mode": action, "held": []}
    if action == "inspect":
        return {**result, **now, "configuredUlimits": worker["ulimits"]}
    if native_pattern.startswith("|"):
        raise RuntimeError("the host routes dumps to a pipe; a file-size limit cannot certify prevention")
    if now["configuredSoftBytes"] != "0" or (explicit and explicit["Soft"] != 0):
        return {**result, "state": "explicit-diagnostic-policy"}
    folder = state / "limits" / worker["id"]
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = folder / "original.json"
    with (folder / "operation.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == "restore" and not receipt.is_file():
            raise RuntimeError("no recorded original limits for this container")
        original = load_json(receipt) if receipt.is_file() else {"worker": binding, "leader": now["leader"], "rows": {}}
        if original["worker"] != binding or original["leader"]["start"] != now["leader"]["start"]:
            raise RuntimeError("worker generation differs from the recorded original")
        for _ in range(5):
            if action == "disable":
                for row in now["rows"]:
                    key = f"{row['pid']}:{row['start']}"
                    original["rows"].setdefault(key, row)
                # Original pairs are durable before any prlimit call.
                atomic_json(receipt, original)
            changed = inside({"action": action, "leader": original["leader"], "rows": list(original["rows"].values())})
            if changed["held"]:
                result["held"].extend(changed["held"])
                break
            now = inside({"action": "inspect"})
            if action == "restore" or all(row["core"][0] == 0 for row in now["rows"]):
                break
        if container(project, service)["id"] != worker["id"]:
            raise RuntimeError("solver container changed during application")
        result.update(after=now["rows"], originalReceipt=str(receipt), originalSha256=digest_file(receipt))
        if action == "disable":
            result["nonzeroSurvivors"] = [r["pid"] for r in now["rows"] if r["core"][0] != 0]
        atomic_json(folder / (action + ".json"), result)
        return result
