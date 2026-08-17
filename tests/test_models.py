import json

import pytest

from airfoilfoam.models import (
    AoASpec,
    FluidProperties,
    JobResult,
    LEGACY_NO_SHEDDING_CERTIFICATE_VERSION,
    NO_SHEDDING_CERTIFICATE_VERSION,
    PolarRequest,
    SolverParams,
    UransCycleCertificateCycle,
    UransCycleDisposition,
)


def _no_shedding_certificate_payload(*, reducer_version: str) -> dict:
    return {
        "reducer_version": reducer_version,
        "certified": True,
        "required_observation_s": 4.2,
        "observation_start_time": 1.8,
        "observation_end_time": 6.0,
        "observed_observation_s": 4.2,
        "source_sample_count": 401,
        "transport_sample_count": 400,
        "relative_tolerance": 0.005,
        "absolute_floor": 0.001,
        "cl_mean": 0.0006,
        "cd_mean": 0.012,
        "cm_mean": -0.0002,
        "cl_rms": 0.0001,
        "cd_rms": 0.00002,
        "cm_rms": 0.00001,
        "transport_cl_mean": 0.00059,
        "transport_cd_mean": 0.01201,
        "transport_cm_mean": -0.00019,
        "transport_cl_rms": 0.00012,
        "transport_cd_rms": 0.00003,
        "transport_cm_rms": 0.00002,
    }


def _job_with_no_shedding_certificate(reducer_version: str) -> dict:
    return {
        "job_id": "f6bc7a18428e4a32a3d73c4123eca78f",
        "state": "failed",
        "polars": [
            {
                "speed": 166.0,
                "chord": 0.05,
                "reynolds": 566000.0,
                "points": [
                    {
                        "case_slug": "c0p05_u166_a11",
                        "aoa_deg": 11.0,
                        "unsteady": True,
                        "no_shedding_certificate": _no_shedding_certificate_payload(
                            reducer_version=reducer_version
                        ),
                    }
                ],
            }
        ],
    }


def test_job_result_keeps_legacy_no_shedding_certificate_transport_readable():
    result = JobResult.model_validate(
        _job_with_no_shedding_certificate(
            LEGACY_NO_SHEDDING_CERTIFICATE_VERSION
        )
    )

    certificate = result.polars[0].points[0].no_shedding_certificate
    assert certificate is not None
    assert certificate.reducer_version == LEGACY_NO_SHEDDING_CERTIFICATE_VERSION


def test_job_result_no_shedding_certificate_rejects_unknown_version():
    with pytest.raises(ValueError):
        JobResult.model_validate(
            _job_with_no_shedding_certificate("no-shedding-v0")
        )


def test_current_no_shedding_certificate_version_remains_v2():
    assert NO_SHEDDING_CERTIFICATE_VERSION == "no-shedding-v2"


def test_aoa_explicit_list():
    assert AoASpec(angles=[0, 5, 10]).expand() == [0, 5, 10]


def test_aoa_range_inclusive():
    assert AoASpec(start=-2, stop=4, step=2).expand() == [-2, 0, 2, 4]


def test_aoa_dedup_list_and_range():
    spec = AoASpec(angles=[0], start=0, stop=2, step=1)
    assert spec.expand() == [0, 1, 2]


def test_aoa_requires_something():
    with pytest.raises(ValueError):
        AoASpec()


def test_fluid_nu_from_mu_rho():
    f = FluidProperties(density=2.0, dynamic_viscosity=4.0)
    assert f.nu == 2.0


def test_fluid_nu_explicit():
    f = FluidProperties(density=1.0, kinematic_viscosity=1.23e-5)
    assert f.nu == 1.23e-5


