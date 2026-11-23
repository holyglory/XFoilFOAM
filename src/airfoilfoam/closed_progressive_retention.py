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


def _images(job, directory, images, allow_empty=False):
    """Normalize the two actual spellings used by engine results and manifests."""
    _require(isinstance(images, dict) and (images or allow_empty), "point has no instantaneous image inventory")
    case = PurePosixPath(*directory.parts[:2])
    prefix = f"/jobs/{job}/files/"
    paths = {}
    for field, name in images.items():
        _require(isinstance(field, str) and isinstance(name, str), "invalid image declaration")
        path = _relative(name[len(prefix):]) if name.startswith(prefix) else case / _relative(name)
        _require(path.parent == directory.parent / "images" and path.name == field + ".png",
                 "image declaration escapes its exact point")
        paths[field] = path.as_posix()
    _require(len(set(paths.values())) == len(paths), "ambiguous image declaration")
    return paths


def _kept_images(root, proofs, declared):
    expected = {}
    for proof in proofs:
        directory = _relative(proof["directory"])
        images = declared[directory.as_posix()]
        rows = proof["keepMedia"]
        _require(isinstance(rows, list) and len(rows) == len(images) and
                 {row["field"] for row in rows} == set(images), "registered image fields differ from engine result")
        for name in images.values():
            _require(name not in expected, "image overlaps another owner")
            expected[name] = None
        for row in rows:
            path = _relative(row["path"])
            native = proof.get("regime") == "urans" and path.as_posix() == images[row["field"]]
            _require(native or (path.is_relative_to(directory / "scaled_media") and path.name == row["field"] + ".png" and
                                path.as_posix() not in expected), "scaled image has a different or duplicate owner")
            expected[path.as_posix()] = (row["byteSize"], row["sha256"])
        if proof.get("regime") == "urans":
            # Prior scale versions can remain visible by their original path.
            # Retain them only under this signed point and declared image field.
            cache = root / directory / "scaled_media" / "default_v1_zoom2"
            if cache.exists():
                _require(cache.resolve(strict=True) == cache and cache.is_dir(), "unsafe scaled-media root")
                for version in cache.iterdir():
                    _require(re.fullmatch(r"v[0-9]+", version.name) and not version.is_symlink() and version.is_dir(),
                             "unknown scaled-media version")
                    for image in version.iterdir():
                        _require(image.name == image.stem + ".png" and image.stem in images, "unknown scaled-media field")
                        expected.setdefault(image.relative_to(root).as_posix(), None)
                        _require(len(expected) <= 512, "media inventory exceeds the bounded job proof")
    _require(0 < len(expected) <= 512, "media inventory exceeds the bounded job proof")
    kept = {}
    total_bytes = 0
    for name, identity in sorted(expected.items()):
        path = root / name
        _require(path.resolve() == path, "symlink in retained media path")
        st = path.lstat()
        _require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, "retained image is not a distinct regular file")
        total_bytes += st.st_size
        _require(total_bytes <= 128 * 1024**2, "retained-image inventory exceeds the bounded byte budget")
        size, digest = _size_and_sha256(path)
        _require((identity is None or identity == (size, digest)) and size > 0 and _same_file(path, st),
                 "retained media bytes or inode differ")
        kept[name] = ({"path": name, "sha256": digest, "byteSize": size}, st)
    return kept


def _result_manifests(root, declared=None, urans_directories=()):
    result = _json(root / "result.json", 128 * 1024**2)
    for record in (result, _json(root / "status.json", 1024**2)):
        _require(record.get("job_id") == root.name and record.get("state") in {"completed", "failed", "cancelled"},
                 "engine job is not exactly terminal")
    inventory = {}
    for polar in result["polars"]:
        for point in (polar.get("points") or []) + (polar.get("attempts") or []):
            _require(not any(point.get(k) for k in ("mean_images", "video")), "result declares separate local media")
            _require(declared is not None or not point.get("images"), "result declares separate local media")
            artifacts = point.get("evidence_artifacts") or []
            items = [a for a in artifacts if a.get("kind") == "manifest"]
            _require(len(items) == 1 and sum(a.get("kind") == "engine_bundle" for a in artifacts) == 1,
                     "point has no unique manifest and bundle")
            path = _relative(f"cases/{point['case_slug']}/{items[0]['path']}")
            _require(path.name == "evidence_manifest.json", "invalid result manifest path")
            directory = path.parent
            if declared is not None:
                images = _images(root.name, directory, point.get("images"), directory.as_posix() in urans_directories)
                _require(declared.setdefault(directory.as_posix(), images) == images, "point image declarations differ")
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


