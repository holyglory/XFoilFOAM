"""Offline short/long monitor replay over authenticated Nov 25 force history.

Stage a read-only corpus and a baseline src snapshot, then run via the existing
governed Python test. Long eligibility uses a recorded native-process-age lower
bound. Short, unavailable and threshold clocks are explicit controlled scenarios
on the same real bytes. No engine process, result publication or CFD speed test.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace


def _json(path: Path):
    return json.loads(path.read_bytes())


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def _timed(call):
    wall, cpu = time.perf_counter(), time.process_time()
    result = call()
    return result, dict(wall=time.perf_counter() - wall, cpu=time.process_time() - cpu)


def _arm(args) -> list[dict]:
    sys.path.insert(0, str(args.source / "src"))
    from airfoilfoam import pipeline
    from airfoilfoam.models import CaseSpec, SolverParams
    from airfoilfoam.openfoam import budget as timing
    from airfoilfoam.openfoam.runner import RunResult
    from airfoilfoam.postprocess.unsteady import coefficient_series

    assert Path(pipeline.__file__).resolve().is_relative_to(args.source.resolve())
    if args.arm == "candidate":
        from airfoilfoam.postprocess import live_coefficients
        reader_class = live_coefficients.LiveCoefficientReader
    records = []
    for metadata in sorted(args.corpus.glob("*/source.json")):
        source = _json(metadata)
        raw = (metadata.parent / "0/coefficient.dat").read_bytes()
        assert _sha(raw) == source["sha"] and len(raw) == source["bytes"]
        assert raw.endswith(b"\n")
        request = source["jobFacts"]["request.json"]
        host, job = source["host"], source["job"]
        observations = [_json(args.corpus / f"{tag}-{host}.json") for tag in ("first", "second")]
        native = [next(row for row in obs["native"] if row["job"] == job) for obs in observations]
        starts = [[row["startTicks"] for row in one["ranks"]] for one in native]
        assert starts[0] == starts[1] == source["rankStart"]
        assert [(r["pid"], r["startTicks"]) for r in native[0]["ranks"]] == [(r["pid"], r["startTicks"]) for r in native[1]["ranks"]]
        assert all(row["rel"] == source["case"] and row["prog"] == source["program"] for row in native)
        assert native[0]["force"]["inode"] == native[1]["force"]["inode"]
        lower_bound = min(float(row["age"]) for row in native[0]["ranks"])
        assert 3600 < lower_bound < 43200
        force_sizes = [row["force"]["size"] for row in native]
        observed_seconds = observations[1]["at"] - observations[0]["at"]
        bytes_per_poll = (force_sizes[1] - force_sizes[0]) / observed_seconds * 10.0
        assert bytes_per_poll > 0
        ends = [raw.rfind(b"\n", 0, len(raw) - round(i * bytes_per_poll)) + 1 for i in reversed(range(6))]
        assert ends == sorted(set(ends)) and ends[-1] == len(raw)
        # All replayed byte prefixes postdate the first observation, so its
        # minimum native-process age is a conservative established lower bound.
        assert ends[0] >= force_sizes[0]
        clocks = {
            "short": [17.0 + i * 10 for i in range(6)],
            "unknown": [None] * 6,
            "crossing": [3590.0, 3599.999, 3600.0, 3601.0, 3610.0, 3620.0],
            "long": [lower_bound] * 6,  # The recorded minimum is enough; do not invent elapsed time.
        }[args.scenario]
        spec = CaseSpec(
            chord=request["chord_lengths"][0], speed=request["speeds"][0],
            aoa_deg=source["jobFacts"]["status.json"]["active_aoa_deg"],
            section_thickness_ratio=_json(args.corpus / f"worker-source-sample-{host}.json")["rows"][job]["thickness"],
        )
        params = SolverParams.model_validate(request["solver"])
        with tempfile.TemporaryDirectory(prefix="force-monitor-", dir=args.output.parent) as temp:
            relative_case = Path(source["case"])
            assert not relative_case.is_absolute() and ".." not in relative_case.parts
            case = Path(temp) / relative_case
            coeff = case / "postProcessing/forceCoeffs1/0/coefficient.dat"
            coeff.parent.mkdir(parents=True)
            for name, _fields in source["sourceTimes"]["root"]:
                (case / name).mkdir(exist_ok=True)
            (case / "system").mkdir()
            for name in ("controlDict", "fvSolution"):
                (case / "system" / name).write_text(source["dictionaries"][f"system/{name}"])
            clock = {"now": 0.0}
            polls, decisions, cached = [], [], []
            monitor_counts = {"construct": 0, "read": 0}
            parser_reader = None
            original_window = pipeline.stable_two_period_window
            original_monotonic = timing.time.monotonic

            def make_reader():
                monitor_counts["construct"] += 1
                reader = reader_class()
                read = reader.read

                def counted(paths):
                    monitor_counts["read"] += 1
                    return read(paths)

                reader.read = counted
                return reader

            def record(*positional, **keywords):
                cached.append("live_reader" in keywords)
                result = original_window(*positional, **keywords)
                decisions.append(dataclasses.asdict(result))
                return result

            def replay(monitor):
                nonlocal parser_reader
                previous = 0
                for index, end in enumerate(ends):
                    clock["now"] = clocks[index] if clocks[index] is not None else float(index * 10)
                    with coeff.open("ab") as stream:
                        stream.write(memoryview(raw)[previous:end])
                    previous = end
                    eligible = args.arm == "candidate" and clocks[index] is not None and clocks[index] >= 3600.0
                    if eligible and parser_reader is None:
                        parser_reader = reader_class()
                    values, parse_timing = _timed(
                        lambda: parser_reader.read([coeff]) if parser_reader is not None else coefficient_series([coeff])
                    )
                    assert values is not None
                    expected = coefficient_series([coeff])
                    assert all(a.tobytes() == b.tobytes() for a, b in zip(values, expected, strict=True))
                    _, monitor_timing = _timed(monitor)
                    assert cached[-1] == eligible
                    assert monitor_counts["construct"] == int(any(cached))
                    assert monitor_counts["read"] == sum(cached)
                    effects = {
                        str(p.relative_to(case)): _sha(p.read_bytes())
                        for p in sorted(case.rglob("*"))
                        if p.is_file() and not p.is_relative_to(case / "postProcessing")
                    }
                    polls.append(dict(
                        bytes=end, samples=len(values[0]),
                        channels=[_sha(a.tobytes()) for a in values],
                        decision=decisions[-1], effects=effects,
                        parser=parse_timing, monitor=monitor_timing,
                        established_active_seconds=clocks[index],
                        monitor_cache_selected=cached[-1],
                        monitor_reader_constructions=monitor_counts["construct"],
                        monitor_cache_reads=monitor_counts["read"],
                    ))
                return RunResult("offline authenticated monitor replay", 0, "No native engine was launched")

            class OfflineRunner:
                external_paths_visible = False
                settings = SimpleNamespace(resolved_worker_cpu_budget=lambda: 4)

                def application(self, _case, command, **_kwargs):
                    assert command.startswith(("decomposePar", "reconstructPar"))
                    return RunResult(command, 0, "offline preparation placeholder")

                def run(self, _case, _command, *, monitor, **_kwargs):
                    return replay(monitor)

                def solver(self, _case, _app, _n_proc, *, monitor, **_kwargs):
                    return replay(monitor)

            inner = OfflineRunner()
            runner = inner if args.scenario == "unknown" else timing.BudgetedRunner(inner, 43200)
            if isinstance(runner, timing.BudgetedRunner):
                runner.begin_case(spec)
            monitor_kwargs = {}
            if args.arm == "candidate":
                monitor_kwargs["solver_active_seconds"] = lambda: timing.case_solver_active_seconds(runner, spec)
                live_coefficients.LiveCoefficientReader = make_reader
            pipeline.stable_two_period_window = record
            timing.time.monotonic = lambda: clock["now"]
            try:
                monitor = pipeline._make_urans_monitor(
                    case, spec, 0.0, solver_params=params,
                    settled_max_courant=params.transient_max_courant,
                    startup_max_delta_t=4.819277108433735e-06 if host == "hz-solver2" else 1.777777777777778e-05,
                    **monitor_kwargs,
                )
                assert monitor_counts["construct"] == 0
                runner.solver(case, source["program"], 4, timeout=43200, restart=True, monitor=monitor)
            finally:
                timing.time.monotonic = original_monotonic
                pipeline.stable_two_period_window = original_window
                if args.arm == "candidate":
                    live_coefficients.LiveCoefficientReader = reader_class
        records.append(dict(
            job=job, name=request["airfoil"]["name"], source_sha256=source["sha"],
            bytes=len(raw), observed_seconds=observed_seconds,
            observed_bytes_added=force_sizes[1] - force_sizes[0],
            native_active_lower_bound_seconds=lower_bound,
            timing_provenance="Recorded same-PID/start-tick native solver age lower bound" if args.scenario == "long" else "Controlled timing scenario on authenticated long-job bytes",
            root_frames=len(source["sourceTimes"]["root"]), polls=polls,
        ))
        print(args.scenario, args.arm, request["airfoil"]["name"], "monitor CPU",
              round(statistics.mean(p["monitor"]["cpu"] for p in polls), 6),
              "cache calls", sum(cached), flush=True)
    assert len(records) == 3
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--arm", choices=("baseline", "candidate"))
    parser.add_argument("--scenario", choices=("short", "unknown", "crossing", "long"))
    args = parser.parse_args()
    if args.arm:
        _save(args.output, _arm(args))
        return
    assert not args.output.exists(), "Keep prior replay evidence immutable; choose a new output"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scenarios, common_evidence = {}, None
    for scenario in ("short", "unknown", "crossing", "long"):
        order = ("baseline", "candidate", "candidate", "baseline") if scenario in ("short", "long") else ("baseline", "candidate")
        runs = []
        for i, label in enumerate(order):
            output = args.output.parent / f"{scenario}-{i}.json"
            assert not output.exists()
            subprocess.run([
                sys.executable, "-B", __file__, "--corpus", str(args.corpus),
                "--source", str(getattr(args, label)), "--arm", label,
                "--scenario", scenario, "--output", str(output),
            ], check=True, env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "PYTHONDONTWRITEBYTECODE": "1"})
            runs.append(_json(output))
        cases, this_evidence = [], []
        for index, first in enumerate(runs[0]):
            evidence = [[{k: p[k] for k in ("bytes", "samples", "channels", "decision", "effects")} for p in run[index]["polls"]] for run in runs]
            assert all(part == evidence[0] for part in evidence), "Numerical or control behavior changed"
            this_evidence.append(evidence[0])
            results = {}
            for label in ("baseline", "candidate"):
                indices = [i for i, value in enumerate(order) if value == label]
                results[label] = {}
                for boundary in ("parser", "monitor"):
                    results[label][boundary] = {clock:dict(
                        cold=[runs[i][index]["polls"][0][boundary][clock] for i in indices],
                        warm_mean=statistics.mean(p[boundary][clock] for i in indices for p in runs[i][index]["polls"][1:]),
                        warm_by_arm=[statistics.mean(p[boundary][clock] for p in runs[i][index]["polls"][1:]) for i in indices],
                    ) for clock in ("wall", "cpu")}
            candidate = runs[order.index("candidate")][index]
            cases.append({k: first[k] for k in ("name", "source_sha256", "bytes", "native_active_lower_bound_seconds", "timing_provenance")} | dict(
                samples=first["polls"][-1]["samples"], all_numerical_and_control_evidence_equal=True,
                cache_selected=[p["monitor_cache_selected"] for p in candidate["polls"]],
                reader_constructions=[p["monitor_reader_constructions"] for p in candidate["polls"]],
                cache_reads=[p["monitor_cache_reads"] for p in candidate["polls"]], results=results,
            ))
        if common_evidence is None:
            common_evidence = this_evidence
        assert this_evidence == common_evidence, "Timing eligibility changed a scientific result"
        scenarios[scenario] = dict(order=order, cases=cases)
    _save(args.output, dict(
        scenarios=scenarios, all_scenarios_numerically_identical=True,
        gate_seconds=3600, total_monitor_calls=216,
        boundary="Actual budget wrapper and monitor closure, real archived prefixes, controlled/replayed active clocks",
        limitation="Offline replay only. Short/crossing clocks are controlled scenarios, not measured short CFD jobs. No whole-solve timing or engine activation.",
        python=sys.version,
    ))
    print("Retained gated replay:", args.output, flush=True)


if __name__ == "__main__":
    main()
