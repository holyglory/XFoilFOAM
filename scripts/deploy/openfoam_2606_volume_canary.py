#!/usr/bin/env python3
"""Certify OpenCFD 2606 on a dedicated volume-backed remote solver.

This is deliberately a separate deployment receipt from the production-hub
GCS canary.  It reuses the numerical/provenance/scenario checks, but accepts
only a retained local ``tar.zst`` bundle and forces post-strip rendering from
an authenticated archive extraction.  It never accepts a bucket, remote-only
disposition, GCS pointer, or object generation.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any


_BASE_PATH = Path(__file__).with_name("openfoam_2606_canary.py")
_SPEC = importlib.util.spec_from_file_location(
    "_airfoilfoam_openfoam_2606_gcs_canary", _BASE_PATH
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - install corruption
    raise RuntimeError(f"could not load canonical OpenCFD 2606 canary: {_BASE_PATH}")
_base = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _base
_SPEC.loader.exec_module(_base)


VOLUME_ATTESTATION_PROFILE = "hz-solver2-volume-v1"


class OpenCfd2606VolumeCanary(_base.OpenCfd2606Canary):
    """Strict local-volume specialization of the production canary runner."""

    def _validate_evidence_config(self, config: Any) -> None:
        _base._require(
            not config.expected_evidence_bucket.strip(),
            "volume canary refuses an evidence bucket or GCS credentials",
        )
        _base._require(
            bool(config.expected_evidence_object_prefix)
            and not config.expected_evidence_object_prefix.startswith("/")
            and ".." not in config.expected_evidence_object_prefix.split("/"),
            "expected evidence object prefix must be a safe relative path",
        )
        _base._require(
            1 <= config.expected_evidence_zstd_level <= 22,
            "expected evidence Zstandard level must be from 1 through 22",
        )

    def _evidence_storage_contract(self) -> dict[str, object]:
        return {
            "backend": "volume",
            "bucket": None,
            "object_prefix": self.config.expected_evidence_object_prefix,
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": self.config.expected_evidence_zstd_level,
            "local_disposition": "volume",
        }

    def _live_evidence_storage_contract(self) -> dict[str, object]:
        return {
            "backend": "volume",
            "bucket": None,
            "object_prefix": self.config.expected_evidence_object_prefix,
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": self.config.expected_evidence_zstd_level,
            "remote_only": False,
        }

    def _render_source_mode(self) -> str:
        # Rendering from the still-present raw VTK would not prove the local
        # tar.zst can restore after retention.  Every canary render must force
        # the archive extraction path.
        return "archive"

    def _validate_remote_engine_bundle(
        self,
        artifact: dict[str, Any],
        label: str,
    ) -> dict[str, object]:
        self._validate_artifact_metadata(artifact, label)
        _base._require(
            str(artifact["path"]).endswith("/engine_evidence.tar.zst"),
            f"{label} is not the canonical Zstandard bundle",
        )
        _base._require(
            artifact.get("mime_type") == "application/zstd",
            f"{label} does not report application/zstd",
        )
        metadata = _base._mapping(artifact.get("metadata"), f"{label}.metadata")
        _base._require(
            metadata.get("storageBackend") == "volume",
            f"{label} is not retained on the solver volume",
        )
        forbidden = {
            "bucket",
            "objectKey",
            "generation",
            "crc32c",
            "pointerPath",
            "verifiedAt",
            "remoteRestoreVerification",
        }
        leaked = sorted(forbidden.intersection(metadata))
        _base._require(
            not leaked,
            f"{label} leaked remote-object metadata into the volume contract: {leaked}",
        )
        _base._require(
            metadata.get("archiveFormat") == "tar+zstd"
            and metadata.get("compression") == "zstd",
            f"{label} archive format is not tar+zstd",
        )
        tar_sha = metadata.get("uncompressedTarSha256")
        tar_size = metadata.get("uncompressedTarByteSize")
        _base._require(
            isinstance(tar_sha, str) and bool(_base.HEX_64.fullmatch(tar_sha)),
            f"{label} uncompressed tar SHA-256 is malformed",
        )
        _base._require(
            isinstance(tar_size, int) and tar_size > 0,
            f"{label} uncompressed tar byte size is invalid",
        )
        _base._require(
            metadata.get("zstdLevel") == self.config.expected_evidence_zstd_level,
            f"{label} Zstandard level does not match the configured level",
        )
        _base._require(
            metadata.get("localEvidenceDisposition") == "volume",
            f"{label} does not retain its complete local archive",
        )
        bundled_file_count = metadata.get("bundledFileCount")
        _base._require(
            isinstance(bundled_file_count, int)
            and not isinstance(bundled_file_count, bool)
            and bundled_file_count > 0,
            f"{label} bundled file count is invalid",
        )
        return {
            "backend": "volume",
            "stored_sha256": artifact["sha256"],
            "stored_byte_size": artifact["byte_size"],
            "archive_format": metadata["archiveFormat"],
            "compression": metadata["compression"],
            "uncompressed_tar_sha256": tar_sha,
            "uncompressed_tar_byte_size": tar_size,
            "zstd_level": metadata["zstdLevel"],
            "local_disposition": metadata["localEvidenceDisposition"],
            # The shared canary validates this against the exact manifest.
            # It is removed from the role-specific persisted receipt below;
            # the remote attestation schema retains its established strict
            # storage shape while the check cannot be bypassed.
            "bundled_file_count": bundled_file_count,
        }

    def _validate_evidence(
        self,
        point: dict[str, Any],
        scenario: Any,
        expected_aoa_deg: float,
    ) -> list[dict[str, object | None]]:
        artifacts = super()._validate_evidence(
            point, scenario, expected_aoa_deg
        )
        for artifact in artifacts:
            storage = _base._mapping(
                artifact.get("storage"),
                f"{scenario.name} volume receipt storage",
            )
            storage.pop("bundled_file_count", None)
        return artifacts

    @staticmethod
    def _validate_retained_receipt_bindings(raw_jobs: list[Any]) -> None:
        expected_keys = {
            "backend",
            "stored_sha256",
            "stored_byte_size",
            "archive_format",
            "compression",
            "uncompressed_tar_sha256",
            "uncompressed_tar_byte_size",
            "zstd_level",
            "local_disposition",
        }
        for job_index, job_value in enumerate(raw_jobs):
            job = _base._mapping(job_value, f"retained volume job {job_index}")
            points = _base._list(
                job.get("points"), f"retained volume job {job_index} points"
            )
            for point_index, point_value in enumerate(points):
                point = _base._mapping(
                    point_value,
                    f"retained volume job {job_index} point {point_index}",
                )
                artifacts = _base._list(
                    point.get("artifacts"),
                    f"retained volume job {job_index} point {point_index} artifacts",
                )
                for artifact_index, artifact_value in enumerate(artifacts):
                    artifact = _base._mapping(
                        artifact_value,
                        f"retained volume artifact {job_index}/{point_index}/{artifact_index}",
                    )
                    storage = _base._mapping(
                        artifact.get("storage"),
                        f"retained volume artifact {job_index}/{point_index}/{artifact_index} storage",
                    )
                    _base._require(
                        set(storage) == expected_keys
                        and storage.get("backend") == "volume"
                        and storage.get("local_disposition") == "volume",
                        "retained volume artifact does not bind the complete local archive contract",
                    )

    @staticmethod
    def _to_volume_receipt(base_receipt: dict[str, Any]) -> dict[str, Any]:
        receipt = json.loads(json.dumps(base_receipt))
        receipt["attestation_profile"] = VOLUME_ATTESTATION_PROFILE
        for job in receipt.get("jobs", []):
            job["volume_restore_proof"] = job.pop("remote_render_proof")
        return receipt

    @staticmethod
    def _to_base_receipt(value: object) -> dict[str, Any]:
        receipt = _base._mapping(value, "retained volume canary receipt")
        expected_keys = {
            "schema_version",
            "status",
            "attestation_profile",
            "engine",
            "engine_handshake_key",
            "execution_pool",
            "runtime",
            "evidence_storage",
            "jobs",
        }
        _base._require(
            set(receipt) == expected_keys,
            "retained volume receipt has an unexpected or incomplete top-level shape",
        )
        _base._require(
            receipt.get("attestation_profile") == VOLUME_ATTESTATION_PROFILE,
            "retained receipt is not the hz-solver2 volume profile",
        )
        transformed = json.loads(json.dumps(receipt))
        transformed.pop("attestation_profile")
        for job in transformed.get("jobs", []):
            _base._require(
                "volume_restore_proof" in job and "remote_render_proof" not in job,
                "retained volume receipt lacks its archive restore/render proof",
            )
            job["remote_render_proof"] = job.pop("volume_restore_proof")
        return transformed

    def run(self) -> dict[str, Any]:
        return self._to_volume_receipt(super().run())

    def verify_retained_receipt(self, value: object) -> dict[str, Any]:
        verified = super().verify_retained_receipt(self._to_base_receipt(value))
        return {
            **verified,
            "attestation_profile": VOLUME_ATTESTATION_PROFILE,
        }


def _normalise_optional(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--coordinates", type=Path, default=_base._default_coordinates_path()
    )
    parser.add_argument(
        "--expected-build-id",
        default=_normalise_optional(os.environ.get("AIRFOILFOAM_BUILD_ID")),
    )
    parser.add_argument(
        "--expected-image-digest",
        default=_normalise_optional(os.environ.get("OPENCFD2606_IMAGE_DIGEST")),
    )
    parser.add_argument(
        "--expected-evidence-object-prefix",
        default=_normalise_optional(
            os.environ.get("AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX")
        )
        or "solver-evidence/v1",
    )
    parser.add_argument(
        "--expected-evidence-zstd-level",
        type=int,
        default=int(os.environ.get("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL", "10")),
    )
    parser.add_argument("--verify-receipt", type=Path)
    parser.add_argument("--expected-source-revision", default=_base.SOURCE_REVISION)
    parser.add_argument("--poll-interval-seconds", type=float, default=5.0)
    parser.add_argument("--rans-timeout-seconds", type=float, default=3600.0)
    parser.add_argument("--urans-timeout-seconds", type=float, default=21600.0)
    parser.add_argument("--request-timeout-seconds", type=float, default=30.0)
    parser.add_argument("--render-timeout-seconds", type=float, default=900.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.expected_build_id:
        parser.error("--expected-build-id or AIRFOILFOAM_BUILD_ID is required")
    for name in (
        "poll_interval_seconds",
        "rans_timeout_seconds",
        "urans_timeout_seconds",
        "request_timeout_seconds",
        "render_timeout_seconds",
    ):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    try:
        config = _base.CanaryConfig(
            gateway_url=args.gateway_url,
            coordinates=_base._load_coordinates(args.coordinates),
            expected_build_id=args.expected_build_id,
            expected_evidence_bucket="",
            expected_evidence_object_prefix=args.expected_evidence_object_prefix,
            expected_evidence_zstd_level=args.expected_evidence_zstd_level,
            expected_image_digest=_normalise_optional(args.expected_image_digest),
            expected_source_revision=args.expected_source_revision,
            poll_interval_s=args.poll_interval_seconds,
            rans_timeout_s=args.rans_timeout_seconds,
            urans_timeout_s=args.urans_timeout_seconds,
            request_timeout_s=args.request_timeout_seconds,
            render_timeout_s=args.render_timeout_seconds,
        )
        runner = OpenCfd2606VolumeCanary(config)
        if args.verify_receipt is None:
            summary = runner.run()
        else:
            try:
                receipt = json.loads(args.verify_receipt.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise _base.CanaryFailure(
                    f"could not read retained volume canary receipt {args.verify_receipt}: {exc}"
                ) from exc
            summary = runner.verify_retained_receipt(receipt)
    except _base.CanaryFailure as exc:
        print(f"OpenCFD 2606 volume canary failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
