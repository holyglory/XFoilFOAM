"""FastAPI application exposing airfoil polar CFD jobs."""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import io
import json
import mimetypes
import os
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import ContextManager, Iterator, Literal

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import __version__, physics
from ..airfoil import load_airfoil
from ..cache import EngineCache
from ..capabilities import MESH_RECOVERY_VERSION, URANS_RECOVERY_VERSION
from ..config import get_settings
from ..evidence_runtime import (
    ARCHIVE_MIME_TYPE,
    EVIDENCE_ARCHIVE_NAME,
    PACKAGED_RAW_DIRS,
    BrokeredRemoteEvidenceReclaim,
    EvidenceCleanupAuthorization,
    EvidenceCleanupError,
    EvidenceDatabaseAssociation,
    evidence_object_store,
    evidence_pointer_path,
    finalize_remote_evidence_cleanup,
    hydrated_pointer_render_source,
    hydrated_render_source,
    reclaim_brokered_remote_evidence,
    hydrated_volume_render_source,
    prepare_brokered_legacy_evidence_archive,
)
from ..evidence_store import (
    MAX_EVIDENCE_MANIFEST_BYTES,
    EvidenceStoreError,
    RemoteEvidencePointer,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
)
from ..evidence_upload_broker import (
    BrokeredEvidenceIdentity,
    BrokeredEvidenceSessionOwner,
    cancel_brokered_upload_session,
    cancel_brokered_upload_session_by_identity,
    create_brokered_upload_session,
    settle_brokered_upload_session_intent,
    verify_brokered_upload,
)
from ..meshing.base import list_meshers
from ..models import (
    AirfoilInput,
    ImageField,
    JobPhase,
    JobResult,
    JobState,
    JobStatus,
    PolarRequest,
    TurbulenceModel,
)
from ..openfoam.dialects import (
    OPENCFD_2606_IDENTITY,
    UnsupportedEngineIdentity,
    get_openfoam_dialect,
    supported_openfoam_identities,
)
from ..postprocess.images import compute_field_extents, render_animations, render_contours, render_custom_field, render_mean_contours
from ..retention import JobRetentionRefused, delete_job_dir, strip_job_dir
from ..storage import JobStore


class RuntimeRequest(BaseModel):
    job_ids: list[str] = Field(default_factory=list, max_length=250)


class RenderFieldRequest(BaseModel):
    case_slug: str
    evidence_base: str = "evidence"
    airfoil_points: list[tuple[float, float]]
    chord: float = Field(gt=0)
    speed: float = Field(ge=0)
    field: ImageField
    role: str = Field(default="instantaneous", pattern="^(instantaneous|mean)$")
    zoom_chords: float = Field(default=2.0, gt=0)
    colormap: str | None = None
    levels: int = Field(default=40, ge=3, le=200)
    vmin: float | None = None
    vmax: float | None = None
    frame_index: int | None = Field(default=None, ge=0)
    width_px: int = Field(default=990, ge=320, le=2400)
    height_px: int = Field(default=660, ge=240, le=1800)
    params_hash: str | None = None
    source_mode: Literal["auto", "archive"] = "auto"
    remote: dict[str, object] | None = None


class FieldScaleRequest(BaseModel):
    vmin: float
    vmax: float


class FieldExtentsRequest(BaseModel):
    case_slug: str
    evidence_base: str = "evidence"
    airfoil_points: list[tuple[float, float]]
    chord: float = Field(gt=0)
    speed: float = Field(ge=0)
    fields: list[ImageField] = Field(default_factory=list)
    zoom_chords: float = Field(default=2.0, gt=0)
    max_frames: int | None = Field(default=220, ge=1, le=500)
    source_mode: Literal["auto", "archive"] = "auto"
    remote: dict[str, object] | None = None


class RenderDefaultMediaRequest(BaseModel):
    case_slug: str
    evidence_base: str = "evidence"
    airfoil_points: list[tuple[float, float]]
    chord: float = Field(gt=0)
    speed: float = Field(ge=0)
    fields: list[ImageField] = Field(default_factory=list)
    scales: dict[ImageField, FieldScaleRequest]
    unsteady: bool = False
    zoom_chords: float = Field(default=2.0, gt=0)
    scale_version: int = Field(default=1, ge=1)
    render_profile_key: str = Field(default="default:v1:zoom2")
    source_mode: Literal["auto", "archive"] = "auto"
    remote: dict[str, object] | None = None


class StripJobRequest(BaseModel):
    keep_case_state: bool = False


class EvidenceDatabaseAssociationRequest(BaseModel):
    result_id: uuid.UUID
    result_attempt_id: uuid.UUID
    source_artifact_id: uuid.UUID
    archive_id: uuid.UUID
    member_association_count: int = Field(ge=1)
    member_associations_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    manifest_member_set_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class FinalizeRemoteEvidenceRequest(BaseModel):
    case_slug: str = Field(min_length=1, max_length=240)
    evidence_base: str = Field(min_length=1, max_length=800)
    remote: dict[str, object]
    database_associations: list[EvidenceDatabaseAssociationRequest] = Field(
        min_length=1, max_length=32
    )


class BrokeredEvidenceIdentityRequest(BaseModel):
    brokered_upload_id: uuid.UUID = Field(alias="brokeredUploadId")
    promise_id: uuid.UUID = Field(alias="promiseId")
    promise_point_id: uuid.UUID = Field(alias="promisePointId")
    solver_id: uuid.UUID = Field(alias="solverId")
    source_instance_id: str = Field(alias="sourceInstanceId", min_length=1, max_length=240)
    remote_result_id: uuid.UUID = Field(alias="remoteResultId")
    remote_result_attempt_id: uuid.UUID = Field(alias="remoteResultAttemptId")
    aoa_deg: float = Field(alias="aoaDeg", ge=-180, le=180)
    engine_job_id: str = Field(alias="engineJobId", min_length=1, max_length=240)
    engine_case_slug: str | None = Field(alias="engineCaseSlug", default=None, max_length=240)
    bucket: str = Field(min_length=1)
    object_key: str = Field(alias="objectKey", min_length=1)
    stored_sha256: str = Field(alias="storedSha256", pattern=r"^[0-9a-f]{64}$")
    stored_size: int = Field(alias="storedSize", gt=0)
    tar_sha256: str = Field(alias="tarSha256", pattern=r"^[0-9a-f]{64}$")
    tar_size: int = Field(alias="tarSize", gt=0)
    manifest_sha256: str = Field(alias="manifestSha256", pattern=r"^[0-9a-f]{64}$")
    manifest_size: int = Field(alias="manifestSize", gt=0)
    zstd_level: int = Field(alias="zstdLevel", ge=1, le=22)
    bundled_file_count: int = Field(alias="bundledFileCount", gt=0)

    def identity(self) -> BrokeredEvidenceIdentity:
        return BrokeredEvidenceIdentity(
            bucket=self.bucket,
            object_key=self.object_key,
            stored_sha256=self.stored_sha256,
            stored_size=self.stored_size,
            tar_sha256=self.tar_sha256,
            tar_size=self.tar_size,
            manifest_sha256=self.manifest_sha256,
            manifest_size=self.manifest_size,
            zstd_level=self.zstd_level,
            bundled_file_count=self.bundled_file_count,
        )

    def owner(self) -> BrokeredEvidenceSessionOwner:
        return BrokeredEvidenceSessionOwner(
            brokered_upload_id=str(self.brokered_upload_id),
            promise_id=str(self.promise_id),
            promise_point_id=str(self.promise_point_id),
            solver_id=str(self.solver_id),
            source_instance_id=self.source_instance_id,
            remote_result_id=str(self.remote_result_id),
            remote_result_attempt_id=str(self.remote_result_attempt_id),
            aoa_deg=self.aoa_deg,
            engine_job_id=self.engine_job_id,
            engine_case_slug=self.engine_case_slug,
        )


class BrokeredEvidenceVerifyRequest(BrokeredEvidenceIdentityRequest):
    generation: str = Field(pattern=r"^[1-9][0-9]{0,19}$")


class BrokeredEvidenceCancelRequest(BaseModel):
    upload_url: str = Field(alias="uploadUrl", min_length=1, max_length=8192)
    bucket: str = Field(min_length=1, max_length=222)
    object_key: str = Field(alias="objectKey", min_length=1, max_length=2048)


class BrokeredEvidenceCancelIdentityRequest(BrokeredEvidenceIdentityRequest):
    upload_url: str | None = Field(alias="uploadUrl", default=None, max_length=8192)


