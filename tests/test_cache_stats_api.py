"""GET /cache/stats: pure disk-truth counts scanned from mesh/seed entry manifests."""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from airfoilfoam.api.main import app
from airfoilfoam.cache import MANIFEST_NAME
from airfoilfoam.config import get_settings


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def cache_root() -> Path:
    """The app settings' resolved cache dir, guaranteed absent before and after."""
    root = get_settings().resolved_cache_dir()
    shutil.rmtree(root, ignore_errors=True)
    yield root
    shutil.rmtree(root, ignore_errors=True)


def _write_entry(entry_dir: Path, kind: str, byte_size: int, mtime: float | None = None) -> Path:
    """A minimal published cache entry: just the manifest (stats reads only manifests)."""
    entry_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "kind": kind,
        "key": entry_dir.name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "byteSize": byte_size,
        "files": [{"path": f"{kind}/payload", "sha256": "0" * 64, "byteSize": byte_size}],
    }
    path = entry_dir / MANIFEST_NAME
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def test_cache_stats_missing_dir_is_zeros(client, cache_root):
    body = client.get("/cache/stats").json()
    assert body["mesh_entries"] == 0
    assert body["seed_entries"] == 0
    assert body["total_bytes"] == 0
    assert body["oldest_last_used"] is None
    assert body["cap_bytes"] == int(get_settings().cache_max_gb * 1024**3)


def test_cache_stats_counts_mesh_and_seed_entries(client, cache_root):
    now = datetime.now(timezone.utc).timestamp()
    _write_entry(cache_root / "mesh" / ("a" * 64), "mesh", 1000, mtime=now - 300)
    _write_entry(cache_root / "mesh" / ("b" * 64), "mesh", 2500, mtime=now - 30)
    _write_entry(cache_root / "seed" / ("c" * 64) / "a5_deadbeef", "seed", 4200, mtime=now - 60)

    body = client.get("/cache/stats").json()
    assert body["mesh_entries"] == 2
    assert body["seed_entries"] == 1
    assert body["total_bytes"] == 1000 + 2500 + 4200
    assert body["cap_bytes"] == int(get_settings().cache_max_gb * 1024**3)
    oldest = datetime.fromisoformat(body["oldest_last_used"])
    assert oldest.timestamp() == pytest.approx(now - 300, abs=2)


def test_cache_stats_ignores_malformed_and_manifestless_entries(client, cache_root):
    _write_entry(cache_root / "mesh" / ("a" * 64), "mesh", 1000)
    # Malformed manifest: unparseable JSON must be skipped, not counted or faked.
    broken = cache_root / "mesh" / ("d" * 64)
    broken.mkdir(parents=True)
    (broken / MANIFEST_NAME).write_text("{not json", encoding="utf-8")
    # Partial entry with no manifest at all (interrupted publish) — also skipped.
    (cache_root / "seed" / ("e" * 64) / "a0_cafecafe").mkdir(parents=True)

    body = client.get("/cache/stats").json()
    assert body["mesh_entries"] == 1
    assert body["seed_entries"] == 0
    assert body["total_bytes"] == 1000
