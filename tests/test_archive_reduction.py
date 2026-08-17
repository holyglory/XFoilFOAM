"""Raw-archive clean-cycle reduction contract tests.

These tests intentionally provide only archived coefficient members and saved
time-directory names.  They never pass a transport `force_history` payload to
the reducer, which would hide the exact bug this migration is meant to avoid.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import airfoilfoam.archive_reduction as archive_reduction
from airfoilfoam.archive_reduction import reduce_remote_archive_clean_cycles
from airfoilfoam.evidence_store import RemoteEvidencePointer
from airfoilfoam.models import NO_SHEDDING_CERTIFICATE_VERSION
from airfoilfoam.postprocess.unsteady import (
    CleanCycleAudit,
    CycleAudit,
    ForceHistory,
    PeriodEstimate,
)


class FakeVerifiedArchiveStore:
    """Small authenticating-member stand-in for the object-store boundary."""

    def __init__(self, members: dict[str, Path]):
        self.members = members
        self.verifications: list[tuple[RemoteEvidencePointer, bytes | None, bool]] = []

    @contextmanager
    def member_source(self, pointer: RemoteEvidencePointer, member_path: str):
        del pointer
        try:
            yield self.members[member_path]
        except KeyError as exc:  # Mirrors a missing authenticated member.
            raise RuntimeError(f"missing archive member {member_path}") from exc

    def verify_all_manifest_members(
        self,
        pointer: RemoteEvidencePointer,
        *,
        expected_manifest: bytes | None = None,
        fresh_download: bool = False,
    ) -> int:
        self.verifications.append((pointer, expected_manifest, fresh_download))
        # A real store verifies each manifest-declared checksum/size.  This
        # fake proves the reducer asks it to do so before trusting coefficients.
        return len(self.members)


def _pointer() -> RemoteEvidencePointer:
    return RemoteEvidencePointer(
        bucket="airfoils-pro-storage-bucket",
        object_key="solver-evidence/v1/sha256/aa/" + "a" * 64 + ".tar.zst",
        generation=18446744073709551615,
        stored_sha256="a" * 64,
        stored_size=1234,
        tar_sha256="b" * 64,
        tar_size=5678,
        crc32c="AAAAAA==",
        zstd_level=10,
        created_at="2026-07-28T00:00:00.000Z",
    )


def _write_coefficient_history(
    path: Path, *, cycles: int = 12
) -> tuple[float, float]:
    """A corrupt prefix followed by a clean 60 Hz tail."""
    frequency = 60.0
    period = 1.0 / frequency
    dt = period / 120.0
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    for index in range(cycles * 120 + 1):
        time_s = index * dt
        if time_s < 2.0 * period:
            # Deliberately nonphysical start-up/noise: a valid clean-tail
            # interpretation must exclude it rather than averaging it in.
            cl = 0.70 + 0.24 * math.sin(2.0 * math.pi * 23.0 * time_s)
            cd = 0.035 + 0.012 * math.cos(2.0 * math.pi * 37.0 * time_s)
            cm = -0.08 + 0.07 * math.sin(2.0 * math.pi * 17.0 * time_s)
        else:
            cl = 0.70 + 0.075 * math.sin(2.0 * math.pi * frequency * time_s)
            cd = 0.035 + 0.004 * math.sin(
                2.0 * math.pi * frequency * time_s + 0.35
            )
            cm = -0.08 + 0.012 * math.sin(
                2.0 * math.pi * frequency * time_s - 0.20
            )
        rows.append(
            f"{time_s:.12g} {cd:.12g} 0 0 {cl:.12g} 0 0 "
            f"{cm:.12g} 0 0 0 0 0"
        )
    path.write_text("\n".join(rows) + "\n")
    return frequency, period


def _write_flat_coefficient_history(
    path: Path,
    *,
    samples: int = 101,
    end_time: float = 0.4,
    corrupt_prefix: bool = False,
    cm_amplitude: float = 0.0,
    absolute_rms_fallback: bool = False,
    terminal_nonfinite: bool = False,
) -> None:
    """Small raw archive trace for no-shedding contract tests.

    At the manifest default c=0.1 m / U=30 m/s, the shared slow-wake horizon
    is 0.14 s.  A 0.4 s trace therefore lets tests prove that only the exact
    terminal horizon contributes to the accepted steady-equivalent result.
    """
    if samples < 2:
        raise ValueError("flat archive fixture needs at least two rows")
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    fallback_noise = (
        np.random.default_rng(2606).uniform(
            -0.0024, 0.0024, size=(samples, 3)
        )
        if absolute_rms_fallback
        else None
    )
    for index in range(samples):
        time_s = end_time * index / (samples - 1)
        if corrupt_prefix and time_s < 0.12:
            cl = 0.7 + 0.2 * math.sin(2.0 * math.pi * 47.0 * time_s)
            cd = 0.035 + 0.02 * math.cos(2.0 * math.pi * 31.0 * time_s)
            cm = -0.08 + 0.1 * math.sin(2.0 * math.pi * 59.0 * time_s)
        elif absolute_rms_fallback:
            # Bounded channel-local numerical noise: no physical-band period
            # is coherent across either independent half of this raw tail.
            assert fallback_noise is not None
            cl_noise, cd_noise, cm_noise = fallback_noise[index]
            cl = 0.7 + cl_noise
            cd = 0.035 + cd_noise
            cm = -0.08 + cm_noise
        else:
            cl = 0.7
            cd = 0.035
            cm = -0.08 + cm_amplitude * math.sin(2.0 * math.pi * 60.0 * time_s)
        rows.append(
            f"{time_s:.12g} {cd:.12g} 0 0 {cl:.12g} 0 0 "
            f"{cm:.12g} 0 0 0 0 0"
        )
    if terminal_nonfinite:
        # It is deliberately *after* the last valid time.  A permissive
        # numeric reader drops it, so this is the exact regression for the
        # raw_latest_time certificate boundary.
        time_s = end_time + end_time / max(samples - 1, 1)
        rows.append(
            f"{time_s:.12g} 0.035 0 0 nan 0 0 -0.08 0 0 0 0 0"
        )
    path.write_text("\n".join(rows) + "\n")


def _manifest(
    coefficient_path: str | None,
    field_times: list[float],
    *,
    transient_start: float | None = None,
) -> dict:
    files: list[dict[str, object]] = []
    if coefficient_path:
        files.append({"path": coefficient_path, "role": "force_coefficients"})
    files.extend(
        {
            "path": f"time_directories/{time_s:.12g}/U",
            "role": "time_directory",
        }
        for time_s in field_times
    )
    if transient_start is not None:
        files.append(
            {
                "path": "openfoam/transient/transient_start.json",
                "role": "transient_start_marker",
            }
        )
    return {
        "schemaVersion": 2,
        "chordM": 0.1,
        "speedMps": 30.0,
        "aoaDeg": 12.0,
        "unsteady": True,
        "files": files,
    }


def test_legacy_archive_without_urans_provenance_requires_fresh_rerun(
    tmp_path: Path,
) -> None:
    """A legacy marker omission must schedule recovery, never publish a guess."""
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "legacy-coefficient.dat"
    _write_flat_coefficient_history(coefficient_path, samples=80, end_time=0.4)
    manifest = _manifest(coefficient_member, [], transient_start=0.0)
    manifest.pop("unsteady")
    manifest_path = tmp_path / "legacy-evidence_manifest.json"
    manifest_path.write_bytes(json.dumps(manifest, sort_keys=True).encode("utf-8"))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
        }
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "rerun_required"
    assert reduction.point["converged"] is False
    assert reduction.point["urans_cycle_certificate"] is None
    assert reduction.diagnostics["recoveryState"] == "fresh_rerun"
    assert reduction.diagnostics["unsteadyEvidence"] is False
    assert reduction.diagnostics["forceCoefficientMembers"] == [coefficient_member]
    assert store.verifications == []


def test_raw_archive_backfill_excludes_corrupt_startup_and_records_clean_cycles(
    tmp_path: Path,
) -> None:
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    # Twenty-five genuine field writes per period; these are archive facts,
    # not a generated frame track.
    field_times = [
        period * (cycle + frame / 25.0)
        for cycle in range(12)
        for frame in range(25)
    ]
    manifest_bytes = json.dumps(
        _manifest(coefficient_member, field_times, transient_start=0.0),
        sort_keys=True,
    ).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "transient_start.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "accepted"
    assert reduction.point["force_history"] is None
    assert reduction.point.get("frame_track") is None
    certificate = reduction.point["urans_cycle_certificate"]
    assert certificate is not None
    assert certificate["certified"] is True
    assert certificate["required_clean_cycles"] == 3
    assert certificate["selected_cycle_start_index"] is not None
    selected = [
        cycle for cycle in certificate["cycles"] if cycle["disposition"] == "selected"
    ]
    # The archive may contain a longer clean tail, but FAST's immutable
    # publication interpretation owns exactly the final three cycles.
    assert len(selected) == 3
    assert certificate["terminal_clean_cycles"] >= len(selected)
    assert min(cycle["field_frames"] for cycle in selected) >= 20
    # The first two physical periods were corrupt and must be excluded.  Cycle
    # indices are local to the selected tail candidate, so assert time rather
    # than incorrectly treating them as global history indices.
    assert min(cycle["t_start"] for cycle in selected) >= 2.0 * period
    assert reduction.point["cl"] == pytest.approx(0.70, abs=0.01)
    assert reduction.point["cd"] == pytest.approx(0.035, abs=0.002)
    assert len(store.verifications) == 1
    verified_pointer, verified_manifest, fresh_download = store.verifications[0]
    assert verified_pointer == _pointer()
    assert verified_manifest == manifest_bytes
    assert fresh_download is True


def test_raw_archive_backfill_does_not_hide_a_terminal_nonfinite_coefficient(
    tmp_path: Path,
) -> None:
    """A raw NaN remains a failed final period, not an interpolated clean tail."""
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    lines = coefficient_path.read_text().splitlines()
    # The helper writes 120 coefficient rows per physical period.  Put the
    # defect well inside the final one so it cannot be dismissed as a partial
    # terminal write or a cycle-boundary ambiguity.
    fields = lines[-60].split()
    fields[4] = "nan"  # Cl
    lines[-60] = " ".join(fields)
    coefficient_path.write_text("\n".join(lines) + "\n")
    field_times = [
        period * (cycle + frame / 25.0)
        for cycle in range(12)
        for frame in range(25)
    ]
    manifest_bytes = json.dumps(
        _manifest(coefficient_member, field_times, transient_start=0.0),
        sort_keys=True,
    ).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "transient_start.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    # The immutable NaN stays rejected, but v2 may append a bounded fresh tail
    # below its finite emergency ceiling. Publication still requires three
    # contiguous clean cycles; the corrupt row is never interpolated away.
    assert reduction.state == "continuation_required"
    certificate = reduction.point["urans_cycle_certificate"]
    assert certificate is not None
    assert certificate["certified"] is False
    assert any(
        "non-finite coefficient sample" in cycle["reasons"]
        for cycle in certificate["cycles"]
    )
    assert reduction.diagnostics["recommendedAdditionalPeriods"] == 3
    assert reduction.diagnostics["recoveryProgress"] == {
        "policyVersion": "adaptive-clean-tail-v2",
        "measuredPeriods": 12,
        "maxPeriods": 18,
        "recommendedAdditionalPeriods": 3,
    }


def test_raw_archive_backfill_requests_bounded_fresh_cycles_after_a_clean_but_drifting_tail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clean FAST suffix with failed stationarity needs 1--3 new periods.

    The archive reducer previously returned ``continuation_required`` with a
    zero-period recommendation in this branch: clean-cycle repair returned
    zero once the three-cycle suffix existed, even though the independent
    stationarity grade still needed new physical evidence.  The control-plane
    contract correctly rejects a zero continuation, leaving the same case
    stranded instead of continuing it.
    """
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path, cycles=6)
    # Keep this beneath FAST's nine-period physical recovery ceiling.  The
    # branch under test is a recoverable clean-but-drifting suffix, not the
    # separate exhausted-budget outcome.
    field_times = [
        period * (cycle + frame / 25.0)
        for cycle in range(6)
        for frame in range(25)
    ]
    manifest_bytes = json.dumps(
        _manifest(coefficient_member, field_times, transient_start=0.0),
        sort_keys=True,
    ).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "transient_start.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    nonstationary = SimpleNamespace(
        stationary=False,
        stationary_reason="cycle means drift",
        cl=SimpleNamespace(mean=0.70, std=0.01),
        cd=SimpleNamespace(mean=0.035, std=0.002),
        cm=SimpleNamespace(mean=-0.08, std=0.004),
    )
    monkeypatch.setattr(
        archive_reduction,
        "period_window_stats",
        lambda *_args, **_kwargs: nonstationary,
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "continuation_required"
    # A clean but borderline tail receives a fresh bounded guard window, never
    # the invalid zero-period recommendation from the pre-fix path.
    assert reduction.diagnostics["recommendedAdditionalPeriods"] == 3
    progress = reduction.diagnostics["recoveryProgress"]
    assert progress["recommendedAdditionalPeriods"] == 3
    assert 1 <= progress["recommendedAdditionalPeriods"] <= 3


def test_raw_archive_backfill_reports_missing_force_evidence_after_full_manifest_check(
    tmp_path: Path,
) -> None:
    manifest_bytes = json.dumps(_manifest(None, []), sort_keys=True).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    store = FakeVerifiedArchiveStore({"evidence_manifest.json": manifest_path})

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_full",
    )

    assert reduction.state == "missing_evidence"
    assert reduction.point["force_history"] is None
    assert reduction.point["urans_cycle_certificate"] is None
    assert "force coefficient" in reduction.diagnostics["reason"]
    assert len(store.verifications) == 1
    assert store.verifications[0][2] is True


