"""Persistent cross-job cache for meshes and steady-solution seeds.

Two content-addressed stores live under one cache root (shared by every worker
process on the host, on a Docker volume in production):

- ``mesh/<key>``: a built ``constant/polyMesh`` keyed by the *normalized airfoil
  contour exactly as meshed*, the canonical chord and the RESOLVED mesh
  parameters (resolution happens after y+/speed sizing, so identical requests
  always map to the same key).
- ``seed/<seed-key>/<entry>``: the latest-time fields of an ACCEPTED steady
  solve, keyed by mesh key + fluid (density, dynamic viscosity) + canonical
  speed. Each entry additionally records the angle of attack and a solver
  signature (turbulence + roughness) so a new case only seeds from a
  physically compatible donor.

Entries are published atomically (staged into ``tmp/`` then renamed), carry a
manifest with per-file sha256 sums, and are evicted least-recently-used under a
size cap. Corrupt or partial entries are ignored and removed. The cache is an
optimisation layer only: every failure degrades to a miss, never to a failed
solve, and hits/misses/evictions are logged with real sizes.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .airfoil import Airfoil
from .config import Settings
from .models import FluidProperties, MeshParams, RoughnessParams, SolverParams

logger = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"
MESH_PAYLOAD_DIR = "polyMesh"
SEED_PAYLOAD_DIR = "fields"
_STALE_TMP_AGE_S = 24 * 3600


def _canon(value: float) -> str:
    """Canonical text form of a float (stable across trailing-zero variants)."""
    return f"{float(value):.12g}"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _angle_slug(aoa_deg: float) -> str:
    return f"a{aoa_deg:g}".replace(".", "p").replace("-", "m")


@dataclass(frozen=True)
class SeedHit:
    """A verified seed-cache entry ready to materialize into a case."""

    entry_dir: Path
    aoa_deg: float
    solver: str
    byte_size: int


class EngineCache:
    """Content-addressed persistent mesh + steady-solution-seed cache."""

    def __init__(self, root: Path, max_bytes: int):
        self.root = Path(root)
        self.max_bytes = max(1, int(max_bytes))
        self.mesh_root = self.root / "mesh"
        self.seed_root = self.root / "seed"
        self.tmp_root = self.root / "tmp"

    @classmethod
    def from_settings(cls, settings: Settings) -> "EngineCache":
        return cls(
            settings.resolved_cache_dir(),
            max_bytes=int(settings.cache_max_gb * 1024**3),
        )

    # -- keys ---------------------------------------------------------------- #
    @staticmethod
    def mesh_key(airfoil: Airfoil, chord: float, resolved_mesh: MeshParams) -> str:
        """Key over (normalized contour as meshed, canonical chord, resolved mesh params)."""
        contour = "\n".join(f"{x:.12g} {y:.12g}" for x, y in airfoil.contour)
        payload = json.dumps(
            {
                "airfoil": contour,
                "chord": _canon(chord),
                "mesh": json.loads(resolved_mesh.model_dump_json()),
            },
            sort_keys=True,
        )
        return _sha256_text(payload)

    @staticmethod
    def fluid_signature(fluid: FluidProperties) -> dict[str, str]:
        """Canonical (density, dynamic viscosity) pair; mu is derived when nu was given."""
        return {
            "density": _canon(fluid.density),
            "dynamic_viscosity": _canon(fluid.nu * fluid.density),
        }

    @classmethod
    def seed_key(cls, mesh_key: str, fluid: FluidProperties, speed: float) -> str:
        payload = json.dumps(
            {"mesh": mesh_key, "fluid": cls.fluid_signature(fluid), "speed": _canon(speed)},
            sort_keys=True,
        )
        return _sha256_text(payload)

    @staticmethod
    def solver_signature(solver_params: SolverParams, roughness: RoughnessParams) -> str:
        """Fields whose 0/-file boundary conditions must match between donor and case."""
        payload = json.dumps(
            {
                "turbulence": {
                    "model": solver_params.turbulence.model.value,
                    "intensity": _canon(solver_params.turbulence.intensity),
                    "viscosity_ratio": _canon(solver_params.turbulence.viscosity_ratio),
                },
                "roughness": {
                    "sand_grain_height": _canon(roughness.sand_grain_height),
                    "roughness_constant": _canon(roughness.roughness_constant),
                },
            },
            sort_keys=True,
        )
        return _sha256_text(payload)[:16]

    # -- mesh store ---------------------------------------------------------- #
    def fetch_mesh(self, key: str, dest_polymesh_dir: Path) -> Optional[dict]:
        """Materialize a cached polyMesh into ``dest_polymesh_dir``. None on miss."""
        entry_dir = self.mesh_root / key
        try:
            manifest = self._verified_manifest(entry_dir)
            if manifest is None:
                logger.info("mesh cache miss key=%s", key)
                return None
            payload = entry_dir / MESH_PAYLOAD_DIR
            if dest_polymesh_dir.is_symlink() or dest_polymesh_dir.is_file():
                dest_polymesh_dir.unlink()
            elif dest_polymesh_dir.is_dir():
                shutil.rmtree(dest_polymesh_dir)
            shutil.copytree(payload, dest_polymesh_dir)
            self._touch(entry_dir)
            logger.info(
                "mesh cache hit key=%s size=%dB files=%d",
                key, int(manifest.get("byteSize", 0)), len(manifest.get("files", [])),
            )
            return manifest
        except Exception as exc:  # noqa: BLE001 - the cache must never fail a job
            logger.warning("mesh cache fetch failed key=%s: %s", key, exc)
            return None

    def publish_mesh(self, key: str, polymesh_dir: Path, n_cells: int) -> bool:
        """Atomically publish a built ``constant/polyMesh`` under ``key``."""
        try:
            if not polymesh_dir.is_dir():
                return False
            entry_dir = self.mesh_root / key
            if (entry_dir / MANIFEST_NAME).exists():
                return False  # already published by a concurrent job
            extra = {"nCells": int(n_cells)}
            ok = self._publish_entry(
                entry_dir, MESH_PAYLOAD_DIR, self._payload_files(polymesh_dir),
                kind="mesh", key=key, extra=extra,
            )
            if ok:
                self.evict_to_cap()
            return ok
        except Exception as exc:  # noqa: BLE001
            logger.warning("mesh cache publish failed key=%s: %s", key, exc)
            return False

    # -- seed store ---------------------------------------------------------- #
    def find_seed(
        self,
        seed_key: str,
        aoa_deg: float,
        solver_signature: str,
        max_delta_deg: float = 2.0,
    ) -> Optional[SeedHit]:
        """Nearest verified donor angle within ``max_delta_deg`` at the same
        (mesh, fluid, speed) key and a compatible solver signature."""
        try:
            group_dir = self.seed_root / seed_key
            if not group_dir.is_dir():
                logger.info("seed cache miss key=%s aoa=%g (no entries)", seed_key, aoa_deg)
                return None
            best: Optional[SeedHit] = None
            best_delta = float("inf")
            for entry_dir in sorted(group_dir.iterdir()):
                if not entry_dir.is_dir() or entry_dir.name.startswith("."):
                    continue  # dot-dirs are half-deleted trash, never candidates
                manifest = self._verified_manifest(entry_dir)
                if manifest is None:
                    continue
                if manifest.get("solverSignature") != solver_signature:
                    continue
                angle = float(manifest.get("aoaDeg", float("nan")))
                delta = abs(angle - aoa_deg)
                if delta > max_delta_deg + 1e-9:
                    continue
                if delta < best_delta:
                    best_delta = delta
                    best = SeedHit(
                        entry_dir=entry_dir,
                        aoa_deg=angle,
                        solver=str(manifest.get("solver", "")),
                        byte_size=int(manifest.get("byteSize", 0)),
                    )
            if best is None:
                logger.info("seed cache miss key=%s aoa=%g", seed_key, aoa_deg)
            else:
                logger.info(
                    "seed cache hit key=%s aoa=%g donor=%g delta=%.3gdeg size=%dB",
                    seed_key, aoa_deg, best.aoa_deg, best_delta, best.byte_size,
                )
            return best
        except Exception as exc:  # noqa: BLE001
            logger.warning("seed cache lookup failed key=%s: %s", seed_key, exc)
            return None

    def materialize_seed(self, hit: SeedHit, dest_dir: Path) -> list[str]:
        """Copy a seed entry's field files into ``dest_dir``; returns copied names."""
        payload = hit.entry_dir / SEED_PAYLOAD_DIR
        dest_dir.mkdir(parents=True, exist_ok=True)
        copied: list[str] = []
        for src in sorted(payload.iterdir()):
            if not src.is_file():
                continue
            shutil.copy2(src, dest_dir / src.name)
            copied.append(src.name)
        self._touch(hit.entry_dir)
        return copied

    def publish_seed(
        self,
        seed_key: str,
        aoa_deg: float,
        solver_signature: str,
        time_dir: Path,
        *,
        solver: str,
        speed: float,
        fluid: FluidProperties,
    ) -> bool:
        """Atomically publish the latest-time fields of an accepted steady solve."""
        try:
            files = self._payload_files(time_dir, recursive=False)
            if not files:
                return False
            entry_dir = self.seed_root / seed_key / f"{_angle_slug(aoa_deg)}_{solver_signature}"
            extra = {
                "aoaDeg": float(aoa_deg),
                "solver": solver,
                "solverSignature": solver_signature,
                "speed": _canon(speed),
                "fluid": self.fluid_signature(fluid),
                "sourceTime": time_dir.name,
            }
            # Re-publishing an angle refreshes the entry with the newest solve.
            ok = self._publish_entry(
                entry_dir, SEED_PAYLOAD_DIR, files,
                kind="seed", key=seed_key, extra=extra, replace=True,
            )
            if ok:
                self.evict_to_cap()
            return ok
        except Exception as exc:  # noqa: BLE001
            logger.warning("seed cache publish failed key=%s aoa=%g: %s", seed_key, aoa_deg, exc)
            return False

    # -- eviction ------------------------------------------------------------ #
    def evict_to_cap(self) -> None:
        """Remove least-recently-used entries until the cache fits the size cap.

        Guarded by a file lock so concurrent workers never race the same
        removals; when another process holds the lock, this pass is skipped
        (that process is already evicting).
        """
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            lock_path = self.root / ".evict.lock"
            with lock_path.open("w") as lock_file:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return
                self._evict_locked()
        except Exception as exc:  # noqa: BLE001
            logger.warning("cache eviction failed: %s", exc)

    def _evict_locked(self) -> None:
        self._sweep_stale_tmp()
        entries: list[tuple[float, int, Path]] = []  # (last_used, bytes, entry_dir)
        total = 0
        for entry_dir in self._entry_dirs():
            manifest_path = entry_dir / MANIFEST_NAME
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                size = int(manifest["byteSize"])
                last_used = manifest_path.stat().st_mtime
            except Exception:  # noqa: BLE001 - corrupt entry: remove it outright
                logger.info("cache evicting corrupt entry %s", entry_dir)
                self._remove_entry(entry_dir)
                continue
            entries.append((last_used, size, entry_dir))
            total += size
        if total <= self.max_bytes:
            return
        for last_used, size, entry_dir in sorted(entries, key=lambda item: item[0]):
            if total <= self.max_bytes:
                break
            self._remove_entry(entry_dir)
            total -= size
            logger.info(
                "cache evicted %s size=%dB (LRU, total now %dB of cap %dB)",
                entry_dir.relative_to(self.root), size, total, self.max_bytes,
            )

    # -- stats (read-only) ----------------------------------------------------- #
    def stats(self) -> dict:
        """Pure-disk cache statistics for the API's ``GET /cache/stats``.

        Scans mesh/seed entry manifests only (they already record byte sizes);
        malformed or manifest-less entries are skipped, never counted. A
        missing or empty cache root yields zeros. Read-only: safe on the API
        container's read-only mount of the cache volume.
        """
        mesh_entries = 0
        seed_entries = 0
        total = 0
        oldest_last_used: float | None = None
        for entry_dir in self._entry_dirs():
            manifest_path = entry_dir / MANIFEST_NAME
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                size = int(manifest["byteSize"])
                last_used = manifest_path.stat().st_mtime
            except Exception:  # noqa: BLE001 - malformed entries are ignored
                continue
            if entry_dir.parent == self.mesh_root:
                mesh_entries += 1
            else:
                seed_entries += 1
            total += size
            if oldest_last_used is None or last_used < oldest_last_used:
                oldest_last_used = last_used
        return {
            "mesh_entries": mesh_entries,
            "seed_entries": seed_entries,
            "total_bytes": total,
            "cap_bytes": self.max_bytes,
            "oldest_last_used": (
                datetime.fromtimestamp(oldest_last_used, timezone.utc).isoformat()
                if oldest_last_used is not None
                else None
            ),
        }

    def total_bytes(self) -> int:
        total = 0
        for entry_dir in self._entry_dirs():
            try:
                manifest = json.loads((entry_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
                total += int(manifest["byteSize"])
            except Exception:  # noqa: BLE001
                continue
        return total

    def _entry_dirs(self) -> list[Path]:
        def live(parent: Path) -> list[Path]:
            return [d for d in parent.iterdir() if d.is_dir() and not d.name.startswith(".")]

        dirs: list[Path] = []
        if self.mesh_root.is_dir():
            dirs.extend(live(self.mesh_root))
        if self.seed_root.is_dir():
            for group in live(self.seed_root):
                dirs.extend(live(group))
        return dirs

    def _sweep_stale_tmp(self) -> None:
        now = datetime.now(timezone.utc).timestamp()

        def sweep(parent: Path, names) -> None:
            for stale in names:
                try:
                    if now - stale.stat().st_mtime > _STALE_TMP_AGE_S:
                        shutil.rmtree(stale, ignore_errors=True)
                except OSError:
                    continue

        if self.tmp_root.is_dir():
            sweep(self.tmp_root, list(self.tmp_root.iterdir()))
        # .trash dirs left behind by a crashed removal
        parents = [self.mesh_root, self.seed_root]
        if self.seed_root.is_dir():
            parents.extend(g for g in self.seed_root.iterdir() if g.is_dir())
        for parent in parents:
            if parent.is_dir():
                sweep(parent, [d for d in parent.iterdir() if d.name.startswith(".") and d.is_dir()])

    # -- internals ----------------------------------------------------------- #
    @staticmethod
    def _payload_files(base: Path, recursive: bool = True) -> list[tuple[Path, Path]]:
        """(source file, relative path) pairs; seeds take only top-level field files
        (subdirectories like ``uniform/`` or decomposed ``processor*`` are not fields)."""
        files: list[tuple[Path, Path]] = []
        if recursive:
            for root, _dirs, names in os.walk(base):
                for name in sorted(names):
                    src = Path(root) / name
                    if src.is_file():
                        files.append((src, src.relative_to(base)))
        else:
            for src in sorted(base.iterdir()):
                if src.is_file():
                    files.append((src, Path(src.name)))
        return files

    def _publish_entry(
        self,
        entry_dir: Path,
        payload_dirname: str,
        files: list[tuple[Path, Path]],
        *,
        kind: str,
        key: str,
        extra: dict,
        replace: bool = False,
    ) -> bool:
        if not files:
            return False
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        stage = self.tmp_root / uuid.uuid4().hex
        try:
            payload_dir = stage / payload_dirname
            manifest_files: list[dict] = []
            total = 0
            for src, rel in files:
                dst = payload_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst, follow_symlinks=True)
                size = dst.stat().st_size
                total += size
                manifest_files.append(
                    {"path": str(Path(payload_dirname) / rel), "sha256": _sha256_file(dst), "byteSize": size}
                )
            manifest = {
                "schemaVersion": 1,
                "kind": kind,
                "key": key,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "byteSize": total,
                "files": manifest_files,
                **extra,
            }
            # The manifest is written last: a stage without one is never valid.
            (stage / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
            entry_dir.parent.mkdir(parents=True, exist_ok=True)
            if replace and entry_dir.exists():
                self._remove_entry(entry_dir)
            try:
                os.rename(stage, entry_dir)
            except OSError:
                # A concurrent publisher won the rename; their copy is equivalent.
                shutil.rmtree(stage, ignore_errors=True)
                return (entry_dir / MANIFEST_NAME).exists()
            logger.info("cache published %s key=%s size=%dB files=%d", kind, key, total, len(manifest_files))
            return True
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise

    def _verified_manifest(self, entry_dir: Path) -> Optional[dict]:
        """Load an entry manifest and verify every payload file (size + sha256).
        Corrupt or partial entries are removed and reported as a miss."""
        manifest_path = entry_dir / MANIFEST_NAME
        if not manifest_path.is_file():
            if entry_dir.exists():
                logger.info("cache removing partial entry %s (no manifest)", entry_dir)
                self._remove_entry(entry_dir)
            return None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            files = manifest["files"]
            if not isinstance(files, list) or not files:
                raise ValueError("manifest has no files")
            for item in files:
                path = entry_dir / str(item["path"])
                if not path.is_file():
                    raise ValueError(f"missing payload file {item['path']}")
                if path.stat().st_size != int(item["byteSize"]):
                    raise ValueError(f"size mismatch for {item['path']}")
                if _sha256_file(path) != str(item["sha256"]):
                    raise ValueError(f"sha256 mismatch for {item['path']}")
            return manifest
        except Exception as exc:  # noqa: BLE001
            logger.info("cache removing corrupt entry %s: %s", entry_dir, exc)
            self._remove_entry(entry_dir)
            return None

    @staticmethod
    def _remove_entry(entry_dir: Path) -> None:
        trash = entry_dir.with_name(f".{entry_dir.name}.{uuid.uuid4().hex}.trash")
        try:
            os.rename(entry_dir, trash)
        except OSError:
            shutil.rmtree(entry_dir, ignore_errors=True)
            return
        shutil.rmtree(trash, ignore_errors=True)

    @staticmethod
    def _touch(entry_dir: Path) -> None:
        try:
            os.utime(entry_dir / MANIFEST_NAME, None)
        except OSError:
            pass
