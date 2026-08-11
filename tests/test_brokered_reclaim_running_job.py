from __future__ import annotations

import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

import airfoilfoam.api.main as api_main
from airfoilfoam.config import get_settings


def test_brokered_reclaim_accepts_only_completed_inactive_case_from_running_job(
    tmp_path, monkeypatch
) -> None:
    token = "r" * 40
    monkeypatch.setenv("AIRFOILFOAM_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AIRFOILFOAM_CONTROL_PLANE_TOKEN", token)
    get_settings.cache_clear()
    calls: list[str] = []

    lock_modes: list[bool] = []

    def reclaim(job_root, evidence_dir, authorization, *, acquire_job_lock=True):
        calls.append(authorization.case_slug)
        lock_modes.append(acquire_job_lock)
        return SimpleNamespace(
            to_dict=lambda: {
                "state": "complete",
                "bytes_freed": 4096,
                "files_removed": 2,
            }
        )

    monkeypatch.setattr(api_main, "reclaim_brokered_remote_evidence", reclaim)
    try:
        settings = get_settings()
        job_id = "running-partial-reclaim"
        job_root = settings.job_dir(job_id)
        completed_slug = "condition_a0"
        active_slug = "condition_a1"
        for slug in (completed_slug, active_slug):
            (job_root / "cases" / slug / "evidence").mkdir(
                parents=True, exist_ok=True
            )
        (job_root / "status.json").write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "state": "running",
                    "phase": "solving_urans",
                    "total_cases": 2,
                    "completed_cases": 1,
                    "active_case_slug": active_slug,
                }
            ),
            encoding="utf-8",
        )
        (job_root / "result.json").write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "state": "running",
                    "polars": [
                        {
                            "speed": 30.0,
                            "chord": 1.0,
                            "reynolds": 1_000_000,
                            "points": [
                                {"case_slug": completed_slug, "aoa_deg": 0.0}
                            ],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        client = TestClient(api_main.create_app())
        headers = {"authorization": f"Bearer {token}"}

        accepted = client.post(
            "/internal/evidence-uploads/reclaim",
            headers=headers,
            json={
                "jobId": job_id,
                "caseSlug": completed_slug,
                "evidenceBase": "evidence",
                "receipt": {"aoaDeg": 0.0},
                "receiptHmac": "a" * 64,
            },
        )
        active = client.post(
            "/internal/evidence-uploads/reclaim",
            headers=headers,
            json={
                "jobId": job_id,
                "caseSlug": active_slug,
                "evidenceBase": "evidence",
                "receipt": {"aoaDeg": 1.0},
                "receiptHmac": "a" * 64,
            },
        )
        missing = client.post(
            "/internal/evidence-uploads/reclaim",
            headers=headers,
            json={
                "jobId": job_id,
                "caseSlug": "condition_missing",
                "evidenceBase": "evidence",
                "receipt": {"aoaDeg": 2.0},
                "receiptHmac": "a" * 64,
            },
        )

        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["bytes_freed"] == 4096
        assert active.status_code == 409
        assert missing.status_code == 409
        assert calls == [completed_slug]
        assert lock_modes == [False]
    finally:
        get_settings.cache_clear()
