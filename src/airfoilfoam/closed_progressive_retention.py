"""Remove only byte-identical live-case copies of authenticated cloud archive members."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .evidence_runtime import EvidenceCleanupError, _atomic_create_json
from .evidence_store import MAX_EVIDENCE_MANIFEST_BYTES, _size_and_sha256
from .retention import JobRetentionRefused, _job_retention_guard


def _require(condition, detail):
    if not condition:
        raise JobRetentionRefused(detail)


def _json(path, limit):
    st = path.lstat()
    _require(stat.S_ISREG(st.st_mode) and st.st_size <= limit, f"unsafe or oversized {path.name}")
    return json.loads(path.read_bytes())


def _relative(path):
    _require(isinstance(path, str) and not any(ord(c) < 32 for c in path) and "\\" not in path and all(p not in {"", ".", ".."} for p in path.split("/")),
             "invalid relative path")
    return PurePosixPath(path)


def _case_path(job_id, value, case):
    parts = PurePosixPath(value).parts
    offsets = [i for i in range(len(parts) - 1) if parts[i:i + 2] == ("jobs", job_id)]
    _require(len(offsets) == 1, "manifest identifies another job")
    path = _relative("/".join(parts[offsets[0] + 2:]))
    _require(path.is_relative_to(case), "manifest identifies another case")
    return path


def _result_manifests(root):
    result = _json(root / "result.json", 128 * 1024**2)
    for record in (result, _json(root / "status.json", 1024**2)):
        _require(record.get("job_id") == root.name and record.get("state") in {"completed", "failed", "cancelled"},
                 "engine job is not exactly terminal")
    inventory = {}
    for polar in result["polars"]:
        for point in (polar.get("points") or []) + (polar.get("attempts") or []):
            _require(not any(point.get(k) for k in ("images", "mean_images", "video")), "result declares separate local media")
            artifacts = point.get("evidence_artifacts") or []
            items = [a for a in artifacts if a.get("kind") == "manifest"]
            _require(len(items) == 1 and sum(a.get("kind") == "engine_bundle" for a in artifacts) == 1,
                     "point has no unique manifest and bundle")
            path = _relative(f"cases/{point['case_slug']}/{items[0]['path']}")
            _require(path.name == "evidence_manifest.json", "invalid result manifest path")
            directory = path.parent
            members = set()
            for item in artifacts:
                item_path = _relative(f"cases/{point['case_slug']}/{item['path']}")
                _require(item_path.is_relative_to(directory) and re.fullmatch(r"[a-z][a-z0-9_]*", item["kind"]) and
                         re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) and type(item["byte_size"]) is int and
                         item["byte_size"] >= 0, "artifact is outside the proven point")
                members.add((item["kind"], str(item_path.relative_to(directory)), item["byte_size"], item["sha256"]))
            key = directory.as_posix()
            _require(inventory.setdefault(key, members) == members, "two reported points disagree on artifacts")
    return inventory


def _time(name):
    try:
        number = float(name)
        return number if math.isfinite(number) and number >= 0 else -1
    except ValueError:
        return -1


def _live_member(member, latest):
    """Continuation uses the mesh, dictionaries and the latest saved U/p fields."""
    path = _relative(member["path"])
    parts = path.parts
    if len(parts) >= 3 and parts[0] == "time_directories" and 0 < _time(parts[1]) < latest:
        return PurePosixPath(*parts[1:])
    if len(parts) >= 3 and parts[:2] == ("openfoam", "postProcessing"):
        return PurePosixPath(*parts[1:])
    return None


def _local_manifest(root, folder, proof, reported, readbacks):
    mf = folder / "evidence_manifest.json"
    _require(mf.stat().st_size == proof["manifestByteSize"] <= MAX_EVIDENCE_MANIFEST_BYTES, "manifest size differs")
    data = mf.read_bytes()
    _require(hashlib.sha256(data).hexdigest() == proof["manifestSha256"], "local manifest differs")
    ack = _json(folder / "brokered_hub_binding.database.json", 65536)
    intent = _json(folder / "brokered_local_reclaim.intent.json", 65536)
    done = _json(folder / "brokered_local_reclaim.json", 65536)
    paths = intent["paths"]
    names = [p["name"] for p in paths]
    permitted = {"openfoam": "directory", "time_directories": "directory", "VTK": "directory",
                 "engine_evidence.tar.zst": "file", "engine_evidence.tar.gz": "file", "openfoam_evidence.tar.gz": "file"}
    _require(ack["schemaVersion"] == intent["schemaVersion"] == done["schemaVersion"] == 1 and
             ack["state"] == "hub_progressive_custody" and intent["kind"] == "brokered-local-evidence-reclaim-intent" and
             len(set(names)) == len(names) == intent["plannedPathCount"] and
             all(permitted.get(p["name"]) == p["kind"] and p["byteSize"] >= 0 for p in paths) and
             sum(p["byteSize"] for p in paths) == intent["plannedBytes"] == done["bytesDeleted"] and
             sorted(names) == done["deletedPaths"], "incomplete local brokered reclaim ledger")
    auth = ack["authorization"]
    receipt = auth["receipt"]
    rel = folder.relative_to(root)
    case = PurePosixPath(*rel.parts[:2])
    _require(auth["jobId"] == root.name and auth["caseSlug"] == case.name and
             auth["evidenceBase"] == PurePosixPath(*rel.parts[2:]).as_posix() and
             receipt["brokeredUploadId"] == proof["brokeredUploadId"] and receipt["remote"]["generation"] == proof["generation"] and
             receipt["remote"]["manifestSha256"] == proof["manifestSha256"] and auth["receiptHmac"] == proof["receiptHmac"] and
             intent["authorization"] == auth == done["authorization"] and done["state"] == "complete" and
             done["intentSha256"] == hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
             "prior local reclaim differs from signed custody")
    if readbacks is not None:
        readback = readbacks[proof["brokeredUploadId"]]
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(readback["verifiedAt"].replace("Z", "+00:00"))).total_seconds()
        _require(-5 <= age <= 1200 and readback["generation"] == proof["generation"] and
                 readback["storedSha256"] == receipt["remote"]["storedSha256"] and
                 readback["storedByteSize"] == receipt["remote"]["storedByteSize"], "fresh complete object readback differs")
    manifest = json.loads(data)
    media = manifest.get("media") or {}
    _require(not any(media.get(k) for k in ("instantaneous", "mean", "video")), "manifest declares separate media")
    # Sweeper ingestion registers mesh_evidence as mesh and retains its original engine kind in metadata.
    catalog = sorted(f"{'mesh' if kind == 'mesh_evidence' else kind}\tjobs/{root.name}/{rel.as_posix()}/{name}\t{size}\t{sha}"
                     for kind, name, size, sha in reported)
    _require(hashlib.sha256("\n".join(catalog).encode()).hexdigest() == proof["catalogSha256"],
             "reported and registered artifact inventories differ")
    members = {(item["path"], item["byteSize"], item["sha256"]) for item in manifest["files"]}
    excluded = {_relative(part) for part in manifest.get("bundleExcludes", [])} | {PurePosixPath("frames")}
    for kind, name, size, sha in reported:
        if kind == "manifest":
            _require((name, size, sha) == ("evidence_manifest.json", len(data), proof["manifestSha256"]), "manifest identity changed")
        elif kind == "engine_bundle":
            _require((name, size, sha) == ("engine_evidence.tar.zst", receipt["remote"]["storedByteSize"],
                     receipt["remote"]["storedSha256"]), "bundle identity changed")
        else:
            _require((name, size, sha) in members and not any(_relative(name).is_relative_to(d) for d in excluded),
                     "registered artifact is outside authenticated bundle members")
    _require(_case_path(root.name, manifest["casePath"], case) == case, "unowned manifest case")
    return case, _case_path(root.name, manifest["postPath"], case), manifest["files"]


def _inventory(root, proofs, readbacks):
    expected = {str(_relative(p["directory"])): p for p in proofs}
    _require(expected and len(expected) == len(proofs), "empty or duplicate evidence identity")
    reported = _result_manifests(root)
    _require(set(reported) == set(expected),
             "engine result and proven point inventory differ")
    cases, solvers, declared_cases, declared_solvers, found = set(), set(), set(), set(), set()
    candidates = {}
    seen = 0

    def walk_error(exc):
        raise exc

    for parent, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        folder = Path(parent)
        relative = folder.relative_to(root)
        seen += len(names) + len(dirs)
        _require(seen <= 100_000, "job exceeds bounded filesystem inventory")
        if len(relative.parts) == 2 and relative.parts[0] == "cases":
            cases.add(relative)
        if folder.name == "transient" or folder.name.startswith("transient_a"):
            solvers.add(relative)
        for name in dirs:
            path = folder / name
            _require(not path.is_symlink() or (name == "polyMesh" and path.resolve().is_relative_to(root / "meshes")),
                     "unaccounted directory symlink")
        if names and any(part in {"images", "frames", "scaled_media", "custom_renders"} for part in relative.parts):
            raise JobRetentionRefused("local media remains")
        for name in names:
            _require(not (folder / name).is_symlink(), "unaccounted file symlink")
        for name in (*dirs, *names):
            _require("quarantine" not in name and name not in {"engine_evidence.tar.gz", "openfoam_evidence.tar.gz",
                     "engine_evidence.tar.zst"}, "local package or forensic evidence remains")
            _require(not name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".mp4",
                     ".webm", ".mov", ".avi", ".tiff", ".tif")), "local media remains")
        if folder.name != "evidence" and "evidence_manifest.json" not in names:
            continue
        key = relative.as_posix()
        _require(key in expected and "evidence_manifest.json" in names, "unowned evidence directory")
        _require(not dirs and set(names) == {"evidence_manifest.json", "brokered_hub_binding.database.json",
                 "brokered_local_reclaim.intent.json", "brokered_local_reclaim.json"}, "extra local evidence remains")
        found.add(key)
        case, post, members = _local_manifest(root, folder, expected[key], reported[key], readbacks)
        declared_cases.add(case)
        declared_solvers.add(post)
        post_dir = root / post
        latest = max((_time(t.name) for t in post_dir.iterdir() if t.is_dir() and not t.is_symlink()
                      and (t / "U").is_file() and (t / "p").is_file()), default=-1) if post_dir.is_dir() else -1
        for member in members:
            live = _live_member(member, latest)
            if live is None:
                continue
            path = root / post / live
            if path in candidates or not path.is_file() or path.resolve() != path:
                continue
            info = path.stat()
            if info.st_nlink != 1 or not stat.S_ISREG(info.st_mode) or info.st_size != member["byteSize"]:
                continue
            if _size_and_sha256(path) == (info.st_size, member["sha256"]):
                candidates[path] = (member["sha256"], info)
    _require(found == set(expected), "expected evidence directory missing")
    _require(cases <= declared_cases and solvers <= declared_solvers, "unarchived case state")
    return candidates


def _same_file(path, original):
    current = path.lstat()
    return (path.resolve() == path and os.path.samestat(current, original) and current.st_nlink == 1 and
            current.st_size == original.st_size and current.st_mtime_ns == original.st_mtime_ns and
            current.st_ctime_ns == original.st_ctime_ns)


def _allocation(root, rows, files, stored):
    parents = {root, *((root / _relative(name)).parent for name, _, _ in rows)}
    directory_bytes = sum(p.stat().st_blocks * 512 for p in parents)
    volume = os.statvfs(root)
    free = volume.f_frsize * volume.f_bfree
    if stored is None:
        return {"fileAllocatedBytes": sum(st.st_blocks * 512 for _, st in files.values()),
                "directoryBytesBefore": directory_bytes, "filesystemFreeBefore": free}
    baseline = stored.get("allocationBaseline")
    if not baseline:
        return None
    receipts = [root / f"closed_progressive_duplicate_files.{kind}.json" for kind in ("intent", "complete")]
    receipt_bytes = sum(p.lstat().st_blocks * 512 for p in receipts if p.exists())
    directory_delta = directory_bytes - baseline["directoryBytesBefore"]
    return {**baseline, "receiptAllocatedBytes": receipt_bytes, "directoryAllocatedDelta": directory_delta,
            "netAttributedAllocatedBytes": baseline["fileAllocatedBytes"] - receipt_bytes - directory_delta,
            "filesystemFreeObserved": free, "filesystemFreeDelta": free - baseline["filesystemFreeBefore"]}


def reclaim_closed_progressive_files(job_root: Path, proofs: list[dict], expected_plan: str | None = None,
                                     readbacks: list[dict] | None = None, *, lock_identity: list[int] | None = None):
    """Preview without writes. Apply rechecks the entire plan under the active solver's lock."""
    if not job_root.exists() and not job_root.is_symlink():
        return {"job_id": job_root.name, "state": "absent", "bytes": 0, "files": 0, "plan": None}
    _require(job_root.is_dir() and not job_root.is_symlink(), "unsafe job directory")
    try:
        with _job_retention_guard(job_root) if expected_plan is not None else nullcontext():
            if lock_identity is not None:
                held = (job_root / ".execute.lock").lstat()
                _require(stat.S_ISREG(held.st_mode) and [held.st_dev, held.st_ino] == lock_identity,
                         "execution lock differs from the worker namespace")

            authenticated = None
            if expected_plan is not None:
                authenticated = {r["brokeredUploadId"]: r for r in readbacks or []}
                _require(len(authenticated) == len(proofs) == len(readbacks or []) and
                         set(authenticated) == {p["brokeredUploadId"] for p in proofs}, "missing exhaustive fresh readback")
            files = _inventory(job_root, proofs, authenticated)
            current = {path.relative_to(job_root).as_posix(): [sha, st.st_size] for path, (sha, st) in files.items()}
            intent_file = job_root / "closed_progressive_duplicate_files.intent.json"
            done_file = job_root / "closed_progressive_duplicate_files.complete.json"
            stored = _json(intent_file, 32 * 1024**2) if intent_file.exists() else None
            rows = stored["files"] if stored is not None else [[name, *current[name]] for name in sorted(current)]
            digest = hashlib.sha256(json.dumps([proofs, rows], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            total = sum(row[2] for row in rows)
            receipt = {"job_id": job_root.name, "plan": digest, "bytes": total, "files": len(rows)}
            if stored is not None:
                _require(stored.get("job_id") == job_root.name and stored.get("plan") == digest, "reclaim intent changed")
                intended = {name: [sha, size] for name, sha, size in rows}
                _require(all(intended.get(name) == identity for name, identity in current.items()), "reclaim plan grew or changed")
                for name in intended.keys() - current.keys():
                    missing = job_root / _relative(name)
                    _require(not missing.exists() and not missing.is_symlink(), "previously inventoried file changed")
            if done_file.exists():
                _require(stored is not None and not files and _json(done_file, 65536) == receipt, "completed receipt or files changed")
                _require(expected_plan is None or expected_plan == digest, "completed plan mismatch")
                return {**receipt, "state": "planned" if expected_plan is None else "reclaimed", "replayed": True,
                        "allocation": _allocation(job_root, rows, files, stored)}
            if expected_plan is None:
                return {**receipt, "state": "planned", "replayed": False}
            _require(digest == expected_plan, "job changed after preflight")
            for path, (_, info) in files.items():
                _require(_same_file(path, info), "source changed before unlink")
            if stored is None:
                stored = {"job_id": job_root.name, "plan": digest, "files": rows,
                          "allocationBaseline": _allocation(job_root, rows, files, None)}
            _atomic_create_json(intent_file, stored)
            for path, (_, info) in files.items():
                _require(_same_file(path, info), "source changed while reclaiming")
                path.unlink()
            # A completed receipt can outlive a power loss only after its directory removals can.
            for parent in { (job_root / name).parent for name, _, _ in rows }:
                fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            _atomic_create_json(done_file, receipt)
            return {**receipt, "state": "reclaimed", "replayed": False,
                    "allocation": _allocation(job_root, rows, files, stored)}
    except (OSError, KeyError, ValueError, TypeError, EvidenceCleanupError) as exc:
        raise JobRetentionRefused(f"closed progressive inventory could not be proven: {exc}") from exc
