import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from scripts.materials.measure_retained_polar import replay_source
from scripts.materials.screen_sparse_polar_means import CANDIDATES, PILOT_SHA256, measure_candidate_profile, study_destination
from scripts.materials.validate_history_transfer import pinned_json, geometry_signature
from scripts.materials.calibrate_history_bias import SELECTION_SHA256
from scripts.materials.validate_polar_uncertainty import write_result


COHORTS = {
    "fit": "dbfae0bda2197f092c5ebdd116a9ecfbec8fb8551492d40bf2d069c533cc8450",
    "calibration": "3064695863541664cfd08ebf8315cc07e70325f8361af9d8ceee3e47bedf610b",
    "heldout": "edbf67d62612bb5b1b8bf1acd91167069222bca8cb4c4100bd77e6997a2c1a4c",
}
COUNTS = {"fit": 12, "calibration": 20, "heldout": 20}


def verify_sources(source_paths, pilot_path):
    if set(source_paths) != set(COHORTS):
        raise ValueError("Every frozen cohort partition is required")
    pilot = pinned_json(pilot_path, PILOT_SHA256)
    if pilot.get("kind") != "retained-polar-cohort-export-v1" or len(pilot.get("sources", [])) != 8:
        raise ValueError("The excluded pilot changed")
    profiles = {source["physical"]["airfoilId"] for source in pilot["sources"]}
    geometries = {geometry_signature(source) for source in pilot["sources"]}
    models = set()
    sources = {}
    for partition, path in source_paths.items():
        payload = pinned_json(path, COHORTS[partition])
        if (payload.get("kind") != "retained-polar-cohort-export-v1" or payload.get("partition") != partition
                or payload.get("selectionSha256") != SELECTION_SHA256
                or len(payload.get("sources", [])) != COUNTS[partition]):
            raise ValueError("Cohort partition contract changed")
        sources[partition] = payload["sources"]
        for source in payload["sources"]:
            profile = source["physical"]["airfoilId"]
            geometry = geometry_signature(source)
            model = source["model"]["id"]
            if (profile in profiles or geometry in geometries or model in models
                    or not isinstance(model, str) or len(model) != 64 or any(character not in "0123456789abcdef" for character in model)):
                raise ValueError("Pilot or cohort profile, geometry or model overlaps")
            profiles.add(profile)
            geometries.add(geometry)
            models.add(model)
    return sources


def run(source_paths, pilot_path, destination):
    partitions = verify_sources(source_paths, pilot_path)
    destination.mkdir(parents=True, exist_ok=False)
    for partition, path in source_paths.items():
        (destination / f"{partition}-cohort.json").write_bytes(Path(path).read_bytes())
    (destination / "excluded-pilot.json").write_bytes(Path(pilot_path).read_bytes())
    for filename in ("validate_grouped_history_cohort.py", "screen_sparse_polar_means.py", "grouped_polar_conflicts.py"):
        (destination / filename).write_bytes(Path(__file__).with_name(filename).read_bytes())
    for filename in ("polar_conflicts.py", "progressive_polar.py"):
        (destination / filename).write_bytes(Path(__file__).resolve().parents[2].joinpath("src/airfoilfoam/postprocess",filename).read_bytes())
    reports = {candidate: {partition: [] for partition in source_paths} for candidate in CANDIDATES}
    failures = []
    profile_ids = []
    for partition, sources in partitions.items():
        for source in sources:
            profile_ids.append(source["physical"]["airfoilId"])
            model_id = source["model"]["id"]
            source_dir = destination / partition / model_id
            source_dir.mkdir(parents=True)
            source_path = source_dir / "source.json"
            source_bytes = json.dumps(source, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            source_path.write_bytes(source_bytes)
            try:
                replayed_source, request, _ = replay_source(source_path, hashlib.sha256(source_bytes).hexdigest())
            except Exception as error:
                failures.append({"partition": partition, "model_id": model_id, "candidate": None, "error": str(error)})
                continue
            for candidate in CANDIDATES:
                try:
                    report = measure_candidate_profile(replayed_source, request, candidate)
                    write_result(source_dir / f"{candidate}.json", report)
                    reports[candidate][partition].append(report)
                except Exception as error:
                    failures.append({"partition": partition, "model_id": model_id, "candidate": candidate, "error": str(error)})
    if len(profile_ids) != len(set(profile_ids)):
        raise ValueError("Disjoint cohort partitions repeat a profile")
    summary = {"kind": "grouped-history-cohort-screening-v1", "complete": not failures,
               "production_policy_changed": False, "pilot_excluded_source_sha256": PILOT_SHA256,
               "validation_scope": "previously_examined_retained_comparison_not_new_blind_validation",
               "cohort_source_sha256": COHORTS, "profile_count": len(profile_ids), "failures": failures,
               "metrics": {}}
    for candidate, partitions in reports.items():
        summary["metrics"][candidate] = {}
        for partition, rows in partitions.items():
            errors = np.asarray([row["mean_absolute_error"] for row in rows], dtype=float)
            summary["metrics"][candidate][partition] = {
                "profiles": len(rows),
                "mean_absolute_error": np.mean(errors, axis=0).tolist() if len(rows) else None,
                "maximum_absolute_error": np.max(errors, axis=0).tolist() if len(rows) else None,
                "activated_profiles": sum(any(any(any(channel["variance_multiplier"] > 0 for channel in group["coefficients"])
                    for group in reference.get("conditional_groups", [])) for reference in row["references"]) for row in rows),
            }
    write_result(destination / "summary.json", summary)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fit", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--heldout", type=Path, required=True)
    parser.add_argument("--pilot", type=Path, required=True)
    destinations = parser.add_mutually_exclusive_group(required=True)
    destinations.add_argument("--destination", type=Path)
    destinations.add_argument("--runs-directory", type=Path)
    args = parser.parse_args()
    destination = study_destination(args.destination, args.runs_directory)
    result = run({"fit": args.fit, "calibration": args.calibration, "heldout": args.heldout}, args.pilot, destination)
    print(json.dumps({"destination": str(destination), "complete": result["complete"], "profiles": result["profile_count"], "failures": len(result["failures"])}))
    raise SystemExit(0 if result["complete"] else 1)
