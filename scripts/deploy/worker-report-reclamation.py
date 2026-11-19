#!/usr/bin/env python3
"""Private read-only relation audit and before/after file-size comparison.

Native maintenance is in reclaim-progressive-worker-reports.sql. This audit
never executes maintenance, changes controls, or uses sample estimates as gates.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shlex
import subprocess
import sys

TARGETS = {
    "worker": ("hz-solver2", "hz-solver2-postgres-1", "progressive_worker_reports", "worker"),
    "hub": ("airfoils.pro", "app-postgres-1", "progressive_remote_reports", "remote"),
}
# A display bucket for the sample, never an eligibility or execution threshold.
SMALL_BODY_BYTES = 8192


def ssh(role: str, command: list[str], sql: str = "") -> str:
    host = TARGETS[role][0]
    result = subprocess.run(
        ["ssh", "-T", "-C", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
         "-oConnectTimeout=10", host, shlex.join(command)],
        input=sql, text=True, capture_output=True, timeout=35, check=False,
    )
    if result.returncode:
        # Keep output limited to diagnostics from these fixed metadata queries.
        raise RuntimeError(f"{role} read-only probe failed ({result.returncode}): {result.stderr[-2000:].strip()}")
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
    if (before["role"],before["table"],before["oid"]) != (after["role"],after["table"],after["oid"]):
        raise ValueError("Cannot compare different relation identities")
    delta = before["totalBytes"]-after["totalBytes"]
    return {"table": after["table"], "observedBefore": before["observedAt"], "observedAfter": after["observedAt"],
        "relationFileDecreaseBytes": delta, "relationShrank": delta>0,
        "toastHeapDecreaseBytes": before["toastHeapBytes"]-after["toastHeapBytes"],
        "postgresFilesystemFreeDeltaBytes": after["postgresFilesystem"]["freeBytes"]-before["postgresFilesystem"]["freeBytes"],
        "samePhysicalFile": before["relfilenode"]==after["relfilenode"],
        "sameServerStart": before.get("serverStartedAt")==after.get("serverStartedAt"),
        "note": "Observed net file changes only. Concurrent writers/WAL/case activity prevent filesystem-level attribution."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--measure", choices=TARGETS)
    action.add_argument("--compare", nargs=2, type=Path, metavar=("BEFORE_JSON", "AFTER_JSON"))
    parser.add_argument("--output", type=Path, help="new local private audit file; existing files are never overwritten")
    args = parser.parse_args()
    if args.compare:
        result = comparison(*(json.loads(path.read_text()) for path in args.compare))
    elif args.measure:
        result = measure(args.measure)
    else:
        parser.print_help()
        return 0
    text = json.dumps(result, indent=2) + "\n"
    if args.output:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
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