class BrokeredEvidenceSessionSettlementRequest(BrokeredEvidenceIdentityRequest):
    final: bool = False
    generation: str | None = Field(
        default=None,
        pattern=r"^[1-9][0-9]{0,19}$",
    )


class BrokeredEvidenceDownloadRequest(BrokeredEvidenceIdentityRequest):
    generation: str = Field(pattern=r"^[1-9][0-9]{0,19}$")
    crc32c: str = Field(pattern=r"^[A-Za-z0-9+/]{6}==$")
    created_at: str = Field(alias="createdAt", min_length=1, max_length=80)

    def pointer(self) -> RemoteEvidencePointer:
        return RemoteEvidencePointer(
            bucket=self.bucket,
            object_key=self.object_key,
            generation=int(self.generation),
            stored_sha256=self.stored_sha256,
            stored_size=self.stored_size,
            tar_sha256=self.tar_sha256,
            tar_size=self.tar_size,
            crc32c=self.crc32c,
            zstd_level=self.zstd_level,
            created_at=self.created_at,
        )


class BrokeredEvidenceReclaimRequest(BaseModel):
    job_id: str = Field(alias="jobId", min_length=1, max_length=240)
    case_slug: str = Field(alias="caseSlug", min_length=1, max_length=240)
    evidence_base: str = Field(alias="evidenceBase", min_length=1, max_length=800)
    receipt: dict[str, object]
    receipt_hmac: str = Field(
        alias="receiptHmac", pattern=r"^[0-9a-f]{64}$"
    )


class PrepareBrokeredLegacyEvidenceRequest(BaseModel):
    case_slug: str = Field(alias="caseSlug", min_length=1, max_length=240)
    evidence_base: str = Field(alias="evidenceBase", min_length=1, max_length=800)
    legacy_archive_name: Literal[
        "openfoam_evidence.tar.gz", "engine_evidence.tar.gz"
    ] = Field(alias="legacyArchiveName")
    legacy_archive_sha256: str = Field(
        alias="legacyArchiveSha256", pattern=r"^[0-9a-f]{64}$"
    )
    legacy_archive_byte_size: int = Field(alias="legacyArchiveByteSize", gt=0)
    manifest_sha256: str = Field(
        alias="manifestSha256", pattern=r"^[0-9a-f]{64}$"
    )
    manifest_byte_size: int = Field(alias="manifestByteSize", gt=0)


_MAX_EVIDENCE_MANIFEST_BASE64_BYTES = (
    4 * ((MAX_EVIDENCE_MANIFEST_BYTES + 2) // 3)
)


class VerifyRemoteEvidenceManifestRequest(BaseModel):
    """Exact immutable archive and manifest identity to authenticate in GCS."""

    remote: dict[str, object]
    manifest_base64: str = Field(
        alias="manifestBase64",
        min_length=4,
        max_length=_MAX_EVIDENCE_MANIFEST_BASE64_BYTES,
    )
    manifest_sha256: str = Field(
        alias="manifestSha256", pattern=r"^[0-9a-f]{64}$"
    )
    manifest_byte_size: int = Field(
        alias="manifestByteSize",
        gt=0,
        le=MAX_EVIDENCE_MANIFEST_BYTES,
    )
    manifest_member_set_sha256: str = Field(
        alias="manifestMemberSetSha256", pattern=r"^[0-9a-f]{64}$"
    )
    manifest_member_count: int = Field(
        alias="manifestMemberCount",
        gt=0,
        le=MAX_EVIDENCE_MANIFEST_BYTES,
    )

    def decoded_manifest(self) -> bytes:
        try:
            manifest = base64.b64decode(self.manifest_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("manifestBase64 must be canonical base64") from exc
        if base64.b64encode(manifest).decode("ascii") != self.manifest_base64:
            raise ValueError("manifestBase64 must be canonical base64")
        if len(manifest) > MAX_EVIDENCE_MANIFEST_BYTES:
            raise ValueError(
                "evidence manifest exceeds the "
                f"{MAX_EVIDENCE_MANIFEST_BYTES}-byte limit"
            )
        if len(manifest) != self.manifest_byte_size:
            raise ValueError(
                "decoded manifest byte size does not match manifestByteSize"
            )
        if hashlib.sha256(manifest).hexdigest() != self.manifest_sha256:
            raise ValueError(
                "decoded manifest SHA-256 does not match manifestSha256"
            )
        member_count, member_set_sha256 = manifest_bundle_member_set_sha256(
            manifest
        )
        if member_count != self.manifest_member_count:
            raise ValueError(
                "manifest member count does not match manifestMemberCount"
            )
        if member_set_sha256 != self.manifest_member_set_sha256:
            raise ValueError(
                "manifest member-set SHA-256 does not match "
                "manifestMemberSetSha256"
            )
        return manifest


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _require_control_plane_bearer(
    expected_token: str | None,
    authorization: str | None,
) -> None:
    supplied_token = ""
    if authorization and authorization.startswith("Bearer "):
        supplied_token = authorization.removeprefix("Bearer ")
    if (
        not expected_token
        or not supplied_token
        or not hmac.compare_digest(supplied_token, expected_token)
    ):
        raise HTTPException(
            status_code=401,
            detail="Valid control-plane bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _evidence_identity_headers(pointer: RemoteEvidencePointer) -> dict[str, str]:
    return {
        "x-content-sha256": pointer.stored_sha256,
        "x-gcs-generation": str(pointer.generation),
    }


def _evidence_dir_for_target(job_root: Path, target: Path) -> Path | None:
    current = target.parent
    while current != job_root and job_root in current.parents:
        if evidence_pointer_path(current).is_file():
            return current
        current = current.parent
    return None


def _expected_archive_pointer(
    evidence_dir: Path,
    *,
    expected_bucket: str | None,
    expected_object_key: str | None,
    expected_generation: int | None,
    expected_stored_sha256: str | None,
    expected_stored_size: int | None,
) -> RemoteEvidencePointer | None:
    values = (
        expected_bucket,
        expected_object_key,
        expected_generation,
        expected_stored_sha256,
        expected_stored_size,
    )
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise HTTPException(
            status_code=400,
            detail="Expected evidence identity must include bucket, object, generation, SHA-256 and size",
        )
    if (
        not expected_bucket
        or not expected_object_key
        or expected_generation is None
        or expected_generation <= 0
        or expected_stored_sha256 is None
        or len(expected_stored_sha256) != 64
        or any(char not in "0123456789abcdef" for char in expected_stored_sha256)
        or expected_stored_size is None
        or expected_stored_size <= 0
    ):
        raise HTTPException(status_code=400, detail="Expected evidence identity is invalid")
    try:
        pointer = read_remote_pointer(evidence_pointer_path(evidence_dir))
    except (EvidenceStoreError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Stored evidence pointer could not be verified: {exc}",
        ) from exc
    if (
        pointer.bucket != expected_bucket
        or pointer.object_key != expected_object_key
        or pointer.generation != expected_generation
        or pointer.stored_sha256 != expected_stored_sha256
        or pointer.stored_size != expected_stored_size
    ):
        raise HTTPException(
            status_code=409,
            detail="Stored evidence pointer does not match the expected immutable generation",
        )
    return pointer


def _stream_verified_local_archive(
    path: Path,
    pointer: RemoteEvidencePointer,
) -> StreamingResponse:
    if not path.is_file() or path.is_symlink():
        raise HTTPException(
            status_code=502,
            detail="Local evidence archive is not a regular file",
        )
    try:
        handle = path.open("rb")
        size = os.fstat(handle.fileno()).st_size
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        if size != pointer.stored_size or digest.hexdigest() != pointer.stored_sha256:
            handle.close()
            raise HTTPException(
                status_code=502,
                detail="Local evidence archive size or SHA-256 does not match the immutable generation",
            )
        handle.seek(0)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Local evidence archive is unavailable: {exc}",
        ) from exc

    def body() -> Iterator[bytes]:
        try:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                yield chunk
        finally:
            handle.close()

    return StreamingResponse(
        body(),
        media_type=ARCHIVE_MIME_TYPE,
        headers={
            "content-length": str(size),
            **_evidence_identity_headers(pointer),
        },
    )


def _render_hash(req: RenderFieldRequest) -> str:
    payload = req.model_dump(mode="json", exclude={"params_hash"})
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _safe_component(value: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in "._-" else "_" for c in value).strip("._-")
    return cleaned or "default"


def _evidence_window(evidence_dir: Path) -> tuple[float | None, float | None]:
    manifest = evidence_dir / "evidence_manifest.json"
    if not manifest.is_file():
        return None, None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return None, None
    start = data.get("windowStart")
    end = data.get("windowEnd")
    return (
        float(start) if isinstance(start, (int, float)) else None,
        float(end) if isinstance(end, (int, float)) else None,
    )


@contextmanager
def _render_source(
    case_dir: Path,
    evidence_dir: Path,
    settings,
    *,
    source_mode: Literal["auto", "archive"] = "auto",
    remote_pointer: RemoteEvidencePointer | None = None,
) -> Iterator[Path]:
    """Yield the best real VTK source, holding remote cache protection in use.

    Finalized remote-only evidence is hydrated only after both the immutable
    archive and its VTK manifest have passed the checks in ``EvidenceObjectStore``.
    Keeping this context open around the renderer prevents the bounded cache
    cleanup pass from evicting that evidence mid-render.
    """

    if remote_pointer is not None:
        if source_mode != "archive":
            raise HTTPException(
                status_code=400,
                detail="An inline remote evidence pointer requires archive source mode",
            )
        try:
            with hydrated_pointer_render_source(remote_pointer, settings) as source_dir:
                if not (source_dir / "VTK").is_dir():
                    raise EvidenceStoreError(
                        "verified remote evidence has no VTK directory"
                    )
                yield source_dir
            return
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"Retained remote evidence is unavailable: {exc}",
            ) from exc
        except (EvidenceStoreError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Retained remote evidence could not be verified: {exc}",
            ) from exc

    if source_mode == "archive":
        pointer_path = evidence_pointer_path(evidence_dir)
        try:
            if pointer_path.is_file():
                with hydrated_render_source(evidence_dir, settings) as source_dir:
                    if not (source_dir / "VTK").is_dir():
                        raise EvidenceStoreError(
                            "verified remote evidence has no VTK directory"
                        )
                    yield source_dir
                return
            with hydrated_volume_render_source(evidence_dir, settings) as source_dir:
                yield source_dir
            return
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"Retained evidence archive is unavailable: {exc}",
            ) from exc
        except (EvidenceStoreError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Retained evidence archive could not be verified: {exc}",
            ) from exc

    if (evidence_dir / "VTK").is_dir():
        yield evidence_dir
        return

    pointer_path = evidence_pointer_path(evidence_dir)
    if pointer_path.is_file():
        try:
            with hydrated_render_source(evidence_dir, settings) as source_dir:
                if not (source_dir / "VTK").is_dir():
                    raise EvidenceStoreError("verified remote evidence has no VTK directory")
                yield source_dir
            return
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Remote VTK evidence is unavailable: {exc}",
            ) from exc
        except (EvidenceStoreError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Remote VTK evidence could not be verified: {exc}",
            ) from exc
    # Legacy/local-only result with no immutable pointer.  Once a pointer is
    # present, never render from the mutable live case instead of its exact
    # archived generation.
    if (case_dir / "VTK").is_dir():
        yield case_dir
        return

    raise HTTPException(
        status_code=404,
        detail="Stored VTK evidence not found",
    )


