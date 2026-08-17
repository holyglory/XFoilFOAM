from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LADDER = (ROOT / "apps/sweeper/src/urans-ladder.ts").read_text()
LOOP = (ROOT / "apps/sweeper/src/loop.ts").read_text()
BREAKER = (ROOT / "packages/db/src/sweeper-admission-breaker.ts").read_text()


def test_archive_recovery_actions_cannot_create_physical_solver_owners() -> None:
    assert "routeArchiveInterpretationRecoveryActions" not in LADDER
    assert "routeLegacyUransArchiveGapRecoveryActions" not in LADDER
    assert "archive interpretation recovery: routed" not in LADDER
    assert "legacy archive-gap recovery: routed" not in LADDER


def test_current_result_archive_reduction_stays_outside_physical_admission() -> None:
    reduction = LOOP.index("scheduleArchiveReductionQueueDrain(")
    admission = LOOP.index("if (\n    localCapacityOpen")
    assert reduction > admission


def test_legacy_missing_video_cannot_directly_fence_solver_capacity() -> None:
    assert "missing-urans-video" not in BREAKER
    assert "point.result_id = incident.result_id" in BREAKER
    assert "campaign.current_condition_generation" in BREAKER