def _live_member(member, latest, urans_solver=None):
    """Continuation uses the mesh, dictionaries and the latest saved U/p fields."""
    path = _relative(member["path"])
    parts = path.parts
    if any(re.fullmatch(r"core\.[0-9]+", part) for part in parts):
        return None
    if urans_solver:
        if parts == ("openfoam", "logs", urans_solver, "log.pimpleFoam"):
            return PurePosixPath("log.pimpleFoam")
        # Processor time directories can link back to reconstructed uniform state.
        if len(parts) >= 3 and parts[0] == "time_directories" and parts[2] == "uniform":
            return None
    if len(parts) >= 3 and parts[0] == "time_directories" and 0 < _time(parts[1]) < latest:
        return PurePosixPath(*parts[1:])
    if len(parts) >= 3 and parts[:2] == ("openfoam", "postProcessing"):
        return PurePosixPath(*parts[1:])
    return None


def _local_manifest(root, folder, proof, reported, readbacks, declared=None):
    mf = folder / "evidence_manifest.json"
    _require(mf.resolve(strict=True) == mf and stat.S_ISREG(mf.lstat().st_mode), "unsafe evidence manifest path")
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
    _require(not any(media.get(k) for k in ("mean", "video")), "manifest declares separate media")
    if declared is None:
        _require(not media.get("instantaneous"), "manifest declares separate media")
    else:
        _require(_images(root.name, rel, media.get("instantaneous"), proof.get("regime") == "urans") == declared,
                 "manifest and result image paths differ")
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
    post = _case_path(root.name, manifest["postPath"], case)
    if proof.get("regime") == "urans":
        _require(manifest.get("unsteady") is True and post.parent == case and
                 re.fullmatch(r"transient(?:_a[0-9]+)?", post.name), "URANS manifest does not own this transient solver")
    return case, post, [m for m in manifest["files"] if not any(_relative(m["path"]).is_relative_to(d) for d in excluded)]