def _inline_remote_pointer(
    remote: dict[str, object] | None,
) -> RemoteEvidencePointer | None:
    if remote is None:
        return None
    try:
        return RemoteEvidencePointer.from_dict(remote)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid remote evidence pointer: {exc}",
        ) from exc


def _manifest_lists_member(evidence_dir: Path, member_path: str) -> bool:
    """Return whether the retained evidence manifest owns an exact member."""

    manifest_path = evidence_dir / "evidence_manifest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - corrupt local evidence is explicit
        raise HTTPException(
            status_code=409,
            detail=f"Stored evidence manifest is unavailable: {exc}",
        ) from exc
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list):
        raise HTTPException(
            status_code=409,
            detail="Stored evidence manifest has no files list",
        )
    return any(
        isinstance(item, dict) and item.get("path") == member_path
        for item in files
    )


def _stream_remote_evidence(
    source: ContextManager[Path],
    *,
    media_type: str,
    identity: RemoteEvidencePointer | None = None,
) -> StreamingResponse:
    """Enter a verified cache lease before responding and hold it to EOF."""

    try:
        path = source.__enter__()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Remote evidence is unavailable: {exc}",
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Remote evidence storage is unavailable: {exc}",
        ) from exc
    except (EvidenceStoreError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Remote evidence could not be verified: {exc}",
        ) from exc

    if not path.is_file() or path.is_symlink():
        source.__exit__(None, None, None)
        raise HTTPException(
            status_code=502,
            detail="Verified remote evidence did not materialize a regular file",
        )
    try:
        content_length = path.stat().st_size
    except OSError as exc:
        source.__exit__(type(exc), exc, exc.__traceback__)
        raise HTTPException(
            status_code=503,
            detail=f"Verified remote evidence became unavailable: {exc}",
        ) from exc

    def body() -> Iterator[bytes]:
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    yield chunk
        finally:
            source.__exit__(None, None, None)

    headers = {"content-length": str(content_length)}
    if identity is not None:
        if (
            content_length != identity.stored_size
            or _sha256_file(path) != identity.stored_sha256
        ):
            source.__exit__(None, None, None)
            raise HTTPException(
                status_code=502,
                detail="Verified remote evidence does not match the expected immutable generation",
            )
        headers.update(_evidence_identity_headers(identity))
    return StreamingResponse(
        body(),
        media_type=media_type,
        headers=headers,
    )


def _field_scales(scales: dict[ImageField, FieldScaleRequest]) -> dict[ImageField, tuple[float, float]]:
    return {field: (spec.vmin, spec.vmax) for field, spec in scales.items()}


def _media_file_payload(job_id: str, case_slug: str, case_dir: Path, path: Path, field: ImageField, role: str, kind: str) -> dict:
    rel = path.relative_to(case_dir)
    return {
        "kind": kind,
        "field": field.value,
        "role": role,
        "path": str(rel),
        "url": f"/jobs/{job_id}/files/cases/{case_slug}/{rel}",
        "mime_type": "video/mp4" if kind == "video" else "image/png",
        "sha256": _sha256_file(path),
        "byte_size": path.stat().st_size,
    }


def _task_job_id(task: dict) -> str | None:
    args = task.get("args")
    if isinstance(args, list) and args:
        return str(args[0])
    if isinstance(args, str):
        stripped = args.strip()
        if stripped.startswith("["):
            try:
                import json

                parsed = json.loads(stripped)
                if parsed:
                    return str(parsed[0])
            except Exception:  # noqa: BLE001
                return None
        if stripped:
            return stripped.split(",", 1)[0].strip("('\" ")
    return None


def _summarize_tasks(tasks_by_worker: dict | None) -> list[dict]:
    rows: list[dict] = []
    for worker, tasks in (tasks_by_worker or {}).items():
        for task in tasks or []:
            rows.append(
                {
                    "worker": worker,
                    "task_id": task.get("id"),
                    "name": task.get("name"),
                    "job_id": _task_job_id(task),
                    "redelivered": bool((task.get("delivery_info") or {}).get("redelivered")),
                    "time_start": task.get("time_start"),
                }
            )
    return rows


