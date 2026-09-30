import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from scripts.materials.measure_retained_polar import replay_source
from scripts.materials.screen_sparse_polar_means import CANDIDATES, measure_candidate_profile
from scripts.materials.validate_history_transfer import pinned_json
from scripts.materials.validate_polar_uncertainty import write_result


COHORTS = {
    "fit": "dbfae0bda2197f092c5ebdd116a9ecfbec8fb8551492d40bf2d069c533cc8450",
    "calibration": "3064695863541664cfd08ebf8315cc07e70325f8361af9d8ceee3e47bedf610b",
    "heldout": "edbf67d62612bb5b1b8bf1acd91167069222bca8cb4c4100bd77e6997a2c1a4c",
}
PILOT_EXCLUDED = "a25a1ec79120cd7794a04e808328d23560d1839d4806aaf492a94952e4f62a8b6"


def run(source_paths, destination):
    destination.mkdir(parents=True, exist_ok=False)
    reports = {candidate: {partition: [] for partition in source_paths} for candidate in CANDIDATES}
    failures = []
    profile_ids = []
    for partition, path in source_paths.items():
        payload = pinned_json(path, COHORTS[partition])
        if payload.get("kind") != "retained-polar-cohort-export-v1" or payload.get("partition") != partition:
            raise ValueError("Cohort partition contract changed")
        for source in payload.get("sources", []):
            profile_ids.append(source["physical"]["airfoilId"])
            model_id = source["model"]["id"]
            source_dir = destination / partition / model_id
            source_dir.mkdir(parents=True)
            source_path = source_dir / "source.json"
            source_bytes = json.dumps(source, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            source_path.write_bytes(source_bytes)
            try:
                replayed_source, request, _ = replay_source(source_path, hashlib.sha256(source_bytes).hexdigest())
                for candidate in CANDIDATES:
                    report = measure_candidate_profile(replayed_source, request, candidate)
                    write_result(source_dir / f"{candidate}.json", report)
                    reports[candidate][partition].append(report)
            except Exception as error:
                failures.append({"partition": partition, "model_id": model_id, "error": str(error)})
    if len(profile_ids) != len(set(profile_ids)):
        raise ValueError("Disjoint cohort partitions repeat a profile")
    summary = {"kind": "grouped-history-cohort-screening-v1", "complete": not failures,
               "production_policy_changed": False, "pilot_excluded_source_sha256": PILOT_EXCLUDED,
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
            }
    write_result(destination / "summary.json", summary)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fit", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--heldout", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    result = run({"fit": args.fit, "calibration": args.calibration, "heldout": args.heldout}, args.destination)
    print(json.dumps({"complete": result["complete"], "profiles": result["profile_count"], "failures": len(result["failures"])}))
    raise SystemExit(0 if result["complete"] else 1)