def test_polar_request_cartesian_cases():
    req = PolarRequest(
        airfoil={"name": "a", "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]},
        chord_lengths=[0.5, 1.0],
        speeds=[20, 40],
        aoa=AoASpec(angles=[0, 5]),
    )
    cases = req.cases()
    assert len(cases) == 2 * 2 * 2
    slugs = {c.slug for c in cases}
    assert len(slugs) == 8  # all unique


def test_transient_max_courant_default_pinned_at_practitioner_ceiling():
    """PIN (prod 2026-07-07, job b01a7d46): relaxed-PIMPLE URANS at Co=15
    accumulated splitting error over the multi-period horizon into a velocity
    singularity (dt collapse, |Cl| excursions ±9.45e5). 4 is the
    practitioner-standard ceiling; profiles may still override the field."""
    assert SolverParams().transient_max_courant == pytest.approx(4.0)
    assert SolverParams(transient_max_courant=15.0).transient_max_courant == pytest.approx(15.0)


def test_case_slug_safe():
    req = PolarRequest(
        airfoil={"name": "a", "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]},
        chord_lengths=[1.0], speeds=[40], aoa=AoASpec(angles=[-2.5]),
    )
    slug = req.cases()[0].slug
    assert "." not in slug and "-" not in slug


def _cycle_certificate_payload(*, disposition: str = "hard_corrupt") -> dict:
    return {
        "reducer_version": "clean-cycle-v3",
        "period_s": 0.02,
        "phase_samples": 96,
        "required_clean_cycles": 3,
        "terminal_clean_cycles": 3,
        "selected_cycle_start_index": 1,
        "certified": True,
        "cadence_adjusted": False,
        "cycles": [
            {
                "index": 0,
                "t_start": 0.0,
                "t_end": 0.02,
                "coefficient_samples": 24,
                "field_frames": 24,
                "phase_max_gap": 0.02,
                "phase_shift_bins": 1,
                "cl_mean": 0.80,
                "cd_mean": 0.03,
                "cm_mean": -0.09,
                "cl_shape_error": 0.02,
                "cd_shape_error": 0.02,
                "cm_shape_error": 0.02,
                "cl_amplitude_deviation": None,
                "cd_amplitude_deviation": None,
                "cm_amplitude_deviation": None,
                "cl_high_frequency": 0.01,
                "cd_high_frequency": 0.01,
                "cm_high_frequency": 0.01,
                "disposition": disposition,
                "reasons": ["phase template unavailable"],
            },
            *[
                {
                    "index": index,
                    "t_start": index * 0.02,
                    "t_end": (index + 1) * 0.02,
                    "coefficient_samples": 24,
                    "field_frames": 24,
                    "phase_max_gap": 0.02,
                    "phase_shift_bins": 1,
                    "cl_mean": 0.81,
                    "cd_mean": 0.031,
                    "cm_mean": -0.09,
                    "cl_shape_error": 0.02,
                    "cd_shape_error": 0.02,
                    "cm_shape_error": 0.02,
                    "cl_amplitude_deviation": 0.02,
                    "cd_amplitude_deviation": 0.02,
                    "cm_amplitude_deviation": 0.02,
                    "cl_high_frequency": 0.01,
                    "cd_high_frequency": 0.01,
                    "cm_high_frequency": 0.01,
                    "disposition": "selected",
                    "reasons": [],
                }
                for index in (1, 2, 3)
            ],
        ],
    }


def _legacy_result_payload(certificate: dict) -> dict:
    return {
        "job_id": "legacy-null-cycle-metrics",
        "state": "completed",
        "polars": [
            {
                "speed": 30.0,
                "chord": 0.1,
                "reynolds": 200_000.0,
                "points": [
                    {
                        "aoa_deg": 12.0,
                        "cl": 0.81,
                        "cd": 0.031,
                        "cm": -0.09,
                        "cl_cd": 0.81 / 0.031,
                        "unsteady": True,
                        "converged": True,
                        "first_order_fallback": False,
                        "images": {},
                        "urans_cycle_certificate": certificate,
                    }
                ],
            }
        ],
    }


def test_legacy_null_urans_cycle_metrics_remain_hard_corrupt_and_result_readable():
    """MUST-CATCH: deployed legacy results must ingest without reviving bad cycles."""
    result = JobResult.model_validate_json(
        json.dumps(_legacy_result_payload(_cycle_certificate_payload()))
    )

    certificate = result.polars[0].points[0].urans_cycle_certificate
    assert certificate is not None
    corrupt = certificate.cycles[0]
    assert corrupt.disposition is UransCycleDisposition.hard_corrupt
    assert corrupt.cl_amplitude_deviation is None
    assert corrupt.cd_amplitude_deviation is None
    assert corrupt.cm_amplitude_deviation is None
    assert any(reason.startswith("unavailable cycle metrics:") for reason in corrupt.reasons)
    # The corrupt prefix is retained; it cannot become part of the later
    # exact clean suffix merely because legacy JSON represented it as null.
    assert certificate.certified is True
    assert [cycle.index for cycle in certificate.cycles if cycle.disposition is UransCycleDisposition.selected] == [1, 2, 3]


def test_urans_cycle_metric_keys_remain_required_when_null_is_supported():
    """False-positive guard: compatibility with null must not accept shape drift."""
    certificate = _cycle_certificate_payload()
    del certificate["cycles"][0]["cl_amplitude_deviation"]

    with pytest.raises(ValueError, match="cl_amplitude_deviation"):
        JobResult.model_validate(_legacy_result_payload(certificate))


def test_current_nonfinite_cycle_diagnostics_serialize_as_explicit_unavailable_state():
    cycle = UransCycleCertificateCycle(
        index=0,
        t_start=0.0,
        t_end=0.02,
        coefficient_samples=24,
        field_frames=24,
        phase_max_gap=0.02,
        phase_shift_bins=1,
        cl_mean=0.80,
        cd_mean=0.03,
        cm_mean=-0.09,
        cl_shape_error=float("inf"),
        cd_shape_error=float("inf"),
        cm_shape_error=float("inf"),
        cl_amplitude_deviation=float("inf"),
        cd_amplitude_deviation=float("inf"),
        cm_amplitude_deviation=float("inf"),
        cl_high_frequency=0.01,
        cd_high_frequency=0.01,
        cm_high_frequency=0.01,
        disposition=UransCycleDisposition.settling_outlier,
    )

    serialized = cycle.model_dump(mode="json")
    assert cycle.disposition is UransCycleDisposition.hard_corrupt
    assert serialized["cl_shape_error"] is None
    assert serialized["cl_amplitude_deviation"] is None
    assert any(reason.startswith("unavailable cycle metrics:") for reason in cycle.reasons)
    assert "Infinity" not in cycle.model_dump_json()


def test_unavailable_selected_tail_withholds_legacy_certificate_publication():
    """False-positive guard: a null metric cannot remain a certified selection."""
    certificate = _cycle_certificate_payload(disposition="selected")
    certificate["selected_cycle_start_index"] = 0
    result = JobResult.model_validate(_legacy_result_payload(certificate))

    parsed = result.polars[0].points[0].urans_cycle_certificate
    assert parsed is not None
    assert parsed.certified is False
    assert parsed.selected_cycle_start_index is None
    assert not [cycle for cycle in parsed.cycles if cycle.disposition is UransCycleDisposition.selected]
