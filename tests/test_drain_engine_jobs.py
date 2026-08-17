from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "ops"
    / "drain-engine-jobs.py"
)


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("drain_engine_jobs", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_nonterminal_detection_uses_processes_and_real_state() -> None:
    module = load_script()
    assert module.is_nonterminal({"status_state": "running", "process_count": 0})
    assert module.is_nonterminal({"status_state": "completed", "process_count": 1})
    assert not module.is_nonterminal({"status_state": "completed", "process_count": 0})
    assert not module.is_nonterminal({"status_state": None, "process_count": 0})


def test_runtime_rows_are_bounded_to_64_jobs(monkeypatch: object) -> None:
    module = load_script()
    payload_sizes: list[int] = []

    def fake_request(_: str, method: str, path: str, payload: object) -> dict[str, object]:
        assert method == "POST"
        assert path == "/jobs/runtime"
        assert isinstance(payload, dict)
        ids = payload["job_ids"]
        assert isinstance(ids, list)
        payload_sizes.append(len(ids))
        return {"jobs": [{"job_id": item} for item in ids]}

    module.request_json = fake_request
    rows = module.runtime_rows("http://engine", [str(i) for i in range(130)])
    assert len(rows) == 130
    assert payload_sizes == [64, 64, 2]


def test_exact_target_mode_is_required(monkeypatch: object) -> None:
    module = load_script()
    monkeypatch.setattr(module, "parse_args", lambda: type("Args", (), {
        "base_url": "http://engine",
        "timeout_seconds": 1,
        "request_timeout_seconds": 1,
        "workers": 1,
        "inventory_only": False,
        "job_id": [],
    })())
    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {"items": []})

    with pytest.raises(ValueError, match="exact --job-id"):
        module.main()