def test_raw_archive_backfill_routes_a_damaged_final_cycle_to_exact_continuation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real cadence plus one damaged terminal cycle is recoverable.

    This is deliberately not a synthetic frame track: the manifest contains
    saved time-directory facts.  A cadence audit marks the last physical cycle
    as corrupt, so a FAST interpretation cannot publish its final three-cycle
    suffix.  The reducer must preserve the authenticated archive and request
    a bounded exact-case continuation rather than declaring the old result a
    terminal rerun.
    """
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    field_times = [
        period * (cycle + frame / 25.0)
        for cycle in range(12)
        for frame in range(25)
    ]
    # This archived transient began after a saved steady/init prefix. The
    # reducer must derive the recovery cap from this authenticated boundary,
    # not from the older coefficient rows retained for forensic context.
    transient_start = 8.0 * period
    manifest_bytes = json.dumps(
        _manifest(
            coefficient_member,
            field_times,
            transient_start=transient_start,
        ),
        sort_keys=True,
    ).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "transient_start.json"
    transient_start_path.write_text(
        json.dumps({"transient_start": transient_start})
    )
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    # The recurrence detector proved a cadence, but its tail selector did not
    # certify a publishable suffix because the last saved physical cycle had
    # a discontinuity.  Model that narrow recovery boundary directly: it
    # belongs to the archive reducer, not to a particular FFT bin choice.
    corrupt_final = CycleAudit(
        index=3,
        start=3.0 * period,
        end=4.0 * period,
        samples=120,
        frames=25,
        phase_gap=0.01,
        phase_shift_bins=0,
        cl_mean=0.7,
        cd_mean=0.035,
        cm_mean=-0.08,
        cl_shape_error=0.01,
        cd_shape_error=0.01,
        cm_shape_error=0.01,
        cl_amplitude_deviation=0.01,
        cd_amplitude_deviation=0.01,
        cm_amplitude_deviation=0.01,
        cl_high_frequency=0.2,
        cd_high_frequency=0.0,
        cm_high_frequency=0.0,
        hard_reasons=("cl high-frequency burst",),
        soft_reasons=(),
    )
    audit = CleanCycleAudit(
        period_s=period,
        phase_samples=96,
        cycles=(corrupt_final,),
        terminal_clean_cycles=0,
        required_clean_cycles=3,
        template_cycles=0,
        shape_error=0.2,
    )
    monkeypatch.setattr(archive_reduction, "clean_periodic_tail", lambda *_a, **_k: None)
    monkeypatch.setattr(
        archive_reduction,
        "estimate_period",
        lambda *_a, **_k: PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
    )
    monkeypatch.setattr(
        archive_reduction,
        "audit_period_cycles",
        lambda *_a, **_k: audit,
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "continuation_required"
    certificate = reduction.point["urans_cycle_certificate"]
    assert certificate is not None
    assert certificate["certified"] is False
    assert certificate["terminal_clean_cycles"] == 0
    assert reduction.diagnostics["requiredCleanCycles"] == 3
    # A damaged terminal cycle gets the bounded three-period recovery chunk.
    assert reduction.diagnostics["recommendedAdditionalPeriods"] == 3
    assert "periodic cadence" in reduction.diagnostics["reason"]
    assert len(store.verifications) == 1
    assert store.verifications[0][2] is True


def test_raw_archive_backfill_continues_a_clean_suffix_when_its_exact_window_is_not_stationary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clean per-cycle suffix gets fresh evidence when its aggregate drifts.

    The archive reducer must never label this a continuation while recommending
    zero periods: that would fail the cross-runtime 1..3 clean-cycle handoff
    contract and leave valid, restartable evidence permanently unpublishable.
    """
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(
        json.dumps(
            _manifest(
                coefficient_member,
                [
                    period * (6 + cycle + frame / 25.0)
                    for cycle in range(6)
                    for frame in range(25)
                ],
                transient_start=6.0 * period,
            ),
            sort_keys=True,
        ).encode("utf-8")
    )
    transient_start_path = tmp_path / "transient_start.json"
    # The exact restart marker bounds this same-case trajectory to six physical
    # periods even though the archive retains older immutable evidence.
    transient_start_path.write_text(json.dumps({"transient_start": 6.0 * period}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )

    def clean_cycle(index: int) -> CycleAudit:
        return CycleAudit(
            index=index,
            start=index * period,
            end=(index + 1) * period,
            samples=120,
            frames=25,
            phase_gap=0.01,
            phase_shift_bins=0,
            cl_mean=0.7,
            cd_mean=0.035,
            cm_mean=-0.08,
            cl_shape_error=0.01,
            cd_shape_error=0.01,
            cm_shape_error=0.01,
            cl_amplitude_deviation=0.01,
            cd_amplitude_deviation=0.01,
            cm_amplitude_deviation=0.01,
            cl_high_frequency=0.0,
            cd_high_frequency=0.0,
            cm_high_frequency=0.0,
        )

    audit = CleanCycleAudit(
        period_s=period,
        phase_samples=96,
        cycles=tuple(clean_cycle(index) for index in range(3)),
        terminal_clean_cycles=3,
        required_clean_cycles=3,
        template_cycles=3,
        shape_error=0.01,
        measured_periods=6,
    )
    tail = SimpleNamespace(
        series=([], [], [], []),
        estimate=PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
        audit=audit,
    )
    stats = SimpleNamespace(
        stationary=False,
        stationary_reason="whole-window mean drift",
        cl=SimpleNamespace(mean=0.70, std=0.02),
        cd=SimpleNamespace(mean=0.035, std=0.001),
        cm=SimpleNamespace(mean=-0.08, std=0.004),
    )
    monkeypatch.setattr(archive_reduction, "clean_periodic_tail", lambda *_a, **_k: tail)
    monkeypatch.setattr(archive_reduction, "period_window_stats", lambda *_a, **_k: stats)

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "continuation_required"
    # The three-period guard lets the next FAST publication window be wholly
    # fresh physical evidence, rather than reusing a borderline aggregate.
    assert reduction.diagnostics["recommendedAdditionalPeriods"] == 3
    assert reduction.diagnostics["recoveryProgress"] == {
        "policyVersion": "adaptive-clean-tail-v2",
        "measuredPeriods": 6,
        "maxPeriods": 18,
        "recommendedAdditionalPeriods": 3,
    }


def test_raw_archive_backfill_guards_a_clean_fallback_audit_without_a_corroborated_tail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clean fallback audit still needs a fresh guard if its cadence is uncorroborated.

    `clean_periodic_tail` deliberately requires a stronger two-half cadence
    proof than `audit_period_cycles`. The archive controller must not report a
    non-executable zero-period continuation when only the fallback audit found
    three clean FAST cycles.
    """
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(
        json.dumps(
            _manifest(
                coefficient_member,
                [
                    period * (6 + cycle + frame / 25.0)
                    for cycle in range(6)
                    for frame in range(25)
                ],
                transient_start=6.0 * period,
            ),
            sort_keys=True,
        ).encode("utf-8")
    )
    transient_start_path = tmp_path / "transient_start.json"
    # The exact restart marker bounds this same-case trajectory to six physical
    # periods even though older immutable evidence remains in the archive.
    transient_start_path.write_text(json.dumps({"transient_start": 6.0 * period}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    audit = CleanCycleAudit(
        period_s=period,
        phase_samples=96,
        cycles=tuple(
            CycleAudit(
                index=index,
                start=index * period,
                end=(index + 1) * period,
                samples=120,
                frames=25,
                phase_gap=0.01,
                phase_shift_bins=0,
                cl_mean=0.7,
                cd_mean=0.035,
                cm_mean=-0.08,
                cl_shape_error=0.01,
                cd_shape_error=0.01,
                cm_shape_error=0.01,
                cl_amplitude_deviation=0.01,
                cd_amplitude_deviation=0.01,
                cm_amplitude_deviation=0.01,
                cl_high_frequency=0.0,
                cd_high_frequency=0.0,
                cm_high_frequency=0.0,
            )
            for index in range(3)
        ),
        terminal_clean_cycles=3,
        required_clean_cycles=3,
        template_cycles=3,
        shape_error=0.01,
        measured_periods=6,
    )
    estimate = PeriodEstimate(
        period_s=period,
        ambiguous=False,
        first_half_s=period,
        second_half_s=period,
    )
    monkeypatch.setattr(
        archive_reduction, "clean_periodic_tail", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        archive_reduction, "estimate_period", lambda *_a, **_k: estimate
    )
    monkeypatch.setattr(
        archive_reduction, "audit_period_cycles", lambda *_a, **_k: audit
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "continuation_required"
    assert reduction.diagnostics["reason"] == (
        "raw evidence has a clean cycle audit but no corroborated exact terminal tail"
    )
    assert reduction.diagnostics["recommendedAdditionalPeriods"] == 3
    assert reduction.diagnostics["recoveryProgress"] == {
        "policyVersion": "adaptive-clean-tail-v2",
        "measuredPeriods": 6,
        "maxPeriods": 18,
        "recommendedAdditionalPeriods": 3,
    }


def test_raw_archive_backfill_never_continues_without_authenticated_transient_origin(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A damaged tail without the source trajectory boundary needs a rerun.

    Counting retained coefficient rows would make a stale steady prefix look
    like actual transient progress and can both exhaust the cap early and
    authorize a continuation from an unknown case.  The archive must carry its
    authenticated `transient_start` marker before the reducer can request more
    same-case periods.
    """
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(
        json.dumps(
            _manifest(
                coefficient_member,
                [period * (cycle + frame / 25.0) for cycle in range(12) for frame in range(25)],
            ),
            sort_keys=True,
        ).encode("utf-8")
    )
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
        }
    )
    corrupt = CycleAudit(
        index=0,
        start=0.0,
        end=period,
        samples=120,
        frames=25,
        phase_gap=0.01,
        phase_shift_bins=0,
        cl_mean=0.7,
        cd_mean=0.035,
        cm_mean=-0.08,
        cl_shape_error=0.01,
        cd_shape_error=0.01,
        cm_shape_error=0.01,
        cl_amplitude_deviation=0.01,
        cd_amplitude_deviation=0.01,
        cm_amplitude_deviation=0.01,
        cl_high_frequency=0.2,
        cd_high_frequency=0.0,
        cm_high_frequency=0.0,
        hard_reasons=("cl high-frequency burst",),
        soft_reasons=(),
    )
    audit = CleanCycleAudit(
        period_s=period,
        phase_samples=96,
        cycles=(corrupt,),
        terminal_clean_cycles=0,
        required_clean_cycles=3,
        template_cycles=0,
        shape_error=0.2,
    )
    monkeypatch.setattr(archive_reduction, "clean_periodic_tail", lambda *_a, **_k: None)
    monkeypatch.setattr(
        archive_reduction,
        "estimate_period",
        lambda *_a, **_k: PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
    )
    monkeypatch.setattr(
        archive_reduction,
        "audit_period_cycles",
        lambda *_a, **_k: audit,
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )

    assert reduction.state == "rerun_required"
    assert "same-case transient start" in reduction.diagnostics["reason"]
    assert "recommendedAdditionalPeriods" not in reduction.diagnostics


