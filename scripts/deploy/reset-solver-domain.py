#!/usr/bin/env python3
"""Preserve canonical configuration, prove restoration, then erase solver data."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


CONFIGURATION_TABLES = frozenset("""
airfoil_hashtags airfoils boundary_conditions boundary_profiles categories
flow_conditions hashtags medium_viscosity_table_points mediums mesh_profiles
operating_conditions output_profiles reference_geometry_profiles
registered_remote_solvers scheduling_profiles sim_campaign_airfoils
sim_campaign_conditions sim_campaign_lifecycle_events sim_campaign_plan_revisions
sim_campaigns simulation_preset_airfoil_targets simulation_preset_revisions
simulation_presets solver_execution_pools solver_implementations solver_profiles
solver_runtime_builds sweep_definitions sweeper_state sync_api_permissions
sync_api_settings
catalog_profile_events campaign_catalog_boundaries campaign_profile_expansions
campaign_condition_scopes campaign_catalog_snapshot
""".split())

SOLVER_TABLES = frozenset("""
field_color_scales field_render_cache force_history historical_archive_audit_decisions
legacy_urans_archive_gap_recovery_actions point_correction_runs
polar_compatibility_fit_members polar_compatibility_fit_points
polar_compatibility_fit_sets polar_fit_points polar_fit_sets remote_asset_references
result_archive_reduction_queue result_attempt_ingest_completions
result_attempt_mesh_identities result_attempts result_canonical_selections
result_classifications result_evidence_field_inventory result_field_extents
result_interpretation_backfill_items result_interpretation_backfill_runs
result_interpretation_cycles result_interpretation_recovery_actions
result_interpretations result_media result_media_blobs result_media_repairs
result_media_storage_bindings result_media_storage_uploads result_reducer_versions
result_review_verdicts results sim_campaign_lane_steps sim_campaign_lanes
sim_campaign_points sim_campaign_progress sim_campaign_solver_cutover_points
sim_campaign_solver_cutovers sim_jobs sim_ladder_submit_retries
sim_precalc_obligation_attempts sim_precalc_obligation_campaigns
sim_precalc_obligation_remediations sim_precalc_obligation_requests
sim_precalc_obligations sim_rans_polar_promotion_points sim_rans_polar_promotions
sim_result_submit_retries sim_solver_incident_campaigns sim_solver_incidents
sim_urans_request_campaigns sim_urans_requests sim_urans_verify_queue
sim_urans_verify_queue_campaigns sim_urans_verify_queue_requests
solver_canary_object_cleanup_receipts solver_canary_object_cleanup_reservations
solver_cutover_continuation_checks solver_engine_canary_attestations
solver_evidence_archives solver_evidence_artifact_members solver_evidence_artifacts
solver_evidence_blobs solver_operational_canary_approved_inventory
solver_operational_canary_evidence_objects solver_operational_canary_retention_receipts
sync_brokered_evidence_uploads sync_import_conflicts sync_remote_hub_binding_receipts
sync_remote_promise_cancellations sync_remote_result_deliveries
sync_sweep_promise_points sync_sweep_promises sync_upload_capacity_reservations
solver_evidence_incomplete_quarantines solver_evidence_orphan_quarantines
calculation_epochs polar_analysis_targets progressive_generations
progressive_generation_targets progressive_work neuralfoil_predictions
progressive_prediction_links
progressive_prediction_repairs progressive_prediction_repair_attempts
progressive_scope_requests progressive_recipe_adoptions
progressive_publication_recovery_claims progressive_publication_recoveries
progressive_cfd_units progressive_cfd_attempts
progressive_cfd_execution_recipes
progressive_cfd_evidence
progressive_cfd_execution_stops
progressive_cfd_stage_decisions
progressive_cfd_runtime_progress
progressive_cfd_recovery_claims
progressive_cfd_recovery_plans
progressive_remote_dispatches
progressive_remote_reports
progressive_remote_report_inventories
progressive_remote_report_sources
progressive_remote_progress_receipts
progressive_remote_evidence_receipts
progressive_worker_evidence_attempts
progressive_worker_evidence_receipts
progressive_worker_hub_receipts
progressive_worker_archive_receipts
progressive_worker_archive_deliveries
progressive_worker_delivery_failures
progressive_worker_staging_failures
progressive_worker_reports
progressive_worker_submission_intents
progressive_worker_assignment_cursors
progressive_polar_models progressive_polar_fit_work progressive_polar_model_evidence
progressive_work_attempts
""".split())

WRITER_SERVICES = ("node-api", "sweeper", "media-repair", "worker", "api")
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")
SCOPE_QUERY = """
SELECT campaign_id::text, condition_id::text, airfoil_id::text,
       revision_id::text, plan_revision_number, derived_by_symmetry,
       jsonb_agg(aoa_deg ORDER BY aoa_deg)::text AS angles
