#!/usr/bin/env python3
"""Fail-closed production canary for the OpenCFD 2606 engine pool.

The canary deliberately talks only to the FastAPI solver gateway.  It proves
the same public contract used by the Node control plane:

* the gateway is configured for the exact OpenCFD 2606 logical identity;
* a live worker consumes only ``openfoam-opencfd-2606`` and reports immutable
  runtime provenance;
* serial RANS, two-rank MPI RANS, and the shortest trustworthy forced-URANS
  request all complete through that worker; and
* coefficients, method/fidelity, mesh, force, VTK and stored-media evidence are
  real, internally consistent, checksummed, and retrievable.

Only the Python standard library is used so this file can run on a production
host before any project virtual environment is available.  The forced URANS
case uses a symmetric NACA 0012 at zero incidence and the ``precalc`` fidelity
tier.  It still executes pimpleFoam and must retain a physically long enough
force history, but a truthful no-shedding result avoids waiting for an
unnecessary periodic-wake animation.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


ENGINE: dict[str, object] = {
    "family": "openfoam",
    "distribution": "opencfd",
    "version": "2606",
    "numerics_revision": "1",
    "adapter_contract_version": 1,
}
ENGINE_NAMESPACE = "openfoam:opencfd:2606:numerics-1"
ENGINE_HANDSHAKE_KEY = f"{ENGINE_NAMESPACE}:adapter-1"
EXECUTION_POOL = "openfoam-opencfd-2606"
SOURCE_REVISION = "481094fdf34f11ed6d0d603ee59a858a0124236d"
BASE_IMAGE = (
    "opencfd/openfoam-run:2606@"
    "sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb"
)
MEDIA_FIELD = "velocity_magnitude"
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
CRC32C_BASE64 = re.compile(r"^[A-Za-z0-9+/]{6}==$")
REMOTE_RESTORE_PROOF = re.compile(
    r"^archive\+manifest\+all-members-restore:([1-9][0-9]*)$"
)
OFFICIAL_PACKAGE_SHA256_BY_ARCH = {
    "amd64": "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
    "x86_64": "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
    "arm64": "8d395ac52c284bc74c0aed774f692004d47ad7088596fabde5efc1f71991548a",
    "aarch64": "8d395ac52c284bc74c0aed774f692004d47ad7088596fabde5efc1f71991548a",
}
TERMINAL_STATES = {"completed", "failed", "cancelled"}
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024

# These are the engine's pinned physical no-shedding gate values.  Rechecking
# them here proves that a forced-URANS result did not merely return a short,
# flat startup trace as if it were accepted evidence.
NO_SHEDDING_SLOW_STROUHAL = 0.05
NO_SHEDDING_MIN_SLOW_PERIODS = 2.1


class CanaryFailure(RuntimeError):
    """A canary assertion or gateway operation failed."""


@dataclass(frozen=True)
class CanaryConfig:
    gateway_url: str
    coordinates: str
    expected_build_id: str
    expected_evidence_bucket: str
    expected_evidence_object_prefix: str
    expected_evidence_zstd_level: int
    expected_image_digest: str | None = None
    expected_source_revision: str = SOURCE_REVISION
    poll_interval_s: float = 5.0
    rans_timeout_s: float = 3600.0
    urans_timeout_s: float = 21600.0
    request_timeout_s: float = 30.0
    render_timeout_s: float = 900.0


@dataclass(frozen=True)
class Scenario:
    name: str
    aoa_degs: tuple[float, ...]
    chord_m: float
    speed_mps: float
    solver_processes: int
    method_key: str
    fidelity: str
    force_transient: bool
    timeout_s: float


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CanaryFailure(message)


def _mapping(value: object, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def _list(value: object, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be a JSON array")
    return value


def _finite(value: object, label: str) -> float:
    _require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{label} must be numeric",
    )
    number = float(value)
    _require(math.isfinite(number), f"{label} must be finite")
    return number


def _logical_identity(value: object, label: str) -> dict[str, object]:
    identity = _mapping(value, label)
    actual = {key: identity.get(key) for key in ENGINE}
    _require(actual == ENGINE, f"{label} is {actual!r}, expected {ENGINE!r}")
    return actual


def _normalise_optional(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _require_utc_timestamp(value: object, label: str) -> str:
    _require(isinstance(value, str) and bool(value), f"{label} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CanaryFailure(f"{label} is not an ISO-8601 timestamp") from exc
    _require(parsed.tzinfo is not None, f"{label} must include a UTC offset")
    _require(parsed.utcoffset() is not None, f"{label} has no UTC offset")
    _require(parsed.utcoffset().total_seconds() == 0, f"{label} is not UTC")
    return value


def _manifest_member_binding(
    payload: bytes, label: str
) -> tuple[int, int, str]:
    """Match the control-plane manifest+bundle member digest exactly."""

    try:
        manifest = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CanaryFailure(f"{label} is invalid JSON") from exc
    manifest = _mapping(manifest, label)
    files = _list(manifest.get("files"), f"{label}.files")
    excludes = _list(manifest.get("bundleExcludes", []), f"{label}.bundleExcludes")
    excluded_roots: set[str] = set()
    for index, value in enumerate(excludes):
        _require(
            isinstance(value, str)
            and bool(value)
            and "/" not in value
            and "\\" not in value
            and value not in {".", ".."},
            f"{label}.bundleExcludes[{index}] is unsafe",
        )
        _require(value not in excluded_roots, f"{label} repeats bundle exclusion {value}")
        excluded_roots.add(value)

    rows: dict[str, tuple[str, int]] = {
        "evidence_manifest.json": (hashlib.sha256(payload).hexdigest(), len(payload))
    }
    for index, raw in enumerate(files):
        entry = _mapping(raw, f"{label}.files[{index}]")
        path = entry.get("path")
        sha256 = entry.get("sha256")
        byte_size = entry.get("byteSize")
        _require(
            isinstance(path, str)
            and bool(path)
            and not path.startswith("/")
            and "\\" not in path
            and "\0" not in path
            and all(part not in {"", ".", ".."} for part in path.split("/")),
            f"{label}.files[{index}].path is unsafe",
        )
        _require(
            isinstance(sha256, str) and bool(HEX_64.fullmatch(sha256)),
            f"{label}.files[{index}].sha256 is malformed",
        )
        _require(
            isinstance(byte_size, int)
            and not isinstance(byte_size, bool)
            and byte_size >= 0,
            f"{label}.files[{index}].byteSize is invalid",
        )
        if path.split("/", 1)[0] in excluded_roots:
            continue
        _require(path not in rows, f"{label} repeats member path {path}")
        rows[path] = (sha256, byte_size)

    digest = hashlib.sha256()
    for path, (sha256, byte_size) in sorted(rows.items()):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256.encode("ascii"))
        digest.update(b"\0")
        digest.update(str(byte_size).encode("ascii"))
        digest.update(b"\n")
    # The object-store restore proof reports bundled manifest entries only;
    # the database association set additionally owns evidence_manifest.json.
    return len(rows) - 1, len(rows), digest.hexdigest()


class GatewayClient:
    """Small same-origin JSON/artifact client with bounded reads."""

    def __init__(self, base_url: str, request_timeout_s: float) -> None:
        raw = base_url.rstrip("/") + "/"
        parsed = urlsplit(raw)
        _require(parsed.scheme in {"http", "https"}, "gateway URL must use http or https")
        _require(bool(parsed.hostname), "gateway URL must include a host")
        _require(parsed.username is None and parsed.password is None, "gateway URL must not contain credentials")
        _require(not parsed.query and not parsed.fragment, "gateway URL must not contain a query or fragment")
        # The production gateway is intentionally loopback-bound.  Refusing a
        # remote host prevents a typo from launching CFD against another site.
        try:
            addresses = {
                item[4][0]
                for item in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
            }
        except OSError as exc:
            raise CanaryFailure(f"could not resolve gateway host {parsed.hostname!r}: {exc}") from exc
        _require(
            bool(addresses) and all(address in {"127.0.0.1", "::1"} for address in addresses),
            f"gateway must resolve only to loopback, got {sorted(addresses)!r}",
        )
        self.base_url = raw
        self.origin = (parsed.scheme, parsed.hostname, parsed.port)
        self.request_timeout_s = request_timeout_s

    def resolve(self, path_or_url: str) -> str:
        _require(isinstance(path_or_url, str) and bool(path_or_url), "gateway URL/path is missing")
        resolved = urljoin(self.base_url, path_or_url.lstrip("/") if not path_or_url.startswith("/") else path_or_url)
        parsed = urlsplit(resolved)
        _require(
            (parsed.scheme, parsed.hostname, parsed.port) == self.origin,
            f"gateway returned cross-origin URL {resolved!r}",
        )
        return resolved

    def bytes(
        self,
        method: str,
        path_or_url: str,
        *,
        body: bytes | None = None,
        expected_status: set[int] | None = None,
        deadline: float | None = None,
        max_bytes: int = MAX_JSON_BYTES,
        request_timeout_s: float | None = None,
    ) -> tuple[int, bytes, str]:
        url = self.resolve(path_or_url)
        headers = {"Accept": "application/json", "User-Agent": "xfoilfoam-openfoam-2606-canary/1"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=method)
        timeout = self.request_timeout_s if request_timeout_s is None else request_timeout_s
        _require(timeout > 0, "request timeout must be positive")
        if deadline is not None:
            remaining = deadline - time.monotonic()
            _require(remaining > 0, f"deadline expired before {method} {url}")
            timeout = min(timeout, remaining)
        try:
            with urlopen(request, timeout=max(0.05, timeout)) as response:
                # urllib follows redirects automatically.  Recheck the final
                # URL so a gateway cannot redirect evidence downloads away
                # from the loopback origin validated above.
                self.resolve(response.geturl())
                status = int(response.status)
                content_length = response.headers.get("Content-Length")
                if content_length is not None:
                    try:
                        declared = int(content_length)
                    except ValueError as exc:
                        raise CanaryFailure(f"{method} {url} returned invalid Content-Length") from exc
                    _require(declared <= max_bytes, f"{method} {url} body exceeds {max_bytes} bytes")
                payload = response.read(max_bytes + 1)
                _require(len(payload) <= max_bytes, f"{method} {url} body exceeds {max_bytes} bytes")
                content_type = response.headers.get("Content-Type", "")
        except HTTPError as exc:
            detail = exc.read(64 * 1024).decode("utf-8", errors="replace")
            raise CanaryFailure(f"{method} {url} returned HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise CanaryFailure(f"{method} {url} failed: {exc}") from exc
        if expected_status is not None:
            _require(status in expected_status, f"{method} {url} returned HTTP {status}, expected {sorted(expected_status)}")
        return status, payload, content_type

    def verify_download(
        self,
        path_or_url: str,
        *,
        expected_size: int,
        expected_sha256: str,
        max_bytes: int,
    ) -> None:
        """Stream a potentially large artifact and verify all of its bytes."""
        _require(0 < expected_size <= max_bytes, f"artifact size {expected_size} exceeds the {max_bytes}-byte canary limit")
        url = self.resolve(path_or_url)
        request = Request(
            url,
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": "xfoilfoam-openfoam-2606-canary/1",
            },
            method="GET",
        )
        count = 0
        digest = hashlib.sha256()
        try:
            with urlopen(request, timeout=max(0.05, self.request_timeout_s)) as response:
                self.resolve(response.geturl())
                _require(int(response.status) == 200, f"GET {url} returned HTTP {response.status}")
                content_length = response.headers.get("Content-Length")
                if content_length is not None:
                    try:
                        declared = int(content_length)
                    except ValueError as exc:
                        raise CanaryFailure(f"GET {url} returned invalid Content-Length") from exc
                    _require(declared == expected_size, f"GET {url} Content-Length differs from artifact metadata")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    _require(count <= expected_size and count <= max_bytes, f"GET {url} exceeded its declared artifact size")
                    digest.update(chunk)
        except HTTPError as exc:
            detail = exc.read(64 * 1024).decode("utf-8", errors="replace")
            raise CanaryFailure(f"GET {url} returned HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise CanaryFailure(f"GET {url} failed: {exc}") from exc
        _require(count == expected_size, f"GET {url} byte size does not match artifact metadata")
        _require(digest.hexdigest() == expected_sha256, f"GET {url} checksum does not match artifact metadata")

    def json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
        expected_status: set[int] | None = None,
        deadline: float | None = None,
        request_timeout_s: float | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        _status, raw, _content_type = self.bytes(
            method,
            path,
            body=body,
            expected_status=expected_status,
            deadline=deadline,
            max_bytes=MAX_JSON_BYTES,
            request_timeout_s=request_timeout_s,
        )
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CanaryFailure(f"{method} {path} returned invalid JSON") from exc
        return _mapping(value, f"{method} {path} response")


class OpenCfd2606Canary:
    def __init__(self, config: CanaryConfig) -> None:
        _require(bool(config.expected_build_id.strip()), "expected build id is required")
        _require(
            bool(config.expected_evidence_bucket.strip()),
            "expected evidence bucket is required",
        )
        _require(
            bool(config.expected_evidence_object_prefix)
            and not config.expected_evidence_object_prefix.startswith("/")
            and ".." not in config.expected_evidence_object_prefix.split("/"),
            "expected evidence object prefix must be a safe relative path",
        )
        _require(
            1 <= config.expected_evidence_zstd_level <= 22,
            "expected evidence Zstandard level must be from 1 through 22",
        )
        if config.expected_image_digest is not None:
            _require(
                bool(OCI_DIGEST.fullmatch(config.expected_image_digest)),
                "expected image digest must be sha256:<64 lowercase hex>",
            )
        self.config = config
        self.client = GatewayClient(config.gateway_url, config.request_timeout_s)
        self.active_jobs: set[str] = set()
        self.terminal_jobs: set[str] = set()
        self.runtime: dict[str, Any] | None = None
        self.mesh_recovery_version: int | None = None
        self.airfoil_points = self._parse_airfoil_points(config.coordinates)

    def _evidence_storage_contract(self) -> dict[str, object]:
        return {
            "backend": "gcs",
            "bucket": self.config.expected_evidence_bucket,
            "object_prefix": self.config.expected_evidence_object_prefix,
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": self.config.expected_evidence_zstd_level,
            "local_disposition": "remote-only",
        }

    def _scenarios(self) -> list[Scenario]:
        return [
            Scenario(
                name="serial-rans",
                # Two points in one job prove production mesh reuse rather
                # than merely checking a scheduling counter on a one-point
                # request.
                aoa_degs=(2.0, 5.0),
                chord_m=0.1,
                speed_mps=50.0,
                solver_processes=1,
                method_key="openfoam.rans",
                fidelity="rans",
                force_transient=False,
                timeout_s=self.config.rans_timeout_s,
            ),
            Scenario(
                name="mpi-2-rans",
                aoa_degs=(5.0,),
                chord_m=0.1,
                speed_mps=50.0,
                solver_processes=2,
                method_key="openfoam.rans",
                fidelity="rans",
                force_transient=False,
                timeout_s=self.config.rans_timeout_s,
            ),
            Scenario(
                name="forced-urans-precalc-no-shedding",
                aoa_degs=(0.0,),
                chord_m=0.05,
                speed_mps=166.0,
                solver_processes=1,
                method_key="openfoam.urans",
                fidelity="urans_precalc",
                force_transient=True,
                timeout_s=self.config.urans_timeout_s,
            ),
        ]

    @staticmethod
    def _parse_airfoil_points(coordinates: str) -> list[list[float]]:
        points: list[list[float]] = []
        for line in coordinates.splitlines()[1:]:
            parts = line.split()
            if len(parts) != 2:
                continue
            try:
                x, y = (float(part) for part in parts)
            except ValueError:
                continue
            _require(math.isfinite(x) and math.isfinite(y), "airfoil coordinates must be finite")
            points.append([x, y])
        _require(len(points) >= 50, "production canary airfoil coordinates are incomplete")
        return points

    def _validate_runtime(self, value: object, label: str) -> dict[str, Any]:
        runtime = _mapping(value, label)
        _logical_identity(runtime, label)
        _require(
            runtime.get("build_id") == self.config.expected_build_id,
            f"{label}.build_id is {runtime.get('build_id')!r}, expected {self.config.expected_build_id!r}",
        )
        _require(
            runtime.get("source_revision") == self.config.expected_source_revision,
            f"{label}.source_revision is {runtime.get('source_revision')!r}, expected {self.config.expected_source_revision!r}",
        )
        image_digest = runtime.get("image_digest")
        if self.config.expected_image_digest is not None:
            _require(
                image_digest == self.config.expected_image_digest,
                f"{label}.image_digest is {image_digest!r}, expected {self.config.expected_image_digest!r}",
            )
        elif image_digest is not None:
            _require(
                isinstance(image_digest, str) and bool(OCI_DIGEST.fullmatch(image_digest)),
                f"{label}.image_digest is malformed",
            )
        for field in ("application_source_sha256", "package_sha256", "binary_sha256"):
            fingerprint = runtime.get(field)
            _require(
                isinstance(fingerprint, str) and bool(HEX_64.fullmatch(fingerprint)),
                f"{label}.{field} must contain an immutable lowercase SHA-256 fingerprint",
            )
        architecture = runtime.get("architecture")
        _require(isinstance(architecture, str) and bool(architecture.strip()), f"{label}.architecture is missing")
        expected_package_sha256 = OFFICIAL_PACKAGE_SHA256_BY_ARCH.get(architecture.strip().lower())
        _require(expected_package_sha256 is not None, f"{label}.architecture {architecture!r} is not a supported official OpenCFD 2606 package architecture")
        _require(
            runtime.get("package_sha256") == expected_package_sha256,
            f"{label}.package_sha256 does not match the official OpenCFD 2606 {architecture} package",
        )
        if self.runtime is not None:
            _require(runtime == self.runtime, f"{label} differs from the preflight worker runtime")
        return runtime

    def _preflight(self) -> dict[str, Any]:
        health = self.client.json("GET", "/health", expected_status={200})
        _require(health.get("status") == "ok", "gateway health is not ok")
        _require(health.get("role") == "solver_gateway", "health role is not solver_gateway")
        _require(health.get("build_id") == self.config.expected_build_id, "gateway build id differs from requested build")
        _logical_identity(health.get("default_engine"), "health.default_engine")
        supported = _list(health.get("supported_engines"), "health.supported_engines")
        matches = [item for item in supported if isinstance(item, dict) and {key: item.get(key) for key in ENGINE} == ENGINE]
        _require(len(matches) == 1, "health must advertise OpenCFD 2606 exactly once")
        _require(
            not any(
                isinstance(item, dict)
                and item.get("family") == "openfoam"
                and item.get("distribution") == "opencfd"
                and item.get("version") == "2406"
                for item in supported
            ),
            "health still advertises the retired OpenCFD 2406 runtime",
        )
        health_storage = _mapping(
            health.get("evidence_storage"), "health.evidence_storage"
        )
        expected_health_storage = {
            "backend": "gcs",
            "bucket": self.config.expected_evidence_bucket,
            "object_prefix": self.config.expected_evidence_object_prefix,
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": self.config.expected_evidence_zstd_level,
            "remote_only": True,
        }
        _require(
            health_storage == expected_health_storage,
            "live gateway evidence storage differs from the expected bucket/prefix/Zstandard/remote-only contract",
        )
        mesh_recovery_version = health.get("mesh_recovery_version")
        _require(
            isinstance(mesh_recovery_version, int) and not isinstance(mesh_recovery_version, bool) and mesh_recovery_version >= 0,
            "health.mesh_recovery_version is invalid",
        )
        self.mesh_recovery_version = mesh_recovery_version

        capabilities = self.client.json("GET", "/capabilities", expected_status={200})
        _logical_identity(capabilities.get("default_engine"), "capabilities.default_engine")
        _require(capabilities.get("openfoam_image") == BASE_IMAGE, "gateway OpenFOAM image pin is not the official 2606 digest")
        engines = _list(capabilities.get("engines"), "capabilities.engines")
        engine_caps = [
            _mapping(item, "capabilities.engines item")
            for item in engines
            if isinstance(item, dict)
            and isinstance(item.get("engine"), dict)
            and {key: item["engine"].get(key) for key in ENGINE} == ENGINE
        ]
        _require(len(engine_caps) == 1, "capabilities must contain exactly one OpenCFD 2606 adapter")
        cap = engine_caps[0]
        _require(cap.get("routing_key") == EXECUTION_POOL, "2606 capability has the wrong routing key")
        methods = set(_list(cap.get("analysis_methods"), "2606 analysis_methods"))
        _require({"rans", "urans"}.issubset(methods), "2606 capability lacks RANS or URANS")
        for field in ("steady", "transient", "volume_fields", "mesh_evidence", "stored_media"):
            _require(cap.get(field) is True, f"2606 capability {field} is not enabled")

        queue = self.client.json("GET", "/queue", expected_status={200})
        _require(queue.get("worker_queues_error") is None, f"worker queue inspection failed: {queue.get('worker_queues_error')}")
        _require(queue.get("worker_runtime_error") is None, f"worker runtime inspection failed: {queue.get('worker_runtime_error')}")
        inspection_errors = _mapping(queue.get("inspection_errors", {}), "queue.inspection_errors")
        _require(not inspection_errors, f"Celery inspection failed: {inspection_errors!r}")
        queue_enabled = _mapping(queue.get("queue_enabled"), "queue.queue_enabled")
        _require(queue_enabled.get(EXECUTION_POOL) is True, f"execution pool {EXECUTION_POOL} is not enabled")
        queue_rows = _list(queue.get("queues"), "queue.queues")
        matching_rows = [row for row in queue_rows if isinstance(row, dict) and row.get("routing_key") == EXECUTION_POOL]
        _require(len(matching_rows) == 1 and matching_rows[0].get("enabled") is True, "queue route for OpenCFD 2606 is missing or disabled")
        _logical_identity(matching_rows[0].get("engine"), "queue 2606 engine")

        workers = _list(queue.get("worker_queues"), "queue.worker_queues")
        target_workers: list[dict[str, Any]] = []
        for raw_worker in workers:
            worker = _mapping(raw_worker, "queue.worker_queues item")
            worker_engine = worker.get("engine")
            if isinstance(worker_engine, dict) and (
                worker_engine.get("family") == "openfoam"
                and worker_engine.get("distribution") == "opencfd"
                and worker_engine.get("version") == "2406"
            ):
                raise CanaryFailure(f"retired OpenCFD 2406 worker is still live: {worker.get('worker')!r}")
            queues = _list(worker.get("queues"), "worker.queues")
            if EXECUTION_POOL in queues:
                _require(worker.get("execution_pool") == EXECUTION_POOL, "2606 worker reports a different execution pool")
                target_workers.append(worker)
        _require(target_workers, f"no live worker consumes {EXECUTION_POOL}")
        runtimes = [self._validate_runtime(worker.get("engine"), f"worker {worker.get('worker')!r} engine") for worker in target_workers]
        first_runtime = runtimes[0]
        _require(all(runtime == first_runtime for runtime in runtimes), "2606 workers do not share one exact runtime provenance")
        self.runtime = first_runtime
        return {"health": health, "capabilities": cap, "runtime": first_runtime}

    def _payload(self, scenario: Scenario) -> dict[str, object]:
        _require(self.mesh_recovery_version is not None, "preflight has not completed")
        solver: dict[str, object] = {
            "turbulence": {
                "model": "kOmegaSST",
                "intensity": 0.001,
                "viscosity_ratio": 10.0,
            },
            "n_iterations": 2500,
            "convergence_tolerance": 1.0e-5,
            "momentum_scheme": "linearUpwind",
            "transient_fallback": False,
            "rans_failure_policy": "continue",
            "force_transient": scenario.force_transient,
            "warm_start": False,
            "write_images": [MEDIA_FIELD],
            "frame_fields": [MEDIA_FIELD],
            "image_zoom_chords": 2.0,
        }
        if scenario.force_transient:
            solver.update(
                {
                    "urans_fidelity": "precalc",
                    "urans_min_periods": 3,
                    "transient_auto_refine": True,
                }
            )
        return {
            "airfoil": {
                "name": "NACA0012 production canary",
                "format": "selig",
                "coordinates": self.config.coordinates,
            },
            "chord_lengths": [scenario.chord_m],
            "speeds": [scenario.speed_mps],
            "aoa": {"angles": list(scenario.aoa_degs)},
            "fluid": {"density": 1.225, "kinematic_viscosity": 1.5e-5},
            "roughness": {"sand_grain_height": 0.0, "roughness_constant": 0.5},
            "mesh": {
                "mesher": "blockmesh-cgrid",
                "farfield_radius_chords": 15.0,
                "wake_length_chords": 12.0,
                "n_surface": 130,
                "n_radial": 80,
                "n_wake": 60,
                "target_y_plus": 1.0,
                "span_chords": 0.1,
            },
            "solver": solver,
            "resources": {
                "cpu_budget": scenario.solver_processes,
                "case_concurrency": 1,
                "solver_processes": scenario.solver_processes,
                "policy": "exclusive",
            },
            "expected_mesh_recovery_version": self.mesh_recovery_version,
            "expected_engine": dict(ENGINE),
            "expected_execution_pool": EXECUTION_POOL,
        }

    def _validate_routing(self, body: dict[str, Any], label: str, *, runtime_required: bool) -> None:
        _logical_identity(body.get("requested_engine"), f"{label}.requested_engine")
        _require(body.get("requested_execution_pool") == EXECUTION_POOL, f"{label} requested the wrong execution pool")
        if runtime_required:
            self._validate_runtime(body.get("engine"), f"{label}.engine")
            _require(body.get("execution_pool") == EXECUTION_POOL, f"{label} executed in the wrong pool")
            _require(body.get("mesh_recovery_version") == self.mesh_recovery_version, f"{label} used a different mesh-recovery contract")
        else:
            engine = body.get("engine")
            if engine is not None:
                self._validate_runtime(engine, f"{label}.engine")
                _require(body.get("execution_pool") == EXECUTION_POOL, f"{label} acknowledged the wrong execution pool")

    def _wait(self, job_id: str, scenario: Scenario, submission: dict[str, Any]) -> dict[str, Any]:
        self._validate_routing(submission, f"{scenario.name} submission", runtime_required=False)
        deadline = time.monotonic() + scenario.timeout_s
        last_progress: tuple[object, ...] | None = None
        while True:
            status = self.client.json("GET", f"/jobs/{job_id}", expected_status={200}, deadline=deadline)
            _require(status.get("job_id") == job_id, f"{scenario.name} status returned a different job id")
            self._validate_routing(status, f"{scenario.name} status", runtime_required=status.get("state") != "pending")
            state = status.get("state")
            _require(isinstance(state, str), f"{scenario.name} status has no state")
            progress = (
                state,
                status.get("phase"),
                status.get("completed_cases"),
                status.get("active_solver"),
                status.get("active_case_slug"),
                status.get("last_progress_at"),
            )
            if progress != last_progress:
                print(
                    f"[{scenario.name}] state={state} phase={status.get('phase')} "
                    f"completed={status.get('completed_cases')}/{status.get('total_cases')}",
                    file=sys.stderr,
                    flush=True,
                )
                last_progress = progress
            if state in TERMINAL_STATES:
                self.terminal_jobs.add(job_id)
                _require(state == "completed", f"{scenario.name} ended {state}: {status.get('message')}")
                return status
            remaining = deadline - time.monotonic()
            _require(remaining > 0, f"{scenario.name} timed out after {scenario.timeout_s:g}s")
            time.sleep(min(self.config.poll_interval_s, remaining))

    def _validate_scheduling(self, value: object, scenario: Scenario, label: str) -> None:
        scheduling = _mapping(value, label)
        _require(scheduling.get("solver_processes") == scenario.solver_processes, f"{label} did not use {scenario.solver_processes} solver process(es)")
        _require(scheduling.get("resolved_case_concurrency") == 1, f"{label} did not isolate the canary case")
        resolved_budget = scheduling.get("resolved_cpu_budget")
        _require(
            isinstance(resolved_budget, int) and resolved_budget >= scenario.solver_processes,
            f"{label} resolved CPU budget is below the MPI rank count",
        )
        _require(scheduling.get("aoa_case_count") == len(scenario.aoa_degs), f"{label} did not execute the complete canary AoA set")
        _require(
            isinstance(scheduling.get("mesh_build_count"), int) and 0 <= scheduling["mesh_build_count"] <= 1,
            f"{label} rebuilt the mesh more than once",
        )

    def _artifact(self, artifacts: list[Any], label: str, predicate) -> dict[str, Any]:
        matches = [item for item in artifacts if isinstance(item, dict) and predicate(item)]
        _require(matches, f"{label} evidence artifact is missing")
        return _mapping(matches[0], f"{label} artifact")

    def _validate_artifact_metadata(self, artifact: dict[str, Any], label: str) -> None:
        _require(isinstance(artifact.get("path"), str) and bool(artifact["path"]), f"{label}.path is missing")
        _require(isinstance(artifact.get("url"), str) and bool(artifact["url"]), f"{label}.url is missing")
        _require(isinstance(artifact.get("sha256"), str) and bool(HEX_64.fullmatch(artifact["sha256"])), f"{label}.sha256 is malformed")
        _require(isinstance(artifact.get("byte_size"), int) and artifact["byte_size"] > 0, f"{label}.byte_size is invalid")
        self.client.resolve(artifact["url"])

    def _verify_large_artifact(self, artifact: dict[str, Any], label: str) -> None:
        self._validate_artifact_metadata(artifact, label)
        self.client.verify_download(
            artifact["url"],
            expected_size=artifact["byte_size"],
            expected_sha256=artifact["sha256"],
            max_bytes=MAX_BUNDLE_BYTES,
        )

    def _validate_remote_engine_bundle(
        self,
        artifact: dict[str, Any],
        label: str,
    ) -> dict[str, object]:
        self._validate_artifact_metadata(artifact, label)
        _require(
            str(artifact["path"]).endswith("/engine_evidence.tar.zst"),
            f"{label} is not the canonical Zstandard bundle",
        )
        _require(
            artifact.get("mime_type") == "application/zstd",
            f"{label} does not report application/zstd",
        )
        metadata = _mapping(artifact.get("metadata"), f"{label}.metadata")
        _require(
            metadata.get("storageBackend") == "gcs",
            f"{label} was not published to GCS",
        )
        _require(
            metadata.get("bucket") == self.config.expected_evidence_bucket,
            f"{label} was published to the wrong GCS bucket",
        )
        object_key = metadata.get("objectKey")
        expected_key = (
            f"{self.config.expected_evidence_object_prefix}/sha256/"
            f"{artifact['sha256'][:2]}/{artifact['sha256']}.tar.zst"
        )
        _require(
            isinstance(object_key, str)
            and object_key == expected_key,
            f"{label} GCS key does not match the configured content-addressed object prefix",
        )
        generation = metadata.get("generation")
        _require(
            isinstance(generation, str)
            and generation.isascii()
            and generation.isdigit()
            and int(generation) > 0,
            f"{label} GCS generation must be an exact positive decimal string",
        )
        _require(
            isinstance(metadata.get("crc32c"), str)
            and bool(CRC32C_BASE64.fullmatch(metadata["crc32c"])),
            f"{label} CRC32C is malformed",
        )
        _require(
            metadata.get("archiveFormat") == "tar+zstd"
            and metadata.get("compression") == "zstd",
            f"{label} archive format is not tar+zstd",
        )
        _require(
            isinstance(metadata.get("uncompressedTarSha256"), str)
            and bool(HEX_64.fullmatch(metadata["uncompressedTarSha256"])),
            f"{label} uncompressed tar SHA-256 is malformed",
        )
        _require(
            isinstance(metadata.get("uncompressedTarByteSize"), int)
            and metadata["uncompressedTarByteSize"] > 0,
            f"{label} uncompressed tar byte size is invalid",
        )
        _require(
            metadata.get("zstdLevel") == self.config.expected_evidence_zstd_level,
            f"{label} Zstandard level does not match the configured level",
        )
        _require_utc_timestamp(metadata.get("verifiedAt"), f"{label} verifiedAt")
        _require(
            metadata.get("pointerPath") == "engine_evidence.remote.json",
            f"{label} pointer path is not canonical",
        )
        _require(
            metadata.get("localEvidenceDisposition")
            == "remote-copy-plus-local-archive-pending-database-ack",
            f"{label} did not retain its archive pending durable database acknowledgement",
        )
        _require(
            metadata.get("rawLocalEvidenceDisposition") == "removed"
            and metadata.get("localArchiveRetainedUntilDatabaseAck") is True,
            f"{label} did not safely remove raw duplicates while retaining the complete archive",
        )
        restore_verification = metadata.get("remoteRestoreVerification")
        _require(
            isinstance(restore_verification, str)
            and REMOTE_RESTORE_PROOF.fullmatch(restore_verification) is not None,
            f"{label} has no all-member generation-pinned remote restore proof",
        )
        # This immutable binding is copied onto every receipt artifact.  The
        # non-bundle artifacts are members of this exact archive generation,
        # so retaining only their member checksums would leave a receipt
        # replayable after a bucket/prefix or object-generation change.
        return {
            "backend": "gcs",
            "bucket": metadata["bucket"],
            "object_key": object_key,
            "generation": generation,
            "stored_sha256": artifact["sha256"],
            "stored_byte_size": artifact["byte_size"],
            "crc32c": metadata["crc32c"],
            "archive_format": metadata["archiveFormat"],
            "compression": metadata["compression"],
            "uncompressed_tar_sha256": metadata["uncompressedTarSha256"],
            "uncompressed_tar_byte_size": metadata["uncompressedTarByteSize"],
            "zstd_level": metadata["zstdLevel"],
            "verified_at": metadata["verifiedAt"],
            "pointer_path": metadata["pointerPath"],
            "local_disposition": metadata["localEvidenceDisposition"],
            "raw_local_disposition": metadata["rawLocalEvidenceDisposition"],
            "local_archive_retained_until_database_ack": metadata[
                "localArchiveRetainedUntilDatabaseAck"
            ],
            "restore_verification": metadata["remoteRestoreVerification"],
        }

    def _fetch_artifact(self, artifact: dict[str, Any], label: str) -> bytes:
        self._validate_artifact_metadata(artifact, label)
        _status, payload, _content_type = self.client.bytes(
            "GET",
            artifact["url"],
            expected_status={200},
            max_bytes=MAX_ARTIFACT_BYTES,
        )
        _require(len(payload) == artifact["byte_size"], f"{label} byte size does not match metadata")
        _require(hashlib.sha256(payload).hexdigest() == artifact["sha256"], f"{label} checksum does not match metadata")
        return payload

    def _fetch_media(self, path: object, label: str, kind: str) -> None:
        _require(isinstance(path, str) and bool(path), f"{label} URL is missing")
        _status, payload, content_type = self.client.bytes(
            "GET", path, expected_status={200}, max_bytes=MAX_ARTIFACT_BYTES
        )
        _require(payload, f"{label} is empty")
        if kind == "image":
            _require(payload.startswith(b"\x89PNG\r\n\x1a\n"), f"{label} is not a PNG")
            _require("image/png" in content_type.lower(), f"{label} does not report image/png")
        elif kind == "video":
            _require(len(payload) >= 12 and payload[4:8] == b"ftyp", f"{label} is not an MP4")
            _require("video/" in content_type.lower(), f"{label} does not report a video MIME type")

    def _validate_force_history(self, point: dict[str, Any], scenario: Scenario) -> None:
        history = _mapping(point.get("force_history"), f"{scenario.name} force_history")
        series = []
        for name in ("t", "cl", "cd", "cm"):
            values = _list(history.get(name), f"{scenario.name} force_history.{name}")
            _require(len(values) >= 2, f"{scenario.name} force_history.{name} is too short")
            series.append([_finite(item, f"{scenario.name} force_history.{name} value") for item in values])
        _require(len({len(values) for values in series}) == 1, f"{scenario.name} force-history arrays differ in length")
        times = series[0]
        _require(all(right > left for left, right in zip(times, times[1:])), f"{scenario.name} force-history time is not strictly increasing")

        if point.get("unsteady") is False:
            required_span = (
                NO_SHEDDING_MIN_SLOW_PERIODS
                * scenario.chord_m
                / (NO_SHEDDING_SLOW_STROUHAL * scenario.speed_mps)
            )
            _require(times[-1] - times[0] + 1e-9 >= required_span, f"{scenario.name} flat wake was observed for less than {required_span:.6g}s")
            _require(point.get("frame_track") is None, f"{scenario.name} no-shedding result must not invent a frame track")
            frequency = history.get("shedding_freq_hz")
            point_strouhal = point.get("strouhal")
            _require(
                history.get("period_s") is None
                and history.get("retained_cycles") is None,
                f"{scenario.name} no-shedding result must not report a periodic window",
            )
            _require(
                frequency is None
                or _finite(frequency, f"{scenario.name} shedding frequency") == 0.0,
                f"{scenario.name} no-shedding result reported a nonzero shedding frequency",
            )
            _require(
                point_strouhal is None
                or _finite(point_strouhal, f"{scenario.name} Strouhal") == 0.0,
                f"{scenario.name} no-shedding result reported a nonzero Strouhal number",
            )
        else:
            frame_track = _mapping(point.get("frame_track"), f"{scenario.name} frame_track")
            _require(frame_track.get("stationary") is True, f"{scenario.name} periodic URANS window is not stationary")
            _require(_finite(frame_track.get("periods_retained"), f"{scenario.name} periods_retained") >= 3.0, f"{scenario.name} retained fewer than three periods")
            _require(MEDIA_FIELD in _list(frame_track.get("fields"), f"{scenario.name} frame fields"), f"{scenario.name} frame track lacks {MEDIA_FIELD}")
            _require(len(_list(frame_track.get("frames"), f"{scenario.name} frames")) >= 60, f"{scenario.name} has fewer than 20 frames per retained period")

    def _validate_evidence(
        self,
        point: dict[str, Any],
        scenario: Scenario,
        expected_aoa_deg: float,
    ) -> dict[str, object]:
        artifacts = _list(point.get("evidence_artifacts"), f"{scenario.name} evidence_artifacts")
        _require(artifacts, f"{scenario.name} has no evidence artifacts")
        for index, item in enumerate(artifacts):
            if isinstance(item, dict):
                self._validate_artifact_metadata(item, f"{scenario.name} artifact {index}")
                metadata = _mapping(item.get("metadata"), f"{scenario.name} artifact {index} metadata")
                _require(metadata.get("engineNamespace") == ENGINE_NAMESPACE, f"{scenario.name} artifact {index} engine namespace is wrong")
                _require(metadata.get("methodKey") == scenario.method_key, f"{scenario.name} artifact {index} method is wrong")

        manifest_artifact = self._artifact(artifacts, "manifest", lambda a: a.get("kind") == "manifest")
        bundle_artifact = self._artifact(artifacts, "engine bundle", lambda a: a.get("kind") == "engine_bundle")
        storage_binding = self._validate_remote_engine_bundle(
            bundle_artifact,
            f"{scenario.name} engine bundle",
        )
        mesh_artifact = self._artifact(
            artifacts,
            "mesh",
            lambda a: a.get("kind") == "mesh"
            and a.get("role") == "mesh"
            and "/constant/polyMesh/" in str(a.get("path", "")),
        )
        force_artifact = self._artifact(
            artifacts,
            "force coefficients",
            lambda a: a.get("kind") == "force_coefficients"
            and a.get("role") == "force_coefficients"
            and str(a.get("path", "")).endswith("/coefficient.dat"),
        )
        vtk_artifact = self._artifact(
            artifacts,
            "VTK window",
            lambda a: a.get("kind") == "vtk_window"
            and a.get("role") == "vtk_window"
            and str(a.get("path", "")).lower().endswith((".vtu", ".vtk", ".vtp")),
        )
        yplus_artifact = self._artifact(
            artifacts,
            "y+",
            lambda a: a.get("kind") == "field_data" and a.get("role") == "y_plus",
        )
        dictionary_artifact = self._artifact(
            artifacts,
            "dictionary",
            lambda a: a.get("kind") == "dictionary" and a.get("role") == "dictionary",
        )
        solver_log_artifact = self._artifact(
            artifacts,
            "solver log",
            lambda a: a.get("kind") == "log"
            and a.get("role") == "log"
            and (
                (scenario.method_key == "openfoam.rans" and "simpleFoam" in str(a.get("path", "")))
                or (scenario.method_key == "openfoam.urans" and "pimpleFoam" in str(a.get("path", "")))
            ),
        )

        manifest_raw = self._fetch_artifact(manifest_artifact, f"{scenario.name} evidence manifest")
        self._verify_large_artifact(bundle_artifact, f"{scenario.name} engine bundle")
        self._fetch_artifact(mesh_artifact, f"{scenario.name} mesh evidence")
        force_raw = self._fetch_artifact(force_artifact, f"{scenario.name} force evidence")
        vtk_raw = self._fetch_artifact(vtk_artifact, f"{scenario.name} VTK evidence")
        yplus_raw = self._fetch_artifact(yplus_artifact, f"{scenario.name} y+ evidence")
        dictionary_raw = self._fetch_artifact(dictionary_artifact, f"{scenario.name} dictionary evidence")
        solver_log_raw = self._fetch_artifact(solver_log_artifact, f"{scenario.name} solver log evidence")
        _require(b"Cl" in force_raw and b"Cd" in force_raw, f"{scenario.name} force evidence lacks coefficient columns")
        _require(b"VTKFile" in vtk_raw[:4096], f"{scenario.name} VTK evidence is not a VTK XML file")
        _require(b"Time" in yplus_raw and b"\n" in yplus_raw, f"{scenario.name} y+ evidence lacks function-object rows")
        _require(b"FoamFile" in dictionary_raw, f"{scenario.name} dictionary evidence is not an OpenFOAM dictionary")
        expected_solver = b"simpleFoam" if scenario.method_key == "openfoam.rans" else b"pimpleFoam"
        _require(expected_solver in solver_log_raw, f"{scenario.name} solver log does not identify {expected_solver.decode()}")
        if scenario.solver_processes > 1:
            _require(
                b"decomposePar -force" in solver_log_raw,
                f"{scenario.name} MPI log lacks the decomposePar execution record",
            )
            _require(
                b"reconstructPar -latestTime" in solver_log_raw,
                f"{scenario.name} MPI log lacks the reconstructPar execution record",
            )
        try:
            manifest = _mapping(json.loads(manifest_raw), f"{scenario.name} evidence manifest")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CanaryFailure(f"{scenario.name} evidence manifest is invalid JSON") from exc
        _require(manifest.get("schemaVersion") == 2, f"{scenario.name} evidence manifest schema changed")
        _require(manifest.get("engine") == self.runtime, f"{scenario.name} manifest runtime differs from worker runtime")
        _require(manifest.get("engineNamespace") == ENGINE_NAMESPACE, f"{scenario.name} manifest engine namespace is wrong")
        _require(manifest.get("methodKey") == scenario.method_key, f"{scenario.name} manifest method is wrong")
        _require(_finite(manifest.get("aoaDeg"), f"{scenario.name} manifest AoA") == expected_aoa_deg, f"{scenario.name} manifest AoA is wrong")
        _require(manifest.get("unsteady") is point.get("unsteady"), f"{scenario.name} manifest unsteady flag differs from point")

        (
            bundled_member_count,
            manifest_member_association_count,
            manifest_member_set_sha256,
        ) = (
            _manifest_member_binding(
                manifest_raw, f"{scenario.name} evidence manifest"
            )
        )
        restore_match = REMOTE_RESTORE_PROOF.fullmatch(
            str(storage_binding["restore_verification"])
        )
        _require(
            restore_match is not None
            and int(restore_match.group(1)) == bundled_member_count,
            f"{scenario.name} remote restore proof did not cover the complete manifest member set",
        )
        bundle_metadata = _mapping(
            bundle_artifact.get("metadata"), f"{scenario.name} engine bundle metadata"
        )
        _require(
            bundle_metadata.get("bundledFileCount") == bundled_member_count,
            f"{scenario.name} bundled file count differs from its manifest",
        )
        case_slug = point.get("case_slug")
        evidence_base = bundle_metadata.get("evidenceBase")
        for value, value_label in (
            (case_slug, "case slug"),
            (evidence_base, "evidence base"),
        ):
            _require(
                isinstance(value, str)
                and bool(value)
                and not value.startswith("/")
                and "\\" not in value
                and all(part not in {"", ".", ".."} for part in value.split("/")),
                f"{scenario.name} {value_label} is unsafe",
            )

        manifest_files = _list(manifest.get("files"), f"{scenario.name} manifest files")
        roles = {item.get("role") for item in manifest_files if isinstance(item, dict)}
        _require(
            {"mesh", "force_coefficients", "vtk_window", "y_plus", "dictionary", "log"}.issubset(roles),
            f"{scenario.name} manifest omits required evidence roles",
        )
        media = _mapping(manifest.get("media"), f"{scenario.name} manifest media")
        _require(media.get("requestedFields") == [MEDIA_FIELD], f"{scenario.name} manifest requested fields are wrong")
        expected_roles = ["instantaneous", "mean", "video"] if point.get("unsteady") is True else ["instantaneous"]
        _require(media.get("expectedRoles") == expected_roles, f"{scenario.name} manifest media roles are wrong")
        unavailable = _mapping(media.get("unavailable"), f"{scenario.name} manifest unavailable media")
        _require(not unavailable, f"{scenario.name} has unavailable requested media: {unavailable!r}")
        role_keys = {"instantaneous": "images", "mean": "mean_images", "video": "video"}
        for role in expected_roles:
            manifest_map = _mapping(media.get(role), f"{scenario.name} manifest media.{role}")
            point_map = _mapping(point.get(role_keys[role]), f"{scenario.name} point {role_keys[role]}")
            _require(MEDIA_FIELD in manifest_map and MEDIA_FIELD in point_map, f"{scenario.name} lacks stored {role} media")
            self._fetch_media(
                point_map[MEDIA_FIELD],
                f"{scenario.name} {role} {MEDIA_FIELD}",
                "video" if role == "video" else "image",
            )

        return {
            "case_slug": case_slug,
            "evidence_base": evidence_base,
            "bundled_member_count": bundled_member_count,
            "manifest_member_association_count": (
                manifest_member_association_count
            ),
            "manifest_member_set_sha256": manifest_member_set_sha256,
            "artifacts": sorted(
                [
                {
                    "kind": item.get("kind"),
                    "path": item.get("path"),
                    "role": item.get("role"),
                    "field": item.get("field"),
                    "sha256": item.get("sha256"),
                    "byte_size": item.get("byte_size"),
                    "storage": dict(storage_binding),
                }
                    for item in artifacts
                    if isinstance(item, dict)
                ],
                key=lambda item: (
                    str(item.get("kind") or ""),
                    str(item.get("path") or ""),
                    str(item.get("role") or ""),
                    str(item.get("field") or ""),
                ),
            ),
        }

    def _remote_render_target(
        self,
        point: dict[str, Any],
        scenario: Scenario,
    ) -> tuple[str, str]:
        case_slug = point.get("case_slug")
        _require(
            isinstance(case_slug, str)
            and bool(case_slug)
            and not case_slug.startswith("/")
            and ".." not in case_slug.split("/"),
            f"{scenario.name} case slug is unsafe",
        )
        artifacts = _list(
            point.get("evidence_artifacts"),
            f"{scenario.name} render evidence_artifacts",
        )
        bundle = self._artifact(
            artifacts,
            "engine bundle",
            lambda item: item.get("kind") == "engine_bundle",
        )
        metadata = _mapping(
            bundle.get("metadata"), f"{scenario.name} engine bundle metadata"
        )
        evidence_base = metadata.get("evidenceBase")
        _require(
            isinstance(evidence_base, str)
            and bool(evidence_base)
            and not evidence_base.startswith("/")
            and ".." not in evidence_base.split("/"),
            f"{scenario.name} evidence base is unsafe",
        )
        return case_slug, evidence_base

    def _verify_remote_render(
        self,
        job_id: str,
        point: dict[str, Any],
        scenario: Scenario,
        *,
        strip_before_render: bool,
        prior_strip_bytes_freed: int | None = None,
    ) -> dict[str, Any]:
        if strip_before_render:
            strip = self.client.json(
                "POST",
                f"/jobs/{job_id}/strip",
                payload={"keep_case_state": False},
                expected_status={200},
                request_timeout_s=self.config.render_timeout_s,
            )
            _require(strip.get("job_id") == job_id, f"{scenario.name} strip targeted the wrong job")
            _require(strip.get("kept_case_state") is False, f"{scenario.name} strip retained live case state")
            _require(strip.get("no_op") is False, f"{scenario.name} full strip was unexpectedly a no-op")
            _require(
                isinstance(strip.get("bytes_freed"), int) and strip["bytes_freed"] > 0,
                f"{scenario.name} full strip did not remove live solver/VTK bytes",
            )
            _require(
                strip.get("unknown_entries_count") == 0
                and strip.get("unknown_entries") == [],
                f"{scenario.name} full strip left unknown entries: {strip.get('unknown_entries')!r}",
            )
            strip_bytes_freed = strip["bytes_freed"]
        else:
            _require(
                isinstance(prior_strip_bytes_freed, int)
                and prior_strip_bytes_freed > 0,
                f"{scenario.name} retained receipt lacks its original strip proof",
            )
            strip_bytes_freed = prior_strip_bytes_freed
        case_slug, evidence_base = self._remote_render_target(point, scenario)
        common: dict[str, object] = {
            "case_slug": case_slug,
            "evidence_base": evidence_base,
            "airfoil_points": self.airfoil_points,
            "chord": scenario.chord_m,
            "speed": scenario.speed_mps,
        }
        extents = self.client.json(
            "POST",
            f"/jobs/{job_id}/field-extents",
            payload={**common, "fields": [MEDIA_FIELD], "max_frames": 16},
            expected_status={200},
            request_timeout_s=self.config.render_timeout_s,
        )
        fields = _mapping(extents.get("fields"), f"{scenario.name} remote field extents")
        scale = _mapping(fields.get(MEDIA_FIELD), f"{scenario.name} {MEDIA_FIELD} extents")
        vmin = _finite(scale.get("min"), f"{scenario.name} remote extent min")
        vmax = _finite(scale.get("max"), f"{scenario.name} remote extent max")
        finite_count = scale.get("finite_count")
        _require(
            isinstance(finite_count, int) and finite_count > 0 and vmax >= vmin,
            f"{scenario.name} remote field extents are empty or inverted",
        )
        if vmax == vmin:
            vmax = vmin + max(abs(vmin) * 1.0e-9, 1.0e-9)

        custom = self.client.json(
            "POST",
            f"/jobs/{job_id}/render-field",
            payload={
                **common,
                "field": MEDIA_FIELD,
                "role": "instantaneous",
                "vmin": vmin,
                "vmax": vmax,
                "params_hash": f"canary-gcs-{scenario.name}",
            },
            expected_status={200},
            request_timeout_s=self.config.render_timeout_s,
        )
        custom_png = self._fetch_artifact(custom, f"{scenario.name} remote custom render")
        _require(custom_png.startswith(b"\x89PNG\r\n\x1a\n"), f"{scenario.name} remote custom render is not PNG")

        defaults = self.client.json(
            "POST",
            f"/jobs/{job_id}/render-default-media",
            payload={
                **common,
                "fields": [MEDIA_FIELD],
                "scales": {MEDIA_FIELD: {"vmin": vmin, "vmax": vmax}},
                "unsteady": False,
                "scale_version": 1,
                "render_profile_key": "canary:gcs-restore",
            },
            expected_status={200},
            request_timeout_s=self.config.render_timeout_s,
        )
        images = _list(defaults.get("images"), f"{scenario.name} default remote images")
        _require(len(images) == 1, f"{scenario.name} default remote render did not persist one image")
        default_image = _mapping(images[0], f"{scenario.name} default remote image")
        _require(default_image.get("field") == MEDIA_FIELD, f"{scenario.name} default remote image field is wrong")
        default_png = self._fetch_artifact(
            default_image, f"{scenario.name} default remote render"
        )
        _require(default_png.startswith(b"\x89PNG\r\n\x1a\n"), f"{scenario.name} default remote render is not PNG")
        return {
            "strip_bytes_freed": strip_bytes_freed,
            "field": MEDIA_FIELD,
            "finite_count": finite_count,
            "vmin": vmin,
            "vmax": vmax,
            "custom_sha256": custom["sha256"],
            "default_sha256": default_image["sha256"],
        }

    def _validate_result(
        self,
        result: dict[str, Any],
        status: dict[str, Any],
        scenario: Scenario,
        job_id: str,
        *,
        strip_before_render: bool = True,
        prior_strip_bytes_freed: int | None = None,
    ) -> dict[str, Any]:
        _require(result.get("job_id") == job_id, f"{scenario.name} result returned a different job id")
        _require(result.get("state") == "completed", f"{scenario.name} result is not completed")
        self._validate_routing(result, f"{scenario.name} result", runtime_required=True)
        _require(result.get("method_keys") == [scenario.method_key], f"{scenario.name} result methods are {result.get('method_keys')!r}")
        self._validate_scheduling(status.get("scheduling"), scenario, f"{scenario.name} status scheduling")
        self._validate_scheduling(result.get("scheduling"), scenario, f"{scenario.name} result scheduling")

        polars = _list(result.get("polars"), f"{scenario.name} polars")
        _require(len(polars) == 1, f"{scenario.name} must produce exactly one polar")
        polar = _mapping(polars[0], f"{scenario.name} polar")
        _require(len(_list(polar.get("attempts"), f"{scenario.name} attempts")) == 0, f"{scenario.name} produced rejected attempts")
        raw_points = _list(polar.get("points"), f"{scenario.name} points")
        _require(len(raw_points) == len(scenario.aoa_degs), f"{scenario.name} did not produce every requested accepted point")
        points_by_aoa: dict[float, dict[str, Any]] = {}
        for index, raw_point in enumerate(raw_points):
            point = _mapping(raw_point, f"{scenario.name} point {index}")
            aoa_deg = _finite(point.get("aoa_deg"), f"{scenario.name} point {index} AoA")
            _require(aoa_deg not in points_by_aoa, f"{scenario.name} returned duplicate AoA {aoa_deg}")
            points_by_aoa[aoa_deg] = point
        _require(set(points_by_aoa) == set(scenario.aoa_degs), f"{scenario.name} returned the wrong AoA set")

        receipt_points: list[dict[str, Any]] = []
        for expected_aoa_deg in scenario.aoa_degs:
            point = points_by_aoa[expected_aoa_deg]
            self._validate_runtime(point.get("engine"), f"{scenario.name} point.engine")
            _require(point.get("method_key") == scenario.method_key, f"{scenario.name} point method is wrong")
            _require(point.get("fidelity") == scenario.fidelity, f"{scenario.name} point fidelity is wrong")
            _require(point.get("failure_disposition") in {None, "none"}, f"{scenario.name} point has a failure disposition")
            _require(point.get("error") is None, f"{scenario.name} point error: {point.get('error')}")
            _require(point.get("converged") is True, f"{scenario.name} point did not converge")
            _require(isinstance(point.get("n_cells"), int) and point["n_cells"] > 0, f"{scenario.name} point has no mesh cell count")
            y_plus_avg = _finite(point.get("y_plus_avg"), f"{scenario.name} y_plus_avg")
            y_plus_max = _finite(point.get("y_plus_max"), f"{scenario.name} y_plus_max")
            _require(0.0 <= y_plus_avg <= y_plus_max, f"{scenario.name} y+ summary is inconsistent")
            cl = _finite(point.get("cl"), f"{scenario.name} Cl")
            cd = _finite(point.get("cd"), f"{scenario.name} Cd")
            cm = _finite(point.get("cm"), f"{scenario.name} Cm")
            _require(-5.0 < cl < 5.0, f"{scenario.name} Cl is not physically sane: {cl}")
            _require(0.0 < cd < 5.0, f"{scenario.name} Cd is not physically sane: {cd}")
            _require(-5.0 < cm < 5.0, f"{scenario.name} Cm is not physically sane: {cm}")
            if scenario.force_transient:
                self._validate_force_history(point, scenario)
                _require(abs(cl) < 0.2, f"{scenario.name} symmetric zero-incidence Cl is unexpectedly large: {cl}")
            else:
                _require(point.get("unsteady") is False, f"{scenario.name} RANS point unexpectedly became unsteady")
                _require(point.get("force_history") is None, f"{scenario.name} RANS point invented a transient force history")
            evidence = self._validate_evidence(point, scenario, expected_aoa_deg)
            receipt_points.append(
                {
                    "aoa_deg": expected_aoa_deg,
                    "cl": cl,
                    "cd": cd,
                    "cm": cm,
                    "n_cells": point["n_cells"],
                    **evidence,
                }
            )

        strip_bytes_freed = prior_strip_bytes_freed
        for index, expected_aoa_deg in enumerate(scenario.aoa_degs):
            render_proof = self._verify_remote_render(
                job_id,
                points_by_aoa[expected_aoa_deg],
                scenario,
                strip_before_render=strip_before_render and index == 0,
                prior_strip_bytes_freed=strip_bytes_freed,
            )
            strip_bytes_freed = render_proof["strip_bytes_freed"]
            receipt_points[index]["remote_render_proof"] = render_proof

        scheduling = _mapping(result.get("scheduling"), f"{scenario.name} result scheduling")
        return {
            "runtime": dict(self.runtime or {}),
            "method_key": scenario.method_key,
            "fidelity": scenario.fidelity,
            "scheduling": {
                "solver_processes": scheduling.get("solver_processes"),
                "resolved_case_concurrency": scheduling.get("resolved_case_concurrency"),
                "mesh_build_count": scheduling.get("mesh_build_count"),
                "aoa_case_count": scheduling.get("aoa_case_count"),
                "mesh_reuse_mode": scheduling.get("mesh_reuse_mode"),
            },
            "points": receipt_points,
        }

    def _run_scenario(self, scenario: Scenario) -> dict[str, Any]:
        submission = self.client.json(
            "POST",
            "/polars",
            payload=self._payload(scenario),
            expected_status={202},
        )
        job_id = submission.get("job_id")
        _require(isinstance(job_id, str) and bool(re.fullmatch(r"[0-9A-Za-z-]{8,64}", job_id)), f"{scenario.name} returned an unsafe job id")
        self.active_jobs.add(job_id)
        status = self._wait(job_id, scenario, submission)
        result = self.client.json("GET", f"/jobs/{job_id}/result", expected_status={200})
        metrics = self._validate_result(result, status, scenario, job_id)
        return {"scenario": scenario.name, "job_id": job_id, **metrics}

    def _cancel_active(self) -> None:
        for job_id in sorted(self.active_jobs - self.terminal_jobs):
            try:
                response = self.client.json(
                    "POST", f"/jobs/{job_id}/cancel", payload={}, expected_status={200}
                )
                if response.get("cancelled") is not True:
                    print(f"warning: gateway did not confirm cancellation for {job_id}", file=sys.stderr)
            except Exception as exc:  # noqa: BLE001 - preserve the original canary failure
                print(f"warning: could not cancel canary job {job_id}: {exc}", file=sys.stderr)

    def verify_retained_receipt(self, value: object) -> dict[str, Any]:
        """Re-prove a retained receipt against the current live gateway.

        Recovery after an ambiguous attestation response must not merely
        replay static JSON.  This path performs no submissions and no strip;
        it rechecks the current worker, downloads every artifact (including
        each exact generation-bound archive), and reruns both field-extents
        and render operations from the already remote-only evidence.
        """

        receipt = _mapping(value, "retained canary receipt")
        expected_keys = {
            "schema_version",
            "status",
            "engine",
            "engine_handshake_key",
            "execution_pool",
            "runtime",
            "evidence_storage",
            "jobs",
        }
        _require(
            set(receipt) == expected_keys,
            "retained canary receipt has an unexpected or incomplete top-level shape",
        )
        _require(
            receipt.get("schema_version") == 1 and receipt.get("status") == "ok",
            "retained canary receipt is not a successful schema-v1 receipt",
        )
        _require(
            receipt.get("engine") == ENGINE
            and receipt.get("engine_handshake_key") == ENGINE_HANDSHAKE_KEY
            and receipt.get("execution_pool") == EXECUTION_POOL,
            "retained canary receipt identifies a different engine route",
        )
        _require(
            receipt.get("evidence_storage") == self._evidence_storage_contract(),
            "retained canary receipt evidence storage differs from the current bucket/prefix/Zstandard configuration",
        )

        preflight = self._preflight()
        _require(
            receipt.get("runtime") == preflight["runtime"],
            "retained canary receipt runtime differs from the current worker",
        )
        raw_jobs = _list(receipt.get("jobs"), "retained canary receipt jobs")
        jobs_by_scenario: dict[str, dict[str, Any]] = {}
        for raw_job in raw_jobs:
            job = _mapping(raw_job, "retained canary receipt job")
            scenario_name = job.get("scenario")
            _require(
                isinstance(scenario_name, str)
                and scenario_name not in jobs_by_scenario,
                "retained canary receipt has a missing or duplicate scenario",
            )
            jobs_by_scenario[scenario_name] = job
        scenarios = self._scenarios()
        _require(
            set(jobs_by_scenario) == {scenario.name for scenario in scenarios},
            "retained canary receipt does not contain the exact three production scenarios",
        )

        verified_jobs: list[dict[str, Any]] = []
        for scenario in scenarios:
            job = jobs_by_scenario[scenario.name]
            job_id = job.get("job_id")
            _require(
                isinstance(job_id, str)
                and bool(re.fullmatch(r"[0-9A-Za-z-]{8,64}", job_id)),
                f"retained {scenario.name} receipt has an unsafe job id",
            )
            prior_points = _list(
                job.get("points"), f"retained {scenario.name} points"
            )
            _require(
                len(prior_points) == len(scenario.aoa_degs),
                f"retained {scenario.name} has the wrong point count",
            )
            prior_first_point = _mapping(
                prior_points[0], f"retained {scenario.name} first point"
            )
            prior_proof = _mapping(
                prior_first_point.get("remote_render_proof"),
                f"retained {scenario.name} first-point remote render proof",
            )
            status = self.client.json(
                "GET", f"/jobs/{job_id}", expected_status={200}
            )
            _require(
                status.get("state") == "completed",
                f"retained {scenario.name} job is no longer completed",
            )
            result = self.client.json(
                "GET", f"/jobs/{job_id}/result", expected_status={200}
            )
            metrics = self._validate_result(
                result,
                status,
                scenario,
                job_id,
                strip_before_render=False,
                prior_strip_bytes_freed=prior_proof.get("strip_bytes_freed"),
            )
            measured = {"scenario": scenario.name, "job_id": job_id, **metrics}
            _require(
                measured == job,
                f"retained {scenario.name} receipt differs from the current generation-pinned hydration/render proof",
            )
            verified_jobs.append(measured)

        return {
            "schema_version": 1,
            "status": "verified",
            "engine_handshake_key": ENGINE_HANDSHAKE_KEY,
            "evidence_storage": self._evidence_storage_contract(),
            "job_ids": [job["job_id"] for job in verified_jobs],
        }

    def run(self) -> dict[str, Any]:
        try:
            preflight = self._preflight()
            jobs = [self._run_scenario(scenario) for scenario in self._scenarios()]
            return {
                "schema_version": 1,
                "status": "ok",
                "engine": dict(ENGINE),
                "engine_handshake_key": ENGINE_HANDSHAKE_KEY,
                "execution_pool": EXECUTION_POOL,
                "runtime": preflight["runtime"],
                "evidence_storage": self._evidence_storage_contract(),
                "jobs": jobs,
            }
        except BaseException:
            self._cancel_active()
            raise


def _default_coordinates_path() -> Path:
    return Path(__file__).resolve().parents[2] / "examples" / "naca0012.dat"


def _load_coordinates(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CanaryFailure(f"could not read NACA 0012 coordinates from {path}: {exc}") from exc
    lines = [line for line in text.splitlines() if line.strip()]
    _require(lines and lines[0].strip().upper() == "NACA0012", f"{path} is not the repository NACA0012 Selig file")
    _require(len(lines) >= 100, f"{path} does not contain the full NACA0012 coordinate set")
    return text


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default="http://127.0.0.1:8000")
    parser.add_argument("--coordinates", type=Path, default=_default_coordinates_path())
    parser.add_argument(
        "--expected-build-id",
        default=_normalise_optional(os.environ.get("AIRFOILFOAM_BUILD_ID")),
        help="required; defaults to AIRFOILFOAM_BUILD_ID",
    )
    parser.add_argument(
        "--expected-image-digest",
        default=_normalise_optional(os.environ.get("OPENCFD2606_IMAGE_DIGEST")),
        help="optional final worker-image digest; defaults to OPENCFD2606_IMAGE_DIGEST",
    )
    parser.add_argument(
        "--expected-evidence-bucket",
        default=_normalise_optional(os.environ.get("AIRFOILFOAM_EVIDENCE_BUCKET")),
        help="required GCS evidence bucket; defaults to AIRFOILFOAM_EVIDENCE_BUCKET",
    )
    parser.add_argument(
        "--expected-evidence-object-prefix",
        default=_normalise_optional(
            os.environ.get("AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX")
        ),
        help="required content-addressed GCS prefix; defaults to AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX",
    )
    parser.add_argument(
        "--expected-evidence-zstd-level",
        type=int,
        default=_normalise_optional(os.environ.get("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL")),
        help="required Zstandard level; defaults to AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL",
    )
    parser.add_argument(
        "--verify-receipt",
        type=Path,
        help="re-prove an existing receipt without submitting or stripping new jobs",
    )
    parser.add_argument("--expected-source-revision", default=SOURCE_REVISION)
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
    if not args.expected_evidence_bucket:
        parser.error(
            "--expected-evidence-bucket or AIRFOILFOAM_EVIDENCE_BUCKET is required"
        )
    if not args.expected_evidence_object_prefix:
        parser.error(
            "--expected-evidence-object-prefix or AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX is required"
        )
    if args.expected_evidence_zstd_level is None:
        parser.error(
            "--expected-evidence-zstd-level or AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL is required"
        )
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
        config = CanaryConfig(
            gateway_url=args.gateway_url,
            coordinates=_load_coordinates(args.coordinates),
            expected_build_id=args.expected_build_id,
            expected_evidence_bucket=args.expected_evidence_bucket,
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
        runner = OpenCfd2606Canary(config)
        if args.verify_receipt is None:
            summary = runner.run()
        else:
            try:
                receipt = json.loads(args.verify_receipt.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise CanaryFailure(
                    f"could not read retained canary receipt {args.verify_receipt}: {exc}"
                ) from exc
            summary = runner.verify_retained_receipt(receipt)
    except (CanaryFailure, KeyboardInterrupt, ValueError) as exc:
        print(f"OpenCFD 2606 canary failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