@pytest.mark.parametrize(
    ("fidelity", "audited_periods", "required_cycles"),
    [
        ("urans_precalc", 18, 3),
        ("urans_full", 27, 5),
    ],
)
def test_raw_archive_backfill_marks_the_explicit_clean_cycle_cap_critical(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fidelity: str,
    audited_periods: int,
    required_cycles: int,
) -> None:
    """The finite v2 emergency ceilings remain terminal and non-publishing."""

    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "coefficient.dat"
    _frequency, period = _write_coefficient_history(coefficient_path)
    field_times = [
        period * (cycle + frame / 25.0)
        for cycle in range(12)
        for frame in range(25)
    ]
    manifest_bytes = json.dumps(
        _manifest(coefficient_member, field_times, transient_start=0.0),
        sort_keys=True,
    ).encode("utf-8")
    manifest_path = tmp_path / "evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "transient_start.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    audit = CleanCycleAudit(
        period_s=period,
        phase_samples=96,
        cycles=tuple(
            CycleAudit(
                index=index,
                start=index * period,
                end=(index + 1) * period,
                samples=120,
                frames=25,
                phase_gap=0.01,
                phase_shift_bins=0,
                cl_mean=0.7,
                cd_mean=0.035,
                cm_mean=-0.08,
                cl_shape_error=0.01,
                cd_shape_error=0.01,
                cm_shape_error=0.01,
                cl_amplitude_deviation=0.01,
                cd_amplitude_deviation=0.01,
                cm_amplitude_deviation=0.01,
                cl_high_frequency=0.2,
                cd_high_frequency=0.0,
                cm_high_frequency=0.0,
                hard_reasons=("cl high-frequency burst",),
                soft_reasons=(),
            )
            for index in range(audited_periods)
        ),
        terminal_clean_cycles=0,
        required_clean_cycles=required_cycles,
        template_cycles=0,
        shape_error=0.2,
    )
    monkeypatch.setattr(archive_reduction, "clean_periodic_tail", lambda *_a, **_k: None)
    monkeypatch.setattr(
        archive_reduction,
        "estimate_period",
        lambda *_a, **_k: PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
    )
    monkeypatch.setattr(
        archive_reduction,
        "audit_period_cycles",
        lambda *_a, **_k: audit,
    )

    reduction = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity=fidelity,
    )

    assert reduction.state == "recovery_exhausted"
    assert reduction.point["urans_cycle_certificate"] is not None
    assert reduction.diagnostics["critical"] is True
    assert reduction.diagnostics["auditedPeriods"] == audited_periods
    assert reduction.diagnostics["maximumPeriods"] == audited_periods
    assert reduction.diagnostics["requiredCleanCycles"] == required_cycles
    assert reduction.diagnostics["recoveryProgress"] == {
        "policyVersion": "adaptive-clean-tail-v2",
        "measuredPeriods": audited_periods,
        "maxPeriods": audited_periods,
    }
    assert "recommendedAdditionalPeriods" not in reduction.diagnostics


