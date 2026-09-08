import io
import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

from airfoilfoam import control_canary


@pytest.mark.parametrize("mode", ["busy", "finished_during_inspection", "wrong_job", "queued_control", "incomplete_stop"])
def test_live_control_verifier_requires_real_busy_inspection_and_exact_stop(monkeypatch, capsys, mode):
    identity = None
    inspections = 0
    statuses = 0
    submitted = []

    def request(request, **kwargs):
        nonlocal identity, inspections, statuses
        path = request.full_url
        if path.endswith("/health"):
            payload = {"status": "ok"}
        elif path.endswith("/polars"):
            body = json.loads(request.data)
            submitted.append(body)
            identity = body["execution_id"]
            payload = {"job_id": identity, "state": "pending"}
        elif path.endswith("/execution-stop-proof"):
            inspections += 1
            if inspections == 1 and mode == "queued_control":
                raise HTTPError(path, 503, "worker slot unavailable", None, None)
            payload = {"version": 1, "job_id": identity, "execution_stopped": inspections > 1,
                       "producer_stopped": inspections > 1, "namespace_verified": inspections > 1,
                       "remaining": [], "error": None}
            if mode == "incomplete_stop" and inspections > 1:
                payload["namespace_verified"] = False
        elif path.endswith("/cancel"):
            payload = {"job_id": identity, "cancelled": True}
        else:
            statuses += 1
            payload = {"job_id": "another" if mode == "wrong_job" and statuses == 2 else identity,
                       "state": "completed" if mode == "finished_during_inspection" and statuses == 2 else "running",
                       "solver_budget_progress": {"cases": [{"solver_running": True, "solver_active_seconds": 1}]}}
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(control_canary, "urlopen", request)
    coordinates = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    if mode == "busy":
        assert control_canary.verify_control("http://isolated.test", coordinates, "isolated-test-token")["outcome"] == "passed"
    else:
        with pytest.raises((RuntimeError, HTTPError)):
            control_canary.verify_control("http://isolated.test", coordinates, "isolated-test-token")
    report = json.loads(capsys.readouterr().out)
    assert report["outcome"] == ("passed" if mode == "busy" else "failed")
    assert report["aerodynamic_result_claimed"] is False
    assert submitted[0]["resources"]["cpu_budget"] == 1
    assert submitted[0]["resources"]["case_solver_budget_seconds"] == 60
