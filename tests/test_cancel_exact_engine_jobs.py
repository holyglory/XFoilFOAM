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
    / "cancel-exact-engine-jobs.py"
)


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cancel_exact_engine_jobs", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_exact_job_ids_are_canonical_and_unique() -> None:
    module = load_script()
    assert module.validate_job_ids(["b" * 32, "a" * 32]) == ["a" * 32, "b" * 32]
    with pytest.raises(ValueError, match="duplicate"):
        module.validate_job_ids(["a" * 32, "a" * 32])
    with pytest.raises(ValueError, match="32 lowercase"):
        module.validate_job_ids(["A" * 32])