def _flat_archive_reduction(
    tmp_path: Path,
    *,
    samples: int = 101,
    end_time: float = 0.4,
    corrupt_prefix: bool = False,
    cm_amplitude: float = 0.0,
    absolute_rms_fallback: bool = False,
    terminal_nonfinite: bool = False,
) -> tuple[object, Path]:
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    coefficient_path = tmp_path / "flat-coefficient.dat"
    _write_flat_coefficient_history(
        coefficient_path,
        samples=samples,
        end_time=end_time,
        corrupt_prefix=corrupt_prefix,
        cm_amplitude=cm_amplitude,
        absolute_rms_fallback=absolute_rms_fallback,
        terminal_nonfinite=terminal_nonfinite,
    )
    manifest_bytes = json.dumps(
        _manifest(coefficient_member, [], transient_start=0.0), sort_keys=True
    ).encode("utf-8")
    manifest_path = tmp_path / "flat-evidence_manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    transient_start_path = tmp_path / "flat-transient_start.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    return (
        reduce_remote_archive_clean_cycles(
            store,
            _pointer(),
            fidelity="urans_precalc",
        ),
        coefficient_path,
    )


def test_archive_no_shedding_uses_only_the_clean_terminal_physical_horizon(
    tmp_path: Path,
) -> None:
    """A broken startup may be retained, but cannot bias an accepted mean."""
    reduction, _coefficient_path = _flat_archive_reduction(
        tmp_path,
        corrupt_prefix=True,
    )

    assert reduction.state == "accepted"
    assert reduction.diagnostics["regime"] == "steady_equivalent"
    certificate = reduction.point["no_shedding_certificate"]
    history = reduction.point["force_history"]
    assert certificate is not None
    assert history is not None
    assert reduction.point["unsteady"] is False
    assert reduction.point["urans_cycle_certificate"] is None
    # c=0.1, U=30 -> exact slow-wake floor 0.14 s; raw tail ends at 0.4 s.
    assert certificate["observation_start_time"] == pytest.approx(0.26)
    assert certificate["observation_end_time"] == pytest.approx(0.4)
    assert certificate["source_sample_count"] >= 20
    assert certificate["transport_sample_count"] >= 20
    assert history["t"][0] == pytest.approx(certificate["observation_start_time"])
    assert history["t"][-1] == pytest.approx(certificate["observation_end_time"])
    assert reduction.point["cl"] == pytest.approx(0.7)
    assert reduction.point["cd"] == pytest.approx(0.035)
    assert reduction.point["cm"] == pytest.approx(-0.08)