def _inventory(root, proofs, readbacks, kept=None):
    expected = {str(_relative(p["directory"])): p for p in proofs}
    _require(expected and len(expected) == len(proofs), "empty or duplicate evidence identity")
    declared = {} if kept is not None else None
    urans = {key for key, proof in expected.items() if kept is not None and proof.get("regime") == "urans"}
    reported = _result_manifests(root, declared, urans)
    _require(set(reported) == set(expected),
             "engine result and proven point inventory differ")
    cases, solvers, declared_cases, declared_solvers, found = set(), set(), set(), set(), set()
    if kept is not None:
        kept.update(_kept_images(root, proofs, declared))
    # Authenticate the point/solver mapping before admitting its dense
    # processor and time directories. All filesystem entries are still checked.
    authenticated = {key: _local_manifest(root, root / key, expected[key], reported[key], readbacks,
                                          declared[key] if declared is not None else None) for key in expected}
    urans_solvers = {authenticated[key][1] for key in urans}
    protected = kept or {}
    protected_dirs = {p.as_posix() for name in protected for p in PurePosixPath(name).parents}
    protected_identities = {(entry["byteSize"], entry["sha256"]) for entry, _ in protected.values()}
    candidates = {}
    seen = 0

    def walk_error(exc):
        raise exc

    for parent, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        folder = Path(parent)
        relative = folder.relative_to(root)
        solver = PurePosixPath(*relative.parts[:3])
        if solver in urans_solvers:
            # os.walk consumes one directory at a time, with bounded per-point
            # manifest candidates. Keep the original bound on unrelated trees.
            _require(len(names) + len(dirs) <= 100_000, "solver directory exceeds bounded filesystem inventory")
        else:
            seen += len(names) + len(dirs)
        _require(seen <= 100_000, "job exceeds bounded filesystem inventory")
        if len(relative.parts) == 2 and relative.parts[0] == "cases":
            cases.add(relative)
        if folder.name == "transient" or folder.name.startswith("transient_a"):
            solvers.add(relative)
        for name in dirs:
            path = folder / name
            if path.is_symlink():
                actual = path.resolve(strict=True) if protected else path.resolve()
                if (solver in urans_solvers and name == "uniform" and len(relative.parts) == 5 and
                        re.fullmatch(r"processor[0-9]+", relative.parts[3]) and _time(relative.name) >= 0 and
                        os.readlink(path) == f"../../{relative.name}/uniform" and
                        actual == root / solver / relative.name / "uniform" and actual.is_dir()):
                    continue
                _require(name == "polyMesh" and actual.is_relative_to(root / "meshes"), "unaccounted directory symlink")
                if protected:
                    lexical = Path(os.path.abspath(path.parent / os.readlink(path)))
                    _require(relative.parts[:1] == ("cases",) and relative.name == "constant" and
                             actual.parts[-2:] == ("constant", "polyMesh") and lexical == actual and actual.is_dir(),
                             "unverified shared-mesh link")
        if any(part in {"images", "frames", "scaled_media", "custom_renders"} for part in relative.parts):
            _require(all((relative / name).as_posix() in protected for name in names), "unaccounted local media remains")
            if protected:
                _require(relative.as_posix() in protected_dirs and
                         all((relative / name).as_posix() in protected_dirs for name in dirs), "unknown media directory")
        for name in names:
            _require(not (folder / name).is_symlink(), "unaccounted file symlink")
            if protected:
                _require(stat.S_ISREG((folder / name).lstat().st_mode), "unaccounted special file")
        for name in (*dirs, *names):
            _require("quarantine" not in name and name not in {"engine_evidence.tar.gz", "openfoam_evidence.tar.gz",
                     "engine_evidence.tar.zst"}, "local package or forensic evidence remains")
            _require(not name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".mp4",
                     ".webm", ".mov", ".avi", ".tiff", ".tif")) or (relative / name).as_posix() in protected, "local media remains")
        if folder.name != "evidence" and "evidence_manifest.json" not in names:
            continue
        key = relative.as_posix()
        _require(key in expected and "evidence_manifest.json" in names, "unowned evidence directory")
        _require(all(d == "scaled_media" and (relative / d).as_posix() in protected_dirs for d in dirs)
                 and set(names) == {"evidence_manifest.json", "brokered_hub_binding.database.json",
                 "brokered_local_reclaim.intent.json", "brokered_local_reclaim.json"}, "extra local evidence remains")
        found.add(key)
        case, post, members = authenticated[key]
        declared_cases.add(case)
        declared_solvers.add(post)
        post_dir = root / post
        latest = max((_time(t.name) for t in post_dir.iterdir() if t.is_dir() and not t.is_symlink()
                      and (t / "U").is_file() and (t / "p").is_file()), default=-1) if post_dir.is_dir() else -1
        for member in members:
            live = _live_member(member, latest, post.name if key in urans else None)
            if live is None:
                continue
            path = root / post / live
            if ((kept is not None and (member["byteSize"], member["sha256"]) in protected_identities) or
                    path.relative_to(root).as_posix() in protected or path in candidates or
                    not path.is_file() or path.resolve() != path):
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
            keep_requested = any("keepMedia" in p for p in proofs)
            _require(not keep_requested or all("keepMedia" in p for p in proofs), "incomplete media keep-set")
            kept = {} if keep_requested else None
            files = _inventory(job_root, proofs, authenticated, kept)
            kept_rows = [entry for entry, _ in (kept or {}).values()]
            current = {path.relative_to(job_root).as_posix(): [sha, st.st_size] for path, (sha, st) in files.items()}
            intent_file = job_root / "closed_progressive_duplicate_files.intent.json"
            done_file = job_root / "closed_progressive_duplicate_files.complete.json"
            stored = _json(intent_file, 32 * 1024**2) if intent_file.exists() else None
            rows = stored["files"] if stored is not None else [[name, *current[name]] for name in sorted(current)]
            fingerprint = [proofs, rows, kept_rows] if keep_requested else [proofs, rows]
            digest = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            total = sum(row[2] for row in rows)
            receipt = {"job_id": job_root.name, "plan": digest, "bytes": total, "files": len(rows)}
            extra = {"mediaFiles": kept_rows, "workingPaths": [name for name, _, _ in rows],
                     "plannedAllocatedBytes": sum(info.st_blocks * 512 for _, info in files.values())
                     if stored is None else stored["allocationBaseline"]["fileAllocatedBytes"]} if keep_requested else {}
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
                return {**receipt, **extra, "state": "planned" if expected_plan is None else "reclaimed", "replayed": True,
                        "allocation": _allocation(job_root, rows, files, stored)}
            if expected_plan is None:
                return {**receipt, **extra, "state": "planned", "replayed": False}
            _require(digest == expected_plan, "job changed after preflight")
            for path, (_, info) in files.items():
                _require(_same_file(path, info), "source changed before unlink")
            for name, (_, st) in (kept or {}).items():
                _require(_same_file(job_root / name, st), "retained image changed before reclaim")
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
            if kept is not None:
                after = {}
                _require(not _inventory(job_root, proofs, authenticated, after) and
                         [entry for entry, _ in after.values()] == kept_rows and
                         all(_same_file(job_root / name, st) for name, (_, st) in kept.items()),
                         "retained media or working-file set changed during reclaim")
            _atomic_create_json(done_file, receipt)
            return {**receipt, **extra, "state": "reclaimed", "replayed": False,
                    "allocation": _allocation(job_root, rows, files, stored)}
    except (OSError, KeyError, ValueError, TypeError, EvidenceCleanupError) as exc:
        raise JobRetentionRefused(f"closed progressive inventory could not be proven: {exc}") from exc
