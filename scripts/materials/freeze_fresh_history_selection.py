"""Freeze a reviewed read-only selection query without reading solver errors."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from uuid import UUID, uuid4


TEMPLATE = Path(__file__).with_name("fresh_history_selection.sql")
MAX_INPUT_BYTES = 16 * 1024 * 1024


def source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_source(path):
    from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object

    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Prior source exceeds the bounded input size")
    raw = path.read_bytes()
    return raw, json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)


def source_exclusions(path):
    raw, payload = read_source(path)
    kind = payload.get("kind")
    if kind == "retained-polar-cohort-export-v1":
        sources = payload.get("sources", [])
    elif kind == "frozen-history-transfer-export-v1":
        sources = [row["source"] for row in payload.get("sources", [])]
    elif kind == "retained-polar-holdout-source-v1" or {"model", "physical", "target"} <= payload.keys():
        sources = [payload]
    else:
        raise ValueError("Unsupported prior-study source")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 64:
        raise ValueError("Prior study must contain one to64 sources")
    profiles, geometries = set(), set()
    for source in sources:
        physical = source["physical"]
        profile = str(UUID(physical["airfoilId"]))
        geometry = physical["geometry"]
        if (not isinstance(geometry, list) or not 3 <= len(geometry) <= 4096
                or any(not isinstance(point, list) or len(point) != 2 or any(
                    isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    for value in point) for point in geometry)):
            raise ValueError("Prior geometry must contain finite coordinate pairs")
        profiles.add(profile)
        geometries.add(json.dumps([[float(value) for value in point] for point in geometry], separators=(",", ":"), allow_nan=False))
    return profiles, geometries, hashlib.sha256(raw).hexdigest()


def build_selection_sql(template: Path, prior_sources: list[Path], per_cohort: int, diagnosis: Path | None = None) -> tuple[str, dict]:
    if type(per_cohort) is not int or not 1 <= per_cohort <= 64:
        raise ValueError("per-cohort selection must be between 1 and 64")
    template_bytes = template.read_bytes()
    if template_bytes != TEMPLATE.read_bytes():
        raise ValueError("Selection requires the reviewed read-only SQL template")
    original = template_bytes.decode()
    profiles: set[str] = set()
    geometries: set[str] = set()
    input_hashes = {str(template): hashlib.sha256(template_bytes).hexdigest()}
    for source in prior_sources:
        source_profiles, source_geometries, signature = source_exclusions(source)
        profiles.update(source_profiles)
        geometries.update(source_geometries)
        input_hashes[str(source)] = signature
    if not profiles:
        raise ValueError("at least one prior cohort source is required")
    slugs = set()
    if diagnosis is not None:
        raw, payload = read_source(diagnosis)
        if payload.get("kind") != "production-polar-diagnosis-v1":
            raise ValueError("Unsupported diagnosed-profile source")
        for row in payload["baseline_to_composite_reversals"]["records"]:
            slug = row["slug"]
            if not isinstance(slug, str) or not slug or len(slug) > 200:
                raise ValueError("Invalid diagnosed profile slug")
            slugs.add(slug)
        input_hashes[str(diagnosis)] = hashlib.sha256(raw).hexdigest()
    def literal(value):
        return json.dumps(value, separators=(",", ":"), allow_nan=False).replace("'", "''")
    replacements = {"__PROFILE_IDS__": literal(sorted(profiles)),
                    "__GEOMETRIES__": literal([json.loads(value) for value in sorted(geometries)]),
                    "__DIAGNOSED_SLUGS__": literal(sorted(slugs)), "__PER_COHORT__": str(per_cohort)}
    query = original
    for marker, replacement in replacements.items():
        if original.count(marker) != (2 if marker == "__PER_COHORT__" else 1):
            raise ValueError("Reviewed SQL template marker contract changed")
        query = query.replace(marker, replacement)
    protocol = {
        "kind": "fresh-history-selection-sql-v2",
        "read_only": True,
        "profile_exclusion_count": len(profiles),
        "geometry_exclusion_count": len(geometries),
        "diagnosed_slug_count": len(slugs),
        "per_cohort": per_cohort,
        "selection_rule": "current verified fit; revision2 mesh3 history and independent accepted reference; exclude prior profiles/geometries and diagnosed profiles; distinct profile/geometry; fixed identity ordering",
        "cohorts": ["iteration", "physical_time"],
        "coefficient_error_filtering": False,
        "exclusions_complete": "only_the_named_input_sources",
        "input_sha256": input_hashes,
        "query_sha256": hashlib.sha256(query.encode()).hexdigest(),
    }
    return query, protocol


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, default=TEMPLATE)
    parser.add_argument("--prior", type=Path, action="append", required=True)
    parser.add_argument("--runs-directory", type=Path, required=True)
    parser.add_argument("--per-cohort", type=int, default=26)
    parser.add_argument("--diagnosis", type=Path)
    arguments = parser.parse_args()
    query, protocol = build_selection_sql(arguments.template, arguments.prior, arguments.per_cohort, arguments.diagnosis)
    run = arguments.runs_directory / str(uuid4())
    run.mkdir(parents=True, exist_ok=False)
    (run / "selection.sql").write_text(query)
    (run / "protocol.json").write_text(json.dumps(protocol, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"run": str(run), **protocol}))


if __name__ == "__main__":
    main()
