"""Runtime configuration loaded from environment variables.

All settings have safe defaults so the package is importable and testable
without any environment set up.
"""
from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIRFOILFOAM_", env_file=".env", extra="ignore")

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

    # --- OpenFOAM execution ---
    openfoam_image: str = Field(
        default="opencfd/openfoam-default:2406",
        description="Docker image containing OpenFOAM (used by the docker runner).",
    )
    openfoam_runner: str = Field(
        default="docker",
        description="How to invoke OpenFOAM commands: 'docker' (run a container per command) or 'local' "
        "(run directly; used inside the OpenFOAM-based worker container).",
    )
    openfoam_bashrc: str = Field(
        default="/usr/lib/openfoam/openfoam2406/etc/bashrc",
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
