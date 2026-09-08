from dataclasses import replace

import numpy as np
import pytest

from airfoilfoam.postprocess.polar_history import HistoryReductionPolicy, PolarHistory, history_observations
from airfoilfoam.postprocess.progressive_polar import fit_progressive_polar
from test_progressive_polar import observation, policy, prior


def history(alpha=0.0, identity="history"):
    times = np.linspace(0.0, 8.0, 161)
    values = np.column_stack((0.1 * alpha + 0.2 + 0.05 * np.sin(2 * np.pi * times),
                              0.024 + 0.002 * np.cos(2 * np.pi * times),
                              -0.03 + 0.003 * np.sin(2 * np.pi * times)))
    return PolarHistory(replace(observation(identity, alpha), numerical_convergence="unconverged",
                                statistical_certification="informative_uncertified"),
                        "a" * 64, "physical_time", times.tolist(), values.tolist(), 2.0, 0.5, "measured-correlation")


def reduction():
    return HistoryReductionPolicy(2.0, 4, [0.01, 0.001, 0.002])


def test_multiple_histories_at_different_angles_inform_one_polar_jointly():
    rows = history_observations(history(-2, "left"), reduction()) + history_observations(history(2, "right"), reduction())
    assert len(rows) == 6
    fitted = fit_progressive_polar(prior(), rows, policy())
    assert len(fitted["contributors"]) == 6
    assert {row["numerical_convergence"] for row in fitted["contributors"]} == {"unconverged"}
    assert fitted["curves"]["composite"]["coefficients"][2][0] > 0.1


def test_blocks_exclude_startup_and_have_nonoverlapping_physical_windows():
    blocks = history_observations(history(), reduction())
    assert [row.window for row in blocks] == [(2, 4), (4, 6), (6, 8)]
    assert len({row.observation_id for row in blocks}) == 3


@pytest.mark.parametrize("maximum", [1, 2, 3])
def test_explicit_block_budget_retains_the_complete_informative_window(maximum):
    source = history()
    rows = history_observations(source, replace(reduction(), block_duration=0.131, maximum_blocks=maximum))
    assert len(rows) == maximum
    assert rows[0].window[0] == 2
    assert rows[-1].window[1] == 8
    assert all(left.window[1] == right.window[0] for left, right in zip(rows, rows[1:]))


def test_bounded_reduction_merges_a_short_tail_without_fabricating_samples():
    source = history()
    rows = history_observations(source, replace(reduction(), block_duration=5.91, maximum_blocks=3))
    assert [row.window for row in rows] == [(2, 8)]


@pytest.mark.parametrize("maximum", [0, 129, True, 1.5])
def test_invalid_block_budgets_are_rejected(maximum):
    with pytest.raises(ValueError, match="reduction policy"):
        history_observations(history(), replace(reduction(), maximum_blocks=maximum))


def test_dense_sampling_does_not_masquerade_as_more_independent_periods():
    dense = history()
    sparse = replace(dense, coordinate=dense.coordinate[::2], coefficients=dense.coefficients[::2])
    dense_error = history_observations(dense, reduction())[0].standard_error
    sparse_error = history_observations(sparse, reduction())[0].standard_error
    np.testing.assert_allclose(dense_error, sparse_error, rtol=0.05)
    unknown = replace(dense, correlation_time=None, correlation_evidence_id=None)
    assert history_observations(unknown, reduction())[0].standard_error[0] >= dense_error[0]


def test_numerical_iterations_are_weak_evidence_not_unsteady_periods():
    source = replace(history(), coordinate_kind="iteration")
    rows = history_observations(source, reduction())
    assert len(rows) == 1
    assert rows[0].window is None
    assert rows[0].statistical_certification == "numerical_iterations_only"


def test_real_time_weighting_does_not_overweight_dense_short_time_samples():
    source = replace(history(), coordinate=[0, 0.01, 0.02, 2.0], informative_start=0.0,
                     coefficients=[[0, 0.02, 0], [0, 0.02, 0], [0, 0.02, 0], [1, 0.02, 0]])
    rows = history_observations(source, reduction())
    assert rows[0].coefficients[0] == pytest.approx(0.495)
    assert rows[0].standard_error[0] > 0.4


def test_drift_increases_uncertainty_without_claiming_certification():
    source = history()
    values = np.array(source.coefficients)
    values[:, 0] += np.array(source.coordinate) * 0.2
    drifting = replace(source, coefficients=values.tolist())
    steady_error = history_observations(source, reduction())[0].standard_error[0]
    rows = history_observations(drifting, reduction())
    assert rows[0].standard_error[0] > 4 * steady_error
    assert rows[0].statistical_certification == "informative_uncertified"


def test_missing_startup_cutoff_evidence_or_corrupt_samples_cannot_be_averaged_away():
    with pytest.raises(ValueError, match="strictly increasing"):
        history_observations(replace(history(), coordinate=[0, 0, 1]), reduction())
    corrupt = history()
    corrupt.coefficients[-1][0] = float("nan")
    with pytest.raises(ValueError, match="history coefficients"):
        history_observations(corrupt, reduction())
    source = replace(history(), informative_start=20)
    assert not history_observations(source, reduction())[0].eligible
    with pytest.raises(ValueError, match="evidence identity"):
        history_observations(replace(history(), correlation_evidence_id=None), reduction())
