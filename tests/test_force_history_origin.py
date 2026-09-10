import math

import pytest

from airfoilfoam.archive_reduction import _force_history_transport
from airfoilfoam.models import ForceHistory
from airfoilfoam.models import CaseSpec
from airfoilfoam.jobs import _outcome_to_point
from airfoilfoam.pipeline import CaseOutcome
from windowed_force_history_fixture import windowed_history_fixture


@pytest.mark.parametrize("offset", [-203.0, 0.0, 203.0])
def test_actual_producer_and_transport_keep_origin_before_windowing(offset):
    history, transported = windowed_history_fixture(offset)
    assert len(history.t) <= 80
    assert history.source_start_time == pytest.approx(offset)
    assert history.window_start == pytest.approx(history.t[0])
    assert history.window_start - history.source_start_time > 0.05
    assert transported.source_start_time == pytest.approx(offset)
    assert _force_history_transport(history)["source_start_time"] == pytest.approx(offset)
    payload = transported.model_dump(mode="json", exclude_unset=True)
    assert ForceHistory.model_validate(payload).model_dump(mode="json", exclude_unset=True) == payload


def test_legacy_history_does_not_acquire_invented_origin_or_replay_fields():
    history, transported = windowed_history_fixture()
    payload = transported.model_dump(mode="json", exclude_unset=True)
    del payload["source_start_time"]
    restored = ForceHistory.model_validate(payload)
    assert restored.model_dump(mode="json", exclude_unset=True) == payload
    assert "source_start_time" not in restored.model_dump(mode="json")
    history.source_start_time = None
    assert "source_start_time" not in _force_history_transport(history)
    outcome = CaseOutcome(spec=CaseSpec(chord=1, speed=20, aoa_deg=0), reynolds=1_000_000, force_history=history, unsteady=True)
    point = _outcome_to_point("isolated-legacy-history", "fixture", outcome)
    assert point.force_history.model_dump(mode="json", exclude_unset=True) == payload


@pytest.mark.parametrize("origin", [math.nan, math.inf, -math.inf, 999.0])
def test_invalid_origin_cannot_become_source_provenance(origin):
    history, transported = windowed_history_fixture()
    payload = transported.model_dump(mode="json", exclude_unset=True)
    payload["source_start_time"] = origin
    with pytest.raises(ValueError):
        ForceHistory.model_validate(payload)
    history.source_start_time = origin
    with pytest.raises(ValueError, match="source history start"):
        _force_history_transport(history)


@pytest.mark.parametrize("origin", [True, "0"])
def test_origin_metadata_requires_a_real_number(origin):
    _, transported = windowed_history_fixture()
    payload = transported.model_dump(mode="json", exclude_unset=True)
    payload["source_start_time"] = origin
    with pytest.raises(ValueError):
        ForceHistory.model_validate(payload)
