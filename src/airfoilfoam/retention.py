"""Retention controls for completed engine job directories.

Keep-set derivation:

* ``request.json``, ``result.json``, ``status.json`` and ``runtime.json`` at
  the job root are part of the engine API contract. ``JobStore`` reads them for
  status/result/runtime endpoints, so strip never removes them.
* Node-facing media URLs are created from ``CaseOutcome`` in ``jobs.py`` and are
  served by ``GET /jobs/{id}/files/{path}``. Default solve media is written
  under ``images/`` or, for marched AoA points, ``a<N>/images/``. URANS
  frame-track PNGs are written under ``frames/`` or ``a<N>/frames/`` and are
  also copied to ``evidence/frames/`` as registered evidence artifacts. All of
  those trees are retained.
* Evidence artifacts registered in result JSON point at
  ``evidence/evidence_manifest.json`` and the canonical Zstandard bundle.
  A verified ``engine_evidence.remote.json`` pins its immutable GCS object.
  Custom/default render outputs point
  under ``evidence/custom_renders/`` and ``evidence/scaled_media/``. These are
  retained wherever an evidence directory appears, including ``a<N>/evidence``.
* ``POST /jobs/{id}/render-field``, ``/field-extents`` and
  ``/render-default-media`` hydrate authenticated VTK members from GCS when a
  verified pointer exists.  Uncompressed ``evidence/VTK`` is therefore removed
  only for a remote-backed archive; without that pointer it remains the local
  re-render source.
* ``continue_from`` staging validates and copies the live saved transient case:
  latest numeric time directory with ``U``/``p``, ``system/controlDict`` and
  ``constant/polyMesh``. It deliberately skips media/evidence/VTK/custom render
  trees and stale ``processor*`` decompositions. ``keep_case_state=True``
  preserves those live solver-state directories for budget-stop continuation;
  the default full strip removes them.
* ``evidence/openfoam``, ``evidence/time_directories``, packaged ``VTK``, and
  local archives are never removed by generic retention. Successful new-result
  finalization has already removed its verified duplicates, while the dedicated
  migration flow requires a database acknowledgement and a fresh
  generation-pinned restore immediately before cleanup. A filename, local
  bundle, or remote pointer alone is never deletion authority.
* A case-root ``mesh-evidence`` directory is live duplicate state. Result
  finalization has already copied its exact files into the canonical engine
  archive as ``openfoam/mesh_evidence``. Full strip removes that duplicate;
  case-state-preserving strip keeps it with the rest of the restartable case.
* A finished URANS transient can leave small JSON records beside its time
  directories. ``transient_start.json`` records the trajectory merge boundary;
  ``urans_early_stop.json`` certifies the exact stable averaging window that
  produced the coefficients and quality verdict. Both are copied byte-for-byte
  into the canonical archive before the result is returned. ``march_budget.json``
  is mutable process-local watchdog arming and continuation staging deliberately
  does not copy it. Full strip removes the budget marker and removes either
  immutable record only after proving exact manifest and tar.zst membership;
  case-state-preserving strip retains all three.

Unknown entries are fail-safe: they are retained and reported instead of being
deleted by a broad "everything not in the keep set" rule.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import tarfile
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import zstandard

from .evidence_store import (
    MAX_EVIDENCE_MANIFEST_BYTES,
    EvidenceStoreError,
    extract_verified_evidence_archive,
    read_remote_pointer,
)


STRIP_MARKER = ".stripped.json"
STRIP_MARKER_SCHEMA_VERSION = 2

_ROOT_JSON_KEEP = {"request.json", "result.json", "status.json", "runtime.json"}
_CASE_DELETE_DIRS = {
    "constant",
    "system",
    "postProcessing",
    "VTK",
    "dynamicCode",
    "mesh-evidence",
}
_CASE_KEEP_DIRS = {"images", "frames", "evidence", "custom_renders"}
_TRANSIENT_START_FILENAME = "transient_start.json"
_TRANSIENT_START_ARCHIVE_MEMBER = "openfoam/transient/transient_start.json"
_URANS_EARLY_STOP_FILENAME = "urans_early_stop.json"
_URANS_EARLY_STOP_ARCHIVE_MEMBER = "openfoam/transient/urans_early_stop.json"
_MARCH_BUDGET_FILENAME = "march_budget.json"
_MAX_TRANSIENT_MARKER_BYTES = 64 * 1024
_IMMUTABLE_TRANSIENT_MARKERS = {
    _TRANSIENT_START_FILENAME: (
        _TRANSIENT_START_ARCHIVE_MEMBER,
        "continuation_state",
    ),
    _URANS_EARLY_STOP_FILENAME: (
        _URANS_EARLY_STOP_ARCHIVE_MEMBER,
        "quality_evidence",
    ),
}
_EVIDENCE_KEEP_NAMES = {
    "evidence_manifest.json",
    "openfoam_evidence.tar.gz",
    "engine_evidence.tar.gz",
    "engine_evidence.tar.zst",
    "engine_evidence.remote.json",
    "storage_migration.json",
    "storage_migration.database.json",
    "incomplete_evidence_quarantine.tar.zst",
    "incomplete_evidence_quarantine.remote.json",
    "incomplete_evidence_quarantine.manifest.json",
    "incomplete_evidence_quarantine.receipt.json",
    "incomplete_evidence_quarantine.database.json",
    "VTK",
    "openfoam",
    "time_directories",
    "frames",
    "scaled_media",
    "custom_renders",
}
_LOCAL_EVIDENCE_ARCHIVES = (
    ("engine_evidence.tar.zst", "zstd"),
    ("engine_evidence.tar.gz", "gzip"),
    ("openfoam_evidence.tar.gz", "gzip"),
)
_RETENTION_VERIFY_ONLY_PREFIX = "__retention_verify_only__"


class JobRetentionRefused(RuntimeError):
    """Raised when retention cannot prove that mutating a job is safe."""


@dataclass
class StripReport:
    job_id: str
    kept_case_state: bool
    bytes_freed: int = 0
    files_removed: int = 0
    dirs_removed: int = 0
    no_op: bool = False
    marker_path: str | None = None
    unknown_entries: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "kept_case_state": self.kept_case_state,
            "bytes_freed": self.bytes_freed,
            "files_removed": self.files_removed,
            "dirs_removed": self.dirs_removed,
            "no_op": self.no_op,
            "marker_path": self.marker_path,
            "unknown_entries_count": len(self.unknown_entries),
            "unknown_entries": list(self.unknown_entries),
        }


@dataclass
class DeleteReport:
    job_id: str
    bytes_freed: int
    files_removed: int
    dirs_removed: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "bytes_freed": self.bytes_freed,
            "files_removed": self.files_removed,
            "dirs_removed": self.dirs_removed,
        }


def strip_job_dir(job_root: Path, keep_case_state: bool = False) -> StripReport:
    """Strip known bulky artifacts from one job directory.

    The operation is idempotent. A marker from the same or a stronger mode
    produces a no-op report. Full strip (``keep_case_state=False``) is stronger
    than case-state-preserving strip.
    """

    job_root = Path(job_root)
    if not job_root.is_dir():
        raise FileNotFoundError(job_root)
    with _job_retention_guard(job_root):
        marker = job_root / STRIP_MARKER
        requested_strength = _mode_strength(keep_case_state)
        existing_mode = _read_marker_mode(marker)
        if existing_mode is not None and _mode_strength(existing_mode) >= requested_strength:
            return StripReport(
                job_id=job_root.name,
                kept_case_state=existing_mode,
                no_op=True,
                marker_path=str(marker),
            )

        if not keep_case_state:
            _require_full_strip_archive_integrity(job_root)

        report = StripReport(job_id=job_root.name, kept_case_state=keep_case_state, marker_path=str(marker))

        # Job-root meshes/ is the shared-mesh store; prod cases SYMLINK their
        # constant/polyMesh into it (jobs.py mesh_reuse_mode="symlink"), and a
        # dangling shared-mesh symlink makes a saved case "not restartable"
        # (pipeline continuation staging). Case-state-preserving strips must
        # therefore keep meshes/ alive alongside the case dirs.
        if not keep_case_state:
            meshes = job_root / "meshes"
            if meshes.exists() or meshes.is_symlink():
                _remove_path(meshes, report)

        cases_root = job_root / "cases"
        if cases_root.is_dir():
            for case_dir in sorted(p for p in cases_root.iterdir() if p.is_dir()):
                _strip_case_dir(job_root, case_dir, report, keep_case_state=keep_case_state)

        if report.unknown_entries:
            # An incomplete classification is not a successful strip.  In
            # particular, never let a strength-only marker turn the next pass
            # into a no-op after a later engine learns how to archive/reclaim
            # the retained entry.  Remove a stale weaker/legacy marker so the
            # case is re-evaluated and the same unknowns remain visible.
            marker.unlink(missing_ok=True)
        else:
            _write_marker(marker, keep_case_state, report)
        return report


def delete_job_dir(job_root: Path) -> DeleteReport:
    """Delete one complete job directory after the same in-flight guard."""

    job_root = Path(job_root)
    if not job_root.is_dir():
        raise FileNotFoundError(job_root)
    with _job_retention_guard(job_root):
        measured = _measure_path(job_root)
        _remove_tree_unchecked(job_root)
        return DeleteReport(
            job_id=job_root.name,
            bytes_freed=measured["bytes"],
            files_removed=measured["files"],
            dirs_removed=measured["dirs"],
        )


def _mode_strength(keep_case_state: bool) -> int:
    return 1 if keep_case_state else 2


def _read_marker_mode(marker: Path) -> bool | None:
    if not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return None
    # Schema-1 markers were written even when unknown entries remained.  They
    # therefore cannot prove a complete pass and must be re-evaluated once
    # under the fail-safe schema rather than hiding old retained files forever.
    if (
        data.get("schemaVersion") != STRIP_MARKER_SCHEMA_VERSION
        or data.get("complete") is not True
    ):
        return None
    value = data.get("keep_case_state")
    return value if isinstance(value, bool) else None


def _write_marker(marker: Path, keep_case_state: bool, report: StripReport) -> None:
    if report.unknown_entries:
        raise ValueError("cannot mark an incomplete retention pass as stripped")
    payload = {
        "schemaVersion": STRIP_MARKER_SCHEMA_VERSION,
        "complete": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "mode": "keep_case_state" if keep_case_state else "full",
        "keep_case_state": keep_case_state,
        "bytes_freed": report.bytes_freed,
        "files_removed": report.files_removed,
        "dirs_removed": report.dirs_removed,
    }
    marker.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _require_full_strip_archive_integrity(job_root: Path) -> None:
    """Authenticate local evidence before removing any restartable state.

    A completed job can retain its only trustworthy copy of mesh, dictionaries,
    logs, fields, and force history in a local gzip or Zstandard bundle.  A
    filename is not proof that the bundle survived finalization intact.  Full
    strip therefore preflights *all* applicable evidence directories before it
    removes the shared mesh or any live case state.

    The existing verified extractor streams every archive member and checks it
    against the bundled manifest.  A deliberately impossible include prefix
    materializes only ``evidence_manifest.json`` in a temporary directory; the
    remaining members are still read and authenticated without being written.
    Any one valid local archive is sufficient, preserving mixed legacy/current
    migration layouts while failing closed when every local copy is corrupt.
    """

    for manifest_path in sorted(job_root.rglob("evidence_manifest.json")):
        evidence_dir = manifest_path.parent
        candidates = [
            (evidence_dir / name, compression)
            for name, compression in _LOCAL_EVIDENCE_ARCHIVES
            if (evidence_dir / name).exists()
            or (evidence_dir / name).is_symlink()
        ]
        if not candidates:
            continue
        try:
            if manifest_path.is_symlink() or not manifest_path.is_file():
                raise OSError("manifest is not a regular local file")
            if manifest_path.stat().st_size > MAX_EVIDENCE_MANIFEST_BYTES:
                raise OSError(
                    "manifest exceeds the permitted "
                    f"{MAX_EVIDENCE_MANIFEST_BYTES}-byte size"
                )
            manifest_bytes = manifest_path.read_bytes()
        except OSError as exc:
            relative = _relative_retention_path(job_root, evidence_dir)
            raise JobRetentionRefused(
                f"full strip refused for {relative}: cannot authenticate the "
                f"local evidence manifest: {exc}"
            ) from exc

        failures: list[str] = []
        verified = False
        for archive_path, compression in candidates:
            try:
                if archive_path.is_symlink() or not archive_path.is_file():
                    raise OSError("archive is not a regular local file")
                with tempfile.TemporaryDirectory(
                    prefix="airfoilfoam-retention-verify-"
                ) as temporary:
                    extract_verified_evidence_archive(
                        archive_path,
                        Path(temporary) / "manifest-only",
                        compression=compression,
                        include_prefixes=(_RETENTION_VERIFY_ONLY_PREFIX,),
                        expected_manifest=manifest_bytes,
                    )
                verified = True
                break
            except (EvidenceStoreError, OSError, ValueError) as exc:
                failures.append(f"{archive_path.name}: {exc}")

        if not verified:
            relative = _relative_retention_path(job_root, evidence_dir)
            detail = "; ".join(failures)
            raise JobRetentionRefused(
                f"full strip refused for {relative}: no local evidence archive "
                f"streamed and authenticated every bundled manifest member"
                + (f" ({detail})" if detail else "")
            )


def _relative_retention_path(job_root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(job_root))
    except ValueError:
        return str(path)


@contextmanager
def _job_retention_guard(job_root: Path):
    """Hold the same advisory lock as ``run_polar`` during retention.

    A lock file's mtime records when a long batch started, not whether its
    process still owns the lock. The previous six-hour timestamp heuristic
    retained tens of GiB for hours after completed jobs and contributed to the
    production disk exhaustion. An OS-held flock is exact and remains held for
    the complete strip/delete operation, closing the check-then-delete race.
    """

    lock = job_root / ".execute.lock"
    try:
        lock_file = lock.open("a+")
    except OSError as exc:
        raise JobRetentionRefused(f"cannot open execution lock: {exc}") from exc
    try:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise JobRetentionRefused(".execute.lock is held; job is executing") from exc

        for name in ("status.json", "result.json"):
            path = job_root / name
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                if name == "status.json":
                    raise JobRetentionRefused(f"cannot read {name}: {exc}") from exc
                continue
            state = data.get("state") if isinstance(data, dict) else None
            if state in {"pending", "running"}:
                raise JobRetentionRefused(f"{name} state is {state}; job may still be executing")
        yield
    finally:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


def _strip_case_dir(job_root: Path, case_dir: Path, report: StripReport, *, keep_case_state: bool) -> None:
    if keep_case_state:
        # Continuation staging deliberately skips every VTK directory and
        # regenerates field exports from the saved OpenFOAM time directories.
        # Keeping these derived exports for the whole continuation window
        # duplicates the immutable remote evidence for no recovery benefit.
        _strip_continuation_vtk(case_dir, report)
    for child in sorted(case_dir.iterdir()):
        name = child.name
        if name == "evidence" and child.is_dir():
            _strip_evidence_dir(job_root, child, report)
            continue
        if _is_aoa_media_dir(child):
            _strip_media_segment(job_root, child, report)
            continue
        if name in {"images", "frames", "custom_renders"}:
            continue
        if name in _ROOT_JSON_KEEP:
            continue
        if _is_transient_solver_dir(child):
            if not keep_case_state:
                _strip_solver_state_dir(
                    job_root,
                    child,
                    report,
                    case_dir=case_dir,
                )
            continue
        if not keep_case_state and _is_case_solver_artifact(child):
            _remove_path(child, report)
            continue
        if keep_case_state and _is_case_solver_artifact(child):
            continue
        _record_unknown(job_root, child, report)


def _strip_continuation_vtk(case_dir: Path, report: StripReport) -> None:
    """Remove derived live-case VTK while preserving packaged evidence."""

    for root, dirnames, _filenames in os.walk(case_dir, topdown=True):
        current = Path(root)
        # Evidence has its own pointer-aware deletion contract below.  Never
        # bypass it merely because the surrounding live case is continuable.
        if current.name == "evidence":
            dirnames[:] = []
            continue
        if "VTK" in dirnames:
            _remove_path(current / "VTK", report)
            dirnames.remove("VTK")


def _strip_media_segment(job_root: Path, segment_dir: Path, report: StripReport) -> None:
    for child in sorted(segment_dir.iterdir()):
        if child.name == "evidence" and child.is_dir():
            _strip_evidence_dir(job_root, child, report)
        elif child.name in {"images", "frames", "custom_renders"}:
            continue
        else:
            _record_unknown(job_root, child, report)


def _strip_evidence_dir(job_root: Path, evidence_dir: Path, report: StripReport) -> None:
    _validate_remote_pointer(evidence_dir, job_root, report)
    _storage_migration_pending(evidence_dir, job_root, report)
    for child in sorted(evidence_dir.iterdir()):
        if child.name in _EVIDENCE_KEEP_NAMES:
            continue
        else:
            _record_unknown(job_root, child, report)


def _validate_remote_pointer(
    evidence_dir: Path,
    job_root: Path,
    report: StripReport,
) -> None:
    pointer_path = evidence_dir / "engine_evidence.remote.json"
    if not pointer_path.is_file():
        return
    try:
        pointer = read_remote_pointer(pointer_path)
        local_archive = evidence_dir / "engine_evidence.tar.zst"
        if local_archive.is_file():
            size, digest = _file_size_sha256(local_archive)
            if size != pointer.stored_size or digest != pointer.stored_sha256:
                raise EvidenceStoreError(
                    "local tar.zst does not match the verified remote pointer"
                )
    except (EvidenceStoreError, OSError) as exc:
        _record_unknown(job_root, pointer_path, report)


def _file_size_sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _storage_migration_pending(
    evidence_dir: Path,
    job_root: Path,
    report: StripReport,
) -> bool:
    """Keep every packaged source until the dedicated migration finalizes.

    The migration owns the destructive contract because it can verify the
    database acknowledgement and perform a fresh exact-generation restore.
    An unreadable or non-complete receipt fails closed.
    """

    receipt_path = evidence_dir / "storage_migration.json"
    if not receipt_path.is_file():
        return False
    try:
        payload = json.loads(receipt_path.read_text(encoding="utf-8"))
        complete = isinstance(payload, dict) and payload.get("state") == "complete"
    except Exception:
        complete = False
    if not complete:
        _record_unknown(job_root, receipt_path, report)
        return True
    return False


def _strip_solver_state_dir(
    job_root: Path,
    solver_dir: Path,
    report: StripReport,
    *,
    case_dir: Path,
) -> None:
    for child in sorted(solver_dir.iterdir()):
        if child.name == "evidence" and child.is_dir():
            _strip_evidence_dir(job_root, child, report)
        elif _is_transient_solver_dir(child):
            _strip_solver_state_dir(
                job_root,
                child,
                report,
                case_dir=case_dir,
            )
        elif child.is_file() and child.name == _MARCH_BUDGET_FILENAME:
            # Mutable watchdog arming belongs only to the completed process.
            # Continuation staging deliberately excludes it and rewrites a
            # fresh budget for every new chunk.
            _remove_path(child, report)
        elif child.is_file() and child.name in _IMMUTABLE_TRANSIENT_MARKERS:
            # Two guarded 2026-07-17 canaries proved that an older engine can
            # leave immutable trajectory/quality records outside its bundle.
            # Delete one only when this exact case's manifest and canonical
            # tar.zst both prove the byte-identical member.  Otherwise
            # retain/report it fail-safe.
            archive_member, role = _IMMUTABLE_TRANSIENT_MARKERS[child.name]
            if _transient_marker_has_exact_archive_proof(
                case_dir,
                solver_dir,
                child,
                archive_member=archive_member,
                role=role,
            ):
                _remove_path(child, report)
            else:
                _record_unknown(job_root, child, report)
        elif _is_case_solver_artifact(child):
            _remove_path(child, report)
        elif child.name in _CASE_KEEP_DIRS:
            continue
        else:
            _record_unknown(job_root, child, report)


def _transient_marker_has_exact_archive_proof(
    case_dir: Path,
    solver_dir: Path,
    marker: Path,
    *,
    archive_member: str,
    role: str,
) -> bool:
    """Prove an exact live transient record is inside canonical evidence.

    This intentionally reads the retained tar.zst rather than trusting only an
    unpacked staging copy or mutable sidecar manifest.  It streams just far
    enough to compare the archive's manifest and marker bytes, so no temporary
    extraction capacity is required during a storage-reclamation operation.
    """

    evidence_dir = _transient_evidence_dir(case_dir, solver_dir)
    manifest_path = evidence_dir / "evidence_manifest.json"
    archive_path = evidence_dir / "engine_evidence.tar.zst"
    if (
        not manifest_path.is_file()
        or manifest_path.is_symlink()
        or not archive_path.is_file()
        or archive_path.is_symlink()
        or not marker.is_file()
        or marker.is_symlink()
    ):
        return False
    try:
        if manifest_path.stat().st_size > MAX_EVIDENCE_MANIFEST_BYTES:
            return False
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or not isinstance(
            manifest.get("files"),
            list,
        ):
            return False
        if marker.stat().st_size > _MAX_TRANSIENT_MARKER_BYTES:
            return False
        marker_bytes = marker.read_bytes()
        marker_sha256 = hashlib.sha256(marker_bytes).hexdigest()
        matching_entries = [
            entry
            for entry in manifest["files"]
            if isinstance(entry, dict)
            and entry.get("path") == archive_member
        ]
        if len(matching_entries) != 1:
            return False
        entry = matching_entries[0]
        if (
            entry.get("role") != role
            or entry.get("sha256") != marker_sha256
            or entry.get("byteSize") != len(marker_bytes)
        ):
            return False

        pointer_path = evidence_dir / "engine_evidence.remote.json"
        if pointer_path.exists() or pointer_path.is_symlink():
            if not pointer_path.is_file() or pointer_path.is_symlink():
                return False
            pointer = read_remote_pointer(pointer_path)
            archive_size, archive_sha256 = _file_size_sha256(archive_path)
            if (
                archive_size != pointer.stored_size
                or archive_sha256 != pointer.stored_sha256
            ):
                return False

        return _tar_zst_contains_exact_transient_marker(
            archive_path,
            manifest_bytes,
            marker_bytes,
            archive_member=archive_member,
        )
    except (EvidenceStoreError, OSError, ValueError, json.JSONDecodeError):
        return False


def _transient_evidence_dir(case_dir: Path, solver_dir: Path) -> Path:
    name = solver_dir.name
    suffix = name.removeprefix("transient_")
    if suffix.endswith("_refined"):
        suffix = suffix.removesuffix("_refined")
    if suffix.startswith("a") and suffix[1:].isdigit():
        return case_dir / suffix / "evidence"
    return case_dir / "evidence"


def _tar_zst_contains_exact_transient_marker(
    archive_path: Path,
    manifest_bytes: bytes,
    marker_bytes: bytes,
    *,
    archive_member: str,
) -> bool:
    expected = {
        "evidence_manifest.json": manifest_bytes,
        archive_member: marker_bytes,
    }
    seen: set[str] = set()
    try:
        with archive_path.open("rb") as compressed:
            with zstandard.ZstdDecompressor().stream_reader(compressed) as stream:
                with tarfile.open(fileobj=stream, mode="r|") as archive:
                    for member in archive:
                        if member.name not in expected:
                            continue
                        if member.name in seen or not member.isfile():
                            return False
                        source = archive.extractfile(member)
                        if source is None:
                            return False
                        wanted = expected[member.name]
                        actual = source.read(len(wanted) + 1)
                        if member.size != len(wanted) or actual != wanted:
                            return False
                        seen.add(member.name)
                        if seen == set(expected):
                            return True
    except (OSError, tarfile.TarError, zstandard.ZstdError):
        return False
    return False


def _is_case_solver_artifact(path: Path) -> bool:
    name = path.name
    if path.is_dir() and (name in _CASE_DELETE_DIRS or _is_numeric_name(name) or name.startswith("processor")):
        return True
    return path.is_file() and name.startswith("log.")


def _is_transient_solver_dir(path: Path) -> bool:
    return path.is_dir() and path.name.startswith("transient")


def _is_aoa_media_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    name = path.name
    return len(name) > 1 and name[0] == "a" and name[1:].isdigit()


def _is_numeric_name(name: str) -> bool:
    try:
        float(name)
    except ValueError:
        return False
    return True


def _record_unknown(job_root: Path, path: Path, report: StripReport) -> None:
    try:
        rel = str(path.relative_to(job_root))
    except ValueError:
        rel = str(path)
    if rel not in report.unknown_entries:
        report.unknown_entries.append(rel)


def _remove_path(path: Path, report: StripReport) -> None:
    if not path.exists() and not path.is_symlink():
        return
    measured = _measure_path(path)
    _remove_tree_unchecked(path)
    report.bytes_freed += measured["bytes"]
    report.files_removed += measured["files"]
    report.dirs_removed += measured["dirs"]


def _measure_path(path: Path) -> dict[str, int]:
    if path.is_symlink() or path.is_file():
        return {"bytes": _lstat_size(path), "files": 1, "dirs": 0}
    if not path.is_dir():
        return {"bytes": 0, "files": 0, "dirs": 0}

    total = _lstat_size(path)
    files = 0
    dirs = 1
    for root, dirnames, filenames in os.walk(path, followlinks=False):
        root_path = Path(root)
        for filename in filenames:
            child = root_path / filename
            total += _lstat_size(child)
            files += 1
        for dirname in dirnames:
            child = root_path / dirname
            total += _lstat_size(child)
            dirs += 1
            if child.is_symlink():
                files += 1
    return {"bytes": total, "files": files, "dirs": dirs}


def _lstat_size(path: Path) -> int:
    try:
        return int(path.lstat().st_size)
    except OSError:
        return 0


def _remove_tree_unchecked(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)
