import json
from pathlib import Path

import pytest

from scripts.materials.freeze_fresh_history_selection import build_selection_sql


def cohort(path: Path, *profiles: str) -> None:
    path.write_text(json.dumps({
        "kind": "retained-polar-cohort-export-v1",
        "sources": [{"physical": {"airfoilId": profile}} for profile in profiles],
    }))


def test_builds_unique_exclusion_sql_and_protocol_hashes(tmp_path: Path) -> None:
    template = tmp_path / "template.sql"
    template.write_text(
        "WITH studied(airfoil_id) AS (VALUES ('00000000-0000-0000-0000-000000000001'::uuid),\n"
        "current_models AS (SELECT 1)\n"
        "SELECT jsonb_build_object('previousStudyProfileCount',60)\n"
        "FROM numbered WHERE selection_rank<=20;\n"
    )
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    cohort(first, "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002")
    cohort(second, "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003")
    query, protocol = build_selection_sql(template, [first, second], 26)
    assert "previousStudyProfileCount',3" in query
    assert "selection_rank<=26" in query
    assert query.count("'00000000-0000-0000-0000-000000000002'::uuid") == 1
    assert protocol["read_only"] is True
    assert len(protocol["input_sha256"]) == 3
    assert len(protocol["query_sha256"]) == 64


def test_refuses_missing_template_or_unbounded_selection(tmp_path: Path) -> None:
    template = tmp_path / "template.sql"
    template.write_text("SELECT 1")
    source = tmp_path / "source.json"
    cohort(source, "00000000-0000-0000-0000-000000000001")
    with pytest.raises(ValueError, match="studied profile CTE"):
        build_selection_sql(template, [source], 26)
    with pytest.raises(ValueError, match="between"):
        build_selection_sql(tmp_path / "template.sql", [source], 65)
