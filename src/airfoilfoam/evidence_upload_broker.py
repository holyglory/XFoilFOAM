"""Hub-only broker for immutable remote-solver evidence uploads.

The remote solver receives a single resumable-upload capability, never Google
credentials.  The hub independently authenticates the resulting exact GCS
generation and every manifest member before the control plane may associate it
with canonical solver evidence.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .evidence_store import (
    ARCHIVE_FORMAT,
    ARCHIVE_MIME_TYPE,
    POINTER_SCHEMA_VERSION,
    EvidenceIntegrityError,
    EvidenceObjectStore,
    EvidenceUploadError,
    RemoteEvidencePointer,
)


# The remote uploader has a six-hour absolute deadline. The extra two hours
# allow hub/remote reconciliation without leaving a dead bearer valid for the
# provider's much longer maximum window. This is application policy enforced
# by the hub's periodic cancellation, not a GCS-side expiry guarantee.
_SESSION_LIFETIME = timedelta(hours=8)
_MAX_GCS_GENERATION = 18_446_744_073_709_551_615


def _sha256(value: str, name: str) -> str:
    value = value.lower()
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    return value


def _positive(value: int, name: str) -> int:
    value = int(value)
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _not_found(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    if callable(code):
        code = code()
    return code == 404 or exc.__class__.__name__ == "NotFound"


@dataclass(frozen=True)
class BrokeredEvidenceIdentity:
    bucket: str
    object_key: str
    stored_sha256: str
    stored_size: int
    tar_sha256: str
    tar_size: int
    manifest_sha256: str
    manifest_size: int
    zstd_level: int
    bundled_file_count: int

    def __post_init__(self) -> None:
        if not self.bucket.strip():
            raise ValueError("bucket is required")
        object.__setattr__(self, "stored_sha256", _sha256(self.stored_sha256, "stored_sha256"))
        object.__setattr__(self, "tar_sha256", _sha256(self.tar_sha256, "tar_sha256"))
        object.__setattr__(self, "manifest_sha256", _sha256(self.manifest_sha256, "manifest_sha256"))
        object.__setattr__(self, "stored_size", _positive(self.stored_size, "stored_size"))
        object.__setattr__(self, "tar_size", _positive(self.tar_size, "tar_size"))
        object.__setattr__(self, "manifest_size", _positive(self.manifest_size, "manifest_size"))
        object.__setattr__(self, "bundled_file_count", _positive(self.bundled_file_count, "bundled_file_count"))
        if not 1 <= int(self.zstd_level) <= 22:
            raise ValueError("zstd_level must be between 1 and 22")
        expected_key = (
            f"solver-evidence/v1/sha256/{self.stored_sha256[:2]}/"
            f"{self.stored_sha256}.tar.zst"
        )
        if self.object_key != expected_key:
            raise ValueError("object_key is not the canonical content-addressed key")

    @property
    def metadata(self) -> dict[str, str]:
        return {
            "airfoilfoam-schema-version": str(POINTER_SCHEMA_VERSION),
            "format": ARCHIVE_FORMAT,
            "stored-sha256": self.stored_sha256,
            "stored-size": str(self.stored_size),
            "tar-sha256": self.tar_sha256,
            "tar-size": str(self.tar_size),
            "zstd-level": str(self.zstd_level),
            "manifest-sha256": self.manifest_sha256,
            "manifest-size": str(self.manifest_size),
            "bundled-file-count": str(self.bundled_file_count),
        }


@dataclass(frozen=True)
class BrokeredEvidenceSessionOwner:
    brokered_upload_id: str
    promise_id: str
    promise_point_id: str
    solver_id: str
    source_instance_id: str
    remote_result_id: str
    remote_result_attempt_id: str
    aoa_deg: float
    engine_job_id: str
    engine_case_slug: str | None

    def __post_init__(self) -> None:
        for field_name in (
            "brokered_upload_id",
            "promise_id",
            "promise_point_id",
            "solver_id",
            "remote_result_id",
            "remote_result_attempt_id",
        ):
            try:
                uuid.UUID(str(getattr(self, field_name)))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{field_name} must be a UUID") from exc
        if not self.source_instance_id or not self.engine_job_id:
            raise ValueError("broker session owner requires source instance and engine job")

    def to_dict(self) -> dict[str, object]:
        return {
            "brokeredUploadId": self.brokered_upload_id,
            "promiseId": self.promise_id,
            "promisePointId": self.promise_point_id,
            "solverId": self.solver_id,
            "sourceInstanceId": self.source_instance_id,
            "remoteResultId": self.remote_result_id,
            "remoteResultAttemptId": self.remote_result_attempt_id,
            "aoaDeg": self.aoa_deg,
            "engineJobId": self.engine_job_id,
            "engineCaseSlug": self.engine_case_slug,
        }


@dataclass(frozen=True)
class BrokeredUploadSession:
    upload_url: str | None
    expires_at: str | None
    verified_pointer: RemoteEvidencePointer | None = None


@dataclass(frozen=True)
class BrokeredVerification:
    pointer: RemoteEvidencePointer
    manifest_sha256: str
    manifest_size: int
    bundled_file_count: int


@dataclass(frozen=True)
class BrokeredSessionCancellation:
    status_code: int
    state: str = "cancelled"


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:  # noqa: ANN001
        return None


def _valid_gcs_resumable_url(
    upload_url: str,
    *,
    expected_bucket: str,
    expected_object_key: str,
) -> bool:
    try:
        parsed = urlsplit(upload_url)
        port = parsed.port
    except (TypeError, ValueError):
        return False
    query = parse_qs(parsed.query, keep_blank_values=True)
    # google-cloud-storage 3.13 returns the provider Location with the exact
    # create-only precondition but without repeating the object ``name`` that
    # was supplied by the authenticated initiation request.  Older examples
    # may retain ``name``.  Accept both shapes, but require the visible
    # ifGenerationMatch=0 fence and reject every other query parameter.
    required_query = {"uploadType", "upload_id", "ifGenerationMatch"}
    allowed_query = required_query | {"name"}
    if not required_query.issubset(query) or not set(query).issubset(
        allowed_query
    ):
        return False
    upload_types = query.get("uploadType", [])
    names = query.get("name", [])
    upload_ids = query.get("upload_id", [])
    generation_matches = query.get("ifGenerationMatch", [])
    path_match = re.fullmatch(r"/upload/storage/v1/b/([^/]+)/o", parsed.path)
    if path_match is None:
        return False
    from urllib.parse import unquote

    path_bucket = unquote(path_match.group(1))
    return bool(
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and parsed.fragment == ""
        and port in {None, 443}
        and parsed.hostname in {"storage.googleapis.com", "www.googleapis.com"}
        and path_bucket == expected_bucket
        and len(upload_types) == 1
        and upload_types[0] == "resumable"
        and (not names or (len(names) == 1 and names[0] == expected_object_key))
        and len(upload_ids) == 1
        and upload_ids[0]
        and generation_matches == ["0"]
    )


def cancel_brokered_upload_session(
    upload_url: str,
    expected_bucket: str,
    expected_object_key: str,
    *,
    timeout_seconds: float = 15.0,
    opener: Any | None = None,
) -> BrokeredSessionCancellation:
    """Invalidate one GCS JSON-API resumable bearer capability.

    GCS documents HTTP 499 as the normal response to cancelling a resumable
    JSON upload. Missing/gone sessions are also terminally harmless. The URL
    is validated before network I/O and is never included in an exception.
    """

    if not _valid_gcs_resumable_url(
        upload_url,
        expected_bucket=expected_bucket,
        expected_object_key=expected_object_key,
    ):
        raise ValueError("invalid GCS resumable upload capability")
    timeout = min(30.0, max(1.0, float(timeout_seconds)))
    request = Request(upload_url, method="DELETE")
    try:
        open_request = opener or build_opener(_NoRedirectHandler()).open
        response = open_request(request, timeout=timeout)
        status = int(getattr(response, "status", response.getcode()))
        close = getattr(response, "close", None)
        if callable(close):
            close()
    except HTTPError as exc:
        status = int(exc.code)
        if status not in {404, 410, 499}:
            raise EvidenceUploadError(
                f"GCS resumable session cancellation failed ({status})"
            ) from exc
    except (OSError, URLError) as exc:
        raise EvidenceUploadError(
            "GCS resumable session cancellation could not reach storage"
        ) from exc
    if status not in {200, 204, 404, 410, 499}:
        raise EvidenceUploadError(
            f"GCS resumable session cancellation failed ({status})"
        )
    return BrokeredSessionCancellation(status_code=status)


def _blob(store: EvidenceObjectStore, identity: BrokeredEvidenceIdentity) -> Any:
    if identity.bucket != store.bucket_name:
        raise EvidenceUploadError("broker request bucket does not match configured evidence bucket")
    return store.client.bucket(identity.bucket).blob(identity.object_key)


def verify_brokered_upload(
    store: EvidenceObjectStore,
    identity: BrokeredEvidenceIdentity,
    generation: int,
) -> BrokeredVerification:
    """Freshly download and authenticate one exact uploaded generation."""

    generation = _positive(generation, "generation")
    if generation > _MAX_GCS_GENERATION:
        raise ValueError("generation exceeds GCS uint64")
    blob = _blob(store, identity)
    try:
        blob.reload(timeout=store.timeout_seconds)
        actual_generation = int(getattr(blob, "generation", 0) or 0)
        if actual_generation != generation:
            raise EvidenceIntegrityError("GCS generation does not match the brokered upload")
        if int(getattr(blob, "size", -1) or -1) != identity.stored_size:
            raise EvidenceIntegrityError("GCS object size does not match the brokered upload")
        if getattr(blob, "content_type", None) != ARCHIVE_MIME_TYPE:
            raise EvidenceIntegrityError("GCS object MIME type is not application/zstd")
        metadata = dict(getattr(blob, "metadata", None) or {})
        if metadata != identity.metadata:
            raise EvidenceIntegrityError("GCS object metadata does not match the brokered upload")
        crc32c = str(getattr(blob, "crc32c", "") or "")
        pointer = RemoteEvidencePointer(
            bucket=identity.bucket,
            object_key=identity.object_key,
            generation=generation,
            stored_sha256=identity.stored_sha256,
            stored_size=identity.stored_size,
            tar_sha256=identity.tar_sha256,
            tar_size=identity.tar_size,
            crc32c=crc32c,
            zstd_level=identity.zstd_level,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        manifest_path: Path = store.materialize_member(pointer, "evidence_manifest.json")
        manifest = manifest_path.read_bytes()
        if len(manifest) != identity.manifest_size:
            raise EvidenceIntegrityError("evidence manifest size does not match the broker request")
        if hashlib.sha256(manifest).hexdigest() != identity.manifest_sha256:
            raise EvidenceIntegrityError("evidence manifest SHA-256 does not match the broker request")
        count = store.verify_all_manifest_members(
            pointer,
            expected_manifest=manifest,
            fresh_download=True,
        )
        if count != identity.bundled_file_count:
            raise EvidenceIntegrityError("manifest member count does not match the broker request")
        return BrokeredVerification(
            pointer=pointer,
            manifest_sha256=identity.manifest_sha256,
            manifest_size=identity.manifest_size,
            bundled_file_count=count,
        )
    except EvidenceIntegrityError:
        raise
    except Exception as exc:  # noqa: BLE001 - provider errors vary
        raise EvidenceUploadError(f"brokered evidence verification failed: {exc}") from exc


def _ledger_path(ledger_dir: Path, owner: BrokeredEvidenceSessionOwner) -> Path:
    root = Path(ledger_dir)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root / f"{owner.brokered_upload_id}.json"


def _read_ledger(path: Path) -> dict[str, Any] | None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise EvidenceUploadError("broker session ledger is not a regular file")
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            descriptor = -1
            payload = json.load(source)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(payload, dict):
        raise EvidenceUploadError("broker session ledger is not an object")
    return payload


def _write_ledger(path: Path, payload: dict[str, Any], *, create_only: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            descriptor = -1
            json.dump(payload, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        if create_only:
            try:
                os.link(temporary, path)
            except FileExistsError:
                if _read_ledger(path) != payload:
                    raise EvidenceUploadError(
                        "broker session ledger identity already has different content"
                    )
        else:
            os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _ledger_identity(
    owner: BrokeredEvidenceSessionOwner,
    identity: BrokeredEvidenceIdentity,
) -> dict[str, object]:
    return {
        "owner": owner.to_dict(),
        "evidence": {
            "bucket": identity.bucket,
            "objectKey": identity.object_key,
            "storedSha256": identity.stored_sha256,
            "storedSize": identity.stored_size,
            "tarSha256": identity.tar_sha256,
            "tarSize": identity.tar_size,
            "manifestSha256": identity.manifest_sha256,
            "manifestSize": identity.manifest_size,
            "zstdLevel": identity.zstd_level,
            "bundledFileCount": identity.bundled_file_count,
        },
    }


def settle_brokered_upload_session_intent(
    ledger_dir: Path,
    owner: BrokeredEvidenceSessionOwner,
    identity: BrokeredEvidenceIdentity,
    *,
    final: bool = False,
    verified_generation: int | None = None,
) -> None:
    path = _ledger_path(ledger_dir, owner)
    payload = _read_ledger(path)
    expected = _ledger_identity(owner, identity)
    if not payload or payload.get("identity") != expected:
        raise EvidenceUploadError("broker session intent is missing or mismatched")
    if payload.get("state") not in {"issued", "registered", "settled"}:
        raise EvidenceUploadError("broker session intent cannot be settled")
    state = "settled" if final else "registered"
    settled_payload: dict[str, Any] = {
        "schemaVersion": 1,
        "state": state,
        "identity": expected,
        "sessionEpoch": int(payload.get("sessionEpoch", 1)),
        f"{state}At": datetime.now(timezone.utc).isoformat(),
    }
    if not final:
        upload_url = payload.get("uploadUrl")
        expires_at = payload.get("expiresAt")
        if not isinstance(upload_url, str) or not isinstance(expires_at, str):
            raise EvidenceUploadError("broker session registration lacks its capability")
        settled_payload["uploadUrl"] = upload_url
        settled_payload["expiresAt"] = expires_at
    else:
        generation = verified_generation or payload.get("verifiedGeneration")
        if generation is not None:
            settled_payload["verifiedGeneration"] = str(
                _positive(int(generation), "verified_generation")
            )
    _write_ledger(path, settled_payload)


def cancel_brokered_upload_session_by_identity(
    ledger_dir: Path,
    owner: BrokeredEvidenceSessionOwner,
    identity: BrokeredEvidenceIdentity,
    *,
    supplied_upload_url: str | None = None,
    timeout_seconds: float = 15.0,
    opener: Any | None = None,
) -> BrokeredSessionCancellation:
    path = _ledger_path(ledger_dir, owner)
    payload = _read_ledger(path)
    expected = _ledger_identity(owner, identity)
    if payload is None:
        return BrokeredSessionCancellation(status_code=404)
    if payload.get("identity") != expected:
        raise EvidenceUploadError("broker session cancellation identity mismatch")
    state = payload.get("state")
    if state in {"cancelled", "settled"}:
        return BrokeredSessionCancellation(status_code=404)
    if state in {"provider-requesting", "creation-uncertain"}:
        raise EvidenceUploadError(
            "provider session creation outcome is uncertain; operator incident retained"
        )
    upload_url = payload.get("uploadUrl")
    if not isinstance(upload_url, str) and state == "registered":
        upload_url = supplied_upload_url
    if not isinstance(upload_url, str):
        # A create intent survived without a returned capability. There is no
        # addressable bearer to revoke; mark it terminal so retries cannot
        # accumulate more sessions under the same exact owner.
        status_code = 410
    else:
        if supplied_upload_url is not None and supplied_upload_url != upload_url:
            raise EvidenceUploadError("broker session URL does not match its durable intent")
        status_code = cancel_brokered_upload_session(
            upload_url,
            identity.bucket,
            identity.object_key,
            timeout_seconds=timeout_seconds,
            opener=opener,
        ).status_code
    _write_ledger(
        path,
        {
            "schemaVersion": 1,
            "state": "cancelled",
            "identity": expected,
            "sessionEpoch": int(payload.get("sessionEpoch", 1)),
            "statusCode": status_code,
            "cancelledAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return BrokeredSessionCancellation(status_code=status_code)


def create_brokered_upload_session(
    store: EvidenceObjectStore,
    identity: BrokeredEvidenceIdentity,
    *,
    owner: BrokeredEvidenceSessionOwner,
    ledger_dir: Path,
) -> BrokeredUploadSession:
    """Issue a create-only GCS resumable capability for the exact object.

    ``size`` makes the GCS library send ``X-Upload-Content-Length`` and
    ``if_generation_match=0`` prevents overwriting any existing generation.
    If content-addressed bytes already exist, they are fully re-verified and no
    upload bearer capability is issued.
    """

    ledger_path = _ledger_path(ledger_dir, owner)
    exact_identity = _ledger_identity(owner, identity)
    existing_intent = _read_ledger(ledger_path)
    replay_session: BrokeredUploadSession | None = None
    if existing_intent is not None:
        if existing_intent.get("identity") != exact_identity:
            raise EvidenceUploadError("broker session owner already names different evidence")
        if existing_intent.get("state") in {"issued", "registered"}:
            existing_url = existing_intent.get("uploadUrl")
            existing_expiry = existing_intent.get("expiresAt")
            if (
                isinstance(existing_url, str)
                and isinstance(existing_expiry, str)
                and _valid_gcs_resumable_url(
                    existing_url,
                    expected_bucket=identity.bucket,
                    expected_object_key=identity.object_key,
                )
            ):
                # A resumable upload's final PUT may commit the immutable GCS
                # object even when the client loses the HTTP response.  On an
                # idempotent replay, inspect the exact content-addressed key
                # before returning the old capability.  This is recovery, not
                # discovery by rounded solver values: the durable owner and
                # full archive identity above must still match first.
                replay_session = BrokeredUploadSession(
                    existing_url,
                    existing_expiry,
                )
        if existing_intent.get("state") == "settled":
            generation = existing_intent.get("verifiedGeneration")
            if generation is None:
                raise EvidenceUploadError(
                    "settled broker session lacks its verified generation"
                )
            verified = verify_brokered_upload(store, identity, int(generation))
            return BrokeredUploadSession(None, None, verified.pointer)
        if existing_intent.get("state") in {"cancelled", "retryable"}:
            # A prior exact capability is provider-terminal and the hub has
            # acknowledged that cancellation. Reusing the immutable broker
            # owner is therefore safe; preserve a monotonic issuance epoch so
            # the durable intent never makes two live capabilities ambiguous.
            _write_ledger(
                ledger_path,
                {
                    "schemaVersion": 1,
                    "state": "creating",
                    "identity": exact_identity,
                    "sessionEpoch": int(existing_intent.get("sessionEpoch", 0)) + 1,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                },
            )
            existing_intent = None
        if existing_intent is not None and replay_session is None:
            raise EvidenceUploadError(
                f"broker session intent is already {existing_intent.get('state', 'unknown')}"
            )
    else:
        _write_ledger(
            ledger_path,
            {
                "schemaVersion": 1,
                "state": "creating",
                "identity": exact_identity,
                "sessionEpoch": 1,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            },
            create_only=True,
        )

    blob = _blob(store, identity)
    creating_intent = _read_ledger(ledger_path)
    session_epoch = int((creating_intent or {}).get("sessionEpoch", 1))
    blob.metadata = dict(identity.metadata)
    blob.content_type = ARCHIVE_MIME_TYPE
    try:
        blob.reload(timeout=store.timeout_seconds)
    except Exception as exc:  # noqa: BLE001 - provider errors vary
        if replay_session is not None and _not_found(exc):
            return replay_session
        if replay_session is not None:
            # Keep the already-issued durable capability intact.  A transient
            # provider inspection failure must not turn an otherwise live
            # session into a new issuance or erase the cancellation handle.
            raise EvidenceUploadError(
                f"could not inspect issued brokered evidence object: {exc}"
            ) from exc
        if not _not_found(exc):
            _write_ledger(
                ledger_path,
                {
                    "schemaVersion": 1,
                    "state": "retryable",
                    "identity": exact_identity,
                    "sessionEpoch": session_epoch,
                    "failedPhase": "object-inspection",
                    "failedAt": datetime.now(timezone.utc).isoformat(),
                },
            )
            raise EvidenceUploadError(f"could not inspect brokered evidence object: {exc}") from exc
    else:
        generation = int(getattr(blob, "generation", 0) or 0)
        verified = verify_brokered_upload(store, identity, generation)
        _write_ledger(
            ledger_path,
            {
                "schemaVersion": 1,
                "state": "settled",
                "identity": exact_identity,
                "sessionEpoch": session_epoch,
                "verifiedGeneration": str(verified.pointer.generation),
                "settledAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        return BrokeredUploadSession(None, None, verified.pointer)

    if replay_session is not None:
        # ``blob.reload`` can only reach this point through a provider adapter
        # that reported absence without raising its normal not-found error.
        # Preserve the one durable capability instead of issuing another.
        return replay_session

    _write_ledger(
        ledger_path,
        {
            "schemaVersion": 1,
            "state": "provider-requesting",
            "identity": exact_identity,
            "sessionEpoch": session_epoch,
            "requestedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    try:
        upload_url = blob.create_resumable_upload_session(
            content_type=ARCHIVE_MIME_TYPE,
            size=identity.stored_size,
            checksum="crc32c",
            if_generation_match=0,
            timeout=store.timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001 - provider errors vary
        _write_ledger(
            ledger_path,
            {
                "schemaVersion": 1,
                "state": "creation-uncertain",
                "identity": exact_identity,
                "sessionEpoch": session_epoch,
                "failedPhase": "provider-session-creation",
                "failedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        raise EvidenceUploadError(f"could not create brokered resumable upload session: {exc}") from exc
    if not isinstance(upload_url, str) or not _valid_gcs_resumable_url(
        upload_url,
        expected_bucket=identity.bucket,
        expected_object_key=identity.object_key,
    ):
        _write_ledger(
            ledger_path,
            {
                "schemaVersion": 1,
                "state": "creation-uncertain",
                "identity": exact_identity,
                "sessionEpoch": session_epoch,
                "failedPhase": "provider-invalid-capability",
                "failedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        raise EvidenceUploadError("GCS returned an invalid resumable upload capability")
    expires_at = (datetime.now(timezone.utc) + _SESSION_LIFETIME).isoformat()
    # The bearer is durably recorded before it can cross the internal API
    # boundary. A Node/API crash after response receipt can therefore recover
    # and cancel by exact owner identity even if DB settlement never happened.
    _write_ledger(
        ledger_path,
        {
            "schemaVersion": 1,
            "state": "issued",
            "identity": exact_identity,
            "sessionEpoch": session_epoch,
            "uploadUrl": upload_url,
            "expiresAt": expires_at,
            "issuedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return BrokeredUploadSession(upload_url=upload_url, expires_at=expires_at)
