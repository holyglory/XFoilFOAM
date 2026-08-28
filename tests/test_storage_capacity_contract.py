from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_production_hydration_cache_cap_cannot_be_overridden_by_stale_env() -> None:
    for compose_name in ("docker-compose.yml", "docker-compose.deploy.yml"):
        compose = yaml.safe_load((ROOT / compose_name).read_text())
        for service_name in ("api", "worker", "worker-foundation14"):
            environment = compose["services"][service_name]["environment"]
            assert (
                environment["AIRFOILFOAM_EVIDENCE_HYDRATION_CACHE_MAX_GB"]
                == "10"
            )
