"""Restore an original HZ evidence path under its immutable, registered storage-only receipt."""

from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .evidence_store import (
    EvidenceIntegrityError,
    EvidenceStoreError,
    RemoteEvidencePointer,
    extract_verified_evidence_archive,
    verify_local_archive_manifest_members,
    _safe_extraction_capacity,
)

WORKER_GATEWAY = "http://node-api:4000"
MARKER = "historical_raw_custody.database.json"
HASH = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def checked(condition, detail):
    if not condition:
        raise EvidenceIntegrityError(detail)


def safe(path):
    checked(
        isinstance(path, str)
        and not any(ord(c) < 32 for c in path)
        and "\\" not in path
        and all(p not in ("", ".", "..") for p in path.split("/")),
        "invalid evidence path",
    )
    return PurePosixPath(path)


def original_scope(root, target, forced=None):
    """A marker belongs to one real evidence directory. The caller authenticates an explicit preflight."""
    if not target.is_relative_to(root) or root.resolve() != root:
        return None
    for directory in target.parents:
        if directory == root:
            break
        marker = directory / MARKER
        if (
            forced is not None
            and directory.name == "evidence"
            and (directory / "evidence_manifest.json").is_file()
        ):
            checked(len(forced) <= 8192, "oversized historical restore selector")
            doc = json.loads(base64.b64decode(forced, validate=True))
        elif marker.exists() or marker.is_symlink():
            s = marker.lstat()
            checked(
                stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= 8192,
                "invalid historical custody marker",
            )
            doc = json.loads(marker.read_bytes())
        else:
            continue
        rel = directory.relative_to(root).as_posix()
        row = doc["receipt"]
        checked(
            doc.get("version") == 1
            and doc.get("directory") == rel
            and safe(rel).parts[0] == "cases"
            and directory.resolve() == directory
            and UUID.fullmatch(root.name)
            and row["sim_job_id"] == root.name,
            "historical custody belongs to another job or directory",
        )
        for k in (
            "point_content_signature",
            "report_signature",
            "assignment_signature",
            "manifest_sha256",
            "stored_sha256",
            "tar_sha256",
            "manifest_set_sha256",
            "stop_signature",
        ):
            checked(isinstance(row.get(k), str) and HASH.fullmatch(row[k]), "invalid historical checksum")
        checked(
            type(row.get("sequence")) is int
            and 1 <= row["sequence"] <= 2**53 - 1
            and isinstance(row.get("generation"), str)
            and re.fullmatch("[1-9][0-9]{0,19}", row["generation"])
            and int(row["generation"]) < 2**64
            and type(row.get("stored_bytes")) is int
            and 0 < row["stored_bytes"] <= 1024**3
            and type(row.get("manifest_bytes")) is int
            and 0 < row["manifest_bytes"] <= 8 * 1024**2
            and row["object_key"]
            == f"solver-evidence/v1/sha256/{row['stored_sha256'][:2]}/{row['stored_sha256']}.tar.zst",
            "invalid historical archive identity",
        )
        mf = directory / "evidence_manifest.json"
        checked(
            stat.S_ISREG(mf.lstat().st_mode) and mf.stat().st_size == row["manifest_bytes"],
            "original manifest size changed",
        )
        manifest = mf.read_bytes()
        checked(hashlib.sha256(manifest).hexdigest() == row["manifest_sha256"], "original manifest changed")
        pointer = RemoteEvidencePointer(
            bucket=row["bucket"],
            object_key=row["object_key"],
            generation=int(row["generation"]),
            stored_sha256=row["stored_sha256"],
            stored_size=row["stored_bytes"],
            tar_sha256=row["tar_sha256"],
            tar_size=row["tar_bytes"],
            crc32c=row["crc32c"],
            zstd_level=row["zstd_level"],
            created_at=row["verified_at"],
        )
        return row, rel, manifest, pointer, target.relative_to(directory).as_posix()
    return None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _download(row, directory, pointer, settings, path):
    checked(settings.control_plane_token, "local engine authorization is unavailable")
    query = urlencode(
        {
            "report": row["report_signature"],
            "stored": pointer.stored_sha256,
            "manifest": row["manifest_sha256"],
            "directory": directory,
        }
    )
    url = f"{WORKER_GATEWAY}/internal/historical-raw/{row['sim_job_id']}/{row['sequence']}/{row['point_content_signature']}/{pointer.generation}?{query}"
    req = Request(
        url,
        headers={"Authorization": "Bearer " + settings.control_plane_token, "Accept-Encoding": "identity"},
    )
    checked(pointer.stored_size <= _safe_extraction_capacity(path), "insufficient restore workspace")
    deadline = time.monotonic() + 1200
    total = 0
    h = hashlib.sha256()
    try:
        with (
            build_opener(ProxyHandler({}), _NoRedirect()).open(req, timeout=1200) as response,
            path.open("xb") as out,
        ):
            checked(
                response.status == 200
                and response.headers.get("x-content-sha256") == pointer.stored_sha256
                and response.headers.get("x-gcs-generation") == str(pointer.generation)
                and response.headers.get("content-length") == str(pointer.stored_size)
                and response.headers.get_content_type() == "application/zstd"
                and not response.headers.get("content-encoding"),
                "registered source response changed",
            )
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                checked(time.monotonic() <= deadline, "registered restore deadline elapsed")
                checked(total <= pointer.stored_size, "registered source exceeds its signed length")
                out.write(chunk)
                h.update(chunk)
    except HTTPError as exc:
        if exc.code == 503:
            raise ConnectionError("registered archive capacity is temporarily unavailable") from exc
        raise EvidenceStoreError("registered worker refused the pinned original") from exc
    except (URLError, TimeoutError) as exc:
        raise ConnectionError("registered archive transport is unavailable") from exc
    checked(
        total == pointer.stored_size and h.hexdigest() == pointer.stored_sha256,
        "registered source contents changed",
    )


@contextmanager
def restored(scope, settings, *, render=False):
    row, directory, manifest, pointer, member = scope
    prefix = "VTK" if render else member
    if not render and member != "engine_evidence.tar.zst":
        checked(
            safe(member).parts[0] in {"openfoam", "time_directories", "VTK"}
            and any(entry.get("path") == member for entry in json.loads(manifest)["files"]),
            "unregistered evidence member",
        )
    with tempfile.TemporaryDirectory(prefix="historical-raw-read-") as temp:
        folder = Path(temp)
        archive = folder / "engine_evidence.tar.zst"
        _download(row, directory, pointer, settings, archive)
        if member == "engine_evidence.tar.zst" and not render:
            record, n = verify_local_archive_manifest_members(
                archive, expected_manifest=manifest, level=pointer.zstd_level
            )
            checked(
                record.tar_sha256 == pointer.tar_sha256
                and record.tar_size == pointer.tar_size
                and record.stored_sha256 == pointer.stored_sha256
                and n == row["bundled_file_count"],
                "historical bundle or member set changed",
            )
            yield archive
        else:
            dest = folder / "members"
            extract_verified_evidence_archive(
                archive,
                dest,
                compression="zstd",
                include_prefixes=(prefix,),
                pointer=pointer,
                expected_manifest=manifest,
            )
            checked(
                (dest / prefix).is_dir() if render else (dest / prefix).is_file(),
                "requested member missing from historical source",
            )
            yield dest if render else dest / member
