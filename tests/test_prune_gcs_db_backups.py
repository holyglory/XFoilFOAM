from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "ops"
    / "prune-gcs-db-backups.py"
)


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("prune_gcs_db_backups", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def version(module: ModuleType, name: str, generation: int) -> object:
    return module.ObjectVersion(name, generation, 10)


def test_prune_keeps_two_newest_complete_sets() -> None:
    module = load_script()
    prefix = "database-backups/production/"
    objects = []
    for index, timestamp in enumerate(
        ("20260809T205123Z", "20260805T114712Z", "20260804T200546Z"), start=1
    ):
        dump = f"{prefix}app-postgres-1-aerodb-{timestamp}-abc{index}.dump"
        objects.extend(
            [version(module, dump, index), version(module, dump + ".manifest.json", index + 10)]
        )

    complete, other = module.classify(objects, prefix)
    retained, delete = module.deletion_plan(complete, other, 2)

    assert [item.timestamp for item in retained] == ["20260809T205123Z", "20260805T114712Z"]
    assert len(delete) == 2
    assert all("20260804T200546Z" in obj.name for obj in delete)


def test_prune_refuses_without_two_complete_sets() -> None:
    module = load_script()
    prefix = "database-backups/production/"
    dump = f"{prefix}app-postgres-1-aerodb-20260809T205123Z-abc.dump"
    complete, other = module.classify([version(module, dump, 1)], prefix)

    with pytest.raises(RuntimeError, match="only 0 complete backup set"):
        module.deletion_plan(complete, other, 2)


def test_new_incomplete_upload_is_not_deleted() -> None:
    module = load_script()
    prefix = "database-backups/production/"
    objects = []
    for index, timestamp in enumerate(("20260808T000000Z", "20260807T000000Z"), start=1):
        dump = f"{prefix}app-postgres-1-aerodb-{timestamp}-abc{index}.dump"
        objects.extend(
            [version(module, dump, index), version(module, dump + ".manifest.json", index + 10)]
        )
    newest_incomplete = f"{prefix}app-postgres-1-aerodb-20260809T000000Z-new.dump"
    objects.append(version(module, newest_incomplete, 99))

    complete, other = module.classify(objects, prefix)
    _, delete = module.deletion_plan(complete, other, 2)

    assert delete == []
