"""All-channel raw RANS final-window certificate contract.

These checks deliberately exercise the engine's normal finalizer rather than
constructing a transport payload by hand: an accepted steady point must carry
proof from its real raw coefficient rows, while a converged point with an
unsettled Cm is explicitly null (never a fake legacy certificate).
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.jobs import _outcome_to_point
from airfoilfoam.models import (
    CaseSpec,
    FluidProperties,
    MeshParams,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import CaseOutcome, _finalize_outcome
from airfoilfoam.postprocess.forces import (
    RANS_HOLD_CERTIFICATE_VERSION,
    RANS_HOLD_REQUIRED_SAMPLES,
    analyze_rans_hold,
)


HEADER = "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _coeff_path(case_dir: Path) -> Path:
    return case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"


def _write_coefficients(case_dir: Path, *, cm_at, n: int = 260) -> Path:
    path = _coeff_path(case_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    for iteration in range(1, n + 1):
        # Keep a small finite final-window ripple below 0.25% in every stable
        # channel.  The first 60 rows are intentionally unrelated startup
        # history and must not alter the exact final 200-row proof.
        cl = 0.8 + (0.02 if iteration <= 60 else 2.0e-5 * math.sin(iteration))
        cd = 0.02 + (0.002 if iteration <= 60 else 2.0e-7 * math.cos(iteration))
        cm = cm_at(iteration)
        lines.append(
            f"{iteration} {cd:.12g} 0 0 {cl:.12g} 0 0 {cm:.12g} 0 0 0 0 0"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _finalize_converged_steady(case_dir: Path) -> CaseOutcome:
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=20.0, aoa_deg=3.0),
        reynolds=1_000_000,
        converged=True,
    )
    _finalize_outcome(
        case_dir,
        outcome,
        airfoil=SimpleNamespace(name="hold-cert airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(transient_fallback=True, write_images=[]),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    return outcome


def test_rans_hold_certificate_uses_exact_raw_final_window_and_serializes(tmp_path: Path):
    case_dir = tmp_path / "steady"
    _write_coefficients(
        case_dir,
        cm_at=lambda iteration: -0.03 + (2.0e-6 * math.sin(iteration)),
    )

    outcome = _finalize_converged_steady(case_dir)

    certificate = outcome.rans_hold_certificate
    assert certificate is not None
    assert certificate.reducer_version == RANS_HOLD_CERTIFICATE_VERSION
    assert certificate.sample_count == certificate.required_sample_count == RANS_HOLD_REQUIRED_SAMPLES
    assert certificate.start_iteration == 61
    assert certificate.end_iteration == 260
    assert certificate.certified is True
    assert certificate.cl.relative_spread <= certificate.relative_tolerance
    assert certificate.cd.relative_spread <= certificate.relative_tolerance
    assert certificate.cm.relative_spread <= certificate.relative_tolerance

    point = _outcome_to_point("job", "case", outcome)
    encoded = json.loads(point.model_dump_json())["rans_hold_certificate"]
    assert set(encoded) == {
        "reducer_version",
        "sample_count",
        "required_sample_count",
        "start_iteration",
        "end_iteration",
        "relative_tolerance",
        "absolute_floor",
        "certified",
        "cl",
        "cd",
        "cm",
    }
    assert set(encoded["cm"]) == {
        "mean",
        "min_value",
        "max_value",
        "peak_to_peak",
        "relative_spread",
    }


def test_unsettled_cm_leaves_current_rans_certificate_explicitly_null(tmp_path: Path):
    case_dir = tmp_path / "cm-drift"
    _write_coefficients(
        case_dir,
        # Cl/Cd are held; Cm remains materially unsettled.  A Cl/Cd-only
        # plateau must never turn that into a certified steady result.
        cm_at=lambda iteration: -0.03 + 0.002 * math.sin(iteration / 3.0),
    )

    raw = analyze_rans_hold(_coeff_path(case_dir))
    assert raw is not None
    assert not raw.certified
    assert "Cm" in raw.reason

    outcome = _finalize_converged_steady(case_dir)
    assert outcome.converged  # producer behavior is unchanged; control plane gates proof.
    assert outcome.rans_hold_certificate is None
    point = _outcome_to_point("job", "case", outcome)
    assert json.loads(point.model_dump_json())["rans_hold_certificate"] is None


def test_rans_hold_refuses_incomplete_or_nonfinite_raw_evidence(tmp_path: Path):
    short = tmp_path / "short"
    _write_coefficients(short, cm_at=lambda _iteration: -0.03, n=199)
    assert analyze_rans_hold(_coeff_path(short)) is None

    nonfinite = tmp_path / "nonfinite"
    path = _write_coefficients(nonfinite, cm_at=lambda _iteration: -0.03)
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[-1] = lines[-1].replace("-0.03 0 0 0 0 0", "nan 0 0 0 0 0")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert analyze_rans_hold(path) is None

    malformed = tmp_path / "malformed"
    malformed_path = _write_coefficients(malformed, cm_at=lambda _iteration: -0.03)
    malformed_path.write_text(
        malformed_path.read_text(encoding="utf-8") + "not-a-coefficient-row\n",
        encoding="utf-8",
    )
    # A permissive display parser may still inspect the earlier rows, but a
    # proof reducer must not skip this final corruption and certify stale data.
    assert analyze_rans_hold(malformed_path) is None

