"""Resolve an absent, retired native working path through its completed registered file plan."""

from __future__ import annotations

import base64
from contextlib import ExitStack
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import stat
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore, Lock
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import google_crc32c

from .evidence_store import (MAX_EVIDENCE_MANIFEST_BYTES, EvidenceStoreError, RemoteEvidencePointer,
                             _safe_extraction_capacity, extract_verified_evidence_archive)

GATEWAY = "http://node-api:4000/internal/closed-working-files"
_HASH = re.compile(r"[a-f0-9]{64}")
_UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
_SEGMENT = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._+-]*")
_PLAN_LIMIT = 32 * 1024**2
_COLD_READ = BoundedSemaphore(1)
_INDEX_LOCK = Lock()


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _key(value):
    if not isinstance(value, str) or not 1 <= len(os.fsencode(value)) <= 4096:
        return False
    return "\\" not in value and all(ord(c) >= 32 and ord(c) != 127 for c in value) and all(
        p not in ("", ".", "..") for p in value.split("/")
    )


def _read(path, limit):
    _require(path.resolve(strict=True) == path, "linked working-file source")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as f:
        st = os.fstat(f.fileno())
        _require(stat.S_ISREG(st.st_mode) and 0 < st.st_size <= limit, "invalid working-file source size")
        data = f.read(st.st_size + 1)
        _require(len(data) == st.st_size and os.fstat(f.fileno()).st_ctime_ns == st.st_ctime_ns
                 and os.path.samestat(st, path.lstat()), "working-file source changed")
    return data


def _stat_key(path):
    s = path.lstat()
    return s.st_dev, s.st_ino, s.st_size, s.st_ctime_ns


@lru_cache(maxsize=1)
def _inventory(root, intent_stat, done_stat):
    intent = root / "closed_progressive_duplicate_files.intent.json"
    done = root / "closed_progressive_duplicate_files.complete.json"
    doc = json.loads(_read(intent, _PLAN_LIMIT))
    final = json.loads(_read(done, 65536))
    plan = doc["plan"]
    _require(doc["job_id"] == final["job_id"] == root.name and _HASH.fullmatch(plan) and final["plan"] == plan,
             "working-file completion belongs to another source")
    rows = doc["files"]
    _require(isinstance(rows, list) and len(rows) == final["files"] and rows, "incomplete working-file list")
    index = {}
    for row in rows:
        _require(isinstance(row, list) and len(row) == 3, "invalid working-file row")
        key, sha, size = row
        _require(isinstance(key, str) and key not in index and isinstance(sha, str) and _HASH.fullmatch(sha)
                 and type(size) is int and size >= 0, "invalid working-file identity")
        index[key] = (size, sha)
    _require(sum(n for n, _ in index.values()) == final["bytes"] and
             (_stat_key(intent), _stat_key(done)) == (intent_stat, done_stat), "changed native completion")
    # Same representation as the Python reclaimer's already-verified plan preimage.
    digest = hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()
    return plan, digest, index


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open(url, token, timeout):
    request = Request(url, headers={"authorization": "Bearer " + token, "accept-encoding": "identity"})
    return build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=timeout)


def _pointer(remote, created):
    gen = remote["generation"]
    _require(isinstance(gen, str) and re.fullmatch(r"[1-9][0-9]{0,19}", gen) and int(gen) < 2**64,
             "invalid registered generation")
    return RemoteEvidencePointer.from_dict({
        "schemaVersion": 1, "format": "tar+zstd", "bucket": remote["bucket"], "objectKey": remote["objectKey"],
        "generation": gen, "storedSize": remote["storedByteSize"], "storedSha256": remote["storedSha256"],
        "tarSize": remote["tarByteSize"], "tarSha256": remote["tarSha256"], "crc32c": remote["crc32c"],
        "zstdLevel": remote["zstdLevel"], "createdAt": created,
    })


