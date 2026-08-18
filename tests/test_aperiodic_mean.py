from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from airfoilfoam import pipeline
from airfoilfoam.aperiodic_evaluator import (
    evaluate_rejected_record,
    summarize_evaluations,
)
from airfoilfoam.models import CaseSpec, SolverParams
from airfoilfoam.pipeline import UransQuality
from airfoilfoam.postprocess.unsteady import CleanCycleAudit, CycleAudit
from airfoilfoam.postprocess.aperiodic import (
    APERIODIC_MEAN_CERTIFICATE_VERSION,
    reduce_aperiodic_mean,
)


def stable_history(samples: int = 2400, duration: float = 0.02):
    t = np.linspace(0.0, duration, samples)
    rng = np.random.default_rng(1701)

    def broadband(scale: float, width: int) -> np.ndarray:
        raw = rng.normal(0.0, 1.0, samples + 2 * width)
        kernel = np.hanning(2 * width + 1)
        kernel /= kernel.sum()
        filtered = np.convolve(raw, kernel, mode="valid")
        filtered -= filtered.mean()
        filtered *= scale / max(filtered.std(), 1e-12)
        return filtered

    cl = 0.72 + broadband(0.055, 17)
    cd = 0.082 + broadband(0.006, 13)
    cm = -0.11 + broadband(0.009, 19)
    return t, cl, cd, cm


def reduce(
    history,
    *,
    prior_diagnostic: str = "",
    periodicity_cycles_observed: int = 8,
    periodicity_nonrepeatable_cycles: int = 6,
    periodicity_contaminated: bool = False,
):
    t, cl, cd, cm = history
    return reduce_aperiodic_mean(
        t=t,
        cl=cl,
        cd=cd,
        cm=cm,
        speed=30.0,
        chord=0.05,
        field_frame_count=120,
        prior_diagnostic=prior_diagnostic,
        candidate_period_s=0.002,
        periodicity_cycles_observed=periodicity_cycles_observed,
        periodicity_nonrepeatable_cycles=periodicity_nonrepeatable_cycles,
        periodicity_contaminated=periodicity_contaminated,
    )


def test_certifies_a_stable_nonperiodic_mean_deterministically() -> None:
    first = reduce(stable_history())
    second = reduce(stable_history())

    assert first.reasons == ()
    assert first.certificate is not None
    assert first.certificate.reducer_version == APERIODIC_MEAN_CERTIFICATE_VERSION
    assert first.certificate.convective_times == pytest.approx(12.0)
    assert first.certificate.field_frame_count == 120
    assert first.certificate.input_sha256 == second.certificate.input_sha256
    assert first.certificate.cl.mean == second.certificate.cl.mean


def test_rejects_explicit_prior_monotonic_or_amplitude_growth_diagnostics() -> None:
    monotonic = reduce(
        stable_history(),
        prior_diagnostic="cycle means trend upward monotonically",
    )
    growing = reduce(
        stable_history(),
        prior_diagnostic="oscillation amplitude growing (x1.5)",
    )

    assert monotonic.certificate is None
    assert monotonic.reasons == ("prior-monotonic-trend",)
    assert growing.certificate is None
    assert growing.reasons == ("prior-amplitude-growth",)


def test_rejects_missing_repeatable_or_contaminated_periodicity_evidence() -> None:
    too_few = reduce(stable_history(), periodicity_cycles_observed=3)
    repeatable = reduce(
        stable_history(),
        periodicity_cycles_observed=8,
        periodicity_nonrepeatable_cycles=1,
    )
    contaminated = reduce(stable_history(), periodicity_contaminated=True)

    assert too_few.certificate is None
    assert "insufficient-periodicity-cycles" in too_few.reasons
    assert repeatable.certificate is None
    assert "periodicity-not-disproven" in repeatable.reasons
    assert contaminated.certificate is None
    assert "periodicity-assessment-contaminated" in contaminated.reasons


def test_rejects_raw_mean_drift_and_amplitude_growth() -> None:
    t, cl, cd, cm = stable_history()
    phase = t / t[-1]
    drifted = reduce((t, cl + 0.35 * phase, cd + 0.04 * phase, cm,))
    growing = reduce(
        (
            t,
            0.72 + (1 + 1.2 * phase) * (cl - 0.72),
            0.082 + (1 + 1.2 * phase) * (cd - 0.082),
            -0.11 + (1 + 1.2 * phase) * (cm + 0.11),
        )
    )

    assert drifted.certificate is None
    assert any("trend" in reason or "drift" in reason for reason in drifted.reasons)
    assert growing.certificate is None
    assert any("amplitude-growth" in reason for reason in growing.reasons)


