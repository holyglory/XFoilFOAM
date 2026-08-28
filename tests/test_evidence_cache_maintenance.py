from __future__ import annotations

from types import SimpleNamespace

from airfoilfoam.api import main as api_main
from airfoilfoam.config import Settings


class _BoundedStop:
    def __init__(self, waits_before_stop: int) -> None:
        self.waits_before_stop = waits_before_stop
        self.waits = 0

    def is_set(self) -> bool:
        return False

    def wait(self, seconds: float) -> bool:
        assert seconds == 10
        self.waits += 1
        return self.waits >= self.waits_before_stop


def test_hydration_cache_defaults_leave_full_slot_headroom(tmp_path) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path)

    assert settings.evidence_hydration_cache_max_gb == 10.0
    assert settings.evidence_hydration_cache_cleanup_interval_seconds == 300


def test_periodic_cleanup_runs_without_an_evidence_read_and_reports_reclaim(
    tmp_path, monkeypatch, capsys
) -> None:
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        evidence_hydration_cache_cleanup_interval_seconds=10,
    )
    calls = 0

    def cleanup(_settings):
        nonlocal calls
        calls += 1
        return SimpleNamespace(
            entries_removed=2,
            bytes_removed=3 * 1024**3,
            bytes_remaining=7 * 1024**3,
        )

    monkeypatch.setattr(
        api_main, "run_evidence_hydration_cache_maintenance_once", cleanup
    )

    api_main._evidence_hydration_cache_maintenance_loop(
        settings, _BoundedStop(waits_before_stop=1)  # type: ignore[arg-type]
    )

    assert calls == 1
    assert "freed 3.0 GiB, 7.0 GiB remains" in capsys.readouterr().out


def test_periodic_cleanup_recovers_after_one_failed_pass(
    tmp_path, monkeypatch, capsys
) -> None:
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        evidence_hydration_cache_cleanup_interval_seconds=10,
    )
    calls = 0

    def cleanup(_settings):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary cache scan failure")
        return SimpleNamespace(
            entries_removed=0,
            bytes_removed=0,
            bytes_remaining=0,
        )

    monkeypatch.setattr(
        api_main, "run_evidence_hydration_cache_maintenance_once", cleanup
    )

    api_main._evidence_hydration_cache_maintenance_loop(
        settings, _BoundedStop(waits_before_stop=2)  # type: ignore[arg-type]
    )

    assert calls == 2
    assert "cleanup failed: temporary cache scan failure" in capsys.readouterr().out