def _matching_member(root, relative, source, identity):
    directory = source["directory"]
    _require(_key(directory), "unsafe registered evidence directory")
    parts = PurePosixPath(directory).parts
    _require(parts[:2] == relative.parts[:2] and parts[-1] == "evidence" and _UUID.fullmatch(source["upload"])
             and _HASH.fullmatch(source["manifest"]), "foreign registered evidence directory")
    folder = root / directory
    raw = _read(folder / "evidence_manifest.json", MAX_EVIDENCE_MANIFEST_BYTES)
    _require(hashlib.sha256(raw).hexdigest() == source["manifest"], "registered manifest checksum changed")
    doc = json.loads(raw)
    case = root.joinpath(*parts[:2])
    declared = PurePosixPath(doc["casePath"])
    canonical = PurePosixPath("/data/airfoilfoam/jobs") / root.name / parts[0] / parts[1]
    _require(declared == PurePosixPath(case) or declared == canonical, "manifest belongs to another case")
    stored_post = PurePosixPath(doc["postPath"])
    _require(stored_post == declared or (stored_post.parent == declared and
             re.fullmatch(r"transient(?:_a[0-9]+)?", stored_post.name)), "manifest has a foreign solver root")
    post = case / stored_post.relative_to(declared)
    target = root / relative
    if not target.is_relative_to(post):
        return None
    suffix = target.relative_to(post)
    segments = suffix.parts
    if len(segments) >= 2 and segments[0] == "postProcessing":
        member = "openfoam/" + suffix.as_posix()
    elif segments == ("log.pimpleFoam",) and post != case:
        member = "openfoam/logs/" + post.name + "/log.pimpleFoam"
    elif len(segments) >= 2:
        try:
            t = float(segments[0])
        except ValueError:
            return None
        if not math.isfinite(t) or t <= 0 or (post != case and segments[1] == "uniform"):
            return None
        member = "time_directories/" + suffix.as_posix()
    else:
        return None
    if member.split("/", 1)[0] in doc.get("bundleExcludes", []):
        return None
    rows = [v for v in doc["files"] if v["path"] == member]
    if not rows:
        return None
    if len(rows) != 1 or (rows[0]["byteSize"], rows[0]["sha256"]) != identity:
        return None
    ack = json.loads(_read(folder / "brokered_hub_binding.database.json", 65536))
    auth = ack["authorization"]
    bound = auth["receipt"]
    remote = bound["remote"]
    _require(ack["state"] == "hub_progressive_custody" and auth["jobId"] == root.name and auth["caseSlug"] == case.name
             and auth["evidenceBase"] == PurePosixPath(*parts[2:]).as_posix()
             and bound["kind"] == "hub-progressive-evidence-custody" and bound["brokeredUploadId"] == source["upload"]
             and bound["source"]["engineJobId"] == root.name and bound["source"]["engineCaseSlug"] == case.name
             and source["generation"] == remote["generation"] and remote["manifestByteSize"] == len(raw)
             and remote["manifestSha256"] == source["manifest"], "working member receipt changed")
    return source["upload"], member, raw, _pointer(remote, bound["boundAt"])


def _materialize(folder, url, token, selected, identity, deadline):
    upload, member, manifest, pointer = selected
    archive = folder / "source.tar.zst"
    _require(0 < pointer.stored_size <= _safe_extraction_capacity(archive), "insufficient working-file restore space")
    total = 0
    sha, crc = hashlib.sha256(), google_crc32c.Checksum()
    with _open(url + "/" + upload + "/" + str(pointer.generation), token, 120) as response:
        _require(response.status == 200 and response.headers.get_content_type() == "application/zstd"
                 and response.headers.get("content-length") == str(pointer.stored_size)
                 and not response.headers.get("content-encoding")
                 and response.headers.get("x-content-sha256") == pointer.stored_sha256
                 and response.headers.get("x-gcs-generation") == str(pointer.generation)
                 and response.headers.get("x-archive-tar-sha256") == pointer.tar_sha256
                 and response.headers.get("x-archive-tar-size") == str(pointer.tar_size)
                 and response.headers.get("x-archive-crc32c") == pointer.crc32c
                 and response.headers.get("x-archive-locator-sha256") == hashlib.sha256(
                     (pointer.bucket + "\0" + pointer.object_key).encode()).hexdigest()
                 and response.headers.get("x-archive-manifest-sha256") == hashlib.sha256(manifest).hexdigest(),
                 "registered working-file response changed")
        with archive.open("xb") as out:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                _require(time.monotonic() <= deadline and total <= pointer.stored_size, "working-file archive exceeded its bound")
                sha.update(chunk)
                crc.update(chunk)
                out.write(chunk)
    _require(total == pointer.stored_size and sha.hexdigest() == pointer.stored_sha256
             and base64.b64encode(crc.digest()).decode() == pointer.crc32c, "working-file archive checksum changed")
    dest = folder / "member"
    extract_verified_evidence_archive(archive, dest, compression="zstd", include_prefixes=(member,),
                                      pointer=pointer, expected_manifest=manifest, verify_stored_pointer=False)
    file = dest / member
    _require(file.is_file() and not file.is_symlink() and file.stat().st_size == identity[0],
             "restored working member size changed")
    digest = hashlib.sha256()
    with file.open("rb") as inp:
        for chunk in iter(lambda: inp.read(1024 * 1024), b""):
            digest.update(chunk)
    _require(digest.hexdigest() == identity[1], "restored working member bytes changed")
    return file


class WorkingFileSourceError(RuntimeError):
    def __init__(self, status, message, *, retry=False):
        super().__init__(message)
        self.status = status
        self.retry = retry


