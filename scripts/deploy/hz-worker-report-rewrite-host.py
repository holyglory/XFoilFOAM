#!/usr/bin/env python3
"""HZ half of the one-off worker report rewrite. The operator owns the user units."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
TABLE = "public.progressive_worker_reports"
VACUUM = "VACUUM (FULL, ANALYZE) public.progressive_worker_reports;"
TOAST_VACUUM = "VACUUM (FULL, PROCESS_MAIN false, PROCESS_TOAST true) public.progressive_worker_reports;"
PROJECT = "hz-solver2"
PG = PROJECT + "-postgres-1"
ROLE_SQL = """SELECT jsonb_build_object('at',clock_timestamp(),'database',current_database(),
 'primary',NOT pg_is_in_recovery(),'version',current_setting('server_version_num')::int,
 'instance',instance_id,'registration',remote_solver_registered_id,'upstream',upstream_base_url IS NOT NULL,
 'remoteEnabled',remote_solver_enabled,'transferPaused',remote_solver_transfer_paused,
 'heartbeatSeconds',remote_solver_heartbeat_interval_seconds,
 'sweeperEnabled',(SELECT enabled FROM sweeper_state WHERE id=1),
 'executionPools',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,enabled) ORDER BY id),'[]'::jsonb) FROM solver_execution_pools),
 'workerTable',(SELECT relkind='r' AND relpersistence='p' AND reltoastrelid<>0
   FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass),
 'oldestOtherSnapshotSeconds',(SELECT max(extract(epoch FROM clock_timestamp()-xact_start))
   FROM pg_stat_activity WHERE backend_xmin IS NOT NULL AND pid<>pg_backend_pid()),
 'preparedTransactions',(SELECT count(*) FROM pg_prepared_xacts),
 'relationOwner',pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass),'USAGE'),
 'collection',jsonb_build_object('inserted',(SELECT n_tup_ins FROM pg_stat_all_tables WHERE relid='public.progressive_worker_reports'::regclass),
 'pending', (SELECT count(*) FROM progressive_worker_reports WHERE acknowledged_at IS NULL)),
 'leases',(SELECT jsonb_build_object('active',count(*),'remainingSeconds',min(extract(epoch FROM ("expiresAt"-clock_timestamp()))),
 'soonest',min("expiresAt")) FROM sync_sweep_promises WHERE status='active' AND "expiresAt">clock_timestamp()
))
 FROM sync_api_settings s WHERE id=1"""
# The proof uses PostgreSQL's binary send functions (including original JSONB
# numeric scale) and fixed primary-key ordering. Only row digests leave psql.
SOURCES = {
    "reports": ("progressive_worker_reports", "sim_job_id,sequence", ""),
    "conflicts": ("progressive_worker_report_conflicts", "sim_job_id,sequence", ""),
    "shared-results": (
        "progressive_report_result_payloads",
        "content_hash",
        "WHERE EXISTS (SELECT FROM progressive_worker_reports r WHERE r.result_payload_hash=t.content_hash)",
    ),
    "archive-members": (
        "progressive_report_archive_members",
        "sim_job_id,member_kind,sequence",
        "WHERE source_kind='worker'",
    ),
    "archive-bundles": (
        "progressive_report_archive_bundles",
        "id",
        "WHERE source_kind='worker'",
    ),
    "staging": ("progressive_worker_evidence_receipts", "sim_job_id,sequence", ""),
    "staged-attempts": (
        "progressive_worker_evidence_attempts",
        "sim_job_id,sequence,result_attempt_id",
        "",
    ),
    "delivery": (
        "progressive_worker_hub_receipts",
        "sim_job_id,point_content_signature",
        "",
    ),
    "delivery-failures": (
        "progressive_worker_delivery_failures",
        "sim_job_id,point_content_signature",
        "",
    ),
    "archive-deliveries": (
        "progressive_worker_archive_deliveries",
        "sim_job_id,point_content_signature",
        "",
    ),
    "archive-receipts": (
        "progressive_worker_archive_receipts",
        "sim_job_id,point_content_signature",
        "",
    ),
    "science": ("progressive_worker_report_science_proofs", "sim_job_id,sequence", ""),
}


def dump(path, obj):
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(obj, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def load_audit():
    spec = importlib.util.spec_from_file_location(
        "worker_report_reclamation", HERE / "worker-report-reclamation.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(argv, *, text=None, seconds=12):
    p = subprocess.run(
        argv, input=text, text=True, capture_output=True, timeout=seconds
    )
    if p.returncode:
        raise RuntimeError(
            f"{argv[0]} exited {p.returncode}: {p.stderr[-400:].strip()}"
        )
    return p.stdout.strip()


def json_rows(text):
    decoder = json.JSONDecoder()
    rows = []
    while text := text.lstrip():
        row, end = decoder.raw_decode(text)
        rows.append(row)
        text = text[end:]
    return rows


def pg_command(pg, tag, seconds, write=False):
    if not re.fullmatch(r"[a-z_0-9]{1,62}", tag):
        raise ValueError("Invalid maintenance session tag")
    opts = f"-c application_name={tag} -c statement_timeout={seconds * 1000} -c lock_timeout=3000 -c max_parallel_workers_per_gather=0 -c jit=off"
    if not write:
        opts += " -c default_transaction_read_only=on"
    return [
        "docker",
        "exec",
        "-i",
        "-e",
        "PGOPTIONS=" + opts,
        "-e",
        "PGAPPNAME=" + tag,
        pg,
        "psql",
        "-XwqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "aerodb",
        "-d",
        "aerodb",
    ]


def rows(pg, statement, seconds=8):
    return json_rows(
        command(
            pg_command(pg, "hz_rewrite_observe", seconds),
            text=statement,
            seconds=seconds + 4,
        )
    )


REPORT_JOB = "EXISTS (SELECT FROM public.progressive_worker_reports r WHERE r.sim_job_id=t.sim_job_id)"
# A report-producing job may already own a real result before its staging
# transaction. A staging receipt also identifies an attempt independently.
OWNED_ATTEMPTS = """SELECT a.id,a.result_id FROM public.result_attempts a
    WHERE EXISTS (SELECT FROM public.progressive_worker_reports r WHERE r.sim_job_id=a.sim_job_id)
       OR EXISTS (SELECT FROM public.progressive_worker_evidence_attempts e WHERE e.result_attempt_id=a.id)"""
SOURCES["result-attempts"] = (
    "result_attempts",
    "id",
    "WHERE "
    + REPORT_JOB
    + " OR EXISTS (SELECT FROM public.progressive_worker_evidence_attempts e WHERE e.result_attempt_id=t.id)",
)
SOURCES["selected-results"] = (
    "results",
    "id",
    f"WHERE {REPORT_JOB} OR t.id IN (SELECT owned.result_id FROM ({OWNED_ATTEMPTS}) owned)",
)
LINKED_ATTEMPT = (
    f"WHERE t.result_attempt_id IN (SELECT owned.id FROM ({OWNED_ATTEMPTS}) owned)"
)
for relation in (
    "result_classifications",
    "result_interpretations",
    "force_history",
    "result_media",
    "solver_evidence_archives",
    "attempt_evidence_archives",
    "attempt_evidence_storage_events",
    "result_history_archives",
):
    SOURCES[relation] = (relation, "id", LINKED_ATTEMPT)
SOURCES["attempt_evidence_history_projections"] = (
    "attempt_evidence_history_projections",
    "result_attempt_id,archive_id",
    LINKED_ATTEMPT,
)


def report_identity(columns, alias="t"):
    if not {
        "sim_job_id",
        "sequence",
        "content_signature",
        "report",
        "result_payload_hash",
        "archive_bundle_id",
    }.issubset(columns):
        raise ValueError("Unrecognized HZ report identity schema")
    if any(not re.fullmatch(r"[a-zA-Z_][0-9a-zA-Z_]*", key) for key in columns):
        raise ValueError("Unrecognized report column")
    metadata = ",".join(f'{alias}."{key}"' for key in columns if key != "report")
    return f"CASE WHEN {alias}.archive_bundle_id IS NOT NULL OR {alias}.result_payload_hash IS NOT NULL THEN pg_catalog.record_send(ROW({alias}.*)) ELSE pg_catalog.record_send(ROW({metadata})) END"


def toast_source(facts):
    name = facts["toastName"]
    if (
        name != "pg_toast.pg_toast_" + str(load_audit().pg_oid(facts["oid"]))
        or not facts["toastReadable"]
    ):
        raise ValueError("Cannot authenticate the named parent table's TOAST chunks")
    return name


def chunk_value_digest():
    # Per-chunk hashes bound string_agg memory even for a large single datum.
    return "sha256(string_agg(sha256(pg_catalog.record_send(ROW(c.chunk_id,c.chunk_seq,c.chunk_data))),''::bytea ORDER BY c.chunk_seq))"


def fingerprint_queries(
    staging_copies=False, *, columns, exhaustive=False, toast_facts=None
):
    sources = dict(SOURCES)
    if staging_copies:
        sources["staging-copies"] = (
            "progressive_worker_staging_copies",
            "sim_job_id,sequence",
            "",
        )
    for label, (table, ordering, where) in sources.items():
        data = (
            report_identity(columns)
            if label == "reports" and not exhaustive
            else "pg_catalog.record_send(ROW(t.*))"
        )
        if label == "reports" and toast_facts is not None:
            # Values larger than an entire PostgreSQL page must be external.
            # Read complete potentially inline bodies; pin the original slots
            # and versions in the parent so no row can retarget a datum.
            if not exhaustive:
                data = f"CASE WHEN pg_column_size(t.report)<={int(toast_facts['blockBytes'])} THEN pg_catalog.record_send(ROW(t.*)) ELSE {data} END"
            data = f"pg_catalog.record_send(ROW(t.xmin::text,t.ctid,{data}))"
        yield (
            label,
            (
                f"SELECT encode(sha256({data}),'hex') "
                f"FROM public.{table} t {where} ORDER BY {ordering}"
            ),
        )
    # Always compare actual stored bytes at both ends of each representation.
    # Overlapping first/last sets are deduplicated by exact owner and sequence.
    boundaries = []
    for condition in (
        "archive_bundle_id IS NOT NULL",
        "result_payload_hash IS NOT NULL",
        "archive_bundle_id IS NULL AND result_payload_hash IS NULL",
    ):
        for direction in ("ASC", "DESC"):
            boundaries.append(
                f"(SELECT sim_job_id,sequence FROM public.progressive_worker_reports WHERE {condition} "
                f"ORDER BY sim_job_id {direction},sequence {direction} LIMIT 4)"
            )
    yield (
        "report-body-witnesses",
        (
            "WITH keys AS (" + " UNION ".join(boundaries) + ") "
            "SELECT encode(sha256(pg_catalog.record_send(ROW(t.*))),'hex') FROM keys JOIN public.progressive_worker_reports t USING(sim_job_id,sequence) "
            "ORDER BY t.sim_job_id,t.sequence"
        ),
    )

    if toast_facts is not None:
        name = toast_source(toast_facts)
        yield (
            "toast-values",
            f"SELECT encode({chunk_value_digest()},'hex') FROM {name} c GROUP BY c.chunk_id ORDER BY c.chunk_id",
        )


def fingerprint_sql(
    staging_copies=False, *, columns, exhaustive=False, toast_facts=None
):
    parts = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"]
    for label, query in fingerprint_queries(
        staging_copies, columns=columns, exhaustive=exhaustive, toast_facts=toast_facts
    ):
        if label == "toast-values":
            parts.append(
                "SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;"
            )
        parts.extend([f"SELECT '@{label}';", f"COPY ({query}) TO STDOUT;"])
    return "\n".join([*parts, "COMMIT;"])


def verify_proof_schema(pg, physical):
    # Parse each actual SELECT without executing a table scan. A relation can
    # have a column with the same name as its alias (force_history.t).
    queries = fingerprint_queries(
        physical["stagingCopies"], columns=physical["columns"]
    )
    rows(
        pg,
        "\n".join(
            f"PREPARE hz_proof AS {query}; DEALLOCATE hz_proof;" for _, query in queries
        ),
    )


class Proof:
    def __init__(self, staging_copies=False, toast=False):
        self.labels = [
            *SOURCES,
            *(["staging-copies"] if staging_copies else []),
            "report-body-witnesses",
            *(["toast-values"] if toast else []),
        ]
        self.parts = {}
        self.current = None
        self.tail = b""

    def feed(self, data):
        *lines, self.tail = (self.tail + data).split(b"\n")
        for line in lines:
            if line.startswith(b"@"):
                label = line[1:].decode("ascii")
                if label not in self.labels or label in self.parts:
                    raise ValueError("Unknown or duplicate identity section")
                self.parts[label] = [0, hashlib.sha256()]
                self.current = self.parts[label]
            else:
                if self.current is None or len(line) != 64:
                    raise ValueError("Incomplete PostgreSQL row digest")
                self.current[1].update(bytes.fromhex(line.decode("ascii")))
                self.current[0] += 1

    def finish(self):
        if self.tail or list(self.parts) != self.labels:
            raise ValueError("Incomplete report/scientific manifest")
        return {
            key: {"rows": v[0], "sha256": v[1].hexdigest()}
            for key, v in self.parts.items()
        }


def collection(pg):
    statement = """WITH jobs AS MATERIALIZED (
      SELECT id FROM sim_jobs WHERE status IN ('pending','submitted','running','ingesting') AND engine_job_id IS NOT NULL
      AND request_payload ? 'remoteProgressiveExecution' ORDER BY id LIMIT 64)
      SELECT jsonb_build_object('samples',coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb),
        'inserted',(SELECT n_tup_ins FROM pg_stat_user_tables WHERE relid='public.progressive_worker_reports'::regclass),
        'reset',(SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()))
      FROM (SELECT id,(SELECT max(sequence) FROM progressive_worker_reports r WHERE r.sim_job_id=jobs.id) AS sequence,
       (SELECT min(sequence) FROM progressive_worker_reports r WHERE r.sim_job_id=jobs.id AND r.acknowledged_at IS NULL) AS first_pending FROM jobs)s"""
    return rows(pg, statement)[0]


def sample_identity_cost(pg, facts):
    """One bounded PG16 TID-range sample. No ordered full-table dry-run scan."""
    blocks = max(1, facts["heapBytes"] // facts["blockBytes"])
    ranges = sorted({n * (blocks - 1) // 11 for n in range(12)})
    windows = ",".join(f"({page})" for page in ranges)
    keys = f"""WITH windows(page) AS (VALUES {windows})
      SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM(
        SELECT r.ctid::text AS tid, r.size FROM windows CROSS JOIN LATERAL (
          SELECT t.ctid,pg_column_size(t.report) AS size FROM public.progressive_worker_reports t
          WHERE t.ctid >= ('('||page||',0)')::tid AND t.ctid < ('('||(page+2)||',0)')::tid
          LIMIT 12)r) s"""
    plan = rows(pg, "EXPLAIN (FORMAT JSON) " + keys)[0]
    if "Tid Range Scan" not in json.dumps(plan):
        return {"state": "no-bounded-tid-plan"}
    candidates = rows(pg, keys)[0]
    chosen = []
    total = 0
    # Sample large datums first within the inspected pages. Neither the trials
    # nor their optimistic extrapolation set the write or scientific gate.
    for item in sorted(candidates, key=lambda k: k["size"], reverse=True):
        size = item["size"]
        if size > 2 * 1024**2 or total + size > 12 * 1024**2:
            continue
        if not re.fullmatch(r"\(\d+,\d+\)", item["tid"]):
            raise ValueError("Invalid heap TID")
        chosen.append(item["tid"])
        total += size
    if not chosen:
        return {"state": "no-bounded-rows"}
    tids = ",".join("'" + v + "'::tid" for v in chosen)

    def trial(data):
        return rows(
            pg,
            f"""WITH sample AS MATERIALIZED (
          SELECT pg_column_size(t.report) AS bytes,sha256({data}) AS fingerprint FROM public.progressive_worker_reports t
          WHERE t.ctid=ANY(ARRAY[{tids}]) AND pg_column_size(t.report)<=2097152
          ), work AS MATERIALIZED (SELECT sum(bytes) AS bytes,count(fingerprint) AS rows,
          encode(sha256(string_agg(fingerprint,''::bytea)),'hex') AS digest FROM sample)
          SELECT jsonb_build_object('rows',rows,'storedReportBytes',bytes,'sampleDigest',digest,
          'seconds',extract(epoch FROM clock_timestamp()-statement_timestamp())) FROM work""",
            15,
        )[0]

    return {
        "state": "measured",
        "pagesInspected": len(ranges) * 2,
        "candidateRows": len(candidates),
        "reportIdentity": trial(report_identity(facts["columns"])),
        "allReportBytes": trial("record_send(ROW(t.*))"),
    }


def collector_count(services):
    running = [row for row in services["sweeper"] if row["state"] == "running"]
    if not running:
        return 0
    script = """const fs=require('node:fs');let n=0;for(const id of fs.readdirSync('/proc')){
        if(!/^[0-9]+$/.test(id)||id===String(process.pid))continue;
        try{const argv=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split(String.fromCharCode(0));
            if(argv.some(x=>x.endsWith('/report-storage-worker.ts')||x.endsWith('/report-storage-worker.js')))n++;}catch{}}
        process.stdout.write(String(n));"""
    return int(command(["docker", "exec", running[0]["id"], "node", "-e", script]))


def auxiliary_files(pg, paths):
    # Enumerate only numeric PostgreSQL segments and forks for the catalogued
    # auxiliary heap and its indexes. st_blocks counts allocated filesystem bytes.
    pattern = r"(?:base/[0-9]+|pg_tblspc/[0-9]+/PG_[0-9]+_[0-9]+/[0-9]+)/[0-9]+"
    if not paths or not all(re.fullmatch(pattern, p) for p in paths):
        raise ValueError("Unknown auxiliary file path")
    script = """cd "$PGDATA"
