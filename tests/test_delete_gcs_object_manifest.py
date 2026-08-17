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
    / "delete-gcs-object-manifest.py"
)


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("delete_gcs_object_manifest", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_manifest_requires_unique_generation_pinned_targets(tmp_path: Path) -> None:
    module = load_script()
    manifest = tmp_path / "objects.csv"
    manifest.write_text(
        "bucket,object_key,generation,byte_size,contract_disposition\n"
        "private-evidence,results/a.tar.zst,123,456,obsolete_no_modern_canonical\n"
        "private-evidence,results/a.tar.zst,123,456,obsolete_no_modern_canonical\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicates an object generation"):
        module.load_targets(manifest)


def test_delete_uses_exact_generation_precondition() -> None:
    module = load_script()
    calls: list[tuple[str, int, int, float]] = []

    class Blob:
        def delete(self, *, if_generation_match: int, timeout: float) -> None:
            calls.append(("delete", 17, if_generation_match, timeout))

    class Bucket:
        def blob(self, object_key: str, *, generation: int) -> Blob:
            assert object_key == "results/a.tar.zst"
            assert generation == 17
            return Blob()

    class Client:
        def bucket(self, name: str) -> Bucket:
            assert name == "private-evidence"
            return Bucket()

    target = module.Target(
        "private-evidence", "results/a.tar.zst", 17, 456, "obsolete_no_modern_canonical"
    )
    assert module.delete_target(Client(), target, 30.0) == "deleted"
    assert calls == [("delete", 17, 17, 30.0)]


def test_delete_is_idempotent_when_generation_is_absent() -> None:
    module = load_script()

    class NotFound(Exception):
        code = 404

    class Blob:
        def delete(self, **_: object) -> None:
            raise NotFound()

    class Bucket:
        def blob(self, *_: object, **__: object) -> Blob:
            return Blob()

    class Client:
        def bucket(self, _: str) -> Bucket:
            return Bucket()

    target = module.Target(
        "private-evidence", "results/a.tar.zst", 17, 456, "obsolete_no_modern_canonical"
    )
    assert module.delete_target(Client(), target, 30.0) == "already_absent"


def test_manifest_refuses_unclassified_targets(tmp_path: Path) -> None:
    module = load_script()
    manifest = tmp_path / "objects.csv"
    manifest.write_text(
        "bucket,object_key,generation,byte_size,contract_disposition\n"
        "private-evidence,results/a.tar.zst,123,456,unknown\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="not explicitly classified"):
        module.load_targets(manifest)
