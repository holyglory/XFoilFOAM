"""Production OpenCFD 2606 canary contract, exercised over real HTTP."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import sys
import threading
from typing import Any, Iterator

import pytest


ROOT = Path(__file__).resolve().parents[1]
CANARY_PATH = ROOT / "scripts" / "deploy" / "openfoam_2606_canary.py"
SPEC = importlib.util.spec_from_file_location("openfoam_2606_canary", CANARY_PATH)
assert SPEC is not None and SPEC.loader is not None
canary = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = canary
SPEC.loader.exec_module(canary)

VOLUME_CANARY_PATH = (
    ROOT / "scripts" / "deploy" / "openfoam_2606_volume_canary.py"
)
VOLUME_SPEC = importlib.util.spec_from_file_location(
    "openfoam_2606_volume_canary_test", VOLUME_CANARY_PATH
)
assert VOLUME_SPEC is not None and VOLUME_SPEC.loader is not None
volume_canary = importlib.util.module_from_spec(VOLUME_SPEC)
sys.modules[VOLUME_SPEC.name] = volume_canary
VOLUME_SPEC.loader.exec_module(volume_canary)

VOLUME_CANARY_MODES = frozenset({"volume-ok", "volume-gcs-leak"})


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class FakeGatewayState:
    def __init__(self, *, mode: str = "ok") -> None:
        self.mode = mode
        self.runtime = {
            **canary.ENGINE,
            "build_id": "build-openfoam-2606-test",
            "source_revision": canary.SOURCE_REVISION,
            "image_digest": "sha256:" + "d" * 64,
            "application_source_sha256": "a" * 64,
            "package_sha256": canary.OFFICIAL_PACKAGE_SHA256_BY_ARCH["x86_64"],
            "binary_sha256": "c" * 64,
            "architecture": "x86_64",
        }
        self.submissions: dict[str, dict[str, Any]] = {}
        self.assets: dict[str, tuple[bytes, str]] = {}
        self.cancelled: list[str] = []
        self.stripped: list[str] = []
        self.remote_render_calls: list[tuple[str, str, str, str]] = []

    def health(self) -> dict[str, Any]:
        if self.mode in VOLUME_CANARY_MODES:
            evidence_storage = {
                "backend": "volume",
                "bucket": None,
                "object_prefix": "solver-evidence/v1",
                "archive_format": "tar+zstd",
                "compression": "zstd",
                "zstd_level": 10,
                "remote_only": False,
            }
        else:
            evidence_storage = {
                "backend": "gcs",
                "bucket": "airfoils-pro-storage-bucket",
                "object_prefix": "solver-evidence/v1",
                "archive_format": "tar+zstd",
                "compression": "zstd",
                "zstd_level": 10,
                "remote_only": True,
            }
        return {
            "status": "ok",
            "role": "solver_gateway",
            "version": "0.1.0",
            "build_id": self.runtime["build_id"],
            "mesh_recovery_version": 2,
            "default_engine": dict(canary.ENGINE),
            "supported_engines": [dict(canary.ENGINE)],
            "registered_disabled_engines": [],
            "evidence_storage": evidence_storage,
        }

    def capabilities(self) -> dict[str, Any]:
        return {
            "openfoam_image": canary.BASE_IMAGE,
            "default_engine": dict(canary.ENGINE),
            "supported_engines": [dict(canary.ENGINE)],
            "registered_disabled_engines": [],
            "engines": [
                {
                    "engine": dict(canary.ENGINE),
                    "routing_key": canary.EXECUTION_POOL,
                    "analysis_methods": ["rans", "urans"],
                    "steady": True,
                    "transient": True,
                    "volume_fields": True,
                    "mesh_evidence": True,
                    "stored_media": True,
                    "custom_field_rendering": True,
                }
            ],
        }

    def queue(self) -> dict[str, Any]:
        return {
            "queue_enabled": {canary.EXECUTION_POOL: True},
            "queues": [
                {
                    "routing_key": canary.EXECUTION_POOL,
                    "enabled": True,
                    "depth": 0,
                    "engine": dict(canary.ENGINE),
                }
            ],
            "worker_queues": [
                {
                    "worker": "worker@openfoam-2606",
                    "queues": [canary.EXECUTION_POOL],
                    "execution_pool": canary.EXECUTION_POOL,
                    "engine": dict(self.runtime),
                }
            ],
            "worker_queues_error": None,
            "worker_runtime_error": None,
            "inspection_errors": {},
        }

    def submit(self, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        job_id = f"canary-job-{len(self.submissions) + 1}"
        self.submissions[job_id] = payload
        return job_id, {
            "job_id": job_id,
            "state": "pending",
            "phase": "pending",
            "requested_engine": dict(canary.ENGINE),
            "requested_execution_pool": canary.EXECUTION_POOL,
            "engine": None,
            "execution_pool": None,
            "mesh_recovery_version": None,
        }

    def scheduling(self, request: dict[str, Any]) -> dict[str, Any]:
        ranks = request["resources"]["solver_processes"]
        return {
            "requested_policy": "exclusive",
            "resolved_policy": "exclusive",
            "worker_cpu_budget": 8,
            "resolved_cpu_budget": ranks,
            "resolved_case_concurrency": 1,
            "solver_processes": ranks,
            "mesh_build_count": (
                2
                if self.mode == "mesh-rebuilt" and len(request["aoa"]["angles"]) > 1
                else 1
            ),
            "aoa_case_count": len(request["aoa"]["angles"]),
            "mesh_reuse_mode": "symlink",
            "queue_depth": 0,
        }

    def status(self, job_id: str) -> dict[str, Any]:
        request = self.submissions[job_id]
        case_count = len(request["aoa"]["angles"])
        if self.mode == "stale-runtime":
            stale = {**self.runtime, "version": "2406"}
            return {
                "job_id": job_id,
                "state": "running",
                "phase": "solving_rans",
                "total_cases": case_count,
                "completed_cases": 0,
                "requested_engine": dict(canary.ENGINE),
                "requested_execution_pool": canary.EXECUTION_POOL,
                "engine": stale,
                "execution_pool": canary.EXECUTION_POOL,
                "mesh_recovery_version": 2,
                "scheduling": self.scheduling(request),
            }
        return {
            "job_id": job_id,
            "state": "completed",
            "phase": "completed",
            "total_cases": case_count,
            "completed_cases": case_count,
            "requested_engine": dict(canary.ENGINE),
            "requested_execution_pool": canary.EXECUTION_POOL,
            "engine": dict(self.runtime),
            "execution_pool": canary.EXECUTION_POOL,
            "mesh_recovery_version": 2,
            "scheduling": self.scheduling(request),
        }

    def _asset(self, url: str, payload: bytes, content_type: str) -> dict[str, Any]:
        self.assets[url] = (payload, content_type)
        return {
            "url": url,
            "mime_type": content_type,
            "sha256": _sha(payload),
            "byte_size": len(payload),
        }

    def result(self, job_id: str) -> dict[str, Any]:
        request = self.submissions[job_id]
        forced = request["solver"]["force_transient"]
        method = "openfoam.urans" if forced else "openfoam.rans"
        fidelity = "urans_precalc" if forced else "rans"
        aoas = request["aoa"]["angles"]
        aoa = aoas[0]
        chord = request["chord_lengths"][0]
        speed = request["speeds"][0]
        base = f"/jobs/{job_id}/files/cases/canary"

        mesh_bytes = b"FoamFile\n(0 0 0)\n"
        force_bytes = b"# Time Cd Cl CmPitch\n0 0.0100 0.0001 0.0\n1 0.0101 0.0002 0.0\n"
        vtk_bytes = b'<?xml version="1.0"?><VTKFile type="UnstructuredGrid"></VTKFile>'
        bundle_bytes = b"fake-engine-bundle"
        image_bytes = b"\x89PNG\r\n\x1a\nreal-canary-media"
        yplus_bytes = b"# yPlus function-object output\n# Time patch min max average\n1 airfoil 0.2 2.0 0.8\n"
        dictionary_bytes = b"FoamFile\n{ version 2.0; class dictionary; object controlDict; }\n"
        solver_name = "pimpleFoam" if forced else "simpleFoam"
        mpi_lines = (
            "Exec: decomposePar -force\nExec: reconstructPar -latestTime\n"
            if request["resources"]["solver_processes"] > 1
            and self.mode != "missing-mpi-command-records"
            else ""
        )
        solver_log_bytes = f"OpenFOAM 2606\nExec: {solver_name}\n{mpi_lines}End\n".encode()

        mesh_url = f"{base}/evidence/openfoam/constant/polyMesh/points"
        force_url = f"{base}/evidence/openfoam/postProcessing/forceCoeffs1/1/coefficient.dat"
        vtk_url = f"{base}/evidence/VTK/canary_1.vtu"
        bundle_url = f"{base}/evidence/engine_evidence.tar.zst"
        media_url = f"{base}/images/velocity_magnitude.png"
        yplus_url = f"{base}/evidence/openfoam/postProcessing/yPlus/1/yPlus.dat"
        dictionary_url = f"{base}/evidence/openfoam/system/controlDict"
        solver_log_url = f"{base}/evidence/openfoam/logs/canary/log.{solver_name}"
        mesh_meta = self._asset(mesh_url, mesh_bytes, "application/octet-stream")
        force_meta = self._asset(force_url, force_bytes, "text/plain")
        vtk_meta = self._asset(vtk_url, vtk_bytes, "application/vnd.vtk")
        bundle_meta = self._asset(bundle_url, bundle_bytes, "application/zstd")
        self._asset(media_url, image_bytes, "image/png")
        yplus_meta = self._asset(yplus_url, yplus_bytes, "text/plain")
        dictionary_meta = self._asset(dictionary_url, dictionary_bytes, "application/octet-stream")
        solver_log_meta = self._asset(solver_log_url, solver_log_bytes, "text/plain")
        if self.mode == "corrupt-bundle":
            self.assets[bundle_url] = (b"evil-engine-bundle", "application/zstd")

        manifest = {
            "schemaVersion": 2,
            "engine": dict(self.runtime),
            "engineNamespace": canary.ENGINE_NAMESPACE,
            "methodKey": method,
            "casePath": "/data/fake/case",
            "postPath": "/data/fake/case/transient" if forced else "/data/fake/case",
            "aoaDeg": aoa,
            "speedMps": speed,
            "chordM": chord,
            "unsteady": False,
            "media": {
                "requestedFields": [canary.MEDIA_FIELD],
                "expectedRoles": ["instantaneous"],
                "instantaneous": {canary.MEDIA_FIELD: "images/velocity_magnitude.png"},
                "mean": {},
                "video": {},
                "unavailable": {},
            },
            "bundleExcludes": [],
            "files": [
                {
                    "path": "openfoam/constant/polyMesh/points",
                    "role": "mesh",
                    "sha256": _sha(mesh_bytes),
                    "byteSize": len(mesh_bytes),
                },
                {
                    "path": "openfoam/postProcessing/forceCoeffs1/1/coefficient.dat",
                    "role": "force_coefficients",
                    "sha256": _sha(force_bytes),
                    "byteSize": len(force_bytes),
                },
                {
                    "path": "VTK/canary_1.vtu",
                    "role": "vtk_window",
                    "sha256": _sha(vtk_bytes),
                    "byteSize": len(vtk_bytes),
                },
                {
                    "path": "openfoam/postProcessing/yPlus/1/yPlus.dat",
                    "role": "y_plus",
                    "sha256": _sha(yplus_bytes),
                    "byteSize": len(yplus_bytes),
                },
                {
                    "path": "openfoam/system/controlDict",
                    "role": "dictionary",
                    "sha256": _sha(dictionary_bytes),
                    "byteSize": len(dictionary_bytes),
                },
                {
                    "path": f"openfoam/logs/canary/log.{solver_name}",
                    "role": "log",
                    "sha256": _sha(solver_log_bytes),
                    "byteSize": len(solver_log_bytes),
                },
            ],
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
        manifest_url = f"{base}/evidence/evidence_manifest.json"
        manifest_meta = self._asset(manifest_url, manifest_bytes, "application/json")

        artifacts = [
            {
                "kind": "manifest",
                "path": "evidence/evidence_manifest.json",
                "role": "evidence",
                **manifest_meta,
            },
            {
                "kind": "engine_bundle",
                "path": "evidence/engine_evidence.tar.zst",
                "role": "evidence",
                **bundle_meta,
            },
            {
                "kind": "mesh",
                "path": "evidence/openfoam/constant/polyMesh/points",
                "role": "mesh",
                **mesh_meta,
            },
            {
                "kind": "force_coefficients",
                "path": "evidence/openfoam/postProcessing/forceCoeffs1/1/coefficient.dat",
                "role": "force_coefficients",
                **force_meta,
            },
            {
                "kind": "dictionary",
                "path": "evidence/openfoam/system/controlDict",
                "role": "dictionary",
                **dictionary_meta,
            },
            {
                "kind": "log",
                "path": f"evidence/openfoam/logs/canary/log.{solver_name}",
                "role": "log",
                **solver_log_meta,
            },
        ]
        if self.mode != "missing-yplus":
            artifacts.append(
                {
                    "kind": "field_data",
                    "path": "evidence/openfoam/postProcessing/yPlus/1/yPlus.dat",
                    "role": "y_plus",
                    **yplus_meta,
                }
            )
        if self.mode != "missing-vtk":
            artifacts.append(
                {
                    "kind": "vtk_window",
                    "path": "evidence/VTK/canary_1.vtu",
                    "role": "vtk_window",
                    **vtk_meta,
                }
            )
        for artifact in artifacts:
            artifact["metadata"] = {
                "engineNamespace": canary.ENGINE_NAMESPACE,
                "methodKey": method,
            }
        bundle_artifact = next(
            artifact for artifact in artifacts if artifact["kind"] == "engine_bundle"
        )
        bundle_artifact["metadata"].update(
            {
                "storageBackend": "gcs",
                "bucket": "airfoils-pro-storage-bucket",
                "objectKey": (
                    "solver-evidence/v1/sha256/"
                    f"{bundle_artifact['sha256'][:2]}/{bundle_artifact['sha256']}.tar.zst"
                ),
                "generation": "1752612345678901",
                "crc32c": "AAAAAA==",
                "archiveFormat": "tar+zstd",
                "compression": "zstd",
                "uncompressedTarSha256": _sha(b"fake-uncompressed-tar"),
                "uncompressedTarByteSize": 4096,
                "zstdLevel": 10,
                "verifiedAt": "2026-07-15T20:50:14+00:00",
                "pointerPath": "engine_evidence.remote.json",
                "localEvidenceDisposition": (
                    "remote-copy-plus-local-archive-pending-database-ack"
                ),
                "rawLocalEvidenceDisposition": "removed",
                "localArchiveRetainedUntilDatabaseAck": True,
                "bundledFileCount": 6,
                "remoteRestoreVerification": (
                    "archive+manifest+all-members-restore:6"
                ),
                "evidenceBase": "evidence",
            }
        )
        if self.mode in VOLUME_CANARY_MODES:
            bundle_artifact["metadata"] = {
                "engineNamespace": canary.ENGINE_NAMESPACE,
                "methodKey": method,
                "storageBackend": "volume",
                "archiveFormat": "tar+zstd",
                "compression": "zstd",
                "uncompressedTarSha256": _sha(b"fake-uncompressed-tar"),
                "uncompressedTarByteSize": 4096,
                "zstdLevel": 10,
                "localEvidenceDisposition": "volume",
                "bundledFileCount": 6,
                "evidenceBase": "evidence",
            }
            if self.mode == "volume-gcs-leak":
                bundle_artifact["metadata"]["bucket"] = (
                    "airfoils-pro-storage-bucket"
                )
        elif self.mode == "volume-bundle":
            bundle_artifact["metadata"]["storageBackend"] = "volume"
        elif self.mode == "local-cleanup-pending":
            bundle_artifact["metadata"]["rawLocalEvidenceDisposition"] = "retained"

        point = {
            "case_slug": "canary",
            "aoa_deg": aoa,
            "cl": 0.0002 if forced else 0.45,
            "cd": 0.0101,
            "cm": 0.0,
            "cl_cd": 0.02 if forced else 44.5,
            "unsteady": False,
            "converged": True,
            "n_cells": 7600,
            "y_plus_avg": 0.8,
            "y_plus_max": 2.0,
            "images": {canary.MEDIA_FIELD: media_url},
            "mean_images": {},
            "video": {},
            "force_history": (
                {
                    "t": [0.0, 0.02],
                    "cl": [0.0001, 0.0002],
                    "cd": [0.01, 0.0101],
                    "cm": [0.0, 0.0],
                }
                if forced
                else None
            ),
            "frame_track": None,
            "fidelity": fidelity,
            "quality_warnings": [],
            "evidence_artifacts": artifacts,
            "engine": dict(self.runtime),
            "method_key": method,
            "failure_disposition": "none",
            "error": None,
        }
        if forced and self.mode == "false-periodic-no-shedding":
            point["strouhal"] = 0.2
            point["force_history"].update(
                {
                    "shedding_freq_hz": 664.0,
                    "period_s": 1.0 / 664.0,
                    "retained_cycles": 3,
                }
            )
        points = [point]
        for index, extra_aoa in enumerate(aoas[1:], start=2):
            extra_point = json.loads(json.dumps(point))
            extra_point["case_slug"] = f"canary-{index}"
            extra_point["aoa_deg"] = extra_aoa
            extra_point["cl"] = 0.45 + 0.01 * index
            extra_manifest = {**manifest, "aoaDeg": extra_aoa}
            extra_manifest_bytes = json.dumps(extra_manifest, sort_keys=True).encode()
            extra_manifest_url = f"{base}/evidence/evidence_manifest-{index}.json"
            extra_manifest_meta = self._asset(
                extra_manifest_url,
                extra_manifest_bytes,
                "application/json",
            )
            for artifact in extra_point["evidence_artifacts"]:
                if artifact["kind"] == "manifest":
                    artifact.update(
                        {
                            "path": f"evidence/evidence_manifest-{index}.json",
                            **extra_manifest_meta,
                        }
                    )
            points.append(extra_point)
        return {
            "job_id": job_id,
            "state": "completed",
            "polars": [
                {
                    "speed": speed,
                    "chord": chord,
                    "reynolds": speed * chord / 1.5e-5,
                    "points": points,
                    "attempts": [],
                }
            ],
            "scheduling": self.scheduling(request),
            "requested_engine": dict(canary.ENGINE),
            "requested_execution_pool": canary.EXECUTION_POOL,
            "engine": dict(self.runtime),
            "execution_pool": canary.EXECUTION_POOL,
            "method_keys": [method],
            "mesh_recovery_version": 2,
        }


@contextmanager
def fake_gateway(*, mode: str = "ok") -> Iterator[tuple[FakeGatewayState, str]]:
    state = FakeGatewayState(mode=mode)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def send(self, status: int, payload: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            self.send(status, json.dumps(payload).encode(), "application/json")

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
            if self.path == "/health":
                self.send_json(200, state.health())
                return
            if self.path == "/capabilities":
                self.send_json(200, state.capabilities())
                return
            if self.path == "/queue":
                self.send_json(200, state.queue())
                return
            if self.path in state.assets:
                payload, content_type = state.assets[self.path]
                self.send(200, payload, content_type)
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)", self.path)
            if match and match.group(1) in state.submissions:
                self.send_json(200, state.status(match.group(1)))
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/result", self.path)
            if match and match.group(1) in state.submissions:
                self.send_json(200, state.result(match.group(1)))
                return
            self.send_json(404, {"detail": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw or b"{}")
            if self.path == "/polars":
                job_id, response = state.submit(payload)
                assert response["job_id"] == job_id
                self.send_json(202, response)
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/strip", self.path)
            if match and match.group(1) in state.submissions:
                job_id = match.group(1)
                assert payload == {"keep_case_state": False}
                state.stripped.append(job_id)
                self.send_json(
                    200,
                    {
                        "job_id": job_id,
                        "kept_case_state": False,
                        "bytes_freed": 8192,
                        "files_removed": 12,
                        "dirs_removed": 4,
                        "no_op": False,
                        "marker_path": f"/data/jobs/{job_id}/.stripped.json",
                        "unknown_entries_count": 0,
                        "unknown_entries": [],
                    },
                )
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/field-extents", self.path)
            if match and match.group(1) in state.submissions:
                job_id = match.group(1)
                assert job_id in state.stripped
                if state.mode in VOLUME_CANARY_MODES:
                    assert payload["source_mode"] == "archive"
                else:
                    assert "source_mode" not in payload
                state.remote_render_calls.append(
                    (
                        job_id,
                        "field-extents",
                        payload["case_slug"],
                        payload["evidence_base"],
                    )
                )
                self.send_json(
                    200,
                    {
                        "fields": {
                            canary.MEDIA_FIELD: {
                                "min": 0.0,
                                "max": float(payload["speed"]) * 1.25,
                                "finite_count": 1024,
                            }
                        },
                        "window_start": None,
                        "window_end": None,
                    },
                )
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/render-field", self.path)
            if match and match.group(1) in state.submissions:
                job_id = match.group(1)
                assert job_id in state.stripped
                if state.mode in VOLUME_CANARY_MODES:
                    assert payload["source_mode"] == "archive"
                else:
                    assert "source_mode" not in payload
                state.remote_render_calls.append(
                    (
                        job_id,
                        "render-field",
                        payload["case_slug"],
                        payload["evidence_base"],
                    )
                )
                png = b"\x89PNG\r\n\x1a\nremote-custom-render"
                url = (
                    f"/jobs/{job_id}/files/cases/{payload['case_slug']}/"
                    f"{payload['evidence_base']}/custom_renders/{payload['params_hash']}.png"
                )
                metadata = state._asset(url, png, "image/png")
                self.send_json(
                    200,
                    {
                        "kind": "image",
                        "field": canary.MEDIA_FIELD,
                        "role": "instantaneous",
                        "path": (
                            f"{payload['evidence_base']}/custom_renders/"
                            f"{payload['params_hash']}.png"
                        ),
                        **metadata,
                    },
                )
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/render-default-media", self.path)
            if match and match.group(1) in state.submissions:
                job_id = match.group(1)
                assert job_id in state.stripped
                if state.mode in VOLUME_CANARY_MODES:
                    assert payload["source_mode"] == "archive"
                else:
                    assert "source_mode" not in payload
                state.remote_render_calls.append(
                    (
                        job_id,
                        "render-default-media",
                        payload["case_slug"],
                        payload["evidence_base"],
                    )
                )
                png = b"\x89PNG\r\n\x1a\nremote-default-render"
                url = (
                    f"/jobs/{job_id}/files/cases/{payload['case_slug']}/"
                    f"{payload['evidence_base']}/scaled_media/canary.png"
                )
                metadata = state._asset(url, png, "image/png")
                self.send_json(
                    200,
                    {
                        "images": [
                            {
                                "kind": "image",
                                "field": canary.MEDIA_FIELD,
                                "role": "instantaneous",
                                "path": (
                                    f"{payload['evidence_base']}/scaled_media/canary.png"
                                ),
                                **metadata,
                            }
                        ],
                        "mean_images": [],
                        "videos": [],
                        "window_start": None,
                        "window_end": None,
                        "scale_version": 1,
                        "render_profile_key": "canary:gcs-restore",
                    },
                )
                return
            match = canary.re.fullmatch(r"/jobs/([^/]+)/cancel", self.path)
            if match and match.group(1) in state.submissions:
                state.cancelled.append(match.group(1))
                self.send_json(200, {"job_id": match.group(1), "cancelled": True})
                return
            self.send_json(404, {"detail": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _config(state: FakeGatewayState, url: str) -> Any:
    return canary.CanaryConfig(
        gateway_url=url,
        coordinates=(ROOT / "examples" / "naca0012.dat").read_text(),
        expected_build_id=state.runtime["build_id"],
        expected_evidence_bucket="airfoils-pro-storage-bucket",
        expected_evidence_object_prefix="solver-evidence/v1",
        expected_evidence_zstd_level=10,
        expected_image_digest=state.runtime["image_digest"],
        poll_interval_s=0.001,
        rans_timeout_s=1.0,
        urans_timeout_s=1.0,
        request_timeout_s=1.0,
    )


def _volume_config(state: FakeGatewayState, url: str) -> Any:
    return volume_canary._base.CanaryConfig(
        gateway_url=url,
        coordinates=(ROOT / "examples" / "naca0012.dat").read_text(),
        expected_build_id=state.runtime["build_id"],
        expected_evidence_bucket="",
        expected_evidence_object_prefix="solver-evidence/v1",
        expected_evidence_zstd_level=10,
        expected_image_digest=state.runtime["image_digest"],
        poll_interval_s=0.001,
        rans_timeout_s=1.0,
        urans_timeout_s=1.0,
        request_timeout_s=1.0,
    )


def test_canary_submits_all_three_exact_2606_workloads_and_checks_evidence():
    with fake_gateway() as (state, url):
        summary = canary.OpenCfd2606Canary(_config(state, url)).run()

    assert summary["status"] == "ok"
    assert summary["schema_version"] == 1
    assert summary["runtime"] == state.runtime
    assert summary["evidence_storage"] == {
        "backend": "gcs",
        "bucket": "airfoils-pro-storage-bucket",
        "object_prefix": "solver-evidence/v1",
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "zstd_level": 10,
        "local_disposition": "remote-only",
    }
    assert [job["scenario"] for job in summary["jobs"]] == [
        "serial-rans",
        "mpi-2-rans",
        "forced-urans-precalc-no-shedding",
    ]
    requests = list(state.submissions.values())
    assert len(requests) == 3
    assert [request["resources"]["solver_processes"] for request in requests] == [1, 2, 1]
    assert all(request["expected_engine"] == canary.ENGINE for request in requests)
    assert all(request["expected_execution_pool"] == canary.EXECUTION_POOL for request in requests)
    assert all(request["expected_mesh_recovery_version"] == 2 for request in requests)
    assert all(
        request["airfoil"]["coordinates"]
        == (ROOT / "examples" / "naca0012.dat").read_text()
        for request in requests
    )
    assert requests[0]["solver"]["force_transient"] is False
    assert requests[0]["solver"]["transient_fallback"] is False
    assert requests[0]["aoa"]["angles"] == [2.0, 5.0]
    assert summary["jobs"][0]["scheduling"]["mesh_build_count"] == 1
    assert len(summary["jobs"][0]["points"]) == 2
    assert all(
        point["artifacts"]
        and all(
            artifact["sha256"]
            and artifact["storage"]["bucket"]
            == "airfoils-pro-storage-bucket"
            and artifact["storage"]["object_key"].startswith(
                "solver-evidence/v1/sha256/"
            )
            and artifact["storage"]["generation"] == "1752612345678901"
            for artifact in point["artifacts"]
        )
        for job in summary["jobs"]
        for point in job["points"]
    )
    assert requests[1]["resources"]["cpu_budget"] == 2
    assert requests[2]["solver"] | {
        "force_transient": True,
        "urans_fidelity": "precalc",
        "urans_min_periods": 3,
    } == requests[2]["solver"]
    assert "budget_override_s" not in requests[2]
    assert state.cancelled == []
    assert state.stripped == ["canary-job-1", "canary-job-2", "canary-job-3"]
    assert state.remote_render_calls == [
        (job["job_id"], operation, point["case_slug"], point["evidence_base"])
        for job in summary["jobs"]
        for point in job["points"]
        for operation in (
            "field-extents",
            "render-field",
            "render-default-media",
        )
    ]
    assert all(
        point["remote_render_proof"]["strip_bytes_freed"] == 8192
        for job in summary["jobs"]
        for point in job["points"]
    )


def test_canary_ignores_unrelated_retained_old_contract_terminal_jobs():
    with fake_gateway() as (state, url):
        old_job_id = "old-contract-canary-job"
        state.submissions[old_job_id] = {"retained_old_contract": True}

        summary = canary.OpenCfd2606Canary(_config(state, url)).run()

    fresh_job_ids = {job["job_id"] for job in summary["jobs"]}
    assert old_job_id not in fresh_job_ids
    assert old_job_id in state.submissions
    assert old_job_id not in state.cancelled
    assert old_job_id not in state.stripped
    assert all(call[0] != old_job_id for call in state.remote_render_calls)


def test_retained_receipt_reproof_downloads_and_renders_without_new_jobs_or_strip():
    with fake_gateway() as (state, url):
        runner = canary.OpenCfd2606Canary(_config(state, url))
        receipt = runner.run()
        submissions = dict(state.submissions)
        stripped = list(state.stripped)
        prior_render_calls = list(state.remote_render_calls)

        verified = canary.OpenCfd2606Canary(_config(state, url)).verify_retained_receipt(
            receipt
        )

    assert verified["status"] == "verified"
    assert verified["evidence_storage"] == receipt["evidence_storage"]
    assert state.submissions == submissions
    assert state.stripped == stripped
    assert state.remote_render_calls == prior_render_calls + [
        (job["job_id"], operation, point["case_slug"], point["evidence_base"])
        for job in receipt["jobs"]
        for point in job["points"]
        for operation in (
            "field-extents",
            "render-field",
            "render-default-media",
        )
    ]


def test_volume_canary_uses_strict_local_archive_receipt_and_archive_only_rendering():
    with fake_gateway(mode="volume-ok") as (state, url):
        summary = volume_canary.OpenCfd2606VolumeCanary(
            _volume_config(state, url)
        ).run()

    assert summary["status"] == "ok"
    assert summary["attestation_profile"] == "hz-solver2-volume-v1"
    assert summary["evidence_storage"] == {
        "backend": "volume",
        "bucket": None,
        "object_prefix": "solver-evidence/v1",
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "zstd_level": 10,
        "local_disposition": "volume",
    }
    assert [job["scenario"] for job in summary["jobs"]] == [
        "serial-rans",
        "mpi-2-rans",
        "forced-urans-precalc-no-shedding",
    ]
    assert all(
        "volume_restore_proof" in job and "remote_render_proof" not in job
        for job in summary["jobs"]
    )
    assert all(
        "volume_restore_proof" in point and "remote_render_proof" not in point
        for job in summary["jobs"]
        for point in job["points"]
    )
    assert all(
        job["volume_restore_proof"] == job["points"][0]["volume_restore_proof"]
        for job in summary["jobs"]
    )
    expected_binding_keys = {
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
    bindings = [
        artifact["storage"]
        for job in summary["jobs"]
        for point in job["points"]
        for artifact in point["artifacts"]
    ]
    assert bindings
    assert all(set(binding) == expected_binding_keys for binding in bindings)
    assert all(
        binding["backend"] == "volume"
        and binding["local_disposition"] == "volume"
        and binding["stored_sha256"]
        and binding["stored_byte_size"] > 0
        and binding["uncompressed_tar_sha256"]
        and binding["uncompressed_tar_byte_size"] > 0
        for binding in bindings
    )
    assert state.stripped == ["canary-job-1", "canary-job-2", "canary-job-3"]
    assert state.remote_render_calls == [
        (job["job_id"], operation, point["case_slug"], point["evidence_base"])
        for job in summary["jobs"]
        for point in job["points"]
        for operation in (
            "field-extents",
            "render-field",
            "render-default-media",
        )
    ]


def test_volume_retained_receipt_reproof_has_no_submission_or_strip_side_effects():
    with fake_gateway(mode="volume-ok") as (state, url):
        config = _volume_config(state, url)
        receipt = volume_canary.OpenCfd2606VolumeCanary(config).run()
        submissions = dict(state.submissions)
        stripped = list(state.stripped)
        prior_render_calls = list(state.remote_render_calls)

        verified = volume_canary.OpenCfd2606VolumeCanary(
            config
        ).verify_retained_receipt(receipt)

    assert verified == {
        "schema_version": 1,
        "status": "verified",
        "engine_handshake_key": canary.ENGINE_HANDSHAKE_KEY,
        "evidence_storage": receipt["evidence_storage"],
        "job_ids": ["canary-job-1", "canary-job-2", "canary-job-3"],
        "attestation_profile": "hz-solver2-volume-v1",
    }
    assert state.submissions == submissions
    assert state.stripped == stripped
    assert state.remote_render_calls == prior_render_calls + [
        (job["job_id"], operation, point["case_slug"], point["evidence_base"])
        for job in receipt["jobs"]
        for point in job["points"]
        for operation in (
            "field-extents",
            "render-field",
            "render-default-media",
        )
    ]


def test_volume_retained_receipt_reproof_rejects_job_point_proof_drift_before_reads():
    with fake_gateway(mode="volume-ok") as (state, url):
        config = _volume_config(state, url)
        receipt = volume_canary.OpenCfd2606VolumeCanary(config).run()
        prior_render_calls = list(state.remote_render_calls)
        receipt["jobs"][0]["volume_restore_proof"]["strip_bytes_freed"] += 1

        with pytest.raises(
            volume_canary._base.CanaryFailure,
            match="job proof differs from its first point",
        ):
            volume_canary.OpenCfd2606VolumeCanary(
                config
            ).verify_retained_receipt(receipt)

    assert state.remote_render_calls == prior_render_calls


def test_volume_canary_rejects_gcs_metadata_leaking_into_volume_receipt():
    with fake_gateway(mode="volume-gcs-leak") as (state, url):
        with pytest.raises(
            volume_canary._base.CanaryFailure,
            match="leaked remote-object metadata",
        ):
            volume_canary.OpenCfd2606VolumeCanary(
                _volume_config(state, url)
            ).run()

    assert state.cancelled == []
    assert state.stripped == []


def test_volume_canary_refuses_an_evidence_bucket_before_contacting_gateway():
    state = FakeGatewayState(mode="volume-ok")
    config = replace(
        _volume_config(state, "http://127.0.0.1:1"),
        expected_evidence_bucket="airfoils-pro-storage-bucket",
    )

    with pytest.raises(
        volume_canary._base.CanaryFailure,
        match="refuses an evidence bucket",
    ):
        volume_canary.OpenCfd2606VolumeCanary(config)

    assert state.submissions == {}


def test_retained_receipt_reproof_rejects_current_storage_prefix_drift_before_reads():
    with fake_gateway() as (state, url):
        receipt = canary.OpenCfd2606Canary(_config(state, url)).run()
        prior_render_calls = len(state.remote_render_calls)
        drifted = replace(
            _config(state, url),
            expected_evidence_object_prefix="solver-evidence/v2",
        )

        with pytest.raises(
            canary.CanaryFailure,
            match="evidence storage differs from the current bucket/prefix/Zstandard configuration",
        ):
            canary.OpenCfd2606Canary(drifted).verify_retained_receipt(receipt)

    assert len(state.remote_render_calls) == prior_render_calls


def test_canary_rejects_periodic_metadata_on_a_no_shedding_result():
    with fake_gateway(mode="false-periodic-no-shedding") as (state, url):
        with pytest.raises(
            canary.CanaryFailure,
            match="no-shedding result must not report a periodic window",
        ):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    # The result is already terminal evidence; the failure path must not try
    # to cancel or mutate it.
    assert state.cancelled == []


def test_canary_cancels_a_nonterminal_job_on_runtime_provenance_mismatch():
    with fake_gateway(mode="stale-runtime") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="version.*2406"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == ["canary-job-1"]


def test_canary_fails_closed_when_completed_result_omits_vtk_evidence():
    with fake_gateway(mode="missing-vtk") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="VTK window evidence artifact is missing"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    # Completed evidence is immutable; the cleanup path only cancels work that
    # is still nonterminal.
    assert state.cancelled == []


def test_canary_fails_closed_when_completed_result_omits_yplus_evidence():
    with fake_gateway(mode="missing-yplus") as (state, url):
        with pytest.raises(canary.CanaryFailure, match=r"y\+ evidence artifact is missing"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []


def test_canary_streams_and_rejects_a_corrupted_engine_bundle():
    with fake_gateway(mode="corrupt-bundle") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="checksum does not match artifact metadata"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []


def test_canary_rejects_a_bundle_that_was_not_published_to_gcs():
    with fake_gateway(mode="volume-bundle") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="was not published to GCS"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []


def test_canary_rejects_remote_evidence_whose_local_cleanup_is_pending():
    with fake_gateway(mode="local-cleanup-pending") as (state, url):
        with pytest.raises(
            canary.CanaryFailure,
            match="did not safely remove raw duplicates",
        ):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []


def test_canary_rejects_non_official_runtime_package_digest():
    with fake_gateway() as (state, url):
        state.runtime["package_sha256"] = "b" * 64
        with pytest.raises(canary.CanaryFailure, match="official OpenCFD 2606"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.submissions == {}


def test_canary_rejects_multi_aoa_rans_mesh_rebuild():
    with fake_gateway(mode="mesh-rebuilt") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="rebuilt the mesh more than once"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []


def test_canary_rejects_mpi_without_decompose_and_reconstruct_records():
    with fake_gateway(mode="missing-mpi-command-records") as (state, url):
        with pytest.raises(canary.CanaryFailure, match="decomposePar execution record"):
            canary.OpenCfd2606Canary(_config(state, url)).run()

    assert state.cancelled == []
