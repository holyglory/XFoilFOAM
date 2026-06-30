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
