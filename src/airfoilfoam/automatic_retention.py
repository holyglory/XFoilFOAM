"""Private sweeper peer for the shared results volume. It has no network or database client."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone

import google_crc32c

from .closed_progressive_retention import reclaim_closed_progressive_files
from .evidence_store import (
    MAX_EVIDENCE_MANIFEST_BYTES, RemoteEvidencePointer, _safe_extraction_capacity,
    extract_verified_evidence_archive, manifest_bundle_member_set_sha256,
)
from .retention import JobRetentionRefused, strip_job_dir


def require(condition, reason):
    if not condition:
        raise JobRetentionRefused(reason)


def regular_json(path, limit):
    require(path.resolve(strict=True) == path, "redirected metadata path")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as source:
        st = os.fstat(source.fileno())
        require(stat.S_ISREG(st.st_mode) and st.st_size <= limit, "unsafe or oversized metadata")
        raw = source.read(limit + 1)
    current = path.lstat()
    require(len(raw) == st.st_size and os.path.samestat(st,current) and st.st_ctime_ns == current.st_ctime_ns, "metadata changed during read")
    return raw, json.loads(raw)


def inode(path):
    st = path.lstat()
    return [str(st.st_dev), str(st.st_ino)]


@contextmanager
def named_owner(root, expected, exclusive, allow_create=False):
    require(root.resolve(strict=True) == root and root.is_dir(), "job root changed")
    path = root / ".execute.lock"
    flags = os.O_RDWR | os.O_CREAT if allow_create else os.O_RDONLY
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and os.path.samestat(st, path.lstat()), "unsafe worker lock")
        if exclusive:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        scope = {"jobs": inode(root.parent), "job": inode(root), "lock": inode(path)}
        require(expected is None or expected == scope, "shared-volume owner changed")
        yield scope
    finally:
        os.close(fd)


def manifest_path(root, proof):
    name = proof["directory"]
    require(isinstance(name, str) and all(c not in ("", ".", "..") for c in name.split("/")) and "\\" not in name,
            "invalid manifest directory")
    rel = PurePosixPath(name)
    require(not rel.is_absolute() and rel.parts[0] == "cases" and rel.name == "evidence", "manifest escapes job")
    return root / rel / "evidence_manifest.json"


def manifest_identity(root, proof):
    raw, manifest = regular_json(manifest_path(root, proof), MAX_EVIDENCE_MANIFEST_BYTES)
    require(len(raw) == proof["manifestByteSize"] and hashlib.sha256(raw).hexdigest() == proof["manifestSha256"],
            "manifest differs from signed custody")
    return raw, manifest


def restore_archive(root, packet, stream):
    ident = packet["archive"]
    proof = packet["manifest"]
    require(ident["generation"] == proof["generation"] and re.fullmatch(r"[1-9][0-9]{0,19}", ident["generation"]) and
            ident["manifestSha256"] == proof["manifestSha256"] and ident["manifestByteSize"] == proof["manifestByteSize"],
            "signed archive identity differs")
    raw, manifest = manifest_identity(root, proof)
    count, set_sha = manifest_bundle_member_set_sha256(raw)
    require(count == 1 + ident["bundledFileCount"], "bundled member count differs")
    pointer = RemoteEvidencePointer.from_dict({
        "schemaVersion": 1, "format": "tar+zstd", "bucket": ident["bucket"], "objectKey": ident["objectKey"],
        "generation": ident["generation"], "storedSize": ident["storedByteSize"], "storedSha256": ident["storedSha256"],
        "tarSize": ident["tarByteSize"], "tarSha256": ident["tarSha256"], "crc32c": ident["crc32c"],
        "zstdLevel": ident["zstdLevel"], "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    excluded = set(manifest.get("bundleExcludes", []))
    members = [entry for entry in manifest["files"] if entry["path"].split("/", 1)[0] not in excluded]
    sample = min(members, key=lambda m: (m["byteSize"], m["path"]), default=None)
    sample_name = sample["path"] if sample else "evidence_manifest.json"
    sample_size = sample["byteSize"] if sample else len(raw)
    sample_sha = sample["sha256"] if sample else proof["manifestSha256"]
    # Use an anonymous file for the compressed stream. SIGTERM or a container restart closes it.
    with tempfile.TemporaryFile() as archive:
        scratch = Path(tempfile.gettempdir())
        require(pointer.stored_size + sample_size + len(raw) <= _safe_extraction_capacity(scratch / "closed-retention"),
                "insufficient safe restore space")
        size = 0
        digest = hashlib.sha256()
        checksum = google_crc32c.Checksum()
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            require(size <= pointer.stored_size, "registered download exceeds signed size")
            digest.update(chunk)
            checksum.update(chunk)
            archive.write(chunk)
        require(size == pointer.stored_size and digest.hexdigest() == pointer.stored_sha256 and
                base64.b64encode(checksum.digest()).decode() == pointer.crc32c, "registered download SHA, CRC or size differs")
        archive.flush()
        with tempfile.TemporaryDirectory(prefix="closed-retention-restore-") as td:
            restored = Path(td) / "members"
            extract_verified_evidence_archive(Path("/proc/self/fd") / str(archive.fileno()), restored,
                compression="zstd", include_prefixes=[sample_name], pointer=pointer, expected_manifest=raw,
                verify_stored_pointer=False)
            file = restored / sample_name
            with file.open("rb") as source:
                require(file.stat().st_size == sample_size and hashlib.file_digest(source, "sha256").hexdigest() == sample_sha,
                        "restored sample differs from the original manifest")
    return {"manifestSha256": proof["manifestSha256"], "memberSetSha256": set_sha, "memberCount": count,
            "sample": {"path": sample_name, "byteSize": sample_size, "sha256": sample_sha}}


def plan_or_apply(root, packet):
    expected = packet.get("plan")
    proofs = packet["manifests"]
    require(isinstance(proofs, list) and 1 <= len(proofs) <= 256 and
            all(not p.get("historicalRaw") for p in proofs), "invalid automatic source inventory")
    require(expected is None or bool(packet.get("owner")), "automatic removal requires its preview owner")
    # For removal the existing canonical function takes the exclusive worker lock itself.
    with named_owner(root, packet.get("owner"), expected is None) as scope:
        if expected is not None:
            reads = packet["readbacks"]
            by_upload = {r["brokeredUploadId"]: r for r in reads}
            require(len(by_upload) == len(proofs) == len(reads), "incomplete automatic member verification")
            for p in proofs:
                raw, _ = manifest_identity(root, p)
                count, sha = manifest_bundle_member_set_sha256(raw)
                restored = by_upload[p["brokeredUploadId"]]["restored"]
                require((restored["manifestSha256"], restored["memberSetSha256"], restored["memberCount"]) ==
                        (p["manifestSha256"], sha, count), "fresh verified member set changed")
        result = reclaim_closed_progressive_files(root, proofs, expected, packet.get("readbacks"),
            lock_identity=list(map(int, scope["lock"])), include_working_paths=True)
        require(root.resolve(strict=True) == root and inode(root) == scope["job"] and inode(root / ".execute.lock") == scope["lock"],
                "worker filesystem owner changed during retention")
        return {**result, "nativeOwner": scope}


def direct_request(root):
    raw, request = regular_json(root / "request.json", 2 * 1024 * 1024)
    require(isinstance(request, dict) and request.get("execution_id") is None and
            not any(k in request for k in ("remoteProgressiveExecution", "progressiveExecution", "executionContract")),
            "native request has a stable progressive execution owner")
    # Presence of these ledgers establishes progressive/forensic provenance even
    # if an old or incomplete request does not contain the execution marker.
    require(not any(p.name.startswith(("closed_progressive_", "historical_raw_")) for p in root.iterdir()),
            "native job has closed progressive custody records")
    return raw


def disposable(root, cutoff):
    # Only exact metadata files of a genuinely empty terminal directory are disposable.
    # Never recursively delete a directory on this normal path.
    previous_mtime = root.stat().st_mtime
    if cutoff is not None:
        require(previous_mtime <= cutoff, "orphan was recently written")
    if not any(root.iterdir()):
        root.rmdir()  # Atomic and refuses if any new file appeared.
        return {"state":"removed","files":0,"allocatedBytes":0}
    allowed = {"request.json","status.json",".execute.lock",".publication.lock","cancelled",".execution-not-started.json"}
    require(all(p.name in allowed for p in root.iterdir()), "directory contains local scientific files or unowned state")
    direct_request(root)
    with named_owner(root, None, True, allow_create=True):
        direct_request(root)
        _, status = regular_json(root / "status.json", 1024 * 1024)
        require(status.get("job_id") == root.name and status.get("state") in {"failed","cancelled","completed"}
                and status.get("completed_cases", 0) == 0, "job has a live execution or completed scientific cases")
        require(not any(status.get(k) for k in ("forces", "polars", "results", "evidence_artifacts", "frame_track",
                        "force_history", "steady_history", "solver_budget_progress")), "status contains solver evidence")
        files = {}
        for path in root.iterdir():
            st = path.lstat()
            require(path.name in allowed and stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and path.resolve() == path,
                    "directory contains local results, scientific files, or unowned state")
            files[path] = st
        require(all(os.path.samestat(st,path.lstat()) and st.st_ctime_ns==path.lstat().st_ctime_ns for path,st in files.items()),
                "disposable file set changed")
        require(set(root.iterdir()) == set(files), "disposable directory contents changed")
        # Keep the locked inode until all other identified metadata is gone.
        for path in sorted(files, key=lambda p: p.name == ".execute.lock"):
            path.unlink()
        root.rmdir()
        return {"state":"removed","files":len(files),"allocatedBytes":sum(st.st_blocks * 512 for st in files.values())}


def main():
    stream = sys.stdin.buffer
    try:
        line = stream.readline(8 * 1024**2 + 1)
        require(line.endswith(b"\n") and len(line) <= 8 * 1024**2, "invalid retention packet")
        packet = json.loads(line)
        jobs = Path(sys.argv[1]) / "jobs"
        require(jobs.is_absolute() and jobs.resolve(strict=True) == jobs and jobs.is_dir(), "results volume is unavailable")
        job = packet["job"]
        require(isinstance(job, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", job), "invalid job path")
        root = jobs / job
        if not root.exists() and not root.is_symlink():
            print(json.dumps({"absent":True}));return
        require(root.resolve(strict=True) == root and root.is_dir(), "unsafe native job directory")
        action = packet["action"]
        if action == "restore":
            with named_owner(root, packet["owner"], False):
                result = restore_archive(root, packet, stream)
        elif action == "progressive":
            result = plan_or_apply(root, packet)
        elif action == "discard":
            result = disposable(root, packet.get("cutoff"))
        elif action == "legacy":
            require(type(packet.get("keepCaseState")) is bool, "invalid legacy strip mode")
            # The caller's DB ownership check and the native request check are
            # independent. The native check and existing strip share the worker lock.
            result = strip_job_dir(root, packet["keepCaseState"], source_guard=direct_request).to_dict()
        else:
            raise JobRetentionRefused("unknown normal retention action")
        print(json.dumps({"result":result}, separators=(",",":")))
    except (OSError, KeyError, ValueError, TypeError, RuntimeError) as exc:
        # No SQL, tokens, upstream body or credentials go through this peer.
        print(json.dumps({"refused":str(exc)[:350]}))


if __name__ == "__main__":
    main()
