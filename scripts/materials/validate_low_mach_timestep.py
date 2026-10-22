"""Source-bound matched-duration replay of the retained FX61147 transient."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import time

import numpy as np

from airfoilfoam import pipeline
from airfoilfoam.config import Settings
from airfoilfoam.models import CaseSpec, SolverParams
from airfoilfoam.openfoam.dialects import OPENCFD_2606, dialect_for_runner
from airfoilfoam.openfoam.rans_hold import atomic_dictionary, root_entry
from airfoilfoam.openfoam.runner import DockerRunner
from airfoilfoam.postprocess.unsteady import (
    PeriodWindow,
    _time_weighted_mean_std,
    _window_series,
    coefficient_invalid_value_times,
    coefficient_series,
    force_history,
    is_no_shedding,
)
from airfoilfoam.provenance import application_source_files, application_source_sha256


SOURCE_JOB = "dd937c94-1de1-4209-af9a-a7fe5aad0fe4"
SOURCE_REVISION = "7464633118826c04bbc71ede214e34509595eff5"
PREPARED_REVISION = "6b56bf7bd68666c946c42ca190249245ef12c655"
PIPELINE_SHA256 = "2efe8111f9dd4b1d520f73ca16a8f955be1ae08e60dbb8dd0048278bd102f7b1"
SAVED_TIME = "600.0332279639939"
FORCE_PREFIX = "force-before-checkpoint.dat"
FORCE_PREFIX_SHA256 = "2b5850cd009951293e5beebd1fbdc3fce18dc082e76da66ec675b42e3109222d"
ARCHIVES = {
    "fx61147-a0-saved-state.tar.gz": "d4258f1a11e8c771a0d87e64508c5947dfb42193bad8cb422b92a2d7cbd62733",
    "fx61147-exact-mesh.tar.gz": "287aecc9ef3c0a53de25e9611143aacae9800b84a37772ca6a57b7cc0483a406",
}
IMAGE = "opencfd/openfoam-run:2606@sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb"
BASHRC = "/usr/lib/openfoam/openfoam2606/etc/bashrc"
BINARY_SHA256 = "3153b175918b4f1983e01e27b05b41872c39429e2831a9db8647a2b9295a02c3"
STARTUP_MAX_DELTA_T = 1.3333333333333334e-6
VARIANTS = {"candidate": 4.0, "refined": 2.0}
SPEC = CaseSpec(chord=0.05, speed=30.0, aoa_deg=-5.0)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def file_record(path: Path) -> dict:
    return {"bytes": path.stat().st_size, "sha256": sha256(path)}


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    os.replace(temporary, path)


def authenticate_fixture(directory: Path) -> tuple[Path, dict, dict]:
    directory = directory.resolve()
    expected = {}
    for filename, checksum in ARCHIVES.items():
        archive_path = directory / filename
        if sha256(archive_path) != checksum:
            raise ValueError(f"Retained source archive changed: {filename}")
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive:
                relative = PurePosixPath(member.name)
                if relative.is_absolute() or ".." in relative.parts or member.issym() or member.islnk():
                    raise ValueError("Retained checkpoint has an unsafe archive member")
                if member.isfile():
                    payload = archive.extractfile(member).read()
                    expected[member.name] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    source = directory / "source"
    expected[FORCE_PREFIX] = {"bytes": 5635276, "sha256": FORCE_PREFIX_SHA256}
    actual = {}
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Retained checkpoint has a symbolic link")
        if path.is_file():
            actual[path.relative_to(source).as_posix()] = file_record(path)
    if actual != expected:
        raise ValueError("Retained checkpoint differs from its authenticated archives/history")
    request = json.loads((source / "request.json").read_text())
    if (
        request["airfoil"]["name"] != "FX 61-147 AIRFOIL"
        or request["chord_lengths"] != [0.05]
        or request["speeds"] != [30.0]
        or request["solver"]["flow_solver_family"] != "pimpleFoam"
        or request["solver"]["urans_fidelity"] != "full"
        or not request["solver"]["force_transient"]
    ):
        raise ValueError("Retained FX61147 physical/numerical request changed")
    return source, request, actual


def governed_context() -> str:
    for key in ("DEVCOORDINATOR_RUN_ID", "DEVCOORDINATOR_CHECK_NAME", "DEVCOORDINATOR_DIAGNOSTIC_FD"):
        if not os.environ.get(key):
            raise RuntimeError(f"Native validation requires a governed check: {key}")
    os.fstat(int(os.environ["DEVCOORDINATOR_DIAGNOSTIC_FD"]))
    return os.environ["DEVCOORDINATOR_RUN_ID"]


def source_identity() -> dict:
    root = Path(__file__).resolve().parents[2]
    if Path(pipeline.__file__).resolve() != root / "src/airfoilfoam/pipeline.py":
        raise RuntimeError("Imported application source differs from the intended checkout")
    if sha256(Path(pipeline.__file__)) != PIPELINE_SHA256:
        raise RuntimeError("Prepared startup-release candidate changed")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if revision != PREPARED_REVISION:
        raise RuntimeError(f"Expected acknowledged HEAD {PREPARED_REVISION}, got {revision}")
    return {
        "checkout_revision": revision,
        "application_source_sha256": application_source_sha256(root),
        "effective_pipeline_path": str(Path(pipeline.__file__).resolve()),
        "pipeline_sha256": PIPELINE_SHA256,
        "driver_sha256": sha256(Path(__file__)),
        "source_files": {path.relative_to(root).as_posix(): file_record(path) for path in application_source_files(root)},
    }


def history_summary(history) -> dict | None:
    if history is None:
        return None
    return {
        key: getattr(history, key)
        for key in (
            "samples", "window_start", "window_end", "source_start_time", "period_s", "strouhal",
            "cl_mean", "cd_mean", "cm_mean", "cl_rms", "cd_rms", "cm_rms",
        )
    }


def grade_case(case: Path, spec: CaseSpec, solver: SolverParams) -> dict:
    coefficients = pipeline._transient_coeff_selection(case, 600.0)
    history = force_history(
        coefficients, spec.speed, spec.chord, solver.transient_discard_fraction,
        target_cycles=solver.urans_min_periods, alpha_deg=spec.aoa_deg,
        section_thickness_ratio=spec.section_thickness_ratio,
    )
    discarded_history = history_summary(history)
    quiet = pipeline._force_history_for_no_shedding_horizon(coefficients, spec, target_cycles=solver.urans_min_periods)
    if is_no_shedding(quiet):
        history = quiet
    quality = pipeline.evaluate_urans_quality(
        case, history, spec.speed, spec.chord, min_cycles=float(solver.urans_min_periods),
        min_no_shedding_observation_s=pipeline._no_shedding_min_observation_s(spec.speed, spec.chord),
        no_shedding_history=quiet, no_shedding_history_authoritative=True,
    )
    for grader in (
        pipeline._grade_precalc_established_oscillation,
        pipeline._grade_precalc_aperiodic_mean,
        pipeline._grade_full_strict_stationarity,
    ):
        quality = grader(case, coefficients, spec, solver, quality, early_stopped=False)
    no_shedding, certificate_reason = pipeline._no_shedding_observation_certificate(
        history, quality, spec, raw_coefficient_paths=coefficients,
    )
    cycle = pipeline._evidence_backed_cycle_certificate(quality.clean_cycle_audit, publishable=quality.ok)
    invalid = coefficient_invalid_value_times(coefficients)
    certificate_present = bool(no_shedding or (cycle and cycle.certified) or quality.aperiodic_mean_certificate)
    return {
        "quality": asdict(quality),
        "post_discard_history": discarded_history,
        "physical_no_shedding_history": history_summary(quiet),
        "graded_history": history_summary(history),
        "required_no_shedding_observation_s": pipeline._no_shedding_min_observation_s(spec.speed, spec.chord),
        "no_shedding_certificate": no_shedding.model_dump(mode="json") if no_shedding else None,
        "no_shedding_certificate_reason": certificate_reason,
        "urans_cycle_certificate": cycle.model_dump(mode="json") if cycle else None,
        "invalid_raw_samples": int(invalid.size),
        "acceptance_gates_passed": bool(quality.ok and certificate_present and invalid.size == 0),
    }


def matched_window(case: Path, start: float, end: float) -> dict:
    coefficients = pipeline._transient_coeff_selection(case, 600.0)
    values = coefficient_series(coefficients)
    if not values[0][0] <= start < end <= values[0][-1]:
        raise ValueError("Native coefficient history does not cover the complete comparison window")
    if coefficient_invalid_value_times(coefficients).size:
        raise ValueError("Native coefficient history contains non-finite samples")
    selected = _window_series(*values, PeriodWindow(start=start, end=end, cycles=0, period_s=0.0))
    channels = {}
    for name, samples in zip(("cl", "cd", "cm"), selected[1:]):
        mean, rms = _time_weighted_mean_std(selected[0], samples)
        channels[name] = {"mean": mean, "rms": rms, "minimum": float(samples.min()), "maximum": float(samples.max())}
    return {
        "start": start, "end": end, "duration_s": end - start, "samples": int(selected[0].size),
        "endpoint_method": "linear interpolation between native neighboring samples; raw evidence remains unchanged",
        "channels": channels,
    }


def native_identity(runner: DockerRunner, case: Path) -> dict:
    result = runner.run(
        case,
        'printf "XFOILFOAM_NATIVE_VERSION=%s\\n" "$WM_PROJECT_VERSION"; sha256sum "$(command -v pimpleFoam)"',
        timeout=60,
    )
    result.check()
    version = re.search(r"XFOILFOAM_NATIVE_VERSION=(\S+)", result.stdout)
    binary = re.search(r"(?m)^([a-f0-9]{64})\s+(/\S+)", result.stdout)
    if version is None or version[1].removeprefix("v") != "2606" or binary is None or binary[1] != BINARY_SHA256:
        raise RuntimeError("Native OpenCFD 2606 version/binary differs from the retained short comparison")
    return {"version": version[1], "binary_sha256": binary[1], "binary_path": binary[2], "image": IMAGE, "bashrc": BASHRC}


def run_variant(input_directory: Path, destination: Path, variant: str, end_time: float, timeout: int) -> dict:
    run_id = governed_context()
    binding = source_identity()
    source, request, members = authenticate_fixture(input_directory)
    solver = SolverParams.model_validate({**request["solver"], "transient_max_courant": VARIANTS[variant]})
    required = pipeline._no_shedding_min_observation_s(SPEC.speed, SPEC.chord)
    comparison_start = end_time - required
    prefix_values = coefficient_series(source / FORCE_PREFIX)
    if not math.isfinite(end_time) or comparison_start < prefix_values[0][0] or end_time <= float(SAVED_TIME):
        raise ValueError("Requested end cannot cover the real full physical observation horizon")
    output = destination.resolve() / variant / run_id
    output.mkdir(parents=True, exist_ok=False)
    shutil.copy2(__file__, output / "driver.py")
    shutil.copy2(source / "request.json", output / "source-request.json")
    case = output / "case"
    for folder in ("constant", "system", SAVED_TIME):
        shutil.copytree(source / folder, case / folder)
    prefix = case / "postProcessing/forceCoeffs1/600/coefficient.dat"
    prefix.parent.mkdir(parents=True)
    shutil.copy2(source / FORCE_PREFIX, prefix)
    control = case / "system/controlDict"
    original = control.read_text()
    cadence = root_entry(original, "writeInterval")
    maximum_step = STARTUP_MAX_DELTA_T * VARIANTS[variant]
    integration_end = float(f"{end_time + STARTUP_MAX_DELTA_T * 4.0:.15g}")
    text = original
    for key, value in {"endTime": f"{integration_end:.15g}", "deltaT": 1.1979032e-6}.items():
        text = root_entry(text, key, value)
    atomic_dictionary(control, text)
    release = pipeline._make_urans_monitor(
        case, SPEC, 600.0, solver_params=solver, settled_max_courant=VARIANTS[variant],
        startup_max_delta_t=STARTUP_MAX_DELTA_T, allow_quiet_startup_release=True,
    )
    release()
    text = control.read_text()
    if float(root_entry(text, "maxCo")) != VARIANTS[variant] or not math.isclose(
        float(root_entry(text, "maxDeltaT")), maximum_step, rel_tol=1e-10,
    ):
        raise RuntimeError("Candidate did not release the prepared bounded timestep")
    for key, value in {"writeInterval": cadence, "endTime": f"{integration_end:.15g}", "stopAt": "endTime", "runTimeModifiable": "false"}.items():
        text = root_entry(text, key, value)
    atomic_dictionary(control, text)
    if (case / pipeline.URANS_IMPULSE_RECOVERY_MARKER).exists():
        raise RuntimeError("The frozen source needs numerical recovery before comparison")
    protected = {relative: record for relative, record in members.items() if relative not in ("request.json", FORCE_PREFIX, "system/controlDict")}
    if any(file_record(case / relative) != expected for relative, expected in protected.items()):
        raise RuntimeError("A physical, mesh, field or solver dictionary changed")
    runner = DockerRunner(Settings(
        _env_file=None, openfoam_image=IMAGE, openfoam_bashrc=BASHRC,
        engine_family="openfoam", engine_distribution="opencfd", engine_version="2606",
        engine_numerics_revision="2", engine_adapter_contract_version=1,
    ))
    if dialect_for_runner(runner) != OPENCFD_2606:
        raise RuntimeError("The configured runner is not OpenCFD 2606")
    report = {
        "kind": "exact-fx61147-full-duration-timestep-v1", "run_id": run_id, "variant": variant,
        "source_job": SOURCE_JOB, "source_engine_revision": SOURCE_REVISION,
        "source_binding": binding, "fixture_members": members, "source_archives": ARCHIVES,
        "saved_time": float(SAVED_TIME), "comparison_start": comparison_start,
        "measurement_end": end_time, "integration_end": integration_end,
        "configured_courant": VARIANTS[variant], "configured_max_delta_t": maximum_step,
        "original_field_write_interval": float(cadence), "discard_fraction": solver.transient_discard_fraction,
        "comparison_policy": "fixed original field cadence and horizon; startup release once, then observe-only",
        "temporal_accuracy_validated": False, "production_evidence": False, "accepted_cfd": False,
        "native_identity": native_identity(runner, case), "diagnostic_complete": False,
    }
    write_json(output / "report.json", report)
    observed = 0.0
    started = time.monotonic()

    def observe() -> None:
        nonlocal observed
        now = time.monotonic()
        if observed and now - observed < 60:
            return
        observed = now
        latest = None
        for path in case.glob("postProcessing/forceCoeffs*/*/coefficient.dat"):
            with path.open("rb") as stream:
                stream.seek(max(0, path.stat().st_size - 8192))
                lines = stream.read().splitlines()
            for line in reversed(lines):
                if line and not line.startswith(b"#"):
                    try:
                        timestamp = float(line.split()[0])
                    except (ValueError, IndexError):
                        continue
                    latest = max(latest or timestamp, timestamp)
                    break
        progress = {"variant": variant, "elapsed_s": now - started, "latest_force_time": latest, "target": end_time}
        write_json(output / "progress.json", progress)
        print(json.dumps(progress), flush=True)

    try:
        result = runner.run(case, "pimpleFoam", timeout=timeout, monitor=observe)
        report["solver_active_seconds"] = time.monotonic() - started
        (case / "log.pimpleFoam").write_text(result.stdout)
        native_times = re.findall(r"(?m)^Time = ([^\n]+)", result.stdout)
        delta_times = [float(value) for value in re.findall(r"(?m)^deltaT = ([^\n]+)", result.stdout)]
        execution = re.findall(r"ExecutionTime = ([\d.]+) s\s+ClockTime = ([\d.]+) s", result.stdout)
        report.update({
            "returncode": result.returncode, "timed_out": result.timed_out, "native_steps": len(native_times),
            "latest_native_time": float(native_times[-1]) if native_times else None,
            "delta_t_min": min(delta_times) if delta_times else None,
            "delta_t_max": max(delta_times) if delta_times else None,
            "delta_t_median": float(np.median(delta_times)) if delta_times else None,
            "native_cpu_seconds": float(execution[-1][0]) if execution else None,
            "native_clock_seconds": float(execution[-1][1]) if execution else None,
        })
        report["prefix_unchanged"] = sha256(prefix) == FORCE_PREFIX_SHA256
        report["protected_members_unchanged"] = all(file_record(case / relative) == expected for relative, expected in protected.items())
        report["control_unchanged"] = control.read_text() == text
        coefficients = pipeline._transient_coeff_selection(case, 600.0)
        values = coefficient_series(coefficients)
        report["raw_force_time_start"] = float(values[0][0])
        report["raw_force_time_end"] = float(values[0][-1])
        report["raw_observation_s"] = float(values[0][-1] - values[0][0])
        report["grading"] = grade_case(case, SPEC, solver)
        report["matched_window"] = matched_window(case, comparison_start, end_time)
        report["source_unchanged"] = source_identity() == binding
        report["diagnostic_complete"] = bool(
            result.ok and values[0][-1] >= end_time and report["prefix_unchanged"]
            and report["protected_members_unchanged"] and report["control_unchanged"] and report["source_unchanged"]
        )
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["retained_files"] = {
            path.relative_to(output).as_posix(): file_record(path)
            for path in sorted(case.rglob("*")) if path.is_file()
        }
        write_json(output / "report.json", report)
        print(json.dumps({key: report.get(key) for key in ("variant", "diagnostic_complete", "solver_active_seconds", "raw_observation_s", "grading", "matched_window", "error")}), flush=True)
    if not report["diagnostic_complete"] or not report["grading"]["acceptance_gates_passed"]:
        raise RuntimeError("Full-duration evidence did not pass the unchanged acceptance gates; retained report explains the result")
    return report


def compare(destination: Path) -> dict:
    run_id = governed_context()
    reports = {name: json.loads((destination / name / run_id / "report.json").read_text()) for name in VARIANTS}
    candidate, refined = reports["candidate"], reports["refined"]
    for key in ("source_binding", "fixture_members", "source_archives", "native_identity", "comparison_start", "measurement_end", "integration_end", "original_field_write_interval", "discard_fraction"):
        if candidate[key] != refined[key]:
            raise RuntimeError(f"Matched full-duration inputs differ: {key}")
    result = {
        "kind": "exact-fx61147-full-duration-comparison-v1", "run_id": run_id,
        "temporal_accuracy_validated": False, "production_evidence": False, "accepted_cfd": False,
        "absolute_temporal_accuracy": "unvalidated: no full Co1 baseline, asymptotic-order proof, or justified error criterion",
        "comparison_window": {"start": candidate["comparison_start"], "end": candidate["measurement_end"]},
        "source_binding": candidate["source_binding"], "native_identity": candidate["native_identity"],
        "reports": {name: {"path": str(destination / name / run_id / "report.json"), **file_record(destination / name / run_id / "report.json")} for name in VARIANTS},
        "runs": {name: {key: report.get(key) for key in ("configured_courant", "solver_active_seconds", "native_cpu_seconds", "native_steps", "delta_t_median", "raw_observation_s", "grading", "matched_window", "diagnostic_complete", "error")} for name, report in reports.items()},
    }
    if all(report.get("matched_window") for report in reports.values()):
        result["candidate_minus_refined"] = {
            channel: {statistic: candidate["matched_window"]["channels"][channel][statistic] - refined["matched_window"]["channels"][channel][statistic] for statistic in ("mean", "rms")}
            for channel in ("cl", "cd", "cm")
        }
    result["diagnostic_complete"] = all(report["diagnostic_complete"] for report in reports.values())
    result["both_acceptance_gates_passed"] = all(report.get("grading", {}).get("acceptance_gates_passed", False) for report in reports.values())
    output = destination / "comparison" / run_id
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "report.json", result)
    print(json.dumps({key: value for key, value in result.items() if key not in ("source_binding", "runs")}), flush=True)
    if not result["diagnostic_complete"] or not result["both_acceptance_gates_passed"]:
        raise RuntimeError("Matched full-duration comparison is incomplete or rejects physical evidence")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-directory", type=Path)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--variant", choices=tuple(VARIANTS))
    parser.add_argument("--end-time", type=float, default=600.075)
    parser.add_argument("--timeout", type=int, default=16000)
    parser.add_argument("--compare", action="store_true")
    arguments = parser.parse_args()
    if arguments.compare:
        compare(arguments.destination.resolve())
    else:
        if arguments.input_directory is None or arguments.variant is None or not 1 <= arguments.timeout <= 16000:
            parser.error("A bounded variant and explicit private fixture directory are required")
        run_variant(arguments.input_directory, arguments.destination, arguments.variant, arguments.end_time, arguments.timeout)


if __name__ == "__main__":
    main()
