"""Private stdin peer of the HZ closed-job operator. This module serves no requests over a network."""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import re
import signal
import stat
import sys
import types
from pathlib import Path

MAX_FRAME = 2 * 1024**2


def require(condition, message):
    if not condition:
        raise ValueError(message)


def signature(token, kind, nonce, body):
    return hmac.new(token.encode(), f"XFoilFOAM closed-job exec v1\0{kind}\0{nonce}\0{body}".encode(),
                    hashlib.sha256).hexdigest()


def inode(path):
    st = path.lstat()
    return [st.st_dev, st.st_ino]


def installed(digests):
    for name, digest in digests.items():
        spec = importlib.util.find_spec("airfoilfoam." + name)
        require(spec and spec.origin and hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest() == digest,
                "installed engine module differs: " + name)


def run_engine(scope, packet, source, settings):
    from airfoilfoam.retention import JobRetentionRefused

    token = settings.control_plane_token or ""
    require(token and isinstance(packet["body"], str) and
            hmac.compare_digest(signature(token, "request", scope["nonce"], packet["body"]), packet["mac"]),
            "engine control-plane authentication refused")
    req = json.loads(packet["body"])
    require(req["id"] == scope["id"] and req["helper"] == scope["helper"] and req["mode"] == scope["mode"],
            "request does not belong to this maintenance operation")
    plan = req.get("expectedPlan")
    require((plan is None and req["step"] == 1) or
            (scope["mode"] == "reclaim" and plan == scope["plan"] and plan is not None and req["step"] == 2),
            "operation differs from the authorized plan")
    manifests, readbacks = req["manifests"], req["readbacks"]
    require(isinstance(manifests, list) and 1 <= len(manifests) <= 256 and
            isinstance(readbacks, list) and len(readbacks) <= 256, "invalid custody inventory")
    for m in manifests:
        require(isinstance(m["directory"], str) and isinstance(m["brokeredUploadId"], str) and
                all(re.fullmatch("[0-9a-f]{64}", m[k]) for k in ("catalogSha256", "manifestSha256", "receiptHmac")) and
                re.fullmatch("[1-9][0-9]{0,19}", m["generation"]) and type(m["manifestByteSize"]) is int and
                m["manifestByteSize"] > 0, "invalid manifest identity")
    for r in readbacks:
        require(isinstance(r["brokeredUploadId"], str) and isinstance(r["verifiedAt"], str) and
                re.fullmatch("[1-9][0-9]{0,19}", r["generation"]) and re.fullmatch("[0-9a-f]{64}", r["storedSha256"]) and
                type(r["storedByteSize"]) is int and r["storedByteSize"] > 0, "invalid object readback")
    root = settings.job_dir(scope["id"])
    require(root.parent == settings.data_dir / "jobs" and root.resolve() == root and root.is_dir() and
            root.name == scope["id"] and inode(root.parent) == scope["jobsInode"] and inode(root) == scope["jobInode"],
            "gateway and worker job directories differ")
    lock = root / ".execute.lock"
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and [info.st_dev, info.st_ino] == scope["lockInode"],
                "gateway and worker execution locks differ")
        if plan is None:
            # Inspect holds the existing inode without creating a lock or writing an intent.
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise JobRetentionRefused("worker holds .execute.lock") from exc
        # Relative imports resolve the verified, installed engine primitives; nothing is installed.
        module = types.ModuleType("airfoilfoam.closed_progressive_maintenance")
        module.__package__ = "airfoilfoam"
        exec(compile(source, "<closed-progressive-retention>", "exec"), module.__dict__)
        result = module.reclaim_closed_progressive_files(root, req["manifests"], plan, req["readbacks"],
                                                        lock_identity=scope["lockInode"])
        require(inode(lock) == scope["lockInode"], "execution lock was replaced")
    finally:
        os.close(descriptor)
    body = json.dumps({"id": scope["id"], "step": req["step"], "result": result}, separators=(",", ":"))
    return {"body": body, "mac": signature(token, "response", scope["nonce"], body)}


def main():
    from airfoilfoam.config import get_settings
    from airfoilfoam.retention import JobRetentionRefused

    raw = sys.stdin.buffer.read(MAX_FRAME + 1)
    require(len(raw) <= MAX_FRAME, "oversized maintenance request")
    boot = json.loads(raw)
    installed(boot["engineHashes"])
    source = boot["native"]
    require(hashlib.sha256(source.encode()).hexdigest() == boot["nativeSha"], "native helper digest differs")
    def expired(*_):
        raise JobRetentionRefused("bounded native maintenance time expired")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(14*60)
    try:
        reply = run_engine(boot["scope"], boot["packet"], source, get_settings())
    except JobRetentionRefused as exc:
        # Include the filed refusal, never a signed request or secret.
        print(json.dumps({"refused": str(exc)[:400]}))
        return
    finally:
        signal.alarm(0)
    print(json.dumps(reply))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Maintenance engine refused: " + (str(exc)[:180] if isinstance(exc, ValueError)
              else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
