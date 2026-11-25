"""Reopen one registered retired working member on the original shared volume."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace

from .evidence_runtime import _atomic_create_json
from .evidence_store import _size_and_sha256
from .working_file_restore import _HASH, _UUID, _key, _open, _read, _stat_key, verified_working_file

DIRECTORY = "closed_progressive_working_file_restores"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _receipt_name(relative):
    return hashlib.sha256(relative.encode()).hexdigest() + ".json"


def _flush_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _record(path):
    return json.loads(_read(path, 8192))


def restored_working_files(root, plan, rows, proofs, current):
    """Authenticate warm returns on a completed plan. This is never consulted before deletion."""
    folder = root / DIRECTORY
    if not folder.exists() and not folder.is_symlink():
        require(not current, "completed working files reappeared without a restore receipt")
        return [], 0
    require(folder.resolve(strict=True) == folder and folder.is_dir(), "working-file restoration ledger changed")
    intended = {n: (s, h) for n, h, s in rows}
    sources = {(p["directory"], p["brokeredUploadId"], p["generation"], p["manifestSha256"]) for p in proofs}
    records = [folder]
    restored = set()
    for entry in folder.iterdir():
        require(entry.name.endswith(".json") and _HASH.fullmatch(entry.name[:-5]),
                "unfinished or foreign working-file restoration")
        rec = _record(entry)
        name = rec["path"]
        require(_key(name) and entry.name == _receipt_name(name) and rec["job"] == root.name and
                rec["version"] == 1 and rec["plan"] == plan and name in intended and
                (rec["bytes"], rec["sha256"]) == intended[name] and
                (rec["directory"], rec["upload"], rec["generation"], rec["manifest"]) in sources,
                "restored working-file identity differs from the original authenticated plan")
        require(root / name in current, "registered local restoration has no matching working file")
        restored.add(root / name)
        records.append(entry)
    require(restored == set(current), "completed working files reappeared without matching restoration")
    return records, sum(info.st_blocks * 512 for _, info in current.values())


def recover(volume, job, relative, plan, sha256, byte_size, generation, settings, *, publish):
    from .automatic_retention import named_owner

    require(_UUID.fullmatch(job) and _key(relative) and _HASH.fullmatch(plan) and _HASH.fullmatch(sha256)
            and type(byte_size) is int and byte_size >= 0 and generation.isascii() and generation.isdecimal()
            and 0 < int(generation) < 2**64 and str(int(generation)) == generation, "invalid working member selector")
    root = volume / "jobs" / job
    target = root / relative
    require(target.parent.resolve(strict=True) == target.parent and target.parent.is_dir(),
            "original working-file parent changed")
    parent_stat = target.parent.stat()
    with named_owner(root, None, False) as owner:
        source = verified_working_file(root, relative, target, settings, allow_present=True)
    require(source is not None, "no registered working member")
    with source.lease:
        require(source.plan == plan and source.identity == (byte_size, sha256)
                and str(source.pointer.generation) == generation, "pinned working member differs")
        rec = {"version": 1, "job": job, "plan": plan, "path": relative, "sha256": sha256,
               "bytes": byte_size, "generation": generation, **source.source}
        ledger = root / DIRECTORY
        marker = ledger / _receipt_name(relative)
        with named_owner(root, owner, True):
            status = json.loads(_read(root / "status.json", 1024 * 1024))
            require(status.get("state") in ("completed", "done", "failed", "cancelled"),
                    "native job lacks a terminal status")
            require(target.parent.resolve(strict=True) == target.parent and
                    os.path.samestat(parent_stat, target.parent.stat()) and
                    (_stat_key(root / "closed_progressive_duplicate_files.intent.json"),
                     _stat_key(root / "closed_progressive_duplicate_files.complete.json")) == source.snapshot,
                    "original collection changed after the archive read")
            # Checking the ordinary registered owner again does not transfer the object a second time.
            suffix = "/" + rec["upload"] + "/" + generation + "?verifyOwner=1"
            with _open(source.url + suffix, settings.control_plane_token, 15) as response:
                require(response.status == 204 and response.headers.get("x-gcs-generation") == generation and
                        response.headers.get("x-content-sha256") == source.pointer.stored_sha256,
                        "current registered ownership is unavailable")
            if ledger.exists() or ledger.is_symlink():
                require(ledger.resolve(strict=True) == ledger and ledger.is_dir(), "restoration ledger moved")
            marked = marker.is_file()
            require(not marker.is_symlink() and (not marked or _record(marker) == rec),
                    "attempted restoration conflicts with a prior source")
            def present():
                st = target.lstat()
                require(target.resolve(strict=True) == target and stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and
                        _size_and_sha256(target) == (byte_size, sha256) and
                        (st.st_ino, st.st_ctime_ns) == (target.lstat().st_ino, target.lstat().st_ctime_ns),
                        "existing native working file differs")
                return {"allocatedBytes": st.st_blocks * 512, "device": str(st.st_dev), "inode": str(st.st_ino)}
            staged = ledger / (marker.stem + ".part")
            exists = target.exists() or target.is_symlink()
            if exists and not marked:
                raise ValueError("existing native working file has no restoration receipt")
            if not publish:
                return {**rec, "state": "verified-existing" if exists else "verified-absent",
                        "native": present() if exists else None}
            ledger.mkdir(mode=0o700, exist_ok=True)
            _flush_directory(root)
            _atomic_create_json(marker, rec)
            if staged.exists() or staged.is_symlink():
                st = staged.lstat()
                require(stat.S_ISREG(st.st_mode) and staged.resolve(strict=True) == staged and
                        (st.st_nlink == 1 or (exists and st.st_nlink == 2 and os.path.samestat(st, target.lstat()))),
                        "unexpected temporary restoration owner")
                # Only an unpublished temporary or the second link from the interrupted atomic publication.
                staged.unlink()
                _flush_directory(ledger)
            if exists:
                return {**rec, "state": "already-present", "native": present()}
            fd = os.open(target.parent, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
            try:
                require(os.path.samestat(os.fstat(fd), parent_stat), "working-file parent moved")
                manifest = root / rec["directory"] / "evidence_manifest.json"
                permissions = 0o200 | (stat.S_IMODE(manifest.stat().st_mode) & 0o444)
                new = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    with os.fdopen(new, "wb") as stream, source.file.open("rb") as actual:
                        check, count = hashlib.sha256(), 0
                        for block in iter(lambda: actual.read(1024 * 1024), b""):
                            count += len(block)
                            require(count <= byte_size, "restored member exceeds its original size")
                            check.update(block)
                            stream.write(block)
                        require((count, check.hexdigest()) == (byte_size, sha256), "restored bytes changed before publication")
                        stream.flush()
                        os.fchmod(stream.fileno(), permissions)
                        os.fsync(stream.fileno())
                    os.link(staged, target.name, dst_dir_fd=fd, follow_symlinks=False)
                    os.fsync(fd)
                finally:
                    staged.unlink(missing_ok=True)
                    _flush_directory(ledger)
                return {**rec, "state": "restored", "native": present()}
            finally:
                os.close(fd)


def main():
    cmd = argparse.ArgumentParser(description=__doc__)
    cmd.add_argument("mode", choices=("verify", "restore"))
    cmd.add_argument("job")
    cmd.add_argument("path")
    cmd.add_argument("plan")
    cmd.add_argument("sha256")
    cmd.add_argument("byte_size", type=int)
    cmd.add_argument("generation")
    args = cmd.parse_args()
    token = os.environ.get("ENGINE_CONTROL_PLANE_TOKEN")
    require(os.environ.get("AIRFOILFOAM_DEPLOYMENT_ROLE") == "remote-solver" and token,
            "installed registered worker read identity is required")
    result = recover(Path("/data/airfoilfoam"), args.job, args.path, args.plan, args.sha256, args.byte_size,
                     args.generation, SimpleNamespace(control_plane_token=token), publish=args.mode == "restore")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
