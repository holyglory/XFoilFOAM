#!/usr/bin/env python3
"""Measure report storage and plan HZ table-local autovacuum changes.
Use --apply with --autovacuum worker to lower the vacuum scale factor.
"""

from __future__ import annotations

import argparse
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

TARGETS = {
    "worker": ("hz-solver2", "hz-solver2-postgres-1", "progressive_worker_reports", "worker"),
    "hub": ("airfoils.pro", "app-postgres-1", "progressive_remote_reports", "remote"),
}
# A display bucket for the sample, never an eligibility or execution threshold.
SMALL_BODY_BYTES = 8192


def pg_oid(value):
    """PostgreSQL emits oid as decimal text in JSON, but oid::bigint as an integer."""
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,10}", value):
        value = int(value)
    if type(value) is not int or not 0 < value <= 0xFFFFFFFF:
        raise ValueError("Invalid PostgreSQL object or file OID")
    return value


def index_files(files):
    if not isinstance(files, dict):
        raise ValueError("Invalid PostgreSQL index file inventory")
    result = {str(pg_oid(index)): pg_oid(filenode) for index, filenode in files.items()}
    if len(result) != len(files):
        raise ValueError("Duplicate PostgreSQL index identity")
    return result


def rewrite_outcome(before, after):
    """Infer a committed rewrite from physical evidence after a lost SQL reply."""
    try:
        if (not before["serverStartedAt"] or before["serverStartedAt"] != after["serverStartedAt"]
                or pg_oid(before["oid"]) != pg_oid(after["oid"])):
            return None
        if pg_oid(before["relfilenode"]) != pg_oid(after["relfilenode"]):
            return True
        if all(pg_oid(before[k]) == pg_oid(after[k]) for k in ("toastOid","toastFilenode")) and index_files(before["indexFiles"]) == index_files(after["indexFiles"]):
            return False
    except (KeyError, TypeError, ValueError):
        pass
    return None


def ssh(role: str, command: list[str], sql: str = "") -> str:
    host = TARGETS[role][0]
    result = subprocess.run(
        ["ssh", "-T", "-C", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
         "-oConnectTimeout=10", host, shlex.join(command)],
        input=sql, text=True, capture_output=True, timeout=35, check=False,
    )
    if result.returncode:
        # Keep output limited to diagnostics from these fixed metadata queries.
        raise RuntimeError(f"{role} operation failed ({result.returncode}): {result.stderr[-2000:].strip()}")
    return result.stdout


