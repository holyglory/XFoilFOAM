"""Build a read-only production cohort-selection SQL document.

The generated SQL must be executed by the reviewed operator workflow. This
utility never connects to a database, reads coefficients, or selects based on
errors. It only excludes previously studied profiles and emits a content-bound
selection contract for later export.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from uuid import uuid4


UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f-]{27,}")
STUDIED_CTE = re.compile(
    r"WITH studied\(airfoil_id\) AS \(VALUES .*?\),\ncurrent_models", re.S
)


def source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def profile_ids_from_source(path: Path) -> set[str]:
    payload = json.loads(path.read_text())
    if payload.get("kind") != "retained-polar-cohort-export-v1":
        raise ValueError(f"unsupported retained cohort: {path}")
    return {source["physical"]["airfoilId"] for source in payload["sources"]}


def build_selection_sql(template: Path, prior_sources: list[Path], per_cohort: int) -> tuple[str, dict]:
    if not 1 <= per_cohort <= 64:
        raise ValueError("per-cohort selection must be between 1 and 64")
    original = template.read_text()
    match = STUDIED_CTE.search(original)
    if not match:
        raise ValueError("selection template has no studied profile CTE")
    profiles: set[str] = set()
    input_hashes = {str(template): source_sha256(template)}
    for source in prior_sources:
        profiles.update(profile_ids_from_source(source))
        input_hashes[str(source)] = source_sha256(source)
    if not profiles:
        raise ValueError("at least one prior cohort source is required")
    values = ",".join(f"('{profile}'::uuid)" for profile in sorted(profiles))
    replacement = f"WITH studied(airfoil_id) AS (VALUES {values}),\ncurrent_models"
    query = original[: match.start()] + replacement + original[match.end() :]
    query = query.replace("'previousStudyProfileCount',60", f"'previousStudyProfileCount',{len(profiles)}")
    query = query.replace("WHERE selection_rank<=20", f"WHERE selection_rank<={per_cohort}")
    if query == original:
        raise ValueError("selection template replacements made no change")
    protocol = {
        "kind": "fresh-history-selection-sql-v1",
        "read_only": True,
        "profile_exclusion_count": len(profiles),
        "per_cohort": per_cohort,
        "selection_rule": "exact prior-profile exclusion, exact geometry exclusion in SQL, source/job/unit eligibility, identity ordering, no coefficient/error filtering",
        "input_sha256": input_hashes,
        "query_sha256": hashlib.sha256(query.encode()).hexdigest(),
    }
    return query, protocol


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--prior", type=Path, action="append", required=True)
    parser.add_argument("--runs-directory", type=Path, required=True)
    parser.add_argument("--per-cohort", type=int, default=26)
    arguments = parser.parse_args()
    run = arguments.runs_directory / str(uuid4())
    run.mkdir(parents=True, exist_ok=False)
    query, protocol = build_selection_sql(arguments.template, arguments.prior, arguments.per_cohort)
    (run / "selection.sql").write_text(query)
    (run / "protocol.json").write_text(json.dumps(protocol, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"run": str(run), **protocol}))


if __name__ == "__main__":
    main()
