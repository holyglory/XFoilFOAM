"""Real dictionary/integration smoke checks, not converged polar validation."""

import json
from pathlib import Path
import subprocess

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.numerical_canary import run_canary
from airfoilfoam.openfoam.runner import DockerRunner


pytestmark = pytest.mark.integration


def test_pinned_runtime_available():
    settings = Settings()
    result = subprocess.run([settings.docker_binary, "image", "inspect", settings.openfoam_image], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, f"Cannot verify the pinned OpenCFD runtime; no skipped numerical canary: {result.stderr.strip()[-500:]}"
    images = json.loads(result.stdout)
    assert len(images) == 1 and images[0]["Id"].startswith("sha256:")


@pytest.mark.parametrize("family,mach", [
    pytest.param("rhoSimpleFoam", 0.72, id="rhoSimple-subsonic"),
    pytest.param("rhoPimpleFoam", 0.9, id="rhoPimple-transonic"),
    pytest.param("rhoCentralFoam", 2.0, id="rhoCentral-mach2"),
    pytest.param("rhoCentralFoam", 3.0, id="rhoCentral-mach3"),
])
def test_real_compressible_integration(family, mach, tmp_path):
    source = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    receipt = run_canary(family, mach, source, tmp_path / "case", DockerRunner(Settings()))
    assert receipt["force_samples"] >= 3
    assert receipt["solver_active_seconds"] > 0
    assert receipt["converged_polar_validated"] is False