def create_app() -> FastAPI:
    app = FastAPI(
        title="XFoilFOAM",
        version=__version__,
        description="Compute airfoil angle-of-attack polars with 2D RANS CFD in OpenFOAM.",
    )
    settings = get_settings()
    store = JobStore(settings)
    # Worker runtime identity is immutable for the lifetime of one exact
    # worker/queue binding. Celery's `inspect.conf()` handler creates a Kombu
    # transport on the worker; polling it on every /queue request leaked
    # eventpoll descriptors until the worker reached RLIMIT_NOFILE. Cache only
    # a complete exact-binding snapshot and invalidate as soon as a worker or
    # queue name changes. The lock is also a single-flight fence for concurrent
    # queue requests.
    worker_runtime_cache_lock = Lock()
    worker_runtime_cache_key: tuple[tuple[str, tuple[str, ...]], ...] | None = None
    worker_runtime_cache_value: dict[str, dict] | None = None

    def registered_dialects():
        return [
            get_openfoam_dialect(identity)
            for identity in supported_openfoam_identities()
        ]

    def enabled_dialects():
        enabled = settings.enabled_engine_key_set()
        return [
            dialect
            for dialect in registered_dialects()
            if dialect.identity.handshake_key in enabled
        ]

    def safe_job_root(job_id: str) -> Path:
        jobs_root = (settings.data_dir / "jobs").resolve()
        job_root = store.job_dir(job_id).resolve()
        if job_root.parent != jobs_root:
            raise HTTPException(status_code=400, detail="Invalid job id")
        return job_root

    # ------------------------------------------------------------------ #
    @app.get("/health")
    def health() -> dict:
        enabled = enabled_dialects()
        disabled = [
            dialect
            for dialect in registered_dialects()
            if dialect not in enabled
        ]
        return {
            "status": "ok",
            "role": "solver_gateway",
            "version": __version__,
            "build_id": settings.build_id,
            "mesh_recovery_version": MESH_RECOVERY_VERSION,
            "urans_recovery_version": URANS_RECOVERY_VERSION,
            "package_file": __file__,
            # A gateway advertises logical routing targets only. Exact runtime
            # provenance appears solely on worker-acknowledged status/results.
            "default_engine": OPENCFD_2606_IDENTITY.model_dump(mode="json"),
            "supported_engines": [
                dialect.identity.model_dump(mode="json") for dialect in enabled
            ],
            "registered_disabled_engines": [
                dialect.identity.model_dump(mode="json") for dialect in disabled
            ],
            # Bucket names and codec policy are non-secret operational
            # identity. Exposing this exact contract lets a guarded cutover
            # prove that the live gateway did not start with storage settings
            # different from the durable canary receipt.
            "evidence_storage": {
                "backend": "gcs" if settings.evidence_bucket else "volume",
                # Pydantic preserves an explicitly empty environment value as
                # ``""`` even though it has the same operational meaning as
                # an unset bucket.  Keep the public storage identity canonical
                # so a credentialless volume runtime reports JSON null and can
                # be compared exactly with its durable canary receipt.
                "bucket": settings.evidence_bucket or None,
                "object_prefix": settings.evidence_object_prefix,
                "archive_format": "tar+zstd",
                "compression": "zstd",
                "zstd_level": settings.evidence_zstd_level,
                "remote_only": settings.evidence_remote_only,
            },
        }

    @app.get("/capabilities")
    def capabilities() -> dict:
        dialects = enabled_dialects()
        disabled = [
            dialect
            for dialect in registered_dialects()
            if dialect not in dialects
        ]
        return {
            "meshers": list_meshers(),
            "turbulence_models": [m.value for m in TurbulenceModel],
            "openfoam_image": settings.openfoam_image,
            "runner": settings.openfoam_runner,
            "default_engine": OPENCFD_2606_IDENTITY.model_dump(mode="json"),
            "supported_engines": [
                dialect.identity.model_dump(mode="json") for dialect in dialects
            ],
            "engines": [dialect.capabilities().model_dump(mode="json") for dialect in dialects],
            "registered_disabled_engines": [
                dialect.identity.model_dump(mode="json") for dialect in disabled
            ],
        }

    @app.get("/cache/stats")
    def cache_stats() -> dict:
        """Disk truth about the mesh/seed cache: entry counts, bytes, cap and
        the oldest last-used manifest. Missing/empty cache dir → zeros."""
        return EngineCache.from_settings(settings).stats()

    @app.post("/airfoils/parse")
    def parse_airfoil(airfoil: AirfoilInput) -> dict:
        try:
            af = load_airfoil(airfoil.name, airfoil.coordinates, airfoil.points, airfoil.format)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not parse airfoil: {exc}")
        upper, lower = af.split_surfaces()
        thickness = float(np.max(np.interp(lower[:, 0], upper[:, 0], upper[:, 1]) - lower[:, 1])) \
            if len(upper) and len(lower) else None
        return {
            "name": af.name,
            "n_points": int(af.contour.shape[0]),
            "leading_edge_index": af.le_index,
            "trailing_edge_gap_original": af.te_gap_original,
            "max_thickness_fraction": thickness,
        }

    @app.post("/polars", response_model=JobStatus, status_code=202)
    def submit_polar(request: PolarRequest) -> JobStatus:
        requested_engine = request.expected_engine or OPENCFD_2606_IDENTITY
        try:
            dialect = get_openfoam_dialect(requested_engine)
        except UnsupportedEngineIdentity as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "unsupported_engine_identity",
                    "requested_engine": requested_engine.model_dump(mode="json"),
                    "message": str(exc),
                },
            ) from exc
        if dialect.identity.handshake_key not in settings.enabled_engine_key_set():
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "engine_not_enabled",
                    "requested_engine": requested_engine.model_dump(mode="json"),
                    "message": (
                        "The solver adapter is registered but no gateway execution pool "
                        "is enabled for this exact engine identity."
                    ),
                },
            )
        if (
            request.expected_execution_pool is not None
            and request.expected_execution_pool != dialect.queue_name
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "execution_pool_mismatch",
                    "requested_execution_pool": request.expected_execution_pool,
                    "actual_execution_pool": dialect.queue_name,
                    "requested_engine": requested_engine.model_dump(mode="json"),
                    "message": (
                        "The requested execution pool does not match the registered "
                        "routing key for this exact solver engine."
                    ),
                },
            )
        if (
            request.expected_mesh_recovery_version is not None
            and request.expected_mesh_recovery_version != MESH_RECOVERY_VERSION
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "mesh_recovery_version_mismatch",
                    "requested_version": request.expected_mesh_recovery_version,
                    "actual_version": MESH_RECOVERY_VERSION,
                    "message": (
                        "Engine mesh-recovery capability changed before submission: "
                        f"requested v{request.expected_mesh_recovery_version}, "
                        f"API is v{MESH_RECOVERY_VERSION}. Refresh capability and retry."
                    ),
                },
            )
        if (
            request.expected_urans_recovery_version is not None
            and request.expected_urans_recovery_version != URANS_RECOVERY_VERSION
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "urans_recovery_version_mismatch",
                    "requested_version": request.expected_urans_recovery_version,
                    "actual_version": URANS_RECOVERY_VERSION,
                    "message": (
                        "Engine URANS-recovery capability changed before submission: "
                        f"requested v{request.expected_urans_recovery_version}, "
                        f"API is v{URANS_RECOVERY_VERSION}. Refresh capability and retry."
                    ),
                },
            )
        # validate airfoil up-front so bad geometry fails fast with 422
        try:
            load_airfoil(
                request.airfoil.name, request.airfoil.coordinates,
                request.airfoil.points, request.airfoil.format,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid airfoil: {exc}")

        job_id = uuid.uuid4().hex
        store.create(job_id, request)
        # import here so the API can start even if the broker is unavailable at import time
        from ..celery_app import task_hard_time_limit_s
        from ..tasks import run_polar

        # Hard celery backstop scaled by THIS job's case count (one task runs
        # the whole polar job; the app-level default only covers one case) and
        # by a continuation's per-job budget override when present.
        total_cases = max(1, len(request.cases()))
        async_result = run_polar.apply_async(
            args=[job_id, request.model_dump_json()],
            task_id=job_id,
            queue=dialect.queue_name,
            time_limit=task_hard_time_limit_s(
                get_settings(), total_cases, budget_override_s=request.budget_override_s
            ),
        )
        status = store.read_status(job_id)
        assert status is not None
        status.task_id = async_result.id
        store.write_status(status)
        return status

    @app.get("/queue")
    def queue_state() -> dict:
        nonlocal worker_runtime_cache_key, worker_runtime_cache_value
        from ..celery_app import celery_app

        inspect = celery_app.control.inspect(timeout=1.0)
        inspection_errors: dict[str, str] = {}
        inspection_workers: dict[str, list[str]] = {}

        def inspect_tasks(kind: str) -> list[dict]:
            try:
                snapshot = getattr(inspect, kind)()
                if snapshot is None:
                    inspection_errors[kind] = (
                        f"Celery inspector returned no {kind} task snapshot"
                    )
                    return []
                if not isinstance(snapshot, dict):
                    inspection_errors[kind] = (
                        f"Celery inspector returned an invalid {kind} task snapshot"
                    )
                    return []
                inspection_workers[kind] = sorted(str(worker) for worker in snapshot)
                return _summarize_tasks(snapshot)
            except Exception as exc:  # noqa: BLE001 - queue observability stays available
                inspection_errors[kind] = f"{type(exc).__name__}: {exc}"
                return []

        active = inspect_tasks("active")
        reserved = inspect_tasks("reserved")
        scheduled = inspect_tasks("scheduled")
        worker_queues: list[dict] | None = None
        worker_queues_error: str | None = None
        worker_runtime_error: str | None = None
        try:
            active_queue_replies = inspect.active_queues()
            if active_queue_replies is None:
                worker_queues_error = "Celery inspector returned no active-queue snapshot"
            elif not isinstance(active_queue_replies, dict):
                worker_queues_error = "Celery inspector returned an invalid active-queue snapshot"
            else:
                expected_workers = {str(worker) for worker in active_queue_replies}
                binding_key = tuple(
                    (
                        str(worker),
                        tuple(
                            sorted(
                                {
                                    str(queue.get("name"))
                                    for queue in queues or []
                                    if isinstance(queue, dict) and queue.get("name")
                                }
                            )
                        ),
                    )
                    for worker, queues in sorted(active_queue_replies.items())
                )
                for kind in ("active", "reserved", "scheduled"):
                    observed_workers = set(inspection_workers.get(kind, []))
                    if kind not in inspection_errors and observed_workers != expected_workers:
                        inspection_errors[kind] = (
                            f"Celery inspector {kind} worker coverage is incomplete: "
                            f"expected={sorted(expected_workers)!r}, "
                            f"observed={sorted(observed_workers)!r}"
                        )
                # Keep the cold inspect, validation, and cache publication in
                # one critical section. Concurrent queue polls must share one
                # broker command rather than each leaking its own transport on
                # the worker before the first response has populated the cache.
                with worker_runtime_cache_lock:
                    if (
                        worker_runtime_cache_key == binding_key
                        and worker_runtime_cache_value is not None
                    ):
                        config_replies = worker_runtime_cache_value
                    else:
                        try:
                            config_replies = inspect.conf()
                            if config_replies is None:
                                worker_runtime_error = (
                                    "Celery inspector returned no worker-runtime snapshot"
                                )
                                config_replies = {}
                            elif not isinstance(config_replies, dict):
                                worker_runtime_error = (
                                    "Celery inspector returned an invalid worker-runtime snapshot"
                                )
                                config_replies = {}
                            elif (
                                set(str(worker) for worker in config_replies)
                                != expected_workers
                            ):
                                worker_runtime_error = (
                                    "Celery inspector worker-runtime coverage is incomplete: "
                                    f"expected={sorted(expected_workers)!r}, "
                                    "observed="
                                    f"{sorted(str(worker) for worker in config_replies)!r}"
                                )
                            else:
                                worker_runtime_cache_key = binding_key
                                worker_runtime_cache_value = config_replies
                        except Exception as exc:  # noqa: BLE001 - fail closed
                            worker_runtime_error = f"{type(exc).__name__}: {exc}"
                            config_replies = {}
                worker_queues = [
                    {
                        "worker": worker,
                        "queues": sorted(
                            {
                                str(queue.get("name"))
                                for queue in queues or []
                                if isinstance(queue, dict) and queue.get("name")
                            }
                        ),
                        "execution_pool": (
                            config_replies.get(worker, {})
                            .get("airfoilfoam_worker_runtime", {})
                            .get("execution_pool")
                        ),
                        "engine": (
                            config_replies.get(worker, {})
                            .get("airfoilfoam_worker_runtime", {})
                            .get("engine")
                        ),
                    }
                    for worker, queues in sorted(active_queue_replies.items())
                ]
        except Exception as exc:  # noqa: BLE001 - report unknown, never invent workers
            worker_queues_error = f"{type(exc).__name__}: {exc}"
        job_ids = [row["job_id"] for row in active + reserved + scheduled if row.get("job_id")]
        duplicates = {job_id: n for job_id, n in Counter(job_ids).items() if n > 1}
        queue_depth = None
        default_queue_depth = None
        registered = registered_dialects()
        enabled_keys = settings.enabled_engine_key_set()
        queue_depths: dict[str, int | None] = {
            dialect.queue_name: None for dialect in registered
        }
        queue_enabled = {
            dialect.queue_name: dialect.identity.handshake_key in enabled_keys
            for dialect in registered
        }
        try:
            from redis import Redis

            redis = Redis.from_url(settings.broker_url)
            for queue_name in queue_depths:
                queue_depths[queue_name] = int(redis.llen(queue_name))
            default_queue_depth = queue_depths.get(
                get_openfoam_dialect(OPENCFD_2606_IDENTITY).queue_name
            )
            # The top-level field is the aggregate across every registered
            # execution pool, including disabled pools that may still be
            # draining. Callers that need the historical queue use the
            # explicit default_queue_depth field.
            queue_depth = sum(int(depth) for depth in queue_depths.values())
        except Exception:  # noqa: BLE001
            queue_depth = None
            default_queue_depth = None
        return {
            "queue_depth": queue_depth,
            "default_queue_depth": default_queue_depth,
            "queue_depths": queue_depths,
            "queue_enabled": queue_enabled,
            "queues": [
                {
                    "routing_key": dialect.queue_name,
                    "enabled": queue_enabled[dialect.queue_name],
                    "depth": queue_depths[dialect.queue_name],
                    "engine": dialect.identity.model_dump(mode="json"),
                }
                for dialect in registered
            ],
            "active": active,
            "reserved": reserved,
            "scheduled": scheduled,
            "active_count": len(active),
            "reserved_count": len(reserved),
            "scheduled_count": len(scheduled),
            "job_ids": sorted(set(job_ids)),
            "duplicates": duplicates,
            "redelivered": [row for row in active + reserved + scheduled if row.get("redelivered")],
            "worker_queues": worker_queues,
            "worker_queues_error": worker_queues_error,
            "worker_runtime_error": worker_runtime_error,
            "inspection_errors": inspection_errors,
            "inspection_workers": inspection_workers,
        }

    @app.get("/maintenance/jobs")
    def maintenance_jobs() -> dict:
        jobs_root = settings.data_dir / "jobs"
        rows = []
        if jobs_root.is_dir():
            for path in sorted(p for p in jobs_root.iterdir() if p.is_dir()):
                rows.append({"job_id": path.name, "mtime_epoch": path.stat().st_mtime, "bytes": None})
        # Cross-runtime contract (node engine-client maintenanceJobs): the
        # payload is wrapped — {"items": [...]} — never a bare list.
        return {"items": rows}

    @app.get("/maintenance/disk")
    def maintenance_disk() -> dict:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        stat = os.statvfs(settings.data_dir)
        total = int(stat.f_blocks * stat.f_frsize)
        free = int(stat.f_bavail * stat.f_frsize)
        used_pct = 0.0 if total <= 0 else 100.0 * (1.0 - (free / total))
        return {"total_bytes": total, "free_bytes": free, "used_pct": used_pct}

    @app.post("/jobs/runtime")
    def jobs_runtime(request: RuntimeRequest) -> dict:
        rows: list[dict] = []
        for job_id in request.job_ids:
            status, status_error = store.read_status_info(job_id)
            result, result_error = store.read_result_info(job_id)
            runtime, runtime_error = store.read_runtime_info(job_id)
            direct_processes = store.job_process_details(job_id)
            direct_process_count = len(direct_processes)
            heartbeat_at = runtime.get("heartbeat_at") if runtime else None
            heartbeat_age_sec = _age_seconds(heartbeat_at)
            heartbeat_process_count = int(runtime.get("process_count") or 0) if runtime else 0
            heartbeat_fresh = heartbeat_age_sec is not None and heartbeat_age_sec <= 120
            heartbeat_processes = runtime.get("processes") if runtime and isinstance(runtime.get("processes"), list) else []
            processes = heartbeat_processes if heartbeat_fresh and heartbeat_processes else direct_processes
            process_count = max(direct_process_count, heartbeat_process_count if heartbeat_fresh else 0)
            rows.append(
                {
                    "job_id": job_id,
                    "exists": store.exists(job_id),
                    "cancelled": store.is_cancelled(job_id),
                    "process_count": process_count,
                    "direct_process_count": direct_process_count,
                    "heartbeat_process_count": heartbeat_process_count,
                    "processes": processes,
                    "active_pids": [int(proc["pid"]) for proc in processes if proc.get("pid") is not None],
                    "runtime_heartbeat_at": heartbeat_at,
                    "runtime_heartbeat_age_sec": heartbeat_age_sec,
                    "runtime_error": runtime_error,
                    "worker_pid": runtime.get("worker_pid") if runtime else None,
                    "runtime_phase": runtime.get("phase") if runtime else None,
                    "runtime_active_solver": runtime.get("active_solver") if runtime else None,
                    "runtime_active_case_slug": runtime.get("active_case_slug") if runtime else None,
                    "runtime_active_aoa_deg": runtime.get("active_aoa_deg") if runtime else None,
                    "runtime_cpu_tokens_waiting": runtime.get("cpu_tokens_waiting") if runtime else None,
                    "runtime_cpu_tokens_held": runtime.get("cpu_tokens_held") if runtime else None,
                    "runtime_current_case": runtime.get("current_case") if runtime else None,
                    "runtime_last_progress_at": runtime.get("last_progress_at") if runtime else None,
                    "status_readable": status is not None,
                    "status_error": status_error,
                    "status_state": status.state.value if status else None,
                    "status_phase": status.phase.value if status else None,
                    "status_message": status.message if status else None,
                    "status_total_cases": status.total_cases if status else None,
                    "status_completed_cases": status.completed_cases if status else None,
                    "status_task_id": status.task_id if status else None,
                    "status_queued_at": status.queued_at.isoformat() if status and status.queued_at else None,
                    "status_started_at": status.started_at.isoformat() if status and status.started_at else None,
                    "status_updated_at": status.updated_at.isoformat() if status and status.updated_at else None,
                    "status_phase_started_at": status.phase_started_at.isoformat() if status and status.phase_started_at else None,
                    "status_last_progress_at": status.last_progress_at.isoformat() if status and status.last_progress_at else None,
                    "status_active_solver": status.active_solver if status else None,
                    "status_active_case_slug": status.active_case_slug if status else None,
                    "status_active_aoa_deg": status.active_aoa_deg if status else None,
                    "status_cpu_tokens_waiting": status.cpu_tokens_waiting if status else None,
                    "status_cpu_tokens_held": status.cpu_tokens_held if status else None,
                    "status_failure_disposition": (
                        status.failure_disposition.value
                        if status and status.failure_disposition
                        else None
                    ),
                    "status_continuation_failure_kind": (
                        status.continuation_failure_kind.value
                        if status and status.continuation_failure_kind
                        else None
                    ),
                    "result_readable": result is not None,
                    "result_error": result_error,
                    "has_result": result is not None,
                    "result_state": result.state.value if result else None,
                    "result_message": result.message if result else None,
                    "result_failure_disposition": (
                        result.failure_disposition.value
                        if result and result.failure_disposition
                        else None
                    ),
                    "result_continuation_failure_kind": (
                        result.continuation_failure_kind.value
                        if result and result.continuation_failure_kind
                        else None
                    ),
                }
            )
        return {"jobs": rows}

    @app.get("/jobs/{job_id}", response_model=JobStatus)
    def job_status(job_id: str) -> JobStatus:
        status, error = store.read_status_info(job_id)
        if status is None and error:
            raise HTTPException(status_code=409, detail=f"Job status unreadable: {error}")
        if status is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return status

    @app.post("/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict:
        if not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        from ..celery_app import celery_app
        from ..tasks import kill_job_processes

        status_before_cancel = store.read_status(job_id)
        request_before_cancel = store.read_request(job_id)
        requested_engine = (
            status_before_cancel.requested_engine
            if status_before_cancel is not None and status_before_cancel.requested_engine is not None
            else request_before_cancel.expected_engine
            if request_before_cancel is not None and request_before_cancel.expected_engine is not None
            else OPENCFD_2606_IDENTITY
        )
        try:
            reaper_queue = get_openfoam_dialect(requested_engine).queue_name
        except UnsupportedEngineIdentity as exc:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "cancel_engine_route_unknown",
                    "requested_engine": requested_engine.model_dump(mode="json"),
                    "message": str(exc),
                },
            ) from exc
        store.mark_cancelled(job_id)
        reaper_results: list[dict] = []
        for _ in range(2):
            try:
                reaper = kill_job_processes.apply_async(args=[job_id], queue=reaper_queue)
                reaper_results.append(reaper.get(timeout=5, propagate=False))
            except Exception as exc:  # noqa: BLE001 - cancellation should still revoke
                reaper_results.append({"error": f"reaper failed: {exc}"})
        try:
            celery_app.control.revoke(job_id, terminate=True, signal="SIGTERM")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Could not cancel task: {exc}")
        try:
            reaper = kill_job_processes.apply_async(args=[job_id], queue=reaper_queue)
            reaper_results.append(reaper.get(timeout=5, propagate=False))
        except Exception as exc:  # noqa: BLE001
            reaper_results.append({"error": f"post-revoke reaper failed: {exc}"})
        status = store.read_status(job_id) or JobStatus(job_id=job_id, state=JobState.cancelled)
        status.state = JobState.cancelled
        status.phase = JobPhase.cancelled
        status.message = "cancelled"
        store.write_status(status)
        store.terminalize_cancelled_result(job_id)
        return {"job_id": job_id, "cancelled": True, "reaper": reaper_results}

    @app.post("/jobs/{job_id}/strip")
    def strip_job(job_id: str, request: StripJobRequest) -> dict:
        job_root = safe_job_root(job_id)
        if not job_root.is_dir():
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            return strip_job_dir(job_root, keep_case_state=request.keep_case_state).to_dict()
        except JobRetentionRefused as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/jobs/{job_id}/evidence/finalize-remote")
    def finalize_remote_evidence(
        job_id: str,
        request: FinalizeRemoteEvidenceRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        job_root = safe_job_root(job_id)
        if not job_root.is_dir() or job_root.is_symlink():
            raise HTTPException(status_code=404, detail="Job not found")
        status = store.read_status(job_id)
        result = store.read_result(job_id)
        terminal = {JobState.completed, JobState.failed, JobState.cancelled}
        if status is None or status.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Evidence cleanup requires a terminal engine job",
            )
        if result is None or result.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Evidence cleanup requires a terminal result payload",
            )
        try:
            evidence_dir = store.file_path(
                job_id,
                f"cases/{request.case_slug}/{request.evidence_base}",
            )
            pointer = RemoteEvidencePointer.from_dict(request.remote)
            association_identities = [
                (
                    row.result_id,
                    row.result_attempt_id,
                    row.source_artifact_id,
                    row.archive_id,
                )
                for row in request.database_associations
            ]
            if len(set(association_identities)) != len(association_identities):
                raise ValueError("duplicate database evidence association")
            cleanup_authorization = EvidenceCleanupAuthorization(
                job_id=job_id,
                case_slug=request.case_slug,
                evidence_base=request.evidence_base,
                pointer=pointer,
                associations=tuple(
                    EvidenceDatabaseAssociation(
                        result_id=str(row.result_id),
                        result_attempt_id=str(row.result_attempt_id),
                        source_artifact_id=str(row.source_artifact_id),
                        archive_id=str(row.archive_id),
                        member_association_count=row.member_association_count,
                        member_associations_sha256=row.member_associations_sha256,
                        manifest_member_set_sha256=row.manifest_member_set_sha256,
                    )
                    for row in request.database_associations
                ),
            )
            return finalize_remote_evidence_cleanup(
                job_root,
                evidence_dir,
                cleanup_authorization,
                settings,
            ).to_dict()
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid evidence cleanup request: {exc}",
            ) from exc
        except EvidenceCleanupError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/session")
    def create_evidence_upload_session(
        request: BrokeredEvidenceIdentityRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            remote_store = evidence_object_store(settings)
            if remote_store is None:
                raise EvidenceStoreError("GCS evidence storage is not configured")
            session = create_brokered_upload_session(
                remote_store,
                request.identity(),
                owner=request.owner(),
                ledger_dir=settings.data_dir / "brokered-upload-sessions",
            )
            if session.verified_pointer is not None:
                return {
                    "state": "verified",
                    "remote": session.verified_pointer.to_dict(),
                }
            return {
                "state": "issued",
                # This URL is a bearer capability. The API is internal and the
                # Node hub must return it only to the exact owning solver.
                "uploadUrl": session.upload_url,
                "expiresAt": session.expires_at,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-archives/verify-manifest")
    def verify_remote_evidence_manifest(
        request: VerifyRemoteEvidenceManifestRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Authenticate every member of one exact generation-pinned archive.

        This endpoint is intentionally read-only and internal.  It exists for
        control-plane reconciliation when a manifest-declared member no longer
        has unpacked local bytes, and returns only the immutable identities it
        proved.  Verification always performs a fresh GCS download rather than
        trusting the render cache.
        """

        _require_control_plane_bearer(
            settings.control_plane_token, authorization
        )
        try:
            manifest = request.decoded_manifest()
            pointer = RemoteEvidencePointer.from_dict(request.remote)
            if pointer.to_dict() != request.remote:
                raise ValueError(
                    "remote must be the exact canonical complete evidence pointer"
                )
            remote_store = evidence_object_store(settings)
            if remote_store is None:
                raise EvidenceStoreError("GCS evidence storage is not configured")
            bundled_file_count = remote_store.verify_all_manifest_members(
                pointer,
                expected_manifest=manifest,
                fresh_download=True,
            )
            if bundled_file_count + 1 != request.manifest_member_count:
                raise EvidenceStoreError(
                    "verified archive member count does not match the exact "
                    "manifest member-set identity"
                )
            return {
                "state": "verified",
                "remote": pointer.to_dict(),
                "manifestSha256": request.manifest_sha256,
                "manifestByteSize": request.manifest_byte_size,
                "manifestMemberSetSha256": (
                    request.manifest_member_set_sha256
                ),
                "manifestMemberCount": request.manifest_member_count,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/session-settled")
    def settle_evidence_upload_session(
        request: BrokeredEvidenceSessionSettlementRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            settle_brokered_upload_session_intent(
                settings.data_dir / "brokered-upload-sessions",
                request.owner(),
                request.identity(),
                final=request.final,
                verified_generation=(
                    int(request.generation) if request.generation is not None else None
                ),
            )
            return {"state": "settled" if request.final else "registered"}
        except (ValueError, EvidenceStoreError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/verify")
    def verify_evidence_upload(
        request: BrokeredEvidenceVerifyRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            remote_store = evidence_object_store(settings)
            if remote_store is None:
                raise EvidenceStoreError("GCS evidence storage is not configured")
            verified = verify_brokered_upload(
                remote_store,
                request.identity(),
                int(request.generation),
            )
            return {
                "state": "verified",
                "remote": verified.pointer.to_dict(),
                "manifestSha256": verified.manifest_sha256,
                "manifestSize": verified.manifest_size,
                "bundledFileCount": verified.bundled_file_count,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/cancel")
    def cancel_evidence_upload(
        request: BrokeredEvidenceCancelRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            cancelled = cancel_brokered_upload_session(
                request.upload_url,
                request.bucket,
                request.object_key,
                timeout_seconds=min(15, settings.evidence_gcs_timeout_seconds),
            )
            return {
                "state": cancelled.state,
                "statusCode": cancelled.status_code,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/cancel-identity")
    def cancel_evidence_upload_by_identity(
        request: BrokeredEvidenceCancelIdentityRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            cancelled = cancel_brokered_upload_session_by_identity(
                settings.data_dir / "brokered-upload-sessions",
                request.owner(),
                request.identity(),
                supplied_upload_url=request.upload_url,
                timeout_seconds=min(15, settings.evidence_gcs_timeout_seconds),
            )
            return {
                "state": cancelled.state,
                "statusCode": cancelled.status_code,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/download")
    def download_brokered_evidence(
        request: BrokeredEvidenceDownloadRequest,
        authorization: str | None = Header(default=None),
    ):
        """Stream one generation-pinned brokered archive after verification.

        Node exposes this only through the exact owning solver or the normal
        local artifact route.  The GCS bearer credential never crosses this
        internal control-plane boundary.
        """

        _require_control_plane_bearer(settings.control_plane_token, authorization)
        try:
            remote_store = evidence_object_store(settings)
            if remote_store is None:
                raise EvidenceStoreError("GCS evidence storage is not configured")
            pointer = request.pointer()
            return _stream_remote_evidence(
                remote_store.archive_source(pointer),
                media_type=ARCHIVE_MIME_TYPE,
                identity=pointer,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except EvidenceStoreError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/internal/evidence-uploads/reclaim")
    def reclaim_remote_solver_evidence(
        request: BrokeredEvidenceReclaimRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        _require_control_plane_bearer(settings.control_plane_token, authorization)
        job_root = safe_job_root(request.job_id)
        if not job_root.is_dir() or job_root.is_symlink():
            raise HTTPException(status_code=404, detail="Job not found")
        status = store.read_status(request.job_id)
        result = store.read_result(request.job_id)
        terminal = {JobState.completed, JobState.failed, JobState.cancelled}
        if status is None or status.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Brokered evidence reclaim requires a terminal engine job",
            )
        if result is None or result.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Brokered evidence reclaim requires a terminal result payload",
            )
        try:
            evidence_dir = store.file_path(
                request.job_id,
                f"cases/{request.case_slug}/{request.evidence_base}",
            )
            authorization_record = BrokeredRemoteEvidenceReclaim(
                job_id=request.job_id,
                case_slug=request.case_slug,
                evidence_base=request.evidence_base,
                receipt=dict(request.receipt),
                receipt_hmac=request.receipt_hmac,
            )
            return reclaim_brokered_remote_evidence(
                job_root,
                evidence_dir,
                authorization_record,
            ).to_dict()
        except EvidenceCleanupError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/jobs/{job_id}/evidence/prepare-brokered-legacy")
    def prepare_brokered_legacy_evidence(
        job_id: str,
        request: PrepareBrokeredLegacyEvidenceRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Verify and transcode one retained legacy gzip for hub brokering.

        The operation is deliberately additive: neither the gzip nor unpacked
        evidence is removed until the hub later returns its signed exact-owner
        binding receipt through the normal brokered reclaim endpoint.
        """

        _require_control_plane_bearer(settings.control_plane_token, authorization)
        job_root = safe_job_root(job_id)
        if not job_root.is_dir() or job_root.is_symlink():
            raise HTTPException(status_code=404, detail="Job not found")
        status = store.read_status(job_id)
        result = store.read_result(job_id)
        terminal = {JobState.completed, JobState.failed, JobState.cancelled}
        if status is None or status.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Legacy evidence preparation requires a terminal engine job",
            )
        if result is None or result.state not in terminal:
            raise HTTPException(
                status_code=409,
                detail="Legacy evidence preparation requires a terminal result payload",
            )
        try:
            evidence_dir = store.file_path(
                job_id,
                f"cases/{request.case_slug}/{request.evidence_base}",
            )
            prepared = prepare_brokered_legacy_evidence_archive(
                job_root,
                evidence_dir,
                evidence_base=request.evidence_base,
                legacy_archive_name=request.legacy_archive_name,
                expected_legacy_sha256=request.legacy_archive_sha256,
                expected_legacy_byte_size=request.legacy_archive_byte_size,
                expected_manifest_sha256=request.manifest_sha256,
                expected_manifest_byte_size=request.manifest_byte_size,
                zstd_level=settings.evidence_zstd_level,
            )
            return {
                "state": "prepared",
                "artifact": prepared.artifact(job_id, request.case_slug),
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (EvidenceCleanupError, EvidenceStoreError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.delete("/jobs/{job_id}")
    def delete_job(job_id: str) -> dict:
        job_root = safe_job_root(job_id)
        if not job_root.is_dir():
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            return delete_job_dir(job_root).to_dict()
        except JobRetentionRefused as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.get("/jobs/{job_id}/result", response_model=JobResult)
    def job_result(job_id: str) -> JobResult:
        if not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        result = store.read_result(job_id)
        if result is None:
            status = store.read_status(job_id)
            state = status.state if status else JobState.pending
            raise HTTPException(status_code=409, detail=f"Result not ready (state={state.value})")
        return result

    @app.get("/jobs/{job_id}/polar.csv")
    def job_polar_csv(job_id: str) -> PlainTextResponse:
        result = store.read_result(job_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Result not found")
        buf = io.StringIO()
        buf.write("chord,speed,reynolds,aoa_deg,cl,cd,cm,cl_cd,converged,y_plus_avg,error\n")
        for pol in result.polars:
            for p in pol.points:
                buf.write(
                    f"{pol.chord},{pol.speed},{pol.reynolds:.6g},{p.aoa_deg},"
                    f"{_csv(p.cl)},{_csv(p.cd)},{_csv(p.cm)},{_csv(p.cl_cd)},"
                    f"{p.converged},{_csv(p.y_plus_avg)},{p.error or ''}\n"
                )
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")

    @app.get("/jobs/{job_id}/files/{path:path}")
    def job_file(
        job_id: str,
        path: str,
        expected_bucket: str | None = None,
        expected_object_key: str | None = None,
        expected_generation: int | None = None,
        expected_stored_sha256: str | None = None,
        expected_stored_size: int | None = None,
    ):
        if not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            target = store.file_path(job_id, path)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid path")
        job_root = safe_job_root(job_id)
        evidence_dir = _evidence_dir_for_target(job_root, target)
        expected_pointer: RemoteEvidencePointer | None = None
        if any(
            value is not None
            for value in (
                expected_bucket,
                expected_object_key,
                expected_generation,
                expected_stored_sha256,
                expected_stored_size,
            )
        ):
            if target.name != EVIDENCE_ARCHIVE_NAME or evidence_dir is None:
                raise HTTPException(
                    status_code=409,
                    detail="Expected immutable evidence identity does not match an archive path",
                )
            expected_pointer = _expected_archive_pointer(
                evidence_dir,
                expected_bucket=expected_bucket,
                expected_object_key=expected_object_key,
                expected_generation=expected_generation,
                expected_stored_sha256=expected_stored_sha256,
                expected_stored_size=expected_stored_size,
            )
        if target.is_file():
            if expected_pointer is not None:
                return _stream_verified_local_archive(target, expected_pointer)
            return FileResponse(target)

        # Finalized evidence retains only its manifest, separately stored frame
        # PNGs, and a verified remote pointer.  Resolve a missing packaged path
        # against that exact case-evidence directory; never rediscover an
        # archive by rounded solver values or a different job.
        if evidence_dir is None:
            raise HTTPException(status_code=404, detail="File not found")

        try:
            member = target.relative_to(evidence_dir).as_posix()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid evidence path")

        try:
            remote_store = evidence_object_store(settings)
        except (EvidenceStoreError, OSError, ValueError) as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Remote evidence storage is unavailable: {exc}",
            ) from exc
        if remote_store is None:
            raise HTTPException(
                status_code=503,
                detail="Remote evidence storage is not configured",
            )
        pointer_path = evidence_pointer_path(evidence_dir)
        if member == EVIDENCE_ARCHIVE_NAME:
            return _stream_remote_evidence(
                remote_store.archive_source(expected_pointer or pointer_path),
                media_type=ARCHIVE_MIME_TYPE,
                identity=expected_pointer,
            )

        top_level = member.split("/", 1)[0]
        if top_level not in PACKAGED_RAW_DIRS:
            # evidence_manifest.json and frames are deliberately retained and
            # served as ordinary local files.  Custom/scaled renders are also
            # never invented from the immutable bundle on a file GET.
            raise HTTPException(status_code=404, detail="File not found")
        if not _manifest_lists_member(evidence_dir, member):
            raise HTTPException(status_code=404, detail="Evidence artifact not found")
        media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return _stream_remote_evidence(
            remote_store.member_source(pointer_path, member),
            media_type=media_type,
        )

    @app.post("/jobs/{job_id}/render-field")
    def render_field(job_id: str, request: RenderFieldRequest) -> dict:
        remote_pointer = _inline_remote_pointer(request.remote)
        if remote_pointer is None and not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            case_dir = store.file_path(job_id, f"cases/{request.case_slug}")
            evidence_dir = store.file_path(job_id, f"cases/{request.case_slug}/{request.evidence_base}")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid case or evidence path")
        if remote_pointer is None and not case_dir.is_dir():
            raise HTTPException(status_code=404, detail="Case directory not found")
        params_hash = request.params_hash or _render_hash(request)
        out_dir = evidence_dir / "custom_renders" / params_hash
        contour = np.asarray(request.airfoil_points, dtype=float)
        try:
            with _render_source(
                case_dir,
                evidence_dir,
                settings,
                source_mode=request.source_mode,
                remote_pointer=remote_pointer,
            ) as source_dir:
                filename = render_custom_field(
                    source_dir,
                    out_dir,
                    contour,
                    request.chord,
                    request.field,
                    role=request.role,
                    freestream_speed=request.speed,
                    zoom_chords=request.zoom_chords,
                    colormap=request.colormap,
                    levels=request.levels,
                    vmin=request.vmin,
                    vmax=request.vmax,
                    frame_index=request.frame_index,
                    width_px=request.width_px,
                    height_px=request.height_px,
                    filename_prefix=params_hash,
                )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not render field: {exc}")
        path = out_dir / filename
        rel = path.relative_to(case_dir)
        return {
            "kind": "image",
            "field": request.field.value,
            "role": request.role,
            "path": str(rel),
            "url": f"/jobs/{job_id}/files/cases/{request.case_slug}/{rel}",
            "mime_type": "image/png",
            "sha256": _sha256_file(path),
            "byte_size": path.stat().st_size,
            "params_hash": params_hash,
        }

    @app.post("/jobs/{job_id}/field-extents")
    def field_extents(job_id: str, request: FieldExtentsRequest) -> dict:
        remote_pointer = _inline_remote_pointer(request.remote)
        if remote_pointer is None and not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            case_dir = store.file_path(job_id, f"cases/{request.case_slug}")
            evidence_dir = store.file_path(job_id, f"cases/{request.case_slug}/{request.evidence_base}")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid case or evidence path")
        if remote_pointer is None and not case_dir.is_dir():
            raise HTTPException(status_code=404, detail="Case directory not found")
        contour = np.asarray(request.airfoil_points, dtype=float)
        fields = request.fields or list(ImageField)
        try:
            with _render_source(
                case_dir,
                evidence_dir,
                settings,
                source_mode=request.source_mode,
                remote_pointer=remote_pointer,
            ) as source_dir:
                start_time, end_time = _evidence_window(evidence_dir)
                if start_time is None and end_time is None:
                    start_time, end_time = _evidence_window(source_dir)
                extents = compute_field_extents(
                    source_dir,
                    contour,
                    request.chord,
                    fields,
                    freestream_speed=request.speed,
                    zoom_chords=request.zoom_chords,
                    max_frames=request.max_frames,
                    start_time=start_time,
                    end_time=end_time,
                )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not compute field extents: {exc}")
        return {
            "fields": extents,
            "window_start": start_time,
            "window_end": end_time,
        }

    @app.post("/jobs/{job_id}/render-default-media")
    def render_default_media(job_id: str, request: RenderDefaultMediaRequest) -> dict:
        remote_pointer = _inline_remote_pointer(request.remote)
        if remote_pointer is None and not store.exists(job_id):
            raise HTTPException(status_code=404, detail="Job not found")
        try:
            case_dir = store.file_path(job_id, f"cases/{request.case_slug}")
            evidence_dir = store.file_path(job_id, f"cases/{request.case_slug}/{request.evidence_base}")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid case or evidence path")
        if remote_pointer is None and not case_dir.is_dir():
            raise HTTPException(status_code=404, detail="Case directory not found")
        fields = request.fields or list(request.scales.keys())
        missing_scale = [field.value for field in fields if field not in request.scales]
        if missing_scale:
            raise HTTPException(status_code=422, detail=f"Missing field scale for: {', '.join(missing_scale)}")
        contour = np.asarray(request.airfoil_points, dtype=float)
        profile = _safe_component(request.render_profile_key)
        out_dir = evidence_dir / "scaled_media" / profile / f"v{request.scale_version}"
        scales = _field_scales(request.scales)
        title_suffix = f"track scale v{request.scale_version}"
        try:
            with _render_source(
                case_dir,
                evidence_dir,
                settings,
                source_mode=request.source_mode,
                remote_pointer=remote_pointer,
            ) as source_dir:
                start_time, end_time = _evidence_window(evidence_dir)
                if start_time is None and end_time is None:
                    start_time, end_time = _evidence_window(source_dir)
                images = render_contours(
                    source_dir,
                    out_dir,
                    contour,
                    request.chord,
                    fields,
                    zoom_chords=request.zoom_chords,
                    title_suffix=title_suffix,
                    freestream_speed=request.speed,
                    field_scales=scales,
                )
                mean_images: dict[str, str] = {}
                videos: dict[str, str] = {}
                if request.unsteady:
                    mean_images = render_mean_contours(
                        source_dir,
                        out_dir,
                        contour,
                        request.chord,
                        fields,
                        zoom_chords=request.zoom_chords,
                        title_suffix=title_suffix,
                        freestream_speed=request.speed,
                        start_time=start_time,
                        end_time=end_time,
                        field_scales=scales,
                    )
                    # One pass: every VTU is read ONCE for all fields (the per-field
                    # loop re-read the whole series per field and burned the API
                    # container at ~390% CPU in the 2026-07-07 incident).
                    batch = render_animations(
                        source_dir,
                        out_dir,
                        contour,
                        request.chord,
                        fields,
                        freestream_speed=request.speed,
                        zoom_chords=request.zoom_chords,
                        start_time=start_time,
                        end_time=end_time,
                        title_suffix=title_suffix,
                        field_scales=scales,
                    )
                    if batch.errors:
                        detail = "; ".join(f"{k}: {v}" for k, v in sorted(batch.errors.items()))
                        raise RuntimeError(f"animation encode failed: {detail}")
                    videos = dict(batch.videos)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Could not render default media: {exc}")

        def payloads(mapping: dict[str, str], role: str, kind: str) -> list[dict]:
            rows = []
            for field_name, filename in mapping.items():
                field = ImageField(field_name)
                rows.append(_media_file_payload(job_id, request.case_slug, case_dir, out_dir / filename, field, role, kind))
            return rows

        return {
            "images": payloads(images, "instantaneous", "image"),
            "mean_images": payloads(mean_images, "mean", "image"),
            "videos": payloads(videos, "instantaneous", "video"),
            "window_start": start_time,
            "window_end": end_time,
            "scale_version": request.scale_version,
            "render_profile_key": request.render_profile_key,
        }

    return app


def _csv(v) -> str:
    return "" if v is None else f"{v:.6g}"


def _age_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())
    except Exception:  # noqa: BLE001
        return None


app = create_app()