def query(role: str, statement: str, *, index_only_path: bool = False) -> list[dict]:
    container = TARGETS[role][1]
    local = "SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off;\n"
    if index_only_path:
        local += "SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;\n"
    text = ssh(role, ["docker", "exec", "-i", "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=500 -c application_name=xfoilfoam_reclaim_readonly",
        container, "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "aerodb", "-d", "aerodb"],
        "BEGIN READ ONLY;\n" + local + statement + "\nCOMMIT;\n")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def base_sql(role: str) -> str:
    table, source = TARGETS[role][2:]
    return f"""
SELECT jsonb_build_object(
 'observedAt',clock_timestamp(),'serverStartedAt',pg_postmaster_start_time(),'serverVersionNum',current_setting('server_version_num')::integer,
 'table','public.{table}','oid',c.oid::bigint,'relfilenode',c.relfilenode::bigint,
 'heapBytes',pg_relation_size(c.oid),'tableBytes',pg_table_size(c.oid),
 'indexBytes',pg_indexes_size(c.oid),'totalBytes',pg_total_relation_size(c.oid),
 'toastHeapBytes',pg_relation_size(c.reltoastrelid),'toastIndexBytes',pg_indexes_size(c.reltoastrelid),
 'liveRowsEstimate',s.n_live_tup,'deadRowsEstimate',s.n_dead_tup,
 'toastLiveChunksEstimate',t.n_live_tup,'toastDeadChunksEstimate',t.n_dead_tup,
 'lastAutovacuum',s.last_autovacuum,'lastToastAutovacuum',t.last_autovacuum,
 'lastAnalyze',greatest(s.last_analyze,s.last_autoanalyze),
 'archive', (SELECT jsonb_build_object('reportMembers',count(*),'originalJsonTextBytes',coalesce(sum(report_byte_size),0))
   FROM public.progressive_report_archive_members WHERE source_kind='{source}' AND member_kind='report'),
 'objects',(SELECT jsonb_build_object('objects',count(*),'storedBytes',coalesce(sum(stored_byte_size),0))
   FROM (SELECT DISTINCT bucket,object_key,generation,stored_byte_size
     FROM public.progressive_report_archive_bundles WHERE source_kind='{source}') objects),
 'payloadPool',(SELECT jsonb_build_object('rows',count(*),'originalJsonTextBytes',coalesce(sum(byte_size),0),
   'relationBytes',pg_total_relation_size('public.progressive_report_result_payloads')) FROM public.progressive_report_result_payloads),
 'installedOnlineExtensions',(SELECT coalesce(jsonb_agg(extname ORDER BY extname),'[]'::jsonb)
   FROM pg_extension WHERE extname IN ('pg_repack','pg_squeeze','pgstattuple','pg_freespacemap','pageinspect')),
 'archiveIndexValid',EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.{table}_archive_idx') AND indisvalid),
 'maintenanceInProgress',EXISTS(SELECT 1 FROM pg_stat_progress_vacuum WHERE relid IN(c.oid,c.reltoastrelid))
) FROM pg_class c JOIN pg_stat_all_tables s ON s.relid=c.oid
 LEFT JOIN pg_stat_all_tables t ON t.relid=c.reltoastrelid WHERE c.oid='public.{table}'::regclass;
"""


def sample_sql(role: str, heap_bytes: int) -> str:
    table = TARGETS[role][2]
    # Expected sampled heap I/O <=2MiB, with a hard 512-row join bound. No
    # report JSON navigation, result resolution, logical body scan, or TOAST read.
    percent = min(1.0, max(0.000001, 100 * 2 * 1024**2 / max(heap_bytes, 1)))
    if role == "worker":
        join = """LEFT JOIN public.sync_sweep_promises promise ON promise.id=CASE
 WHEN job.request_payload->>'syncPromiseId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 THEN (job.request_payload->>'syncPromiseId')::uuid END"""
    else:
        join = """LEFT JOIN public.progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
 LEFT JOIN public.sync_sweep_promises promise ON promise.id=dispatch.promise_id"""
    return f"""
WITH drawn AS MATERIALIZED (
 SELECT r.sim_job_id,r.sequence,r.archived_at,r.result_payload_hash,r.acknowledged_at,
   pg_column_size(r.report)::bigint AS body_bytes,md5(r.ctid::text||'reclaim-20261119') AS sample_order
 FROM public.{table} r TABLESAMPLE SYSTEM({percent:.8f}) REPEATABLE(7119)
), chosen AS MATERIALIZED (SELECT * FROM drawn ORDER BY sample_order LIMIT 512),
classified AS (SELECT chosen.*,
 CASE WHEN archived_at IS NOT NULL THEN 'archived' WHEN result_payload_hash IS NOT NULL THEN 'shared_payload' ELSE 'inline' END representation,
 CASE WHEN job.id IS NULL THEN 'missing_job'
   WHEN job.status NOT IN ('done','failed','cancelled') OR job."ingestedAt" IS NULL THEN 'active_or_not_ingested'
   WHEN promise.id IS NULL OR promise.status NOT IN ('fulfilled','expired','cancelled') THEN 'promise_not_closed'
   WHEN job.ingest_lease_token IS NOT NULL AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at>clock_timestamp()) THEN 'active_ingest'
   ELSE 'closed_metadata_candidate' END lifecycle
 FROM chosen LEFT JOIN public.sim_jobs job ON job.id=chosen.sim_job_id {join})
SELECT jsonb_build_object('representation',representation,'lifecycle',lifecycle,'rows',count(*),
 'storedReportBytes',sum(body_bytes),'maxStoredReportBytes',max(body_bytes),
 'smallRetiredRows',count(*) FILTER(WHERE (archived_at IS NOT NULL OR result_payload_hash IS NOT NULL) AND body_bytes<={SMALL_BODY_BYTES}))
 FROM classified GROUP BY representation,lifecycle ORDER BY representation,lifecycle;
""".replace("r.acknowledged_at,", "" if role == "hub" else "r.acknowledged_at,")


def measure(role: str) -> dict:
    facts = query(role, base_sql(role))[0]
    container = TARGETS[role][1]
    disk = ssh(role, ["docker", "exec", container, "df", "-Pk", "/var/lib/postgresql/data"]).splitlines()[-1].split()
    facts["postgresFilesystem"] = {"source": disk[0], "sizeBytes": int(disk[1])*1024,
        "usedBytes": int(disk[2])*1024, "freeBytes": int(disk[3])*1024}
    root_disk = ssh(role, ["df", "-Pk", "/"]).splitlines()[-1].split()
    facts["rootFilesystem"] = {"source": root_disk[0], "sizeBytes": int(root_disk[1])*1024,
        "usedBytes": int(root_disk[2])*1024, "freeBytes": int(root_disk[3])*1024}
    binary = ssh(role, ["docker", "exec", container, "sh", "-c",
        "for tool in vacuumdb pg_repack pgcompacttable pg_squeeze; do command -v \"$tool\" || true; done"])
    facts["installedBinaries"] = binary.splitlines()
    facts["role"] = role
    facts["sample"] = query(role, sample_sql(role, facts["heapBytes"]))
    if facts["archiveIndexValid"]:
        predicate = "archived_at IS NOT NULL" if role == "worker" else "archive_bundle_id IS NOT NULL"
        facts["archivedRows"] = query(role,
            f"SELECT jsonb_build_object('rows',count(*),'currentStoredHeaderBytes',coalesce(sum(pg_column_size(report)::bigint),0)) FROM public.{TARGETS[role][2]} WHERE {predicate};",
            index_only_path=True)[0]
    else:
        facts["archivedRows"] = None
    facts["interpretation"] = {
        "catalogBytes": "actual allocated relation bytes, including TOAST and indexes",
        "archiveBytes": "original JSON text and compressed object bytes, not filesystem space returned",
        "sample": "physical-page sample; closed metadata is not proof of evidence settlement or product-reader custody",
        "bodyBytes": "pg_column_size storage size; excludes TOAST tuple/page overhead",
    }
    facts["sampleEstimates"] = sample_estimates(facts)
    facts["freeTail"] = {"bytes": None, "measured": False,
        "reason": "No exact tail probe ran. Row/archive counts, dead-tuple estimates and samples do not establish a contiguous free tail."}
    facts["nativeMaintenance"] = "stock per-table VACUUM; optional tail truncation, no interior-hole packing"
    facts["onlinePackingInstalled"] = any(name in facts["installedOnlineExtensions"] for name in ("pg_repack", "pg_squeeze"))
    return facts


def sample_estimates(facts: dict) -> dict:
    sample = facts.get("sample", [])
    rows = sum(group["rows"] for group in sample)
    small = sum(group["smallRetiredRows"] for group in sample)
    body_bytes = sum(group["storedReportBytes"] for group in sample)
    return {"rowsObserved": rows, "smallArchivedOrSharedRows": small,
        "smallBodyDisplayCutoffBytes": SMALL_BODY_BYTES,
        "smallArchivedOrSharedFraction": small/rows if rows else None,
        "meanStoredReportFieldBytes": body_bytes/rows if rows else None,
        "extrapolatedReportFieldBytes": math.ceil(body_bytes*facts["liveRowsEstimate"]/rows) if rows else None,
        "note": "Heuristic projection of stored report fields only, excluding TOAST overhead. This is neither measured bloat nor reclaimable disk, and does not allow or block maintenance."}


def comparison(before: dict, after: dict) -> dict:
    if (before["role"],before["table"],pg_oid(before["oid"])) != (after["role"],after["table"],pg_oid(after["oid"])):
        raise ValueError("Cannot compare different relation identities")
    delta = before["totalBytes"]-after["totalBytes"]
    return {"table": after["table"], "observedBefore": before["observedAt"], "observedAfter": after["observedAt"],
        "relationFileDecreaseBytes": delta, "relationShrank": delta>0,
        "toastHeapDecreaseBytes": before["toastHeapBytes"]-after["toastHeapBytes"],
        "postgresFilesystemFreeDeltaBytes": after["postgresFilesystem"]["freeBytes"]-before["postgresFilesystem"]["freeBytes"],
        "samePhysicalFile": pg_oid(before["relfilenode"])==pg_oid(after["relfilenode"]),
        "sameServerStart": before.get("serverStartedAt")==after.get("serverStartedAt"),
        "note": "Observed net file changes only. Concurrent writers/WAL/case activity prevent filesystem-level attribution."}


# Two catalog rows. Inspect the specific TOAST relation PostgreSQL owns for this
# table. Neither planning nor verification visits any report or TOAST chunks.
VACUUM_RELATIONS = """
SELECT v.kind,c.oid::bigint AS oid,pg_relation_filenode(c.oid)::bigint AS filenode,
       c.reltuples::float8 AS tuples,c.oid::regclass::text AS relation,
       coalesce((SELECT jsonb_object_agg(option_name,option_value) FROM pg_options_to_table(c.reloptions)), '{}') AS options
FROM pg_class heap CROSS JOIN LATERAL (VALUES ('heap',heap.oid),('toast',heap.reltoastrelid)) v(kind,id)
JOIN pg_class c ON c.oid=v.id
WHERE heap.oid='public.progressive_worker_reports'::regclass AND heap.relkind='r'
  AND ((v.kind='heap' AND c.relkind='r') OR (v.kind='toast' AND c.relkind='t'))
"""
VACUUM_SNAPSHOT = f"""
SELECT to_jsonb(r) || jsonb_build_object(
 'deadEstimate',s.n_dead_tup,'lastVacuum',s.last_vacuum,'lastAutovacuum',s.last_autovacuum,
 'vacuumPhase',(SELECT phase FROM pg_stat_progress_vacuum WHERE relid=r.oid::oid LIMIT 1),
 'serverScale',current_setting('autovacuum_vacuum_scale_factor'),
 'serverBase',current_setting('autovacuum_vacuum_threshold'),
 'serverMax',current_setting('autovacuum_vacuum_max_threshold',true),
 'localEnabled',(r.options->>'autovacuum_enabled')::boolean,
 'autovacuum',current_setting('autovacuum'),'trackCounts',current_setting('track_counts'),
 'costDelayMs',(SELECT setting::numeric FROM pg_settings WHERE name='autovacuum_vacuum_cost_delay'),
 'vacuumCostDelayMs',(SELECT setting::numeric FROM pg_settings WHERE name='vacuum_cost_delay'),
 'costLimit',current_setting('autovacuum_vacuum_cost_limit'),
 'vacuumCostLimit',current_setting('vacuum_cost_limit'),'observedAt',clock_timestamp())
FROM ({VACUUM_RELATIONS}) r LEFT JOIN pg_stat_all_tables s ON s.relid=r.oid::oid ORDER BY r.kind
"""
SCALE = "autovacuum_vacuum_scale_factor"


def scale_factor(value: str) -> Decimal:
    try:
        result = Decimal(value)
        if result.is_finite() and 0 <= result <= 100:
            return result if result else Decimal(0)
    except InvalidOperation:
        pass
    raise argparse.ArgumentTypeError("vacuum scale factor must be a finite PostgreSQL factor from 0 through 100")


def json_rows(text: str) -> list:
    # EXPLAIN FORMAT JSON spans several psql output lines.
    decoder = json.JSONDecoder()
    records = []
    text = text.lstrip()
    while text:
        value, used = decoder.raw_decode(text)
        records.append(value)
        text = text[used:].lstrip()
    return records


def vacuum_session(statement: str, write: bool) -> list[dict]:
    # Bind both the host/container and the configured deployment role. Inspect
    # only this one nonsecret setting. Apply shares the existing HZ deploy lock.
    role_check = ["docker", "inspect", "--format",
        '{{range .Config.Env}}{{if eq . "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver"}}remote-solver{{end}}{{end}}',
        "hz-solver2-sweeper-1"]
    psql = ["docker", "exec", "-i", "-e",
        f"PGOPTIONS=-c default_transaction_read_only={'off' if write else 'on'} -c statement_timeout=5000 "
        "-c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c application_name=hz_report_autovacuum",
        TARGETS["worker"][1], "psql", "-XwqAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "aerodb", "-d", "aerodb"]
    command = ["sh", "-ec", f'test "$({shlex.join(role_check)})" = remote-solver || '
        '{ echo "Expected the HZ remote-solver deployment" >&2; exit 1; }; exec ' + shlex.join(psql)]
    if write:
        command = ["flock", "-s", "-w", "5", "-E", "75", "/tmp/airfoils-pro-deploy.lock", *command]
    return json_rows(ssh("worker", command, statement))


def autovacuum_plan(rows: list[dict], target: Decimal) -> tuple[dict, dict]:
    relations = {r["kind"]: r for r in rows}
    if len(rows) != 2 or set(relations) != {"heap", "toast"}:
        raise ValueError("Expected the worker report heap and its owned TOAST relation")
    changes, facts = {}, {}
    for kind in ("heap", "toast"):
        r = relations[kind]
        # PostgreSQL uses the parent's autovacuum options only when the TOAST
        # relation has no options of its own. Creating a first toast option
        # could discard inherited cost/threshold settings. Keep inheritance.
        inherited = kind == "toast" and not r["options"]
        options = relations["heap"]["options"] if inherited else r["options"]
        scale = Decimal(options.get(SCALE, r["serverScale"]))
        desired = min(scale, target)
        if desired < scale and not inherited:
            changes[kind] = str(desired)
        base = int(options.get("autovacuum_vacuum_threshold", r["serverBase"]))
        cap = int(options.get("autovacuum_vacuum_max_threshold", r["serverMax"] or -1))
        tuples = max(Decimal(0), Decimal(str(r["tuples"])))

        def threshold(factor: Decimal) -> float:
            estimate = base + tuples * factor
            return float(min(estimate, cap) if cap >= 0 else estimate)

        delay = float(options.get("autovacuum_vacuum_cost_delay", r["costDelayMs"]))
        limit = int(options.get("autovacuum_vacuum_cost_limit", r["costLimit"]))
        facts[kind] = {
            **r,
            "inheritsHeapOptions": inherited,
            "currentScale": float(scale),
            "targetScale": float(desired),
            "currentDeadTupleThresholdEstimate": threshold(scale),
            "targetDeadTupleThresholdEstimate": threshold(desired),
            "aboveTargetEstimate": r["deadEstimate"] > threshold(desired) if r["deadEstimate"] is not None else None,
            "ordinaryAutovacuumEnabled": (
                r["autovacuum"] == "on" and r["trackCounts"] == "on" and
                (relations["heap"] if inherited else r)["localEnabled"] is not False
            ),
            "effectiveCostDelayMs": delay if delay >= 0 else r["vacuumCostDelayMs"],
            "effectiveCostLimit": limit if limit > 0 else int(r["vacuumCostLimit"]),
        }
    return changes, facts


def worker_autovacuum(target: Decimal, apply: bool, session=vacuum_session) -> dict:
    rows = session(f"BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; {VACUUM_SNAPSHOT}; COMMIT;", False)
    changes, facts = autovacuum_plan(rows, target)
    setters = [f"{'toast.' if kind == 'toast' else ''}{SCALE}='{value}'" for kind, value in changes.items()]
    ddl = "ALTER TABLE ONLY public.progressive_worker_reports SET (" + ", ".join(setters) + ")" if setters else None
    result = {
        "role": "worker", "table": "public.progressive_worker_reports", "mode": "apply" if apply else "dry-run",
        "scaleFactorCeiling": float(target), "plannedChanges": changes, "sql": ddl, "changed": False, "before": facts,
    }
    if not apply or ddl is None:
        return result

    def expected(after: bool) -> str:
        identity = {}
        for r in rows:
            opts = dict(r["options"])
            if after and r["kind"] in changes:
                opts[SCALE] = changes[r["kind"]]
            identity[r["kind"]] = [r["oid"], r["filenode"], opts, r["serverScale"]]
        # Arbitrary pre-existing option strings are data, never SQL fragments.
        return "convert_from(decode('" + json.dumps(identity).encode().hex() + "','hex'),'UTF8')::jsonb"

    observed = f"""SELECT jsonb_object_agg(r.kind,jsonb_build_array(r.oid,r.filenode,r.options,current_setting('{SCALE}')))
                   FROM ({VACUUM_RELATIONS}) r"""
    # Recheck under the same lock as ALTER. A racing policy change aborts the
    # transaction. Both file identities and every unrelated reloption must match
    # again after the change, before we commit.
    script = f"""BEGIN; SET LOCAL search_path=pg_catalog;
LOCK TABLE ONLY public.progressive_worker_reports IN SHARE UPDATE EXCLUSIVE MODE NOWAIT;
DO $verify$ BEGIN
 IF ({observed}) IS DISTINCT FROM {expected(False)} THEN RAISE EXCEPTION 'Worker report storage policy changed; rerun the plan'; END IF;
 {ddl};
 IF ({observed}) IS DISTINCT FROM {expected(True)} THEN RAISE EXCEPTION 'Unexpected worker report policy or relation file change'; END IF;
END $verify$;
{VACUUM_SNAPSHOT};
COMMIT;"""
    after = session(script, True)
    result["after"] = autovacuum_plan(after, target)[1]
    result["changed"] = True
    return result


# Fixed to the worker. The optional census reads stored sizes directly from the
# parent heap; it never selects the JSON value or scans its TOAST relation.
RETURN_SNAPSHOT = """
WITH h AS (SELECT * FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass),
 idx AS (SELECT i.indexrelid AS oid FROM h JOIN pg_index i ON i.indrelid IN (h.oid,h.reltoastrelid))
SELECT jsonb_build_object(
 'observedAt',clock_timestamp(),'serverStartedAt',pg_postmaster_start_time(),'role','worker',
 'table','public.progressive_worker_reports','oid',h.oid::bigint,'relfilenode',pg_relation_filenode(h.oid)::bigint,
 'toastName',t.oid::regclass::text,'toastReadable',has_schema_privilege(t.relnamespace,'USAGE') AND has_table_privilege(t.oid,'SELECT'),
 'blockBytes',current_setting('block_size')::int,
 'toastOid',t.oid::bigint,'toastFilenode',pg_relation_filenode(t.oid)::bigint,
 'heapBytes',pg_relation_size(h.oid),'toastHeapBytes',pg_relation_size(t.oid),'toastIndexBytes',pg_indexes_size(t.oid),
 'tableBytes',pg_table_size(h.oid),'indexBytes',pg_indexes_size(h.oid),'totalBytes',pg_total_relation_size(h.oid),
 'indexFiles',(SELECT jsonb_object_agg(oid::text,pg_relation_filenode(oid)::bigint) FROM idx),
 'paths',jsonb_build_object('heap',pg_relation_filepath(h.oid),'toast',pg_relation_filepath(t.oid),'wal','pg_wal') ||
     (SELECT coalesce(jsonb_object_agg('index-'||oid,pg_relation_filepath(oid)),'{}') FROM idx),
 'dataDir',(SELECT setting FROM pg_settings WHERE name='data_directory'),'tempTablespaces',current_setting('temp_tablespaces'),
 'lastAutovacuum',hs.last_autovacuum,'lastToastAutovacuum',ts.last_autovacuum,'toastAutovacuumCount',ts.autovacuum_count,
 'vacuum',coalesce((SELECT jsonb_agg(jsonb_build_object('oid',v.relid::bigint,'pid',v.pid,'startedAt',a.query_start,
    'backendStart',a.backend_start,'type',a.backend_type,'phase',v.phase,'scannedBlocks',v.heap_blks_scanned,
    'totalBlocks',v.heap_blks_total,'vacuumedBlocks',v.heap_blks_vacuumed,'indexPasses',v.index_vacuum_count))
    FROM pg_stat_progress_vacuum v LEFT JOIN pg_stat_activity a ON a.pid=v.pid WHERE v.relid IN (h.oid,t.oid)),'[]'),
 'wal',jsonb_build_object('canListDirectory',has_function_privilege('pg_catalog.pg_ls_waldir()','EXECUTE'),
    'lsn',pg_current_wal_lsn()::text,'level',current_setting('wal_level'),'archiveMode',current_setting('archive_mode'),
    'maxWalSize',current_setting('max_wal_size'),'slots',(SELECT count(*) FROM pg_replication_slots),
    'retainedByOldestSlotBytes',(SELECT max(pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)) FROM pg_replication_slots)),
 'ingress',jsonb_build_object('runningJobs',(SELECT count(*) FROM public.sim_jobs WHERE status='running'),
    'ingestingJobs',(SELECT count(*) FROM public.sim_jobs WHERE status='ingesting'),
    'unacknowledgedReport',EXISTS(SELECT 1 FROM public.progressive_worker_reports WHERE acknowledged_at IS NULL),
    'liveClaims',EXISTS(SELECT 1 FROM public.progressive_worker_evidence_delivery_claims WHERE claim_expires_at>clock_timestamp()),
    'livePromises',(SELECT count(*) FROM public.sync_sweep_promises WHERE status='active' AND "expiresAt">clock_timestamp())))
FROM h JOIN pg_class t ON t.oid=h.reltoastrelid LEFT JOIN pg_stat_all_tables hs ON hs.relid=h.oid
LEFT JOIN pg_stat_all_tables ts ON ts.relid=t.oid
"""
LIVE_VALUES = """
SELECT coalesce(jsonb_object_agg(kind,jsonb_build_object('rows',n,'storedReportBytes',bytes,'referenceBytes',refs)),'{}') FROM (
 SELECT CASE WHEN archived_at IS NOT NULL THEN 'archived' WHEN result_payload_hash IS NULL THEN 'inline' ELSE 'shared' END AS kind,
 count(*) AS n,sum(pg_column_size(report)) AS bytes,sum(coalesce(pg_column_size(result_payload_hash),0)) AS refs
 FROM public.progressive_worker_reports GROUP BY 1) g
"""

# Resolve files through PostgreSQL's actual container mounts. Docker's in-container
# df can report a different bind mount on the same device (for example /etc/hosts).
WORKER_VOLUMES = """
import json, os, pathlib, subprocess, sys
def run(cmd):
    return subprocess.check_output(cmd, text=True, timeout=8).strip()
container='hz-solver2-postgres-1'
paths=json.loads(sys.argv[1])
if any(not pathlib.PurePosixPath(path).is_absolute() for path in paths.values()):
    # Data directory in the live postmaster's lockfile, also usable when SQL
    # intentionally hides the data_directory setting from the database role.
    base=run(['docker','exec',container,'sh','-ec','sed -n 2p "$PGDATA/postmaster.pid"'])
    if not pathlib.PurePosixPath(base).is_absolute():
        raise ValueError('Cannot establish the active PostgreSQL data directory')
    paths={k:str(pathlib.PurePosixPath(base)/v) for k,v in paths.items()}
resolved=run(['docker','exec',container,'sh','-ec','for p; do readlink -f "$p"; done','sh',*paths.values()]).splitlines()
if len(resolved)!=len(paths):
    raise ValueError('Incomplete PostgreSQL filesystem mapping')
mounts=json.loads(run(['docker','inspect','--format','{{json .Mounts}}',container]))
devices, files = {}, {}
for label, raw in zip(paths,resolved):
    name=pathlib.PurePosixPath(raw)
    mount=max((m for m in mounts if name.is_relative_to(m['Destination'])),key=lambda m:len(m['Destination']))
    host=pathlib.Path(mount['Source'])/name.relative_to(mount['Destination'])
    dev=str(os.stat(host).st_dev)
    if dev not in devices:
        disk=run(['df','-Pk',str(host)]).splitlines()[-1].split(maxsplit=5)
        s=os.statvfs(host)
        devices[dev]={'source':disk[0],'mount':disk[5],'freeBytes':s.f_bavail*s.f_frsize,'sizeBytes':s.f_blocks*s.f_frsize}
    files[label]=dev
services={s:[] for s in ['api','worker','postgres','redis','node-api','sweeper','web','media-repair']}
ids=run(['docker','ps','--all','--no-trunc','--quiet','--filter','label=com.docker.compose.project=hz-solver2']).split()
if ids:
    fmt='{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}'
    for line in sorted(run(['docker','inspect','--format',fmt,*ids]).splitlines()):
        service,oneoff,identity,state,start,restarts=line.split('|')
        if service in services and oneoff.lower()!='true':
            services[service].append({'id':identity,'state':state,'startedAt':start,'restarts':int(restarts)})
print(json.dumps({'devices':devices,'files':files,'services':services}))
"""


def worker_tail_witness(facts, session):
    tables = [("heap", "public.progressive_worker_reports", facts["oid"], facts["relfilenode"], facts["heapBytes"]),
              ("toast", facts["toastName"], facts["toastOid"], facts["toastFilenode"], facts["toastHeapBytes"])]
    if not re.fullmatch(r"pg_toast\.pg_toast_[0-9]+", tables[1][1]):
        raise ValueError("Unexpected worker report TOAST relation")
    block = facts["blockBytes"]
    probes, result = {}, {}
    for kind, name, oid, file, size in tables:
        end = size // block
        start = max(0, end - 32)
        result[kind] = {"endBlockExclusive": end, "probedBlocks": 0, "visibleTailUpperBoundBytes": None}
        if kind == "toast" and not facts["toastReadable"]:
            result[kind]["status"] = "no-existing-read-access"
            continue
        if end == 0:
            result[kind]["visibleTailUpperBoundBytes"] = 0
            continue
        select = f"""SELECT max(split_part(trim(both '()' from ctid::text),',',1)::bigint) AS last_block
            FROM {name} WHERE ctid>='({start},0)'::tid AND ctid<'({end},0)'::tid"""
        probes[kind] = (select, oid, file, end - start)
    if not probes:
        return result
    prefix = ("BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL max_parallel_workers_per_gather=0; "
              "SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; ")
    plans = session(prefix + "".join(f"EXPLAIN (FORMAT JSON,COSTS OFF) {p[0]};" for p in probes.values()) + "COMMIT;", False)
    for (kind, (select, oid, file, span)), explained in zip(probes.items(), plans, strict=True):
        plan = explained[0]["Plan"]
        children = plan.get("Plans", [])
        if plan["Node Type"] != "Aggregate" or len(children) != 1 or children[0]["Node Type"] != "Tid Range Scan" or children[0].get("Plans"):
            result[kind]["status"] = "no-bounded-tid-plan"
            continue
        [observed] = session(prefix + f"""SELECT jsonb_build_object('lastVisibleBlock',last_block,
            'blocksAtRead',pg_relation_size({oid}::oid)/{block},'filenodeAtRead',pg_relation_filenode({oid}::oid)::bigint)
            FROM ({select}) visible; COMMIT;""", False)
        result[kind].update(observed, probedBlocks=span)
        last = observed["lastVisibleBlock"]
        if observed["filenodeAtRead"] == file and last is not None and observed["blocksAtRead"] > last:
            result[kind]["visibleTailUpperBoundBytes"] = (observed["blocksAtRead"] - last - 1) * block
    return result


def worker_return_check(prior=None, live_values=False, session=vacuum_session, host=ssh, *, review_free_bytes=None):
    if prior is not None and (not isinstance(prior, dict) or prior.get("role") != "worker" or
                              prior.get("table") != "public.progressive_worker_reports"):
        raise ValueError("Expected a private HZ worker report measurement as the baseline")
    if review_free_bytes is not None and review_free_bytes < 1:
        raise ValueError("A workspace review budget must be positive")
    statement = "BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; " + RETURN_SNAPSHOT + "; COMMIT;"
    rows = session(statement, False)
    if len(rows) != 1:
        raise ValueError("Missing worker report or TOAST relation")
    facts = rows[0]
    facts["mode"] = "read-only-return-check"
    # PostgreSQL can check privileges on a function RTE even in a skipped
    # CASE branch. Issue the separate metadata query only for existing rights.
    facts["wal"]["directoryBytes"] = None
    if facts["wal"].pop("canListDirectory"):
        [wal] = session("BEGIN READ ONLY; SELECT jsonb_build_object('bytes',coalesce(sum(size),0)) FROM pg_catalog.pg_ls_waldir(); COMMIT;", False)
        facts["wal"]["directoryBytes"] = wal["bytes"]
    paths = {k: str(Path(facts["dataDir"] or "") / name) for k, name in facts["paths"].items()}
    runtime = json.loads(host("worker", ["python3", "-c", WORKER_VOLUMES, json.dumps(paths)]))
    devices, files = runtime["devices"], runtime["files"]
    facts["tail"] = worker_tail_witness(facts, session)
    facts["fileVolumes"] = {name: devices[dev] for name, dev in files.items()}
    facts["postgresFilesystem"] = devices[files["heap"]]
    facts["serviceStates"] = runtime["services"]
    if len(facts["serviceStates"]["postgres"]) != 1 or facts["serviceStates"]["postgres"][0]["state"] != "running":
        raise ValueError("Cannot identify the running HZ PostgreSQL container")
    facts["sharedDataAndWalVolume"] = len(set(files.values())) == 1 and not facts["tempTablespaces"]
    # This is the margin for a copy as large as the present allocation, not
    # a replacement-size estimate or authorization to start an exclusive rewrite.
    free = facts["postgresFilesystem"]["freeBytes"]
    facts["freeMinusCurrentAllocationBytes"] = free - facts["totalBytes"] if facts["sharedDataAndWalVolume"] else None
    if review_free_bytes is not None:
        # A caller-supplied workspace budget triggers review only. Mixed volumes
        # require separate budgets; never count unrelated space against one.
        facts["reviewBudgetBytes"] = review_free_bytes
        facts["reviewBudgetCovered"] = free >= review_free_bytes if facts["sharedDataAndWalVolume"] else None
    if live_values:
        # Keep the file/volume observation even when concurrent I/O exhausts
        # the census deadline. An unavailable value sum never becomes zero.
        census = ("BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='12s'; "
                  "SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off; SET LOCAL work_mem='1MB'; "
                  "SELECT jsonb_build_object('observedAt',statement_timestamp(),'groups',g.value) "
                  "FROM (" + LIVE_VALUES + ") g(value); COMMIT;")
        try:
            [observed] = session(census, False)
        except RuntimeError as error:
            if not re.search(r"\b57014\b", str(error)) and "canceling statement due to statement timeout" not in str(error):
                raise
            facts["liveCensus"] = {"state": "cancelled", "statementDeadlineSeconds": 12}
        else:
            facts["liveCensus"] = {"state": "measured", "observedAt": observed["observedAt"]}
            facts["liveValues"] = observed["groups"]
            total = sum(group["storedReportBytes"] for group in facts["liveValues"].values())
            facts["liveReportValueBytes"] = total
            facts["freeMinusLiveReportValuesBytes"] = free - total if facts["sharedDataAndWalVolume"] else None
    if prior is not None:
        invalid = "Worker, physical files, server start or data volume changed; capture a new baseline"
        try:
            change = comparison(prior, facts)
            same_toast = "toastFilenode" not in prior or all(
                pg_oid(prior[k]) == pg_oid(facts[k]) for k in ("toastOid", "toastFilenode")
            )
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(invalid) from exc
        if (not change["samePhysicalFile"] or not change["sameServerStart"] or not same_toast
                or prior["postgresFilesystem"]["source"] != facts["postgresFilesystem"]["source"]):
            raise ValueError(invalid)
        signals = []
        if change["relationFileDecreaseBytes"] > 0:
            signals.append("relation-allocation-fell")
        if facts["lastToastAutovacuum"] and prior.get("lastToastAutovacuum") != facts["lastToastAutovacuum"]:
            signals.append("new-toast-autovacuum")
        if facts.get("reviewBudgetCovered") is True and prior["postgresFilesystem"]["freeBytes"] < review_free_bytes:
            signals.append("specified-review-budget-reached")
        gap = prior.get("freeMinusCurrentAllocationBytes")
        if gap is not None and gap < 0 and facts["freeMinusCurrentAllocationBytes"] is not None and facts["freeMinusCurrentAllocationBytes"] >= 0:
            signals.append("available-space-crossed-current-allocation")
        old_margin, new_margin = prior.get("freeMinusLiveReportValuesBytes"), facts.get("freeMinusLiveReportValuesBytes")
        if old_margin is not None and new_margin is not None:
            change["liveValueMarginDeltaBytes"] = new_margin - old_margin
            if new_margin > old_margin:
                signals.append("live-value-workspace-improved")
        if "serviceStates" in prior:
            changed = [name for name in sorted(prior["serviceStates"].keys() | facts["serviceStates"].keys())
                       if prior["serviceStates"].get(name) != facts["serviceStates"].get(name)]
            change["changedServices"] = changed
            change["sameServiceStates"] = not changed
            if changed:
                signals.append("service-state-changed")
        if "indexFiles" in prior:
            change["sameIndexFiles"] = index_files(prior["indexFiles"]) == index_files(facts["indexFiles"])
        if "ingress" in prior:
            keys = ("unacknowledgedReport", "liveClaims", "livePromises", "ingestingJobs")
            old_ingress = any(prior["ingress"][k] for k in keys)
            new_ingress = any(facts["ingress"][k] for k in keys)
            if old_ingress != new_ingress:
                signals.append("outstanding-ingress-cleared" if old_ingress else "ingress-resumed")
        facts["change"] = change
        facts["reviewSignals"] = signals
    return facts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--measure", choices=TARGETS)
    action.add_argument("--compare", nargs=2, type=Path, metavar=("BEFORE_JSON", "AFTER_JSON"))
    action.add_argument("--autovacuum", choices=["worker"], help="plan HZ report heap and TOAST vacuum thresholds")
    action.add_argument("--return-check", choices=["worker"], help="read HZ physical allocation, WAL, ingress and service state")
    parser.add_argument("--prior", type=Path, help="previous private worker measurement or return check")
    parser.add_argument("--review-free-bytes", type=int, help="optional combined workspace byte budget for a review signal")
    parser.add_argument("--live-values", action="store_true", help="include a time-limited census of live stored report fields")
    parser.add_argument("--scale-factor", type=scale_factor, help="ceiling for both effective scale factors (default 0.02)")
    parser.add_argument("--apply", action="store_true", help="commit the planned worker-local reloptions")
    parser.add_argument("--output", type=Path, help="new local private audit file; existing files are never overwritten")
    args = parser.parse_args()
    if not args.autovacuum and (args.apply or args.scale_factor is not None):
        parser.error("--apply and --scale-factor require --autovacuum worker")
    if not args.return_check and (args.prior or args.live_values or args.review_free_bytes is not None):
        parser.error("--prior, --live-values and --review-free-bytes require --return-check worker")
    if not (args.autovacuum or args.compare or args.measure or args.return_check):
        parser.print_help()
        return 0
    # Reserve the private receipt before a possible database commit.
    output = (os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w")
              if args.output else nullcontext())
    with output as stream:
        if args.autovacuum:
            target = Decimal("0.02") if args.scale_factor is None else args.scale_factor
            result = worker_autovacuum(target, args.apply)
        elif args.return_check:
            prior = json.loads(args.prior.read_text()) if args.prior else None
            result = worker_return_check(prior, args.live_values, review_free_bytes=args.review_free_bytes)
        elif args.compare:
            result = comparison(*(json.loads(path.read_text()) for path in args.compare))
        else:
            result = measure(args.measure)
        text = json.dumps(result, indent=2) + "\n"
        if stream is not None:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
