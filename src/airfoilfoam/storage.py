"""Filesystem-backed job storage shared between the API and the worker."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .config import Settings, get_settings
from .models import JobResult, JobState, JobStatus, PolarRequest


class JobStore:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    # -- paths -------------------------------------------------------------- #
    def job_dir(self, job_id: str) -> Path:
        return self.settings.job_dir(job_id)

    def cases_dir(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "cases"

    def case_dir(self, job_id: str, slug: str) -> Path:
        return self.cases_dir(job_id) / slug

    def file_path(self, job_id: str, relpath: str) -> Path:
        """Resolve a path inside the job dir, guarding against traversal."""
        base = self.job_dir(job_id).resolve()
        target = (self.job_dir(job_id) / relpath).resolve()
        if base not in target.parents and target != base:
            raise ValueError("Path escapes job directory")
        return target

    # -- lifecycle ---------------------------------------------------------- #
    def create(self, job_id: str, request: PolarRequest) -> None:
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        (self.job_dir(job_id) / "request.json").write_text(request.model_dump_json(indent=2))
        total = len(request.cases())
        self.write_status(JobStatus(job_id=job_id, state=JobState.pending, total_cases=total))

    def write_status(self, status: JobStatus) -> None:
        path = self.job_dir(status.job_id) / "status.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(status.model_dump_json(indent=2))

    def read_status(self, job_id: str) -> Optional[JobStatus]:
        path = self.job_dir(job_id) / "status.json"
        if not path.exists():
            return None
        return JobStatus.model_validate_json(path.read_text())

    def write_result(self, result: JobResult) -> None:
        path = self.job_dir(result.job_id) / "result.json"
        path.write_text(result.model_dump_json(indent=2))

    def read_result(self, job_id: str) -> Optional[JobResult]:
        path = self.job_dir(job_id) / "result.json"
        if not path.exists():
            return None
        return JobResult.model_validate_json(path.read_text())

    def read_request(self, job_id: str) -> Optional[PolarRequest]:
        path = self.job_dir(job_id) / "request.json"
        if not path.exists():
            return None
        return PolarRequest.model_validate_json(path.read_text())

    def exists(self, job_id: str) -> bool:
        return self.job_dir(job_id).exists()