def test_archive_no_shedding_matches_the_live_bounded_rms_certificate(
    tmp_path: Path,
) -> None:
    """The raw archive reducer must accept the same quiet tail as live URANS."""
    reduction, _coefficient_path = _flat_archive_reduction(
        tmp_path,
        samples=2001,
        absolute_rms_fallback=True,
    )

    assert reduction.state == "accepted"
    certificate = reduction.point["no_shedding_certificate"]
    assert certificate is not None
    assert certificate["reducer_version"] == NO_SHEDDING_CERTIFICATE_VERSION
    assert certificate["absolute_floor"] == pytest.approx(2e-3)


def test_archive_no_shedding_certificate_stamps_the_bounded_transport_witness() -> None:
    """Source statistics and the downsampled witness are separate facts.

    The intentionally inconsistent source summary models a damaged or stale
    transport projection.  The archive reducer must not copy those source
    numbers into the transport fields: the control plane can later recompute
    these values from the transmitted force history and reject the mismatch.
    """
    times = [4.2 * index / 20 for index in range(21)]
    history = ForceHistory(
        t=times,
        cl=[0.4] + [0.7] * 20,
        cd=[0.035] * 21,
        cm=[-0.08] * 21,
        # These represent the exact raw source interval, not the deliberately
        # perturbed bounded transport above.
        cl_mean=0.7,
        cl_rms=0.0001,
        cd_mean=0.035,
        cd_rms=0.0001,
        cm_mean=-0.08,
        cm_rms=0.0001,
        shedding_freq_hz=0.0,
        strouhal=0.0,
        samples=21,
        period_s=None,
        retained_cycles=None,
        window_start=0.0,
        window_end=4.2,
    )

    certificate = archive_reduction._no_shedding_certificate(
        history,
        required_observation_s=4.2,
        raw_source_sample_count=21,
    )

    assert certificate is not None
    assert certificate.cl_mean == pytest.approx(0.7)
    assert certificate.cl_rms == pytest.approx(0.0001)
    # Time-weighted trapezoidal witness values from [0.4, 0.7, ..., 0.7].
    assert certificate.transport_cl_mean == pytest.approx(0.6925)
    assert certificate.transport_cl_rms == pytest.approx(0.04683, abs=1e-5)
    assert certificate.transport_cl_mean != certificate.cl_mean
    assert certificate.transport_cl_rms != certificate.cl_rms
    assert certificate.transport_cd_mean == pytest.approx(0.035)
    assert certificate.transport_cd_rms == pytest.approx(0.0)
    assert certificate.transport_cm_mean == pytest.approx(-0.08)
    assert certificate.transport_cm_rms == pytest.approx(0.0)


