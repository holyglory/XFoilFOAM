"""Runtime configuration loaded from environment variables.

All settings have safe defaults so the package is importable and testable
without any environment set up.
"""
from __future__ import annotations

from functools import lru_cache
import os
import platform
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Compose intentionally exports optional deployment variables as empty
    # strings.  Treat those as absent so optional typed settings retain their
    # canonical defaults (notably ``None`` for a volume-backed evidence bucket
    # and control-plane token in non-production development).
    model_config = SettingsConfigDict(
        env_prefix="AIRFOILFOAM_",
        env_file=".env",
        env_ignore_empty=True,
        extra="ignore",
    )

    # --- Storage ---
    data_dir: Path = Field(
        default=Path("/data/airfoilfoam"),
        description="Directory where job cases and results are stored (shared between API and worker).",
    )
    cache_dir: Path | None = Field(
        default=None,
        description="Persistent cross-job cache for built meshes and steady-solution seeds "
        "(a Docker volume in production so it survives worker rebuilds). Defaults to <data_dir>/cache.",
    )
    cache_max_gb: float = Field(
        default=20.0,
        gt=0,
        description="Size cap [GiB] for the mesh/seed cache; least-recently-used entries are evicted beyond it.",
    )
    evidence_bucket: str | None = Field(
        default=None,
        description="Private GCS bucket holding immutable finalized evidence archives. "
        "Unset keeps tar.zst archives on the shared data volume for development.",
    )
    evidence_object_prefix: str = Field(
        default="solver-evidence/v1",
        description="Versioned prefix for content-addressed evidence objects.",
    )
    evidence_zstd_level: int = Field(
        default=10,
        ge=1,
        le=22,
        description="Zstandard compression level for finalized tar archives.",
    )
    evidence_remote_only: bool = Field(
        default=False,
        description="Remove local packaged evidence only after a verified GCS upload.",
    )
    control_plane_token: str | None = Field(
        default=None,
        min_length=32,
        description="Dedicated server-to-server bearer token authorizing exact database-backed evidence cleanup.",
    )
    evidence_hydration_cache_dir: Path | None = Field(
        default=None,
        description="Temporary render hydration cache. Defaults to <data_dir>/evidence-hydration-cache.",
    )
    evidence_hydration_cache_max_gb: float = Field(
        default=50.0,
        gt=0,
        description="Hard size target [GiB] for temporary hydrated archives and VTK trees.",
    )
    evidence_hydration_cache_ttl_seconds: int = Field(
        default=24 * 60 * 60,
        ge=60,
        description="Idle age after which temporary evidence hydration may be evicted.",
    )
    evidence_gcs_timeout_seconds: int = Field(
        default=900,
        ge=30,
        description="Bounded timeout for one GCS upload/download operation.",
    )

    # --- OpenFOAM execution ---
    engine_family: str = Field(
        default="openfoam",
        description="Extensible solver family slug executed by this worker.",
    )
    engine_distribution: str = Field(
        default="opencfd",
        description="Implementation/distribution slug executed by this worker.",
    )
    engine_version: str = Field(
        default="2606",
        description="Upstream solver release executed by this worker.",
    )
    engine_numerics_revision: str = Field(
        default="1",
        description="Explicit revision of numerically significant adapter behaviour/defaults.",
    )
    engine_adapter_contract_version: int = Field(
        default=1,
        ge=1,
        description="Wire/adapter contract revision required for exact worker acknowledgement.",
    )
    engine_source_revision: str | None = Field(
        default=None,
        description="Pinned upstream/source revision, when known.",
    )
    engine_image_digest: str | None = Field(
        default=None,
        description="OCI image digest of the executing worker, when supplied by deployment.",
    )
    engine_application_source_sha256: str | None = Field(
        default=None,
        description="Deterministic checksum of the adapter/application sources copied into the worker image.",
    )
    engine_package_sha256: str | None = Field(
        default=None,
        description="Checksum of the installed upstream package/archive, when known.",
    )
    engine_binary_sha256: str | None = Field(
        default=None,
        description="Checksum of the solver executable, when captured by the image build.",
    )
    engine_architecture: str = Field(
        default_factory=platform.machine,
        description="Runtime architecture included in immutable provenance.",
    )
    celery_queue: str = Field(
        default="openfoam-opencfd-2606",
        description="Exact implementation-owned Celery queue this worker consumes.",
    )
    enabled_engine_keys: str = Field(
        default="openfoam:opencfd:2606:numerics-1:adapter-1",
        description="Comma-separated exact engine handshake keys the API gateway is allowed to route. "
        "Registered but disabled adapters are rejected before queueing.",
    )
    openfoam_image: str = Field(
        default="opencfd/openfoam-run:2606@sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb",
        description="Docker image containing OpenFOAM (used by the docker runner).",
    )
    openfoam_runner: str = Field(
        default="docker",
        description="How to invoke OpenFOAM commands: 'docker' (run a container per command) or 'local' "
        "(run directly; used inside the OpenFOAM-based worker container).",
    )
    openfoam_bashrc: str = Field(
        default="/usr/lib/openfoam/openfoam2606/etc/bashrc",
        description="Path to the OpenFOAM bashrc that must be sourced before running solvers.",
    )
    docker_binary: str = Field(default="docker", description="Path/name of the docker CLI.")
    solver_processes: int = Field(
        default=1,
        ge=1,
        description="Number of MPI processes per CFD case (1 = serial). Cases are also parallelised "
        "across the Celery worker pool.",
    )
    case_concurrency: int = Field(
        default=4, ge=1, description="How many CFD cases of one job to run concurrently."
    )
    worker_cpu_budget: int | None = Field(
        default=None,
        ge=1,
        description="Shared worker-local CPU token budget. Defaults to Docker CPU quota or detected CPU count.",
    )
    cpu_token_state_path: Path = Field(
        default=Path("/tmp/airfoilfoam-cpu-tokens.json"),
        description="Small JSON file used by worker processes to coordinate CPU token leases.",
    )
    cpu_token_lease_ttl_seconds: float = Field(
        default=120.0,
        ge=5.0,
        description="Bounded heartbeat TTL used to recover CPU-token leases owned by another "
        "worker container after that container disappears.",
    )
    solver_timeout: int = Field(default=7200, ge=60, description="Per-case URANS/global solver guard timeout [s].")
    rans_solver_timeout: int = Field(
        default=1200,
        ge=60,
        description="Per-case steady RANS wall-clock timeout [s]. Slow 2D RANS points are stored as evidence and the sweep moves on.",
    )
    rans_max_iterations: int = Field(
        default=600,
        ge=50,
        description="Worker-side SIMPLE iteration cap for steady RANS. Prevents 2D points from monopolising CPU during large sweeps.",
    )
    media_budget_fraction: float = Field(
        default=0.5,
        gt=0,
        description="Wall-clock budget for the post-solve media/frame rendering stage of one case, "
        "as a fraction of solver_timeout. On breach the job COMPLETES with whatever rendered, a loud "
        "'media rendering budget exhausted' quality warning, and the evidence manifest unavailable map "
        "recording the gaps (2026-07-07 incident: unbudgeted per-frame renders pinned workers for hours).",
    )
    stall_no_progress_minutes: float = Field(
        default=20.0,
        gt=0,
        description="Engine-side stall detector threshold: a running task in a solving/postprocessing "
        "phase with NO live OpenFOAM process and NO progress-token advance (status.json update, "
        "coefficient.dat mtime, frame PNG mtime) for this many minutes is marked failed "
        "('stalled in <phase> — no progress for Nm') and the worker child exits, converting an "
        "eternal in-process grind into the already-handled failed job class.",
    )
    divergence_cl_bound: float = Field(
        default=50.0,
        gt=0,
        description="In-run divergence watchdog: |Cl| sanity bound. A solving case whose newest "
        "coefficient.dat rows exceed this on 3 consecutive heartbeat samples is condemned (solver "
        "process group killed; the case fails with a truthful 'transient diverged' error and flows "
        "the normal failed/timeout grading path). Physical post-stall |Cl| stays below ~3; a "
        "diverging URANS run shoots past 50 within seconds (prod 2026-07-07: |Cl| excursions "
        "reached ±9.45e5).",
    )
    divergence_dt_floor: float = Field(
        default=1e-7,
        gt=0,
        description="In-run divergence watchdog: adaptive-timestep floor [s], estimated from the "
        "coefficient.dat time deltas. A transient whose dt stays below this floor persistently for "
        "divergence_grace_minutes is condemned (prod 2026-07-07: dt collapsed 8e-6 -> 5e-8 and the "
        "simulated time froze for the whole 7200 s budget). Legitimate startup ramps recover above "
        "the floor within the grace and are never condemned.",
    )
    divergence_grace_minutes: float = Field(
        default=5.0,
        gt=0,
        description="In-run divergence watchdog: how long the timestep must stay below "
        "divergence_dt_floor (with no recovery) before the case is condemned.",
    )
    build_id: str = Field(
        default="dev",
        description="Source/image build identifier reported to the API for UI version-parity checks.",
    )

    # --- Messaging ---
    redis_url: str = Field(default="redis://localhost:6379/0")

    @model_validator(mode="after")
    def require_remote_cleanup_authentication(self) -> "Settings":
        if (
            (self.evidence_bucket or "").strip()
            and self.evidence_remote_only
            and not (self.control_plane_token or "").strip()
        ):
            raise ValueError(
                "AIRFOILFOAM_CONTROL_PLANE_TOKEN (at least 32 characters) is required when remote-only GCS evidence is enabled"
            )
        return self

    @property
    def broker_url(self) -> str:
        return self.redis_url

    @property
    def result_backend(self) -> str:
        return self.redis_url

    def job_dir(self, job_id: str) -> Path:
        return self.data_dir / "jobs" / job_id

    def resolved_cache_dir(self) -> Path:
        return self.cache_dir if self.cache_dir is not None else self.data_dir / "cache"

    def resolved_evidence_hydration_cache_dir(self) -> Path:
        return (
            self.evidence_hydration_cache_dir
            if self.evidence_hydration_cache_dir is not None
            else self.data_dir / "evidence-hydration-cache"
        )

    def engine_identity(self):
        """Logical configured solver identity (local import avoids config/model cycles)."""
        from .models import EngineIdentity

        return EngineIdentity(
            family=self.engine_family,
            distribution=self.engine_distribution,
            version=self.engine_version,
            numerics_revision=self.engine_numerics_revision,
            adapter_contract_version=self.engine_adapter_contract_version,
        )

    def engine_runtime_identity(self):
        """Exact provenance acknowledged by work executed in this runtime."""
        from .models import EngineRuntimeIdentity
        from .provenance import installed_application_source_sha256

        def optional_text(value: str | None) -> str | None:
            if value is None:
                return None
            normalized = value.strip()
            return normalized or None

        return EngineRuntimeIdentity(
            **self.engine_identity().model_dump(),
            build_id=self.build_id,
            source_revision=optional_text(self.engine_source_revision),
            image_digest=optional_text(self.engine_image_digest),
            application_source_sha256=(
                optional_text(self.engine_application_source_sha256)
                or installed_application_source_sha256()
            ),
            package_sha256=optional_text(self.engine_package_sha256),
            binary_sha256=optional_text(self.engine_binary_sha256),
            architecture=optional_text(self.engine_architecture),
        )

    def enabled_engine_key_set(self) -> set[str]:
        return {
            item.strip()
            for item in self.enabled_engine_keys.split(",")
            if item.strip()
        }

    def resolved_engine_cache_dir(self) -> Path:
        """Numerical cache namespace, preserving the historical v2406 path byte-for-byte."""
        identity = self.engine_identity()
        if identity.compatibility_key == "openfoam:opencfd:2406:numerics-1":
            return self.resolved_cache_dir()
        safe = identity.compatibility_key.replace(":", "_")
        return self.resolved_cache_dir() / "engines" / safe

    def media_budget_seconds(self) -> float:
        """Wall-clock seconds one case's post-solve media/frame stage may consume."""
        return self.media_budget_fraction * self.solver_timeout

    def resolved_worker_cpu_budget(self) -> int:
        if self.worker_cpu_budget is not None:
            return max(1, int(self.worker_cpu_budget))
        quota = _docker_cpu_quota()
        if quota is not None:
            return max(1, quota)
        return max(1, os.cpu_count() or 1)


def _docker_cpu_quota() -> int | None:
    """Best-effort CPU quota detection for cgroup v2/v1 Docker containers."""
    try:
        cpu_max = Path("/sys/fs/cgroup/cpu.max")
        if cpu_max.exists():
            quota_s, period_s = cpu_max.read_text().strip().split()[:2]
            if quota_s != "max":
                quota = int(quota_s)
                period = int(period_s)
                if quota > 0 and period > 0:
                    return max(1, quota // period)
    except Exception:
        pass
    try:
        quota_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        period_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        if quota_path.exists() and period_path.exists():
            quota = int(quota_path.read_text().strip())
            period = int(period_path.read_text().strip())
            if quota > 0 and period > 0:
                return max(1, quota // period)
    except Exception:
        pass
    return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
