"""Immutable clean-cycle reductions from archived URANS evidence.

This is deliberately separate from the live solver pipeline.  It consumes an
exact generation-pinned archive, authenticates its complete manifest, and
derives a *new* interpretation from raw force-coefficient members plus actual
saved field-time directories.  It never writes into a case directory and it
never changes a result projection.

The control plane calls this module through an authenticated internal route;
the sweeper stores its response in the append-only interpretation ledger.
"""

from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol

from .evidence_store import EvidenceObjectStore, RemoteEvidencePointer
from .models import (
    NoSheddingCertificate,
    NO_SHEDDING_CERTIFICATE_VERSION,
    UransCycleCertificate,
    UransCycleCertificateCycle,
    UransCycleDisposition,
)
from .postprocess.unsteady import (
    CLEAN_CYCLE_CERTIFICATION_VERSION,
    CLEAN_CYCLE_RECOVERY_POLICY_VERSION,
    NO_SHEDDING_ABS_RMS_FALLBACK,
    NO_SHEDDING_MIN_SAMPLE_COUNT,
    NO_SHEDDING_REL_TOL,
    CleanCycleAudit,
    additional_periods_for_clean_suffix,
    audit_period_cycles,
    clean_cycle_max_periods,
    clean_cycle_minimum,
    clean_cycle_recovery_exhausted,
    clean_periodic_tail,
    coefficient_invalid_value_times,
    coefficient_series,
    estimate_period,
    force_history,
    force_history_transport_statistics,
    is_no_shedding,
    no_shedding_min_observation_s,
    period_window_stats,
    terminal_period_estimate,
    with_clean_cycle_recovery_progress,
)


class ArchiveMemberStore(Protocol):
    """The narrow verified-member surface needed for one archive reduction."""

    def member_source(self, pointer: RemoteEvidencePointer, member_path: str):
        ...

    def verify_all_manifest_members(
        self,
        pointer: RemoteEvidencePointer,
        *,
        expected_manifest: bytes | None = None,
        fresh_download: bool = False,
    ) -> int:
        ...


class ArchiveReductionError(RuntimeError):
    """The archive is authentic but cannot supply a reducible raw trajectory."""


_TRANSIENT_START_ARCHIVE_MEMBER = "openfoam/transient/transient_start.json"


@dataclass(frozen=True)
class ArchiveCleanCycleReduction:
    """One raw-evidence interpretation response suitable for the ledger."""

    state: str
    input_evidence_signature: str
    point: dict[str, Any]
    diagnostics: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "inputEvidenceSignature": self.input_evidence_signature,
            "point": self.point,
            "diagnostics": self.diagnostics,
        }


def _stable_json_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        )
    ).hexdigest()


def _require_object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ArchiveReductionError(f"{label} must be an object")
    return value