@dataclass
class VerifiedWorkingFile:
    file: Path
    lease: ExitStack
    identity: tuple[int, str]
    plan: str
    inventory: str
    source: dict
    pointer: RemoteEvidencePointer
    url: str
    snapshot: tuple


def verified_working_file(root: Path, rel: str, target: Path, settings, *, allow_present=False):
    """Open the exact registered member and transfer ownership of its temporary-file lease."""
    if not _UUID.fullmatch(root.name) or not _key(rel) or not rel.startswith("cases/") or root / rel != target:
        return None
    parts = PurePosixPath(rel).parts
    if len(parts) < 4 or not _SEGMENT.fullmatch(parts[1]) or any(p in ("evidence", "images", "frames") or p.startswith("processor")
                              or re.fullmatch(r"core(?:\.[0-9]+)?", p) for p in parts[2:]):
        return None
    done = root / "closed_progressive_duplicate_files.complete.json"
    intent = root / "closed_progressive_duplicate_files.intent.json"
    if not done.exists() or not settings.control_plane_token:
        return None
    with ExitStack() as lease:
        try:
            # Serialize large changed-index parsing, but do not consume a download
            # slot for an unrelated missing path.
            with _INDEX_LOCK:
                snapshot = (_stat_key(intent), _stat_key(done))
                plan, digest, files = _inventory(root, *snapshot)
                identity = files.get(rel)
            if identity is None:
                return None
            if not _COLD_READ.acquire(blocking=False):
                raise WorkingFileSourceError(503, "Working-file restore is busy", retry=True)
            lease.callback(_COLD_READ.release)
            url = f"{GATEWAY}/{root.name}/{plan}/{digest}/{parts[1]}"
            with _open(url, settings.control_plane_token, 10) as response:
                _require(response.status == 200 and response.headers.get_content_type() == "application/json"
                         and not response.headers.get("content-encoding"), "invalid registered working-file index")
                body = response.read(256 * 1024 + 1)
            _require(len(body) <= 256 * 1024, "oversized working-file index")
            data = json.loads(body)
            _require(data["job"] == root.name and data["plan"] == plan and data["filesSha256"] == digest
                     and isinstance(data["sources"], list) and 0 < len(data["sources"]) <= 256,
                     "registered working-file plan differs")
            # The native reclaimer binds transient_aN to the exact aN/evidence
            # directory. Read one manifest for this common multi-angle case.
            segment = parts[2]
            sources = data["sources"]
            if re.fullmatch(r"transient_a[0-9]+", segment):
                stem = "/".join((*parts[:2], segment.removeprefix("transient_"), "evidence"))
                sources = [s for s in sources if s["directory"] == stem]
            matches = [(row, matched) for row in sources
                       if (matched := _matching_member(root, PurePosixPath(rel), row, identity))]
            _require(len(matches) == 1, "missing or ambiguous immutable working-file member")
            row, selected = matches[0]
            temp = Path(lease.enter_context(TemporaryDirectory(prefix="working-file-restore-")))
            file = _materialize(temp, url, settings.control_plane_token, selected, identity, time.monotonic() + 1200)
            _require((_stat_key(intent), _stat_key(done)) == snapshot and (allow_present or not target.exists())
                     and not target.is_symlink() and root / rel == target.resolve(), "original path or owner changed during restore")
            return VerifiedWorkingFile(file, lease.pop_all(), identity, plan, digest, row, selected[3], url, snapshot)
        except HTTPError as error:
            if error.code == 404:
                return None
            raise WorkingFileSourceError(503 if error.code == 503 else 409, "Registered working-file source unavailable") from error
        except (TimeoutError, URLError, OSError) as error:
            raise WorkingFileSourceError(503, "Working-file source or restore storage unavailable") from error
        except (KeyError, TypeError, ValueError, EvidenceStoreError) as error:
            raise WorkingFileSourceError(409, "Working-file receipt or immutable source differs") from error

def original_file(root: Path, rel: str, target: Path, settings):
    """Serve the verified member with byte-range support through the native endpoint."""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    try:
        item = verified_working_file(root, rel, target, settings)
    except WorkingFileSourceError as exc:
        headers = {"Retry-After": "2"} if exc.retry else None
        raise HTTPException(exc.status, str(exc), headers=headers) from exc
    if item is None:
        return None

    class LeasedResponse(FileResponse):
        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                item.lease.close()

    return LeasedResponse(item.file, media_type=mimetypes.guess_type(item.file.name)[0] or "application/octet-stream",
                          headers={"x-content-sha256": item.identity[1], "x-gcs-generation": str(item.pointer.generation),
                                   "x-working-file-plan": item.plan})
