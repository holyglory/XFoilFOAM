from pathlib import Path
import runpy

import pytest


RESET = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/deploy/reset-solver-domain.py"))


def recognized_tables():
    return [{"schema": "public", "name": name} for name in ("airfoils", "sim_campaigns", "sync_api_settings")]


def test_reset_rejects_unclassified_tables_and_schemas():
    for row in ({"schema": "public", "name": "user_documents"},
                {"schema": "private", "name": "results"}):
        with pytest.raises(ValueError, match="Unclassified"):
            RESET["classify_tables"]([*recognized_tables(), row])


def test_reset_never_truncates_configuration_or_uses_cascade():
    with pytest.raises(ValueError, match="explicit solver domain"):
        RESET["truncate_statement"](["results", "sim_campaigns"])
    command = RESET["truncate_statement"](["sim_jobs", "results"])
    assert "RESTRICT" in command
    assert "CASCADE" not in command
    assert command == 'TRUNCATE TABLE public."results", public."sim_jobs" RESTART IDENTITY RESTRICT;'


def test_reset_allowlists_are_disjoint_and_preserve_campaign_membership():
    assert not RESET["CONFIGURATION_TABLES"] & RESET["SOLVER_TABLES"]
    assert {"sim_campaign_airfoils", "sim_campaign_plan_revisions", "sim_campaign_conditions",
            "registered_remote_solvers", "sync_api_settings"} <= RESET["CONFIGURATION_TABLES"]
    assert {"results", "result_attempts", "force_history", "sim_jobs",
            "sync_sweep_promises", "polar_fit_sets", "solver_evidence_incomplete_quarantines",
            "solver_evidence_orphan_quarantines", "progressive_cfd_units", "progressive_cfd_attempts",
            "progressive_cfd_execution_stops", "progressive_cfd_stage_decisions", "progressive_cfd_runtime_progress",
            "progressive_prediction_repairs", "progressive_prediction_repair_attempts", "progressive_recipe_adoptions"} <= RESET["SOLVER_TABLES"]


def test_preserved_foreign_keys_cannot_retain_solver_dependencies():
    with pytest.raises(ValueError, match="Configuration depends"):
        RESET["validate_foreign_keys"]([{"source": "sim_campaigns", "target": "results"}], ["sim_campaigns"])
    RESET["validate_foreign_keys"]([{"source": "results", "target": "sim_campaigns"}], ["sim_campaigns"])


def test_scope_export_contains_angles_and_identity_but_not_result_values():
    query = RESET["SCOPE_QUERY"]
    assert "jsonb_agg(aoa_deg ORDER BY aoa_deg)" in query
    for forbidden in ("result_id", "result_attempt_id", "cl", "cd", "cm"):
        assert forbidden not in query.split()


def test_atomic_receipt_and_artifact_fingerprint_detect_corruption(tmp_path):
    path = tmp_path / "proof.json"
    RESET["atomic_json"](path, {"verified": True})
    before = RESET["fingerprint"](path)
    assert path.stat().st_mode & 0o077 == 0
    path.write_text('{"verified": false}')
    assert RESET["fingerprint"](path) != before


def test_invalid_identifiers_and_unknown_deployments_are_refused(tmp_path):
    with pytest.raises(ValueError, match="identifier"):
        RESET["identifier"]("results; DROP SCHEMA public")
    with pytest.raises(ValueError, match="Unknown deployment"):
        RESET["Reset"]("other-project", tmp_path)


def test_bucket_cleanup_preserves_bucket_and_all_policy_settings():
    path = Path(__file__).resolve().parents[1] / "scripts/deploy/clear-solver-object-storage.py"
    storage = runpy.run_path(str(path))
    policy = {"name": "bucket", "softDeletePolicy": {"retentionDurationSeconds": "2592000"},
              "versioning": {"enabled": True}, "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}}}
    assert storage["policy_projection"]({**policy, "updated": "new", "metageneration": "2"}) == policy
    source = path.read_text()
    assert '"gs://" + BUCKET + "/**"' in source
    assert '"--all-versions"' in source
    assert '"--recursive"' not in source
    assert '"retentionDurationSeconds"' not in source


def test_runtime_cleanup_rejects_other_projects_and_database_volumes():
    mounts = [{"Destination": "/data/airfoilfoam", "Type": "volume", "Name": "app_results"}]
    volume = {"Name": "app_results", "Mountpoint": "/var/lib/docker/volumes/app_results/_data",
              "Labels": {"com.docker.compose.project": "app", "com.docker.compose.volume": "results"}}
    root = RESET["runtime_volume_root"]("app", "results", "/data/airfoilfoam", mounts, volume)
    assert str(root) == volume["Mountpoint"]
    for invalid in ({**volume, "Name": "app_pgdata"},
                    {**volume, "Mountpoint": "/var/lib/docker/volumes/app_pgdata/_data"},
                    {**volume, "Labels": {"com.docker.compose.project": "another-app"}}):
        with pytest.raises(ValueError):
            RESET["runtime_volume_root"]("app", "results", "/data/airfoilfoam", mounts, invalid)
    with pytest.raises(ValueError):
        RESET["runtime_volume_root"]("app", "pgdata", "/data/airfoilfoam", mounts, volume)
    with pytest.raises(ValueError):
        RESET["runtime_volume_root"]("app", "results", "/data/airfoilfoam", [{**mounts[0], "Type": "bind"}], volume)


def test_deployment_lock_reuses_read_only_existing_file_and_excludes_other_writer(tmp_path):
    path = tmp_path / "deployment.lock"
    path.write_text("existing operator lock")
    path.chmod(0o400)
    with RESET["deployment_lock"](path):
        with pytest.raises(BlockingIOError):
            with RESET["deployment_lock"](path):
                pytest.fail("Concurrent maintenance must not acquire the same lock")
    assert path.read_text() == "existing operator lock"