def test_rejects_short_sparse_nonfinite_and_nonpositive_drag_evidence() -> None:
    short = reduce(stable_history(duration=0.004))
    t, cl, cd, cm = stable_history()
    sparse_mask = (t < 0.008) | (t > 0.012)
    sparse = reduce((t[sparse_mask], cl[sparse_mask], cd[sparse_mask], cm[sparse_mask]))
    nonfinite_cl = cl.copy()
    nonfinite_cl[50] = np.nan
    nonfinite = reduce((t, nonfinite_cl, cd, cm))
    invalid_cd = cd.copy()
    invalid_cd[100] = 0.0
    nonpositive_drag = reduce((t, cl, invalid_cd, cm))

    assert short.certificate is None
    assert short.reasons == ("insufficient-observation-horizon",)
    assert short.additional_convective_times is not None
    assert short.additional_convective_times > 0
    assert sparse.certificate is None
    assert "source-cadence-gap" in sparse.reasons
    assert nonfinite.certificate is None
    assert "non-finite-evidence" in nonfinite.reasons
    assert nonpositive_drag.certificate is None
    assert "non-positive-instantaneous-drag" in nonpositive_drag.reasons


def _write_force_coefficients(
    path: Path,
    t: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    rows.extend(
        f"{time:.12g} {drag:.12g} 0 0 {lift:.12g} 0 0 {moment:.12g} 0 0 0 0 0"
        for time, lift, drag, moment in zip(t, cl, cd, cm, strict=True)
    )
    path.write_text("\n".join(rows) + "\n")


def _nonrepeatable_cycle_audit() -> CleanCycleAudit:
    cycles = tuple(
        CycleAudit(
            index=index,
            start=index * 0.002,
            end=(index + 1) * 0.002,
            samples=300,
            frames=20,
            phase_gap=0.01,
            phase_shift_bins=8,
            cl_mean=0.72,
            cd_mean=0.082,
            cm_mean=-0.11,
            cl_shape_error=0.2,
            cd_shape_error=0.2,
            cm_shape_error=0.2,
            cl_amplitude_deviation=0.4,
            cd_amplitude_deviation=0.4,
            cm_amplitude_deviation=0.4,
            cl_high_frequency=0.0,
            cd_high_frequency=0.0,
            cm_high_frequency=0.0,
            soft_reasons=("phase-repeatability failed",),
        )
        for index in range(8)
    )
    return CleanCycleAudit(
        period_s=0.002,
        phase_samples=96,
        cycles=cycles,
        terminal_clean_cycles=0,
        required_clean_cycles=3,
        template_cycles=3,
        shape_error=0.2,
        measured_periods=8,
    )


def test_precalc_pipeline_emits_the_immutable_aperiodic_certificate(tmp_path) -> None:
    t, cl, cd, cm = stable_history()
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_force_coefficients(coeff, t, cl, cd, cm)
    for frame_time in np.linspace(float(t[0]), float(t[-1]), 121):
        (tmp_path / f"{frame_time:.12g}").mkdir(exist_ok=True)

    quality = pipeline._grade_precalc_aperiodic_mean(
        tmp_path,
        [coeff],
        CaseSpec(chord=0.05, speed=30.0, aoa_deg=13.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            transient_discard_fraction=0.0,
        ),
        UransQuality(
            ok=False,
            can_refine=True,
            reason="periodic clean-cycle quality was not repeatable",
            clean_cycle_audit=_nonrepeatable_cycle_audit(),
        ),
        early_stopped=False,
    )

    assert quality.ok
    assert not quality.can_refine
    assert quality.aperiodic_reasons == ()
    assert quality.aperiodic_mean_certificate is not None
    assert quality.aperiodic_mean_certificate.reducer_version == (
        APERIODIC_MEAN_CERTIFICATE_VERSION
    )


def test_retrospective_evaluator_is_nonpublishing_and_reports_efficiency() -> None:
    t, cl, cd, cm = stable_history()
    raw = {
        "obligation_id": "obligation-1",
        "result_attempt_id": "attempt-1",
        "speed": 30.0,
        "chord": 0.05,
        "field_frame_count": 120,
        "estimated_cpu_hours": 2.5,
        "restartable": True,
        "evidence_payload": {
            "force_history": {
                "t": t.tolist(),
                "cl": cl.tolist(),
                "cd": cd.tolist(),
                "cm": cm.tolist(),
            },
            "urans_cycle_certificate": {
                "period_s": 0.002,
                "cycles": [
                    {
                        "disposition": "settling_outlier",
                        "field_frames": 20,
                        "reasons": ["phase-repeatability failed"],
                    }
                    for _ in range(8)
                ],
            },
            "quality_warnings": ["periodic cycles were not repeatable"],
        },
    }
    evaluation = evaluate_rejected_record(raw)
    summary = summarize_evaluations([evaluation])

    assert evaluation["certificate_candidate"] is True
    assert evaluation["recommended_action"] == "rerun_statistical_mean_contract"
    assert evaluation["certificate"] is not None
    assert summary.certificate_candidates == 1
    assert summary.estimated_rerun_cpu_hours == pytest.approx(2.5)
    assert summary.estimated_cpu_hours_per_certificate_candidate == pytest.approx(2.5)