FROM sim_campaign_points
GROUP BY campaign_id, condition_id, airfoil_id, revision_id,
         plan_revision_number, derived_by_symmetry
ORDER BY campaign_id, condition_id, airfoil_id, revision_id,
         plan_revision_number, derived_by_symmetry
"""


def identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError("Invalid database identifier")
    return '"' + value + '"'


def fingerprint(path: Path) -> dict:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return {"sha256": checksum.hexdigest(), "bytes": path.stat().st_size}


def atomic_json(path: Path, value: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".reset-")
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def classify_tables(rows: list[dict]) -> tuple[list[str], list[str]]:
    configuration = []
    solver = []
    for row in rows:
        schema, name = row["schema"], row["name"]
        if schema == "drizzle" and name == "__drizzle_migrations":
            continue
        if schema != "public":
            raise ValueError(f"Unclassified schema: {schema}")
        if name in CONFIGURATION_TABLES:
            configuration.append(name)
        elif name in SOLVER_TABLES:
            solver.append(name)
        else:
            raise ValueError(f"Unclassified table: {name}")
    if not {"airfoils", "sim_campaigns", "sync_api_settings"}.issubset(configuration):
        raise ValueError("The database is not a recognized XFoilFOAM database")
    return sorted(configuration), sorted(solver)


def validate_foreign_keys(rows: list[dict], configuration: list[str]) -> None:
    for row in rows:
        if row["source"] in configuration and row["target"] not in configuration:
            raise ValueError(
                f"Configuration depends on disposable data: {row['source']} -> {row['target']}"
            )


def truncate_statement(tables: list[str]) -> str:
    if not tables or any(name not in SOLVER_TABLES for name in tables):
        raise ValueError("Refusing to truncate outside the explicit solver domain")
    targets = ", ".join("public." + identifier(name) for name in sorted(set(tables)))
    return f"TRUNCATE TABLE {targets} RESTART IDENTITY RESTRICT;"


def runtime_volume_root(project: str, suffix: str, destination: str, mounts: list[dict], volume: dict) -> Path:
    if project not in {"app", "hz-solver2"} or suffix not in {"results", "engine_runtime", "sync_imports"}:
        raise ValueError("Unknown solver runtime volume")
    volume_name = f"{project}_{suffix}"
    matches = [mount for mount in mounts if mount.get("Destination") == destination]
    if len(matches) != 1 or matches[0].get("Type") != "volume" or matches[0].get("Name") != volume_name:
        raise ValueError(f"Unexpected runtime volume ownership: {volume_name}")
    labels = volume.get("Labels") or {}
    if (volume.get("Name") != volume_name or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.volume") != suffix):
        raise ValueError(f"Unverified volume owner: {volume_name}")
    root = Path(volume["Mountpoint"])
    if str(root) != f"/var/lib/docker/volumes/{volume_name}/_data":
        raise ValueError(f"Unexpected runtime volume location: {volume_name}")
    return root


class Reset:
    def __init__(self, project: str, audit: Path, database: str = "aerodb") -> None:
        if project not in {"app", "hz-solver2"}:
            raise ValueError("Unknown deployment project")
        identifier(database)
        self.project = project
        self.database = database
        self.postgres = f"{project}-postgres-1"
        self.audit = audit.resolve()
        self.audit.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.receipt_path = self.audit / "configuration-restore-proof.json"

    def command(self, arguments: list[str], **kwargs) -> subprocess.CompletedProcess:
        return subprocess.run(arguments, check=True, **kwargs)

    def sql(self, query: str, database: str | None = None) -> str:
        return self.command(
            ["docker", "exec", "-i", self.postgres, "psql", "-X", "-qAt",
             "-v", "ON_ERROR_STOP=1", "-U", "aerodb", "-d", database or self.database],
            input=query, text=True, capture_output=True,
        ).stdout.strip()

    def quiesced(self) -> None:
        for service in ("postgres", "redis", *WRITER_SERVICES):
            container = f"{self.project}-{service}-1"
            state = json.loads(self.command(
                ["docker", "inspect", "--format",
                 '{{json .Config.Labels}}', container], text=True, capture_output=True,
            ).stdout)
            if (state.get("com.docker.compose.project") != self.project
                    or state.get("com.docker.compose.service") != service):
                raise ValueError(f"Unexpected deployment ownership: {container}")
            running = self.command(
                ["docker", "inspect", "--format", "{{.State.Running}}", container],
                text=True, capture_output=True,
            ).stdout.strip() == "true"
            if service in WRITER_SERVICES and running:
                raise ValueError(f"Writer is still running: {container}")
            if service in {"postgres", "redis"} and not running:
                raise ValueError(f"Required store is stopped: {container}")
        enabled = self.sql("""
            SELECT (SELECT count(*) FROM sweeper_state WHERE enabled)
                 + (SELECT count(*) FROM solver_execution_pools WHERE enabled);
        """)
        if enabled != "0":
            raise ValueError("Scheduling admission must remain disabled")
        clients = self.sql("""
            SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND backend_type='client backend';
        """)
        if clients != "0":
            raise ValueError("Other database clients are connected; freeze writers first")

    def inventory(self) -> tuple[list[str], list[str]]:
        rows = json.loads(self.sql("""
            SELECT coalesce(json_agg(t),'[]') FROM (
              SELECT schemaname AS schema, tablename AS name FROM pg_tables
              WHERE schemaname NOT IN ('pg_catalog','information_schema')
              ORDER BY schemaname, tablename
            ) t;
        """))
        configuration, solver = classify_tables(rows)
        keys = json.loads(self.sql("""
            SELECT coalesce(json_agg(t),'[]') FROM (
              SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target
              FROM pg_constraint WHERE contype='f'
            ) t;
        """))
        validate_foreign_keys(keys, configuration)
        return configuration, solver

    def configuration_digests(self, tables: list[str], database: str | None = None) -> dict:
        digests = {}
        for table in tables:
            content = self.sql(
                f"SELECT row_to_json(configuration)::jsonb::text FROM public.{identifier(table)} "
                "AS configuration ORDER BY row_to_json(configuration)::jsonb::text COLLATE \"C\";",
                database,
            )
            digests[table] = {
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
                "rows": len(content.splitlines()) if content else 0,
            }
        content = self.sql('SELECT row_to_json(m)::jsonb::text FROM drizzle.__drizzle_migrations m ORDER BY id;', database)
        digests["drizzle.__drizzle_migrations"] = {
            "sha256": hashlib.sha256(content.encode()).hexdigest(),
            "rows": len(content.splitlines()) if content else 0,
        }
        return digests

    def export_scope(self, destination: Path, database: str | None = None) -> None:
        with destination.open("wb") as output:
            self.command(
                ["docker", "exec", "-i", self.postgres, "psql", "-X", "-qAt",
                 "-v", "ON_ERROR_STOP=1", "-U", "aerodb", "-d", database or self.database],
                input=f"COPY ({SCOPE_QUERY}) TO STDOUT WITH (FORMAT csv, HEADER true);".encode(),
                stdout=output,
            )

    def restore_proof(self, archive: Path, tables: list[str], expected: dict) -> dict:
        check_database = "reset_check_" + hashlib.sha256(str(self.audit).encode()).hexdigest()[:16]
        identifier(check_database)
        existing = self.sql(f"SELECT count(*) FROM pg_database WHERE datname='{check_database}';", "postgres")
        if existing != "0":
            raise ValueError(f"Prior restore database exists; inspect it before retrying: {check_database}")
        self.sql(f"CREATE DATABASE {identifier(check_database)} TEMPLATE template0;", "postgres")
        with archive.open("rb") as stream, (self.audit / "restore.log").open("wb") as log:
            self.command(
                ["docker", "exec", "-i", self.postgres, "pg_restore", "--exit-on-error",
                 "--no-owner", "--no-privileges", "-U", "aerodb", "-d", check_database],
                stdin=stream, stdout=log, stderr=log,
            )
        actual = self.configuration_digests(tables, check_database)
        if actual != expected:
            raise ValueError(f"Restored configuration differs; inspect {check_database}")
        scope = self.audit / "campaign-target-intent.csv"
        self.sql("""
            CREATE TABLE public.reset_target_intent (
              campaign_id uuid REFERENCES sim_campaigns(id),
              condition_id uuid REFERENCES sim_campaign_conditions(id),
              airfoil_id uuid REFERENCES airfoils(id),
              revision_id uuid REFERENCES simulation_preset_revisions(id),
              plan_revision_number integer NOT NULL,
              derived_by_symmetry boolean NOT NULL, angles jsonb NOT NULL
            );
        """, check_database)
        with scope.open("rb") as stream:
            self.command(
                ["docker", "exec", "-i", self.postgres, "psql", "-X", "-q",
                 "-v", "ON_ERROR_STOP=1", "-U", "aerodb", "-d", check_database,
                 "-c", "COPY reset_target_intent FROM STDIN WITH (FORMAT csv, HEADER true);"],
                stdin=stream, stdout=subprocess.DEVNULL,
            )
        count = int(self.sql("SELECT count(*) FROM reset_target_intent;", check_database))
        with (self.audit / "restored-target-intent.csv").open("wb") as output:
            self.command(
                ["docker", "exec", self.postgres, "psql", "-X", "-qAt",
                 "-v", "ON_ERROR_STOP=1", "-U", "aerodb", "-d", check_database,
                 "-c", "COPY (SELECT * FROM reset_target_intent ORDER BY campaign_id, condition_id, "
                 "airfoil_id, revision_id, plan_revision_number, derived_by_symmetry) TO STDOUT "
                 "WITH (FORMAT csv, HEADER true);"], stdout=output,
            )
        if fingerprint(scope) != fingerprint(self.audit / "restored-target-intent.csv"):
            raise ValueError("Campaign target intent did not restore byte-for-byte")
        self.sql(f"DROP DATABASE {identifier(check_database)};", "postgres")
        return {"database": check_database, "configuration": actual, "target_groups": count}

    def preserve(self, environment: Path) -> dict:
        self.quiesced()
        configuration, solver = self.inventory()
        if self.receipt_path.exists():
            return self.verify_preservation(configuration, solver)
        archive = self.audit / "configuration.dump"
        if archive.exists():
            raise ValueError("An unverified export exists; diagnose it rather than overwrite it")
        before = self.configuration_digests(configuration)
        arguments = ["docker", "exec", self.postgres, "pg_dump", "-Fc", "--no-owner",
                     "--no-privileges", "--no-blobs", "-U", "aerodb", "-d", self.database]
        arguments.extend(f"--exclude-table-data=public.{table}" for table in solver)
        with archive.open("xb") as output:
            self.command(arguments, stdout=output)
            output.flush()
            os.fsync(output.fileno())
        self.export_scope(self.audit / "campaign-target-intent.csv")
        shutil.copyfile(environment, self.audit / "deployment.env")
        (self.audit / "deployment.env").chmod(0o600)
        if self.configuration_digests(configuration) != before:
            raise ValueError("Configuration changed during export")
        restored = self.restore_proof(archive, configuration, before)
        self.quiesced()
        receipt = {
            "version": 1, "project": self.project, "database": self.database,
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "configuration_tables": configuration, "solver_tables": solver,
            "configuration": before, "restore": restored,
            "artifacts": {name: fingerprint(self.audit / name) for name in (
                "configuration.dump", "campaign-target-intent.csv", "deployment.env",
            )},
        }
        atomic_json(self.receipt_path, receipt)
        return receipt

    def verify_preservation(self, configuration: list[str], solver: list[str]) -> dict:
        receipt = json.loads(self.receipt_path.read_text())
        if (receipt["project"] != self.project or receipt["database"] != self.database
                or receipt["configuration_tables"] != configuration or receipt["solver_tables"] != solver):
            raise ValueError("Preservation proof belongs to another database or schema")
        if receipt["configuration"] != self.configuration_digests(configuration):
            raise ValueError("Canonical configuration changed since the restore proof")
        for name in ("configuration.dump", "campaign-target-intent.csv", "deployment.env"):
            if fingerprint(self.audit / name) != receipt["artifacts"][name]:
                raise ValueError(f"Preserved artifact changed: {name}")
        return receipt

    def erase(self) -> dict:
        self.quiesced()
        configuration, solver = self.inventory()
        self.verify_preservation(configuration, solver)
        completed = self.audit / "database-erased.json"
        if not completed.exists():
            self.sql("BEGIN; SET LOCAL lock_timeout='5s'; " + truncate_statement(solver) + " COMMIT;")
        remaining = {}
        for table in solver:
            exists = self.sql(f"SELECT EXISTS(SELECT 1 FROM public.{identifier(table)} LIMIT 1);")
            if exists != "f":
                remaining[table] = exists
        if remaining:
            raise ValueError(f"Solver data remains in {sorted(remaining)}")
        self.verify_preservation(configuration, solver)
        receipt = {"project": self.project, "database": self.database,
                   "verified_at": datetime.now(timezone.utc).isoformat(),
                   "empty_solver_tables": solver, "admission": "disabled"}
        if not completed.exists():
            atomic_json(completed, receipt)
        return receipt

    def clear_runtime(self) -> dict:
        self.erase()
        expected_mounts = {
            "results": ("worker", "/data/airfoilfoam"),
            "engine_runtime": ("worker", "/data/airfoilfoam-runtime"),
            "sync_imports": ("node-api", "/data/airfoilfoam/sync-imports"),
        }
        roots = []
        for suffix, (service, destination) in expected_mounts.items():
            volume_name = f"{self.project}_{suffix}"
            mounts = json.loads(self.command(
                ["docker", "inspect", "--format", "{{json .Mounts}}", f"{self.project}-{service}-1"],
                text=True, capture_output=True,
            ).stdout)
            volume = json.loads(self.command(
                ["docker", "volume", "inspect", volume_name], text=True, capture_output=True,
            ).stdout)[0]
            root = runtime_volume_root(self.project, suffix, destination, mounts, volume)
            if root.resolve() != root or not root.is_dir():
                raise ValueError(f"Unexpected runtime volume location: {volume_name}")
            roots.append(root)
        self.quiesced()
        for root in roots:
            for child in root.iterdir():
                if child.is_symlink() or not child.is_dir():
                    child.unlink()
                else:
                    shutil.rmtree(child)
        self.command(
            ["docker", "exec", f"{self.project}-redis-1", "redis-cli", "FLUSHALL", "SYNC"],
            stdout=subprocess.DEVNULL,
        )
        if any(any(root.iterdir()) for root in roots):
            raise ValueError("Solver runtime files reappeared during cleanup")
        keyspace = self.command(
            ["docker", "exec", f"{self.project}-redis-1", "redis-cli", "INFO", "keyspace"],
            text=True, capture_output=True,
        ).stdout
        if any(line.startswith("db") for line in keyspace.splitlines()):
            raise ValueError("Redis work reappeared during cleanup")
        self.quiesced()
        receipt = {"project": self.project, "verified_at": datetime.now(timezone.utc).isoformat(),
                   "runtime_volumes_empty": len(roots), "redis_empty": True, "admission": "disabled"}
        atomic_json(self.audit / "runtime-cleared.json", receipt)
        return receipt


@contextmanager
def deployment_lock(path: Path):
    try:
        stream = path.open("r")
    except FileNotFoundError:
        stream = path.open("x")
    with stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "preserve", "erase", "clear-runtime"))
    parser.add_argument("--project", required=True, choices=("app", "hz-solver2"))
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--environment", type=Path, default=Path("/opt/airfoils-pro/state/.env.deploy"))
    parser.add_argument("--lock", type=Path, default=Path("/tmp/airfoils-pro-deploy.lock"))
    arguments = parser.parse_args()
    os.umask(0o077)
    try:
        with deployment_lock(arguments.lock):
            reset = Reset(arguments.project, arguments.audit)
            if arguments.action == "inspect":
                reset.quiesced()
                configuration, solver = reset.inventory()
                print(json.dumps({"configuration_tables": configuration, "solver_tables": solver}))
            elif arguments.action == "preserve":
                receipt = reset.preserve(arguments.environment)
                print(json.dumps({"restore_verified": True, "configuration_tables": len(receipt["configuration"]),
                                  "campaign_target_groups": receipt["restore"]["target_groups"],
                                  "receipt": str(reset.receipt_path)}))
            elif arguments.action == "clear-runtime":
                print(json.dumps(reset.clear_runtime()))
            else:
                receipt = reset.erase()
                print(json.dumps({"solver_tables_empty": len(receipt["empty_solver_tables"]),
                                  "configuration_unchanged": True, "admission": "disabled"}))
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Reset stopped without resuming writers: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
