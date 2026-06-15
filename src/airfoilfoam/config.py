"""Runtime configuration loaded from environment variables.

All settings have safe defaults so the package is importable and testable
without any environment set up.
"""
from __future__ import annotations

from functools import lru_cache
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
    solver_timeout: int = Field(default=7200, ge=60, description="Per-case solver timeout [s].")

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