def _finite(value: object, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ArchiveReductionError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ArchiveReductionError(f"{label} must be a finite number")
    return result


def _positive(value: object, label: str) -> float:
    result = _finite(value, label)
    if result <= 0:
        raise ArchiveReductionError(f"{label} must be positive")
    return result


def _safe_member_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ArchiveReductionError(f"{label} must be a non-empty exact path")
    if value.startswith("/") or "\\" in value or "\x00" in value:
        raise ArchiveReductionError(f"{label} must be a safe relative path")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ArchiveReductionError(f"{label} must be a safe relative path")
    return value


def _manifest_from_bytes(manifest_bytes: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        raw = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArchiveReductionError("raw evidence manifest is invalid JSON") from exc
    manifest = _require_object(raw, "raw evidence manifest")
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ArchiveReductionError("raw evidence manifest has no files array")
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry_value in enumerate(files):
        entry = _require_object(entry_value, f"manifest file {index}")
        path = _safe_member_path(entry.get("path"), f"manifest file {index} path")
        if path in seen:
            raise ArchiveReductionError("raw evidence manifest has duplicate member paths")
        seen.add(path)
        role = entry.get("role")
        if role is not None and (
            not isinstance(role, str) or not role or role.strip() != role
        ):
            raise ArchiveReductionError(f"manifest file {index} role is malformed")
        parsed.append(entry)
    return manifest, parsed


def _frame_times(entries: Iterable[Mapping[str, object]]) -> list[float]:
    """Saved OpenFOAM field times, never a synthetic frame cadence.

    Evidence archives retain every file under ``time_directories/<physical
    time>/``.  Counting distinct numeric directory names proves that a real
    field write existed at each returned time without having to copy every
    field into a temporary render tree.
    """

    times: set[float] = set()
    for entry in entries:
        if entry.get("role") != "time_directory":
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            continue
        parts = path.split("/")
        if len(parts) < 3 or parts[0] != "time_directories":
            continue
        try:
            value = float(parts[1])
        except ValueError:
            continue
        if math.isfinite(value) and value >= 0:
            times.add(value)
    return sorted(times)


def _coefficient_members(entries: Iterable[Mapping[str, object]]) -> list[str]:
    paths: list[str] = []
    for entry in entries:
        if entry.get("role") != "force_coefficients":
            continue
        paths.append(_safe_member_path(entry.get("path"), "force coefficient path"))
    return sorted(set(paths))


def _authenticated_transient_start(
    store: ArchiveMemberStore | EvidenceObjectStore,
    pointer: RemoteEvidencePointer,
    entries: Iterable[Mapping[str, object]],
) -> float | None:
    """Read the exact same-case start marker only when it is archived.

    A coefficient tail can prove a scientific average but cannot prove how
    much physical time the case already consumed.  Exact continuation needs
    the latter so a short inspected suffix never resets the finite fidelity
    recovery ceiling.
    The caller has already authenticated every manifest member; absence or a
    malformed marker is therefore an honest reason to choose a fresh rerun,
    not a reason to invent an origin from a trimmed coefficient suffix.
    """
    if not any(entry.get("path") == _TRANSIENT_START_ARCHIVE_MEMBER for entry in entries):
        return None
    try:
        with store.member_source(pointer, _TRANSIENT_START_ARCHIVE_MEMBER) as source:
            raw = json.loads(Path(source).read_text())
    except Exception:  # noqa: BLE001 - a bad archive marker is non-restartable
        return None
    if not isinstance(raw, dict):
        return None
    value = raw.get("transient_start")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    start = float(value)
    return start if math.isfinite(start) and start >= 0.0 else None


def _recovery_progress_diagnostics(
    audit: CleanCycleAudit,
    fidelity: str,
    *,
    recommended_additional_periods: int | None = None,
) -> dict[str, int | str]:
    """Versioned cross-runtime recovery-budget contract.

    v2 reports the authenticated physical count truthfully, including a rare
    overrun caused by cadence re-estimation.  The client may authorize only a
    bounded continuation below this policy's exact fidelity ceiling; an
    exhausted overrun remains terminal rather than being clamped into a
    deceptively exact count.
    """
    maximum = clean_cycle_max_periods(fidelity)
    progress: dict[str, int | str] = {
        "policyVersion": CLEAN_CYCLE_RECOVERY_POLICY_VERSION,
        "measuredPeriods": audit.physical_periods,
        "maxPeriods": maximum,
    }
    if recommended_additional_periods is not None:
        progress["recommendedAdditionalPeriods"] = int(
            recommended_additional_periods
        )
    return progress


def _cycle_disposition(
    cycle: object,
    *,
    selected_start: float | None,
) -> UransCycleDisposition:
    """Map reducer diagnostics into the stable persisted certificate enum."""

    # ``CleanCycleAudit`` is intentionally an engine-local data class.  Keep
    # this thin adapter explicit so a later reducer can change diagnostics
    # while the ledger contract remains append-only and inspectable.
    if cycle.clean and selected_start is not None and cycle.start + 1e-10 >= selected_start:
        return UransCycleDisposition.selected
    if cycle.clean:
        return UransCycleDisposition.startup
    reasons = (*cycle.hard_reasons, *cycle.soft_reasons)
    lowered = " ".join(reasons).lower()
    if "frame" in lowered or "phase gap" in lowered or "sample" in lowered:
        return UransCycleDisposition.insufficient_frames
    if "high-frequency" in lowered or "noise" in lowered:
        return UransCycleDisposition.numerically_noisy
    if cycle.hard_reasons:
        return UransCycleDisposition.hard_corrupt
    return UransCycleDisposition.settling_outlier


def clean_cycle_certificate(audit: CleanCycleAudit) -> UransCycleCertificate:
    """Convert one raw audit to the public/persisted certificate contract."""

    selected_start = audit.selected_start
    selected = [
        cycle
        for cycle in audit.cycles
        if cycle.clean
        and selected_start is not None
        and cycle.start + 1e-10 >= selected_start
    ]
    return UransCycleCertificate(
        reducer_version=CLEAN_CYCLE_CERTIFICATION_VERSION,
        period_s=audit.period_s,
        phase_samples=audit.phase_samples,
        required_clean_cycles=audit.required_clean_cycles,
        terminal_clean_cycles=audit.terminal_clean_cycles,
        selected_cycle_start_index=selected[0].index if selected else None,
        certified=audit.certified,
        cadence_adjusted=audit.cadence_adjusted,
        cycles=[
            UransCycleCertificateCycle(
                index=cycle.index,
                t_start=cycle.start,
                t_end=cycle.end,
                coefficient_samples=cycle.samples,
                field_frames=cycle.frames or 0,
                phase_max_gap=cycle.phase_gap,
                phase_shift_bins=abs(cycle.phase_shift_bins),
                cl_mean=cycle.cl_mean,
                cd_mean=cycle.cd_mean,
                cm_mean=cycle.cm_mean,
                cl_shape_error=cycle.cl_shape_error,
                cd_shape_error=cycle.cd_shape_error,
                cm_shape_error=cycle.cm_shape_error,
                cl_amplitude_deviation=cycle.cl_amplitude_deviation,
                cd_amplitude_deviation=cycle.cd_amplitude_deviation,
                cm_amplitude_deviation=cycle.cm_amplitude_deviation,
                cl_high_frequency=cycle.cl_high_frequency,
                cd_high_frequency=cycle.cd_high_frequency,
                cm_high_frequency=cycle.cm_high_frequency,
                disposition=_cycle_disposition(cycle, selected_start=selected_start),
                reasons=[*cycle.hard_reasons, *cycle.soft_reasons],
            )
            for cycle in audit.cycles
        ],
    )


def _base_point(*, aoa_deg: float, certificate: UransCycleCertificate | None) -> dict[str, Any]:
    return {
        "aoa_deg": aoa_deg,
        "unsteady": True,
        "converged": bool(certificate and certificate.certified),
        "first_order_fallback": False,
        "images": {},
        "video": {},
        "mean_images": {},
        "urans_cycle_certificate": (
            certificate.model_dump(mode="json") if certificate is not None else None
        ),
        # A current archive-derived no-shedding result replaces this with its
        # bounded proof transport. Periodic reductions never attach a
        # downsampled history: their raw coefficient member plus exact archive
        # identity are the only reduction input.
        "force_history": None,
        "no_shedding_certificate": None,
    }


def _force_history_transport(history: Any) -> dict[str, Any]:
    """Return the bounded force witness tied to a no-shedding certificate.

    The raw archive remains the authoritative source. This small transport is
    persisted only so the control plane can independently verify the current
    certificate's sample count, endpoints, and published means before an
    archive interpretation becomes canonical.
    """
    return {
        "t": [float(value) for value in history.t],
        "cl": [float(value) for value in history.cl],
        "cd": [float(value) for value in history.cd],
        "cm": [float(value) for value in history.cm],
        "shedding_freq_hz": float(history.shedding_freq_hz),
        "samples": int(history.samples),
        "period_s": history.period_s,
        "retained_cycles": history.retained_cycles,
        "window_start": float(history.window_start),
        "window_end": float(history.window_end),
    }


def _no_shedding_certificate(
    history: Any,
    *,
    required_observation_s: float,
    raw_source_sample_count: int,
) -> NoSheddingCertificate | None:
    """Build one typed certificate from the exact terminal raw observation."""
    channels = (history.t, history.cl, history.cd, history.cm)
    transport_count = len(history.t)
    if transport_count < 2 or any(len(channel) != transport_count for channel in channels):
        return None
    try:
        values = [float(value) for channel in channels for value in channel]
        source_count = int(raw_source_sample_count)
        start = float(history.t[0])
        end = float(history.t[-1])
        required = float(required_observation_s)
    except (TypeError, ValueError, OverflowError):
        return None
    if (
        source_count < NO_SHEDDING_MIN_SAMPLE_COUNT
        or transport_count < NO_SHEDDING_MIN_SAMPLE_COUNT
        or source_count < transport_count
        or not all(math.isfinite(value) for value in values)
        or not math.isfinite(required)
        or required <= 0
        or end <= start
        or any(float(history.t[index + 1]) <= float(history.t[index]) for index in range(transport_count - 1))
    ):
        return None
    try:
        transport_statistics = force_history_transport_statistics(history)
        return NoSheddingCertificate(
            reducer_version=NO_SHEDDING_CERTIFICATE_VERSION,
            certified=True,
            required_observation_s=required,
            observation_start_time=start,
            observation_end_time=end,
            observed_observation_s=end - start,
            source_sample_count=source_count,
            transport_sample_count=transport_count,
            relative_tolerance=NO_SHEDDING_REL_TOL,
            # Match the current live reducer.  The archive path replays the
            # same coherent-period and temporal-tail gates from raw members,
            # so this v2 allowance is never a summary-only relaxation.
            absolute_floor=NO_SHEDDING_ABS_RMS_FALLBACK,
            cl_mean=float(history.cl_mean),
            cd_mean=float(history.cd_mean),
            cm_mean=float(history.cm_mean),
            cl_rms=float(history.cl_rms),
            cd_rms=float(history.cd_rms),
            cm_rms=float(history.cm_rms),
            transport_cl_mean=transport_statistics.cl_mean,
            transport_cd_mean=transport_statistics.cd_mean,
            transport_cm_mean=transport_statistics.cm_mean,
            transport_cl_rms=transport_statistics.cl_rms,
            transport_cd_rms=transport_statistics.cd_rms,
            transport_cm_rms=transport_statistics.cm_rms,
        )
    except (TypeError, ValueError, OverflowError):
        return None


def _manifest_signature(
    pointer: RemoteEvidencePointer,
    manifest_bytes: bytes,
    coefficient_paths: list[str],
    frame_times: list[float],
) -> str:
    return _stable_json_sha256(
        {
            "contract": "archive-clean-cycle-reduction-v1",
            "pointer": pointer.to_dict(),
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "coefficientPaths": coefficient_paths,
            "fieldFrameTimes": frame_times,
        }
    )


def _recovery_exhausted_reduction(
    *,
    signature: str,
    point: dict[str, Any],
    base_diagnostics: Mapping[str, Any],
    audit: CleanCycleAudit,
    fidelity: str,
    required_cycles: int,
    reason: str,
) -> ArchiveCleanCycleReduction:
    """Preserve exhausted raw evidence without scheduling another physical run.

    The archive worker is allowed to discover a critical exhausted trajectory,
    but it is never allowed to quietly turn that discovery into another
    continuation.  The sweeper stages its immutable cycle audit as a terminal
    interpretation and records no recovery-action handoff for this state.
    """

    return ArchiveCleanCycleReduction(
        state="recovery_exhausted",
        input_evidence_signature=signature,
        point=point,
        diagnostics={
            **base_diagnostics,
            "reason": reason,
            "critical": True,
            "recoveryState": "exhausted",
            "auditedPeriods": len(audit.cycles),
            "maximumPeriods": clean_cycle_max_periods(fidelity),
            "recoveryProgress": _recovery_progress_diagnostics(audit, fidelity),
            "terminalCleanCycles": audit.terminal_clean_cycles,
            "requiredCleanCycles": required_cycles,
        },
    )


def reduce_remote_archive_clean_cycles(
    store: ArchiveMemberStore | EvidenceObjectStore,
    pointer: RemoteEvidencePointer,
    *,
    fidelity: str,
) -> ArchiveCleanCycleReduction:
    """Reduce one exact GCS archive from raw coefficient/field evidence.

    The all-member verification is intentionally before any value is returned:
    a valid tar digest alone is not proof that each manifest-declared force and
    field member is present.  This makes the response fit for an immutable
    interpretation ledger and prevents a backfill from treating a rendered,
    downsampled payload as a substitute for the raw simulation.
    """

    if fidelity not in {"urans_precalc", "urans_full"}:
        raise ArchiveReductionError("archive clean-cycle reduction requires URANS fidelity")
    try:
        with store.member_source(pointer, "evidence_manifest.json") as manifest_path:
            manifest_bytes = Path(manifest_path).read_bytes()
    except Exception as exc:  # noqa: BLE001 - storage backend errors are typed externally
        raise ArchiveReductionError(
            f"raw archive manifest cannot be materialized: {exc}"
        ) from exc
    manifest, entries = _manifest_from_bytes(manifest_bytes)
    aoa_deg = _finite(manifest.get("aoaDeg"), "raw archive aoaDeg")
    coefficient_paths = _coefficient_members(entries)
    frame_times = _frame_times(entries)
    signature = _manifest_signature(pointer, manifest_bytes, coefficient_paths, frame_times)
    # Released legacy archives sometimes contain an otherwise useful force
    # history but predate the immutable ``unsteady`` provenance contract.
    # They cannot be classified as steady-equivalent URANS and must never be
    # selected from their scalar summary.  Return an exact source-pinned rerun
    # requirement instead of throwing a generic operational error: the control
    # plane can then lease one fresh URANS generation through the normal
    # evidence-preserving recovery ladder.
    if manifest.get("unsteady") is not True:
        return ArchiveCleanCycleReduction(
            state="rerun_required",
            input_evidence_signature=signature,
            point=_base_point(aoa_deg=aoa_deg, certificate=None),
            diagnostics={
                "source": "archive_backfill",
                "reason": (
                    "raw archive predates immutable URANS provenance; "
                    "a fresh URANS generation is required"
                ),
                "critical": False,
                "recoveryState": "fresh_rerun",
                "unsteadyEvidence": False,
                "rawManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "forceCoefficientMembers": coefficient_paths,
                "savedFieldFrameCount": len(frame_times),
                "fidelity": fidelity,
            },
        )
    chord = _positive(manifest.get("chordM"), "raw archive chordM")
    speed = _positive(manifest.get("speedMps"), "raw archive speedMps")

    # A full fresh verification binds both the raw manifest and every saved
    # field member to this exact immutable GCS generation.  It is expensive by
    # design, but this is a one-time evidence migration—not a browser poll.
    try:
        verified_member_count = store.verify_all_manifest_members(
            pointer,
            expected_manifest=manifest_bytes,
            fresh_download=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise ArchiveReductionError(
            f"raw archive member verification failed: {exc}"
        ) from exc

    transient_start = _authenticated_transient_start(store, pointer, entries)

    base_diagnostics: dict[str, Any] = {
        "source": "archive_backfill",
        # The manifest's explicit URANS marker is part of the archive proof.
        # A no-shedding result has ``unsteady=false`` at the point level, so
        # preserving this provenance lets the control plane distinguish an
        # actual flat URANS observation from an ordinary RANS row that merely
        # resembles one.
        "unsteadyEvidence": True,
        "rawManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "verifiedMemberCount": verified_member_count,
        "forceCoefficientMembers": coefficient_paths,
        "savedFieldFrameCount": len(frame_times),
        "fidelity": fidelity,
        "authenticatedTransientStart": transient_start,
    }
    if not coefficient_paths:
        return ArchiveCleanCycleReduction(
            state="missing_evidence",
            input_evidence_signature=signature,
            point=_base_point(aoa_deg=aoa_deg, certificate=None),
            diagnostics={
                **base_diagnostics,
                "reason": "archive has no manifest-declared raw force coefficient member",
            },
        )

    try:
        with ExitStack() as stack:
            raw_coefficient_paths = [
                Path(stack.enter_context(store.member_source(pointer, member)))
                for member in coefficient_paths
            ]
            times, cl, cd, cm = coefficient_series(raw_coefficient_paths)
            invalid_coefficient_times = coefficient_invalid_value_times(
                raw_coefficient_paths
            )
            if times.size == 0:
                raise ArchiveReductionError(
                    "raw archive has no finite force coefficient samples"
                )
            required_no_shedding_observation = no_shedding_min_observation_s(
                speed=speed,
                chord=chord,
            )
            invalid_latest = (
                max(float(timestamp) for timestamp in invalid_coefficient_times)
                if invalid_coefficient_times.size
                else float("-inf")
            )
            raw_latest_time = max(float(times[-1]), invalid_latest)
            terminal_no_shedding_start = (
                raw_latest_time - required_no_shedding_observation
                if math.isfinite(required_no_shedding_observation)
                else math.inf
            )
            # Grade the *terminal physical slow-wake horizon*, not the entire
            # retained trajectory. A damaged startup must not poison a clean
            # late steady wake, but a terminal NaN/noisy sample must never be
            # averaged away. ``force_history`` interpolates the exact boundary
            # between actual samples, so this duration cannot be shortened by
            # an adaptive time step.
            no_shedding_history = force_history(
                raw_coefficient_paths,
                speed=speed,
                chord=chord,
                discard_fraction=0.0,
                observation_start_time=(
                    terminal_no_shedding_start
                    if math.isfinite(terminal_no_shedding_start)
                    else None
                ),
                preserve_observation_window=True,
                alpha_deg=aoa_deg,
            )
    except Exception as exc:  # noqa: BLE001
        raise ArchiveReductionError(
            f"raw archive force coefficient members cannot be reduced: {exc}"
        ) from exc

    no_shedding_start = (
        float(no_shedding_history.t[0]) if no_shedding_history.t else math.inf
    )
    no_shedding_end = (
        float(no_shedding_history.t[-1]) if no_shedding_history.t else -math.inf
    )
    no_shedding_endpoint_tolerance = 1e-10 * max(
        1.0,
        abs(no_shedding_start),
        abs(no_shedding_end),
        abs(raw_latest_time),
        abs(terminal_no_shedding_start),
    )
    # The raw terminal timestamp includes rows the permissive numeric reader
    # has discarded.  This is the key fail-closed distinction: a NaN after the
    # last valid row cannot redefine the end of the physical observation.
    terminal_window_matches_raw = (
        math.isfinite(terminal_no_shedding_start)
        and abs(no_shedding_start - terminal_no_shedding_start)
        <= no_shedding_endpoint_tolerance
        and abs(no_shedding_end - raw_latest_time)
        <= no_shedding_endpoint_tolerance
    )
    invalid_no_shedding_sample = bool(
        any(
            terminal_no_shedding_start - no_shedding_endpoint_tolerance
            <= float(timestamp)
            <= raw_latest_time + no_shedding_endpoint_tolerance
            for timestamp in invalid_coefficient_times
        )
    )
    terminal_raw_source_samples = int(
        sum(
            terminal_no_shedding_start - no_shedding_endpoint_tolerance
            <= float(timestamp)
            <= raw_latest_time + no_shedding_endpoint_tolerance
            for timestamp in times
        )
    )
    if is_no_shedding(no_shedding_history):
        certificate = _no_shedding_certificate(
            no_shedding_history,
            required_observation_s=required_no_shedding_observation,
            raw_source_sample_count=terminal_raw_source_samples,
        )
        if (
            invalid_no_shedding_sample
            or not terminal_window_matches_raw
            or certificate is None
            or certificate.cd_mean <= 0
        ):
            reason = (
                "terminal no-shedding observation contains a non-finite coefficient sample"
                if invalid_no_shedding_sample
                else "terminal no-shedding observation does not reach the latest raw coefficient timestamp"
                if not terminal_window_matches_raw
                else "terminal no-shedding observation has non-positive drag"
                if certificate is not None and certificate.cd_mean <= 0
                else "terminal no-shedding observation cannot produce a typed physical certificate"
            )
            return ArchiveCleanCycleReduction(
                state="rerun_required",
                input_evidence_signature=signature,
                point=_base_point(aoa_deg=aoa_deg, certificate=None),
                diagnostics={
                    **base_diagnostics,
                    "regime": "steady_equivalent",
                    "reason": reason,
                },
            )
        point = _base_point(aoa_deg=aoa_deg, certificate=None)
        point.update(
            {
                "unsteady": False,
                "converged": True,
                "cl": certificate.cl_mean,
                "cd": certificate.cd_mean,
                "cm": certificate.cm_mean,
                "cl_cd": (
                    certificate.cl_mean / certificate.cd_mean
                    if certificate.cd_mean != 0
                    else None
                ),
                "cl_std": certificate.cl_rms,
                "cd_std": certificate.cd_rms,
                "cm_std": certificate.cm_rms,
                "frame_track": None,
                "force_history": _force_history_transport(no_shedding_history),
                "no_shedding_certificate": certificate.model_dump(mode="json"),
            }
        )
        return ArchiveCleanCycleReduction(
            state="accepted",
            input_evidence_signature=signature,
            point=point,
            diagnostics={
                **base_diagnostics,
                "regime": "steady_equivalent",
                "noSheddingCertificate": certificate.model_dump(mode="json"),
            },
        )

    required_cycles = clean_cycle_minimum(fidelity)
    latest_physical_time = max(
        raw_latest_time,
        float(frame_times[-1]) if frame_times else float("-inf"),
    )
    tail = clean_periodic_tail(
        times,
        cl,
        cd,
        cm,
        speed=speed,
        chord=chord,
        required_cycles=required_cycles,
        fidelity=fidelity,
        frame_times=frame_times,
        min_frames_per_cycle=20,
        alpha_deg=aoa_deg,
        recovery_origin_time=transient_start,
        recovery_latest_time=latest_physical_time,
        invalid_coefficient_times=invalid_coefficient_times,
    )
    audit: CleanCycleAudit | None = tail.audit if tail is not None else None
    if audit is None:
        estimate = estimate_period(
            times,
            cl,
            speed=speed,
            chord=chord,
            alpha_deg=aoa_deg,
        )
        if estimate is None or estimate.ambiguous:
            estimate = terminal_period_estimate(
                times,
                cl,
                cd,
                cm,
                speed=speed,
                chord=chord,
                required_cycles=required_cycles,
                fidelity=fidelity,
                alpha_deg=aoa_deg,
            )
        if estimate is not None and not estimate.ambiguous and estimate.period_s > 0:
            audit = audit_period_cycles(
                times,
                cl,
                cd,
                cm,
                estimate.period_s,
                fidelity=fidelity,
                required_cycles=required_cycles,
                frame_times=frame_times,
                min_frames_per_cycle=20,
                invalid_coefficient_times=invalid_coefficient_times,
            )
            audit = with_clean_cycle_recovery_progress(
                audit,
                origin_time=transient_start,
                latest_time=latest_physical_time,
            )
    certificate = clean_cycle_certificate(audit) if audit is not None else None
    point = _base_point(aoa_deg=aoa_deg, certificate=certificate)
    if certificate is None:
        return ArchiveCleanCycleReduction(
            state="rerun_required",
            input_evidence_signature=signature,
            point=point,
            diagnostics={
                **base_diagnostics,
                "reason": "raw evidence has no corroborated periodic cadence",
                "terminalCleanCycles": 0,
                "requiredCleanCycles": required_cycles,
            },
        )

    # A real periodic cadence with an uncertified tail is not an excuse to
    # throw away a restartable physical trajectory.  Its immutable archive has
    # precisely the evidence needed to continue the exact case under the
    # clean-cycle controller.  Reserve ``rerun_required`` for the narrower
    # case where raw evidence cannot even establish a periodic cadence.
    if tail is None:
        if transient_start is None:
            return ArchiveCleanCycleReduction(
                state="rerun_required",
                input_evidence_signature=signature,
                point=point,
                diagnostics={
                    **base_diagnostics,
                    "reason": (
                        "raw evidence has a periodic cadence but no authenticated "
                        "same-case transient start for an exact continuation"
                    ),
                    "terminalCleanCycles": certificate.terminal_clean_cycles,
                    "requiredCleanCycles": required_cycles,
                },
            )
        if clean_cycle_recovery_exhausted(audit, fidelity=fidelity):
            return _recovery_exhausted_reduction(
                signature=signature,
                point=point,
                base_diagnostics=base_diagnostics,
                audit=audit,
                fidelity=fidelity,
                required_cycles=required_cycles,
                reason=(
                    "raw evidence reached the clean-cycle recovery cap without "
                    "a publishable terminal suffix"
                ),
            )
        recommended = additional_periods_for_clean_suffix(
            audit,
            fidelity=fidelity,
            required_cycles=required_cycles,
            # `clean_periodic_tail` is stricter than a per-cycle audit: a
            # fallback audit can find clean cycles while the exact terminal
            # series still lacks a corroborated cadence.  That certified-but-
            # uncorroborated case must append fresh evidence rather than emit
            # a zero-period continuation.  Incomplete/damaged suffixes retain
            # the normal progressive 1--3-period policy.
            borderline=certificate.certified,
        )
        continuation_reason = (
            "raw evidence has a clean cycle audit but no corroborated exact "
            "terminal tail"
            if certificate.certified
            else "raw evidence has a periodic cadence but no certified terminal "
            "clean-cycle suffix"
        )
        return ArchiveCleanCycleReduction(
            state="continuation_required",
            input_evidence_signature=signature,
            point=point,
            diagnostics={
                **base_diagnostics,
                "reason": continuation_reason,
                "terminalCleanCycles": certificate.terminal_clean_cycles,
                "requiredCleanCycles": required_cycles,
                "recommendedAdditionalPeriods": recommended,
                "recoveryProgress": _recovery_progress_diagnostics(
                    audit,
                    fidelity,
                    recommended_additional_periods=recommended,
                ),
            },
        )

    stats = period_window_stats(
        *tail.series,
        tail.estimate.period_s,
        established_oscillation=fidelity == "urans_precalc",
    )
    if stats is None:
        raise ArchiveReductionError("certified raw clean-cycle tail has no statistics window")
    point.update(
        {
            "converged": certificate.certified and stats.stationary,
            "cl": stats.cl.mean,
            "cd": stats.cd.mean,
            "cm": stats.cm.mean,
            "cl_cd": stats.cl.mean / stats.cd.mean if stats.cd.mean != 0 else None,
            "cl_std": stats.cl.std,
            "cd_std": stats.cd.std,
            "cm_std": stats.cm.std,
            # It is intentionally absent, not reconstructed from downsampled
            # transport frames.  The certificate records the raw field-frame
            # proof and the UI can fetch stored media separately.
        }
    )
    if not certificate.certified or not stats.stationary:
        if transient_start is None:
            return ArchiveCleanCycleReduction(
                state="rerun_required",
                input_evidence_signature=signature,
                point=point,
                diagnostics={
                    **base_diagnostics,
                    "regime": "periodic",
                    "periodS": tail.estimate.period_s,
                    "reason": (
                        "raw evidence needs more settling periods but has no "
                        "authenticated same-case transient start for continuation"
                    ),
                    "terminalCleanCycles": certificate.terminal_clean_cycles,
                    "requiredCleanCycles": certificate.required_clean_cycles,
                },
            )
        if clean_cycle_recovery_exhausted(audit, fidelity=fidelity):
            return _recovery_exhausted_reduction(
                signature=signature,
                point=point,
                base_diagnostics={
                    **base_diagnostics,
                    "regime": "periodic",
                    "periodS": tail.estimate.period_s,
                    "statisticsStationary": stats.stationary,
                    "statisticsReason": stats.stationary_reason,
                },
                audit=audit,
                fidelity=fidelity,
                required_cycles=required_cycles,
                reason=(
                    "raw evidence reached the clean-cycle recovery cap without "
                    "stationary publishable coefficients"
                ),
            )
        recommended = additional_periods_for_clean_suffix(
            audit,
            fidelity=fidelity,
            required_cycles=required_cycles,
            # The per-cycle certificate can be clean while the independent
            # exact-window stationarity test still rejects its aggregate.
            # That is a recoverable borderline tail, not a zero-period
            # continuation: append a bounded fresh guard window, then audit
            # again. Three periods give the next FAST publication window wholly
            # new physical evidence, while FINAL still advances without a blind
            # long rerun. Without this explicit branch the helper returns zero
            # after an already complete clean suffix, which produces an invalid
            # ``continuation_required`` response that the control plane must
            # reject rather than continue.
            borderline=certificate.certified and not stats.stationary,
        )
        return ArchiveCleanCycleReduction(
            state="continuation_required",
            input_evidence_signature=signature,
            point=point,
            diagnostics={
                **base_diagnostics,
                "regime": "periodic",
                "periodS": tail.estimate.period_s,
                "terminalCleanCycles": certificate.terminal_clean_cycles,
                "requiredCleanCycles": certificate.required_clean_cycles,
                "statisticsStationary": stats.stationary,
                "statisticsReason": stats.stationary_reason,
                "recommendedAdditionalPeriods": recommended,
                "recoveryProgress": _recovery_progress_diagnostics(
                    audit,
                    fidelity,
                    recommended_additional_periods=recommended,
                ),
            },
        )
    return ArchiveCleanCycleReduction(
        state="accepted",
        input_evidence_signature=signature,
        point=point,
        diagnostics={
            **base_diagnostics,
            "regime": "periodic",
            "periodS": tail.estimate.period_s,
            "terminalCleanCycles": certificate.terminal_clean_cycles,
            "requiredCleanCycles": certificate.required_clean_cycles,
            "statisticsStationary": stats.stationary,
            "statisticsReason": stats.stationary_reason,
        },
    )