for p do
 for f in "$p" "$p".[0-9]* "$p"_fsm* "$p"_vm* "$p"_init*; do
  if [ -f "$f" ]; then stat -Lc '%n|%d|%i|%b|%s' "$f"; fi
 done
done"""
    result = {}
    raw = command(
        ["docker", "exec", pg, "sh", "-ec", script, "hz_auxiliary_files", *paths],
        seconds=20,
    )
    for line in raw.splitlines():
        name, dev, inode, blocks, size = line.split("|")
        root = (
            re.split(r"(?:_[a-z]+|\.[0-9]+)$", name)[0]
            .split("_fsm")[0]
            .split("_vm")[0]
            .split("_init")[0]
        )
        if root not in paths or name in result:
            raise ValueError("Unexpected auxiliary fork or segment")
        result[name] = {
            "device": int(dev),
            "inode": int(inode),
            "allocated": int(blocks) * 512,
            "size": int(size),
        }
    return result


def toast_proof_plan(pg, f):
    name = toast_source(f)
    value = rows(
        pg,
        f"""BEGIN READ ONLY; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;
       EXPLAIN (FORMAT JSON) SELECT encode({chunk_value_digest()},'hex') FROM {name} c GROUP BY c.chunk_id ORDER BY c.chunk_id;
       COMMIT;""",
    )[0]

    def nodes(n):
        yield n["Node Type"]
        for child in n.get("Plans", []):
            yield from nodes(child)

    sequence = list(nodes(value[0]["Plan"]))
    return {
        "nodes": sequence,
        "orderedByChunkIndex": "Index Scan" in sequence and "Sort" not in sequence,
    }


def sample_auxiliary_cost(pg, facts):
    """Read complete external values from 96 bounded heap pages, in two disjoint cohorts."""
    name = toast_source(facts)
    pages = max(1, facts["toastHeapBytes"] // facts["blockBytes"])
    windows = ",".join(
        f"({p})" for p in sorted({i * (pages - 1) // 31 for i in range(32)})
    )
    keys = f"""WITH pages(k) AS(VALUES {windows}) SELECT DISTINCT t.chunk_id FROM pages CROSS JOIN LATERAL(
      SELECT c.chunk_id::bigint FROM {name} c WHERE c.ctid>=('('||k||',0)')::tid AND c.ctid<('('||(k+3)||',0)')::tid LIMIT 12)t"""
    plan = rows(pg, "EXPLAIN (FORMAT JSON) " + keys)[0]
    if "Tid Range Scan" not in json.dumps(plan):
        return {"state": "no bounded physical sampling plan"}
    ids = rows(
        pg, "SELECT to_jsonb(q.chunk_id) FROM (" + keys + ")q ORDER BY q.chunk_id"
    )
    if not ids:
        return {"state": "no live sampled chunks"}
    choices = ",".join(f"({int(i)}::oid)" for i in ids)
    counts = rows(
        pg,
        f"""WITH keys(k) AS(VALUES {choices}) SELECT jsonb_build_object('id',k::bigint,'n',
       (SELECT count(*) FROM(SELECT FROM {name} c WHERE c.chunk_id=k LIMIT 4097)b)) FROM keys ORDER BY k""",
    )
    chunk = int(
        facts.get("packing", {}).get("toastChunkBytes", facts["blockBytes"] // 4)
    )
    cohorts = []
    for group in (counts[::2], counts[1::2]):
        picked = []
        n = 0
        for item in group:
            if 0 < item["n"] <= 4096 and (n + item["n"]) * chunk <= 48 * 1024**2:
                picked.append(int(item["id"]))
                n += item["n"]
        if not picked:
            continue
        values = ",".join(f"({i}::oid)" for i in picked)
        sql = f"""WITH keys(k) AS(VALUES {values}), hashed AS MATERIALIZED(SELECT k,g.* FROM keys CROSS JOIN LATERAL
        (SELECT count(*) AS n,sum(octet_length(c.chunk_data)) AS bytes,{chunk_value_digest()} AS digest FROM {name} c WHERE c.chunk_id=k)g),
        work AS MATERIALIZED(SELECT count(*) AS datums,sum(n) AS chunks,sum(bytes) AS bytes,
         encode(sha256(string_agg(digest,''::bytea ORDER BY k)),'hex') AS digest FROM hashed)
        SELECT jsonb_build_object('values',datums,'chunks',chunks,'bytes',bytes,'digest',digest,
          'seconds',extract(epoch FROM clock_timestamp()-statement_timestamp())) FROM work"""
        trials = [rows(pg, sql, 15)[0] for _ in range(2)]
        if (
            trials[0]["digest"] != trials[1]["digest"]
            or trials[0]["chunks"] != n
            or trials[1]["chunks"] != n
        ):
            return {"state": "sample changed during the read"}
        cohorts.append(trials)
    return {
        "state": "measured" if cohorts else "no bounded whole values",
        "candidateValues": len(ids),
        "trials": cohorts,
    }


def measured(pg, *, census=False, sample=False, toast=False):
    audit = load_audit()
    (physical,) = rows(pg, audit.RETURN_SNAPSHOT)
    (role,) = rows(pg, ROLE_SQL)
    if (
        role["database"] != "aerodb"
        or not 160000 <= role["version"] < 170000
        or not role["workerTable"]
        or not role["primary"]
        or not role["relationOwner"]
        or not role["upstream"]
        or not role["registration"]
    ):
        raise ValueError("Unbound HZ primary database, relation owner or registration")
    physical["paths"]["database-default"] = rows(
        pg, "SELECT to_jsonb(pg_relation_filepath('pg_catalog.pg_class'::regclass))"
    )[0]
    layout = {
        k: str(Path(physical["dataDir"] or "") / path)
        for k, path in physical["paths"].items()
    }
    runtime = json.loads(
        command(
            [sys.executable, "-c", audit.WORKER_VOLUMES, json.dumps(layout)], seconds=30
        )
    )
    services = runtime["services"]
    compose = command(
        [
            "docker",
            "ps",
            "--filter",
            "label=com.docker.compose.project=hz-solver2",
            "--format",
            '{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.oneoff"}}',
        ]
    )
    known = set(services) | {"worker-foundation14"}
    for line in compose.splitlines():
        service, oneoff = line.split("|")
        if service not in known or oneoff.lower() != "false":
            raise ValueError("Unclassified running HZ compose service: " + service)
    physical["reportStorageProcesses"] = collector_count(services)
    if len(services["postgres"]) != 1 or services["postgres"][0]["state"] != "running":
        raise ValueError("HZ PostgreSQL container identity changed")
    for svc in ("node-api", "sweeper"):
        if len(services[svc]) != 1:
            raise ValueError("Missing dedicated HZ control-plane identity")
        info = command(
            [
                "docker",
                "inspect",
                "--format",
                '{{range .Config.Env}}{{if eq (index (split . "=") 0) "AIRFOILFOAM_DEPLOYMENT_ROLE"}}{{.}}{{end}}{{end}}',
                services[svc][0]["id"],
            ]
        )
        if info != "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver":
            raise ValueError("Refusing non-worker deployment")
    physical["columns"] = rows(
        pg,
        "SELECT jsonb_agg(attname ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.progressive_worker_reports'::regclass AND attnum>0 AND NOT attisdropped",
    )[0]
    physical["collection"] = collection(pg)
    physical["stagingCopies"] = rows(
        pg,
        "SELECT to_jsonb(to_regclass('public.progressive_worker_staging_copies') IS NOT NULL)",
    )[0]
    verify_proof_schema(pg, physical)
    physical["writerLocks"] = rows(
        pg,
        """SELECT to_jsonb(count(*)) FROM pg_locks l JOIN pg_stat_activity a USING(pid)
      WHERE l.relation IN ('public.progressive_worker_reports'::regclass,(SELECT reltoastrelid FROM pg_class WHERE oid='public.progressive_worker_reports'::regclass))
      AND a.backend_type='client backend' AND a.pid<>pg_backend_pid() AND l.mode<>'AccessShareLock'""",
    )[0]
    physical["solverProcesses"] = {}
    engine_rows = services["worker"]
    engine_ps = (
        command(["docker", "top", engine_rows[0]["id"], "-eo", "pid,comm"])
        if engine_rows and engine_rows[0]["state"] == "running"
        else ""
    )
    for line in engine_ps.splitlines():
        name = line.split()[-1]
        if re.fullmatch(
            r"(?:[A-Za-z0-9_.-]*Foam|foamRun|mpirun|decomposePar|snappyHexMesh)", name
        ):
            physical["solverProcesses"][name] = (
                physical["solverProcesses"].get(name, 0) + 1
            )
    if pg != PG and pg != services["postgres"][0]["id"]:
        raise ValueError("Captured PostgreSQL container changed")
    devices = runtime["files"]
    device = devices["heap"]
    disk = runtime["devices"][device]
    physical.update(
        {
            "services": services,
            "runtimeRole": "remote-solver",
            "database": role,
            "disk": disk,
            "device": device,
            "allFilesOnVolume": len(set(devices.values())) == 1
            and not physical["tempTablespaces"],
        }
    )
    physical["wal"]["directoryBytes"] = wal_bytes(pg)
    physical["wal"]["slotStatus"] = rows(
        pg,
        "SELECT coalesce(jsonb_agg(jsonb_build_object('active',active,'type',slot_type,'status',wal_status,'retainedBytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn))),'[]'::jsonb) FROM pg_replication_slots",
    )[0]
    physical["wal"]["maxSizeBytes"] = rows(
        pg, "SELECT to_jsonb(pg_size_bytes(current_setting('max_wal_size')))"
    )[0]
    if toast:
        physical["toastProofPlan"] = (
            toast_proof_plan(pg, physical)
            if physical["toastReadable"]
            else {"nodes": [], "orderedByChunkIndex": False}
        )
        paths = [
            physical["paths"]["toast"],
            *(physical["paths"]["index-" + key] for key in physical["toastIndexFiles"]),
        ]
        physical["auxiliaryPaths"] = paths
        physical["auxiliaryFiles"] = auxiliary_files(pg, paths)
        if any(path not in physical["auxiliaryFiles"] for path in paths):
            raise RuntimeError("Incomplete auxiliary heap/index file inventory")
    if census:
        # Both operands come from this cluster. Charge each real datum its
        # own last partial page, including inline headers already in the heap.
        chunk = int(
            command(
                [
                    "docker",
                    "exec",
                    pg,
                    "sh",
                    "-ec",
                    """LC_ALL=C pg_controldata "$PGDATA" | awk -F: '/Maximum size of a TOAST chunk/ {print $2}'""",
                ]
            )
        )
        block = int(physical["blockBytes"])
        if not 0 < chunk * 4 < block:
            raise ValueError("Unrecognized worker TOAST page geometry")
        payload = 4 * chunk
        physical["live"] = (
            rows(
                pg,
                f"""SELECT jsonb_object_agg(kind,jsonb_build_object(
            'rows',n,'storedReportBytes',bytes,'referenceBytes',refs,'reportPageBytes',pages*{block},'potentialChunks',chunks))
            FROM (SELECT CASE WHEN archived_at IS NOT NULL THEN 'archived'
            WHEN result_payload_hash IS NULL THEN 'inline' ELSE 'shared' END AS kind,
            count(*) AS n,sum(pg_column_size(report)) AS bytes,sum(coalesce(pg_column_size(result_payload_hash),0)) AS refs,
            sum((pg_column_size(report)::bigint+{payload - 1})/{payload}) AS pages, sum((pg_column_size(report)::bigint+{chunk - 1})/{chunk}) AS chunks
            FROM public.progressive_worker_reports GROUP BY 1) measured;""",
                60,
            )[0]
            or {}
        )
        physical["packing"] = {
            "toastChunkBytes": chunk,
            "usableFullChunkBytesPerPage": payload,
            "modeledReplacementBytes": sum(
                v["reportPageBytes"] for v in physical["live"].values()
            )
            + physical["totalBytes"]
            - physical["toastHeapBytes"],
        }
        if toast:
            chunks = sum(
                group["potentialChunks"] for group in physical["live"].values()
            )
            # A sorted chunk btree with fixed (oid,int4) keys. Charge 256
            # entries/leaf and at most 128 branch entries/page through the root.
            pages = (chunks + 255) // 256
            levels = 0
            while pages > 1:
                levels += pages
                pages = (pages + 127) // 128
            chunk_index = (levels + 65) * block
            heap_bound = sum(
                group["reportPageBytes"] for group in physical["live"].values()
            )
            physical["packing"].update(
                potentialChunks=chunks,
                chunkIndexEstimate=chunk_index,
                toastReplacementBytes=heap_bound
                + chunk_index
                + (heap_bound + chunk_index + 1023) // 1024
                + 16 * 1024**2,
            )
    if sample:
        physical["identitySample"] = sample_identity_cost(pg, physical)
        if toast and physical["toastReadable"]:
            physical["toastProofSample"] = sample_auxiliary_cost(pg, physical)
    return physical


def wal_bytes(pg):
    return 1024 * int(
        command(
            ["docker", "exec", pg, "sh", "-ec", 'du -skL "$PGDATA/pg_wal" | cut -f1']
        ).strip()
    )


def budget(facts, config):
    mode = config.get("mode", "whole")
    if mode not in ("whole", "toast"):
        raise ValueError("Unknown report rewrite mode")
    toast = mode == "toast"
    old = int(facts["toastTotalBytes"] if toast else facts["totalBytes"])
    indexes = int(facts["toastIndexBytes"]) + (0 if toast else int(facts["indexBytes"]))
    modeled = facts.get("packing", {}).get("modeledReplacementBytes")
    if toast and modeled is not None:
        modeled = facts["packing"].get("toastReplacementBytes")
        indexes = max(indexes, facts["packing"].get("chunkIndexEstimate", 0))
    replacement = config["replacement"] if config["replacement"] is not None else old
    wal = facts["wal"]
    # max_wal_size is a checkpoint target, never a hard ceiling. Retainers can
    # pin WAL across the whole rewrite. Live monitoring also checks actual bytes.
    retaining = bool(wal["slots"]) or wal["archiveMode"] != "off"
    wal_budget = (
        config["wal"]
        if config["wal"] is not None
        else max(
            wal["directoryBytes"],
            2 * wal["maxSizeBytes"],
            replacement if retaining else 0,
        )
    )
    floor = config["floor"]
    total = replacement + indexes + wal_budget + config["growth"] + floor
    reasons = []
    if not facts["allFilesOnVolume"]:
        reasons.append(
            "Heap, TOAST, indexes, WAL or temporary workspace are on separate volumes"
        )
    if replacement < old:
        live = sum(x["storedReportBytes"] for x in facts.get("live", {}).values())
        # The auxiliary-only projection charges every report (including
        # inline values) an entire final page and retains its own index/FSM
        # allowance. Parent heap and indexes stay in place.
        minimum = modeled if toast else live + indexes + facts["heapBytes"]
        if not live or minimum is None or replacement < minimum:
            reasons.append(
                "Packed TOAST budget is below the measured auxiliary heap, chunk index and fork model, or the census is unavailable"
                if toast
                else "Packed replacement budget is below live report bytes plus the existing heap/index allowances, or the census is unavailable"
            )
    if toast:
        try:
            toast_source(facts)
            if facts.get("toastProofPlan", {}).get("orderedByChunkIndex") is False:
                reasons.append(
                    "Chunk proof requires unbudgeted sorting of auxiliary data"
                )
        except ValueError as exc:
            reasons.append(str(exc))
    if facts["disk"]["freeBytes"] < total:
        reasons.append("Insufficient available bytes on the PostgreSQL volume")
    return {
        "mode": mode,
        "parentTotalBytes": facts["totalBytes"],
        "allocatedBytes": old,
        "replacementBytes": replacement,
        "modeledReplacementBytes": modeled,
        "indexScratchBytes": indexes,
        "additionalWalBytes": wal_budget,
        "externalGrowthBytes": config["growth"],
        "stopFreeBytes": floor,
        "requiredBytes": total,
        "availableBytes": facts["disk"]["freeBytes"],
        "marginBytes": facts["disk"]["freeBytes"] - total,
        "maximumAffordableReplacementBytes": facts["disk"]["freeBytes"]
        - (total - replacement),
        "additionalAvailableBytesNeeded": max(0, total - facts["disk"]["freeBytes"]),
        "walRetainers": retaining,
        "additionalFilesystemGrowthBudgeted": config["growth"],
        "headroomBasis": "reviewed packed replacement"
        if config["replacement"] is not None
        else "entire current allocation",
        "refusals": reasons,
    }


def normalized_identity(key):
    columns, staging, heap, heap_file, toast, toast_file, indexes, *pins = key
    audit = load_audit()
    return [
        columns,
        staging,
        *(audit.pg_oid(i) for i in (heap, heap_file, toast, toast_file)),
        audit.index_files(indexes),
        *pins,
    ]


def identity(f):
    return normalized_identity(
        [
            f["columns"],
            f["stagingCopies"],
            f["oid"],
            f["relfilenode"],
            f["toastOid"],
            f["toastFilenode"],
            f["indexFiles"],
            f["serverStartedAt"],
            f["device"],
            f["disk"]["source"],
            f["database"]["instance"],
            f["database"]["registration"],
            f["services"]["postgres"][0]["id"],
        ]
    )


def check_phase_space(f, config):
    st = os.stat(f["disk"]["mount"])
    if str(st.st_dev) != f["device"]:
        raise ValueError("PostgreSQL filesystem changed")
    v = os.statvfs(f["disk"]["mount"])
    free = v.f_bavail * v.f_frsize
    if free <= config["floor"]:
        raise RuntimeError("Low-space cancellation threshold reached")
    return free


def monitor_sql(tag, oid):
    return f"""SELECT jsonb_build_object('phase',p.phase,'reportedCommand',p.command,'blocksScanned',p.heap_blks_scanned,
     'blocksTotal',p.heap_blks_total,'tuplesWritten',p.heap_tuples_written,'indexesRebuilt',p.index_rebuild_count,
     'waitType',a.wait_event_type,'wait',a.wait_event,'lockedBy',cardinality(pg_blocking_pids(a.pid)))
     FROM pg_stat_activity a LEFT JOIN pg_stat_progress_cluster p ON p.pid=a.pid AND p.relid={int(oid)}::oid
     WHERE a.application_name='{tag}' AND a.datname=current_database() AND a.backend_type='client backend';"""


def run_phase(argv, sql, seconds, poll, cancel, proof=None):
    # COPY streams only SHA-256 values. Drain stdout while monitoring, never
    # spool full rows or wait on a full pipe during the exclusive lock.
    poll()
    with (
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors
        ) as proc,
    ):
        end = time.monotonic() + seconds
        try:
            proc.stdin.write(sql.encode() + b"\n")
            proc.stdin.close()
            next_poll = time.monotonic() + 2
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                while True:
                    now = time.monotonic()
                    if now >= end:
                        raise TimeoutError("Maintenance phase deadline expired")
                    if now >= next_poll:
                        poll()
                        next_poll = time.monotonic() + 2
                    if sel.select(min(1, max(0, end - now))):
                        chunk = os.read(proc.stdout.fileno(), 262144)
                        if not chunk:
                            break
                        if proof:
                            proof.feed(chunk)
            rc = proc.wait(timeout=max(0.1, end - time.monotonic()))
            if rc:
                errors.seek(0)
                raise RuntimeError(
                    f"PostgreSQL phase exited {rc}: {errors.read(450).decode(errors='replace')}"
                )
            return proof.finish() if proof else None
        except BaseException:
            if proc.poll() is None:
                proc.terminate()
            try:
                cancel()
            finally:
                try:
                    proc.wait(2)
                except subprocess.TimeoutExpired:
                    proc.kill()
            raise


def host_phase(action, directory, pg):
    opts = json.loads((directory / "plan.json").read_text())
    cfg = opts["budget"]
    tag = "hz_rewrite_" + directory.name
    if not re.fullmatch(r"hz_rewrite_[0-9a-f]{32}", tag):
        raise ValueError("Invalid pinned run directory")
    # Capture a new filesystem/TTL snapshot under the deploy lock, before
    # stopping writers and again once their original container IDs are stopped.
    if action in ("preflight", "quiesced", "ready", "after", "resumed"):
        f = measured(
            pg,
            toast=cfg.get("mode") == "toast",
            census=action in ("preflight", "quiesced", "ready")
            and cfg["replacement"] is not None,
        )
        dump(directory / (action + ".json"), f)
        if action == "preflight":
            if any(
                f["services"][name] != opts["worker"]["services"][name]
                for name in f["services"]
            ):
                raise RuntimeError(
                    "Container identity/state changed since operator preflight"
                )
        if action in ("preflight", "quiesced", "ready"):
            if identity(f) != normalized_identity(opts["identity"]):
                raise RuntimeError(
                    "Database, volume, registration or table files changed since preflight"
                )
            b = budget(f, cfg)
            dump(directory / (action + "-workspace.json"), b)
            if b["refusals"]:
                raise RuntimeError("; ".join(b["refusals"]))
            if action != "preflight":
                if f["writerLocks"]:
                    raise RuntimeError(
                        "A SQL writer still owns the report relation after the pause"
                    )
                if any(
                    c["state"] == "running"
                    for n in ("sweeper", "node-api", "web", "media-repair")
                    for c in f["services"][n]
                ):
                    raise RuntimeError(
                        "A captured HZ control-plane writer is still running"
                    )
            remaining = (
                opts["remainingWorkSeconds"]
                if action != "ready"
                else opts["sqlSeconds"]
                + opts["identitySeconds"]
                + opts["restoreReserve"]
            )
            ttl = f["database"]["leases"]["remainingSeconds"]
            if ttl is not None and float(ttl) < remaining:
                raise RuntimeError(
                    "Local scheduling lease is too short for the reserved pause"
                )
            if (
                opts["leaseDeadline"] is not None
                and time.time() + remaining >= opts["leaseDeadline"]
            ):
                raise RuntimeError(
                    "Pause no longer fits the authoritative lease window"
                )
        if action == "resumed":
            original = opts["worker"]["database"]
            if any(
                f["database"][key] != original[key]
                for key in (
                    "instance",
                    "registration",
                    "remoteEnabled",
                    "transferPaused",
                    "sweeperEnabled",
                    "executionPools",
                )
            ):
                raise RuntimeError(
                    "Prior worker registration or collection policy changed"
                )
            wanted = opts["worker"]["reportStorageProcesses"]
            until = time.monotonic() + 18
            while f["reportStorageProcesses"] != wanted and time.monotonic() < until:
                time.sleep(1)
                f["reportStorageProcesses"] = collector_count(f["services"])
            if f["reportStorageProcesses"] != wanted:
                raise RuntimeError(
                    "Original report storage process count was not restored"
                )
            dump(directory / "resumed.json", f)
        if action == "after":
            before = json.loads((directory / "quiesced.json").read_text())
            if (
                load_audit().rewrite_outcome(before, f, cfg.get("mode", "whole"))
                is not True
            ):
                raise RuntimeError(
                    "Committed rewrite did not preserve table/server identity and replace the physical file"
                )
            if cfg.get("mode") == "toast" and any(
                before[k] != f[k]
                for k in ("heapBytes", "indexBytes", "parentIndexFileBytes")
            ):
                raise RuntimeError(
                    "Parent heap or index allocation changed during the TOAST-only rewrite"
                )
            physical_result = {}
            if cfg.get("mode") == "toast":
                retired = auxiliary_files(pg, before["auxiliaryPaths"])
                if any(v["allocated"] for v in retired.values()):
                    raise RuntimeError(
                        "Retired TOAST relation files still have allocated blocks"
                    )
                old_blocks = sum(
                    v["allocated"] for v in before["auxiliaryFiles"].values()
                )
                new_blocks = sum(v["allocated"] for v in f["auxiliaryFiles"].values())
                physical_result = dict(
                    oldAuxiliaryAllocatedBytes=old_blocks,
                    newAuxiliaryAllocatedBytes=new_blocks,
                    releasedAllocatedBytes=old_blocks - new_blocks,
                    oldFilePathsRemainingAllocatedBytes=0,
                )
            dump(
                directory / "space-result.json",
                {
                    **physical_result,
                    "relationBytesReturned": before["totalBytes"] - f["totalBytes"],
                    "filesystemAvailableDeltaBytes": f["disk"]["freeBytes"]
                    - before["disk"]["freeBytes"],
                    "beforeAllocation": before["totalBytes"],
                    "afterAllocation": f["totalBytes"],
                    "device": f["disk"]["source"],
                    "mode": cfg.get("mode", "whole"),
                    "toastBytesReturned": before["toastTotalBytes"]
                    - f["toastTotalBytes"],
                },
            )
        return
    f = json.loads((directory / "quiesced.json").read_text())
    workspace = json.loads((directory / "quiesced-workspace.json").read_text())

    def poll():
        if (directory / "cancel").exists():
            raise InterruptedError("Operator cancellation")
        free = check_phase_space(f, cfg)
        wal = wal_bytes(pg)
        if wal - f["wal"]["directoryBytes"] > workspace["additionalWalBytes"]:
            raise RuntimeError("WAL directory exceeded its extra-space budget")
        if (
            opts["leaseDeadline"] is not None
            and time.time() + opts["restoreReserve"] >= opts["leaseDeadline"]
        ):
            raise RuntimeError("Lease renewal/restoration margin reached")
        progress = rows(
            pg,
            monitor_sql(tag, f["toastOid"] if cfg.get("mode") == "toast" else f["oid"]),
            4,
        )
        sample = {
            "at": time.time(),
            "phase": action,
            "freeBytes": free,
            "walBytes": wal,
            "postgres": progress,
        }
        with (directory / "progress.jsonl").open("a") as stream:
            stream.write(json.dumps(sample) + "\n")

    def cancel():
        rows(
            pg,
            f"SELECT to_jsonb(pg_cancel_backend(pid)) FROM pg_stat_activity WHERE application_name='{tag}' AND datname=current_database() AND pid<>pg_backend_pid()",
        )

    secs = opts["sqlSeconds"] if action == "rewrite" else opts["identitySeconds"]
    run_sql = (
        (TOAST_VACUUM if cfg.get("mode") == "toast" else VACUUM)
        if action == "rewrite"
        else fingerprint_sql(
            f["stagingCopies"],
            columns=f["columns"],
            exhaustive=opts["allReportBytes"],
            toast_facts=f if cfg.get("mode") == "toast" else None,
        )
    )
    result = run_phase(
        pg_command(pg, tag, secs, write=action == "rewrite"),
        run_sql,
        secs,
        poll,
        cancel,
        None
        if action == "rewrite"
        else Proof(f["stagingCopies"], cfg.get("mode") == "toast"),
    )
    if action == "rewrite":
        dump(
            directory / "rewrite-commit.json",
            {
                "completedAt": time.time(),
                "table": TABLE,
                "mode": cfg.get("mode", "whole"),
            },
        )
    else:
        dump(directory / (action + ".json"), result)
        if action == "identity-after" and result != json.loads(
            (directory / "identity-before.json").read_text()
        ):
            raise RuntimeError(
                "Report/scientific fingerprint mismatch after committed rewrite"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "phase",
        choices=[
            "inspect",
            "preflight",
            "quiesced",
            "identity-before",
            "ready",
            "rewrite",
            "identity-after",
            "after",
            "resumed",
        ],
    )
    parser.add_argument("directory", nargs="?", type=Path)
    parser.add_argument("pg", nargs="?", default=PG)
    parser.add_argument("--census", action="store_true")
    args = parser.parse_args()

    def interrupted(*_):
        raise InterruptedError("Worker rewrite interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    if args.phase == "inspect":
        print(json.dumps(measured(args.pg, census=args.census)))
    else:
        host_phase(args.phase, args.directory, args.pg)