def test_archive_no_shedding_rejects_a_nonfinite_row_after_the_last_valid_sample(
    tmp_path: Path,
) -> None:
    """MUST-CATCH: raw_latest includes a terminal NaN, not just valid rows."""
    reduction, _coefficient_path = _flat_archive_reduction(
        tmp_path,
        terminal_nonfinite=True,
    )

    assert reduction.state == "rerun_required"
    assert reduction.point["no_shedding_certificate"] is None
    assert "non-finite coefficient sample" in reduction.diagnostics["reason"]


def test_archive_no_shedding_allows_an_old_corrupt_startup_row_outside_the_tail(
    tmp_path: Path,
) -> None:
    """The raw bad-row guard is terminal-window scoped, not a whole-run ban."""
    reduction, coefficient_path = _flat_archive_reduction(tmp_path)
    assert reduction.state == "accepted"

    lines = coefficient_path.read_text().splitlines()
    fields = lines[4].split()  # t=0.012, safely before the 0.26 s tail start.
    fields[4] = "nan"
    lines[4] = " ".join(fields)
    coefficient_path.write_text("\n".join(lines) + "\n")

    # Rebuild the exact immutable reduction from the altered raw member rather
    # than mutating a point transport.  The startup corruption stays archived
    # but is outside the accepted terminal physical observation.
    coefficient_member = "postProcessing/forceCoeffs1/0/coefficient.dat"
    manifest_path = tmp_path / "flat-evidence_manifest-recheck.json"
    manifest_path.write_bytes(
        json.dumps(_manifest(coefficient_member, [], transient_start=0.0), sort_keys=True).encode(
            "utf-8"
        )
    )
    transient_start_path = tmp_path / "flat-transient_start-recheck.json"
    transient_start_path.write_text(json.dumps({"transient_start": 0.0}))
    store = FakeVerifiedArchiveStore(
        {
            "evidence_manifest.json": manifest_path,
            coefficient_member: coefficient_path,
            "openfoam/transient/transient_start.json": transient_start_path,
        }
    )
    rerun = reduce_remote_archive_clean_cycles(
        store,
        _pointer(),
        fidelity="urans_precalc",
    )
    assert rerun.state == "accepted"
    assert rerun.point["no_shedding_certificate"] is not None


def test_archive_no_shedding_requires_twenty_raw_and_transport_samples(
    tmp_path: Path,
) -> None:
    """Two sparse endpoint-style rows never demonstrate a missing slow wake."""
    reduction, _coefficient_path = _flat_archive_reduction(
        tmp_path,
        samples=19,
        # Make total span exactly the slow-wake floor so sample density, not
        # duration, is the rejection cause.
        end_time=0.14,
    )

    assert reduction.state != "accepted"
    assert reduction.point.get("no_shedding_certificate") is None


def test_archive_no_shedding_rejects_a_noisy_moment_channel(
    tmp_path: Path,
) -> None:
    """Large Cl must not hide a distinct Cm oscillation."""
    reduction, _coefficient_path = _flat_archive_reduction(
        tmp_path,
        cm_amplitude=0.02,
    )

    assert reduction.state != "accepted"
    assert reduction.point.get("no_shedding_certificate") is None
