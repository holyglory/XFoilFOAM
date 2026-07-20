#!/usr/bin/env python3
"""Validate the fully merged hz-solver2 Compose configuration from stdin."""

from __future__ import annotations

import json
import sys
from typing import Any


REQUIRED_SERVICES = {
    "api",
    "worker",
    "node-api",
    "sweeper",
    "media-repair",
    "postgres",
    "redis",
}


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _environment(service: dict[str, Any], label: str) -> dict[str, str]:
    value = service.get("environment", {})
    if isinstance(value, dict):
        return {str(key): "" if item is None else str(item) for key, item in value.items()}
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            if not isinstance(item, str) or "=" not in item:
                raise ValueError(f"{label}.environment has an invalid entry")
            key, item_value = item.split("=", 1)
            result[key] = item_value
        return result
    raise ValueError(f"{label}.environment must be an object or KEY=VALUE list")


def _volume_sources(service: dict[str, Any], label: str) -> set[str]:
    value = service.get("volumes", [])
    if not isinstance(value, list):
        raise ValueError(f"{label}.volumes must be a list")
    sources: set[str] = set()
    for item in value:
        if isinstance(item, dict) and item.get("type") == "volume":
            source = item.get("source")
            if isinstance(source, str) and source:
                sources.add(source)
        elif isinstance(item, str):
            source = item.split(":", 1)[0]
            if source and not source.startswith(('/', '.', '~')):
                sources.add(source)
    return sources


def validate(value: object) -> None:
    root = _mapping(value, "Compose config")
    services = _mapping(root.get("services"), "Compose services")
    missing = sorted(REQUIRED_SERVICES - set(services))
    if missing:
        raise ValueError("remote-solver Compose config misses: " + ", ".join(missing))
    worker = _mapping(services["worker"], "worker")
    worker_env = _environment(worker, "worker")
    for key in (
        "AIRFOILFOAM_WORKER_CPU_BUDGET",
        "AIRFOILFOAM_CASE_CONCURRENCY",
        "AIRFOILFOAM_CELERY_CONCURRENCY",
    ):
        if worker_env.get(key) != "40":
            raise ValueError(f"merged worker config must retain {key}=40")
    limits = _mapping(
        _mapping(
            _mapping(worker.get("deploy"), "worker.deploy").get("resources"),
            "worker.deploy.resources",
        ).get("limits"),
        "worker.deploy.resources.limits",
    )
    try:
        cpu_limit = float(limits.get("cpus"))
    except (TypeError, ValueError) as exc:
        raise ValueError("merged worker CPU limit is missing") from exc
    if cpu_limit != 40.0:
        raise ValueError(f"merged worker CPU limit is {cpu_limit:g}, expected 40")
    nofile = _mapping(
        _mapping(worker.get("ulimits"), "worker.ulimits").get("nofile"),
        "worker.ulimits.nofile",
    )
    if nofile.get("soft") != 65_536 or nofile.get("hard") != 524_288:
        raise ValueError(
            "merged worker nofile limit must retain soft=65536 and hard=524288"
        )

    for name in ("api", "worker"):
        env = _environment(_mapping(services[name], name), name)
        if env.get("AIRFOILFOAM_EVIDENCE_BUCKET", ""):
            raise ValueError(f"{name} must not receive a GCS bucket")
        if env.get("AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX") != "solver-evidence/v1":
            raise ValueError(f"{name} must use the canonical evidence object prefix")
        if env.get("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "").lower() not in {
            "false",
            "0",
            "no",
            "off",
        }:
            raise ValueError(f"{name} must retain volume evidence (remote-only=false)")
        if env.get("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL") != "10":
            raise ValueError(f"{name} must use Zstandard level 10")

    volumes = _mapping(root.get("volumes"), "Compose volumes")
    for name in ("results", "pgdata", "engine_runtime"):
        if name not in volumes:
            raise ValueError(f"remote-solver Compose config lacks persistent {name} volume")
    required_mounts = {
        "api": {"results"},
        "worker": {"results", "engine_runtime"},
        "postgres": {"pgdata"},
    }
    for service_name, required in required_mounts.items():
        mounted = _volume_sources(
            _mapping(services[service_name], service_name), service_name
        )
        missing_mounts = sorted(required - mounted)
        if missing_mounts:
            raise ValueError(
                f"{service_name} does not mount persistent volume(s): "
                + ", ".join(missing_mounts)
            )


def main() -> int:
    try:
        value = json.load(sys.stdin)
        validate(value)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"remote-solver Compose profile error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
