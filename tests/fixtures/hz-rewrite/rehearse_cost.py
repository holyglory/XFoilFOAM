"""Full disposable PostgreSQL 16 rewrite with actual report bytes and index definitions."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

MIB = 1024**2
PREFIX = "progressive_worker_reports_"
REFERENCE = PREFIX + "staging_candidate_idx"
MODES = ("current", "normalized", "metadata", "combined")
FIELDS = (
    "sim_job_id",
    "sequence",
    "created_at",
    "acknowledged_at",
    "content_signature",
    "assignment_signature",
    "stopped_engine_job_id",
    "report",
    "result_payload_hash",
    "archive_bundle_id",
    "archived_at",
)


class PG:
    def __init__(self):
        host = os.environ["PGHOST"]
        if os.environ.get("HZ_REWRITE_COST_DISPOSABLE") != "1" or not (
            host.startswith("/") or host in ("127.0.0.1", "::1", "localhost")
        ):
            raise ValueError("Use the governed local hz-worker-rewrite-cost graph")
        self.cmd = [
            "psql",
            "-XwqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            host,
            "-p",
            os.environ["PGPORT"],
            "-d",
            "hz_rewrite_cost",
        ]
        self.env = dict(
            os.environ,
            PGAPPNAME="hz_rewrite_cost",
            PGOPTIONS="-c jit=off -c lock_timeout=2000 -c statement_timeout=300000",
        )
        if (
            self.run(
                "SELECT current_database()||'/'||(current_setting('server_version_num')::int/10000)"
            )
            != "hz_rewrite_cost/16"
        ):
            raise ValueError("Expected disposable PostgreSQL 16")
        if (
            self.run("SELECT count(*) FROM public.progressive_worker_reports") != "0"
            or self.run("SELECT to_regnamespace('hz_cost') IS NULL") != "t"
        ):
            raise ValueError("Expected a fresh migrated database")

    def use_fixture_disk(self):
        run = os.environ.get("DEVCOORDINATOR_TEST_RUN_ID") or os.environ.get(
            "DEVCOORDINATOR_RUN_ID", ""
        )
        if not re.fullmatch(r"t[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}", run):
            raise ValueError("A governed fixture run ID is required")
        args = [
            "docker",
            "ps",
            "--filter",
            "label=devcoordinator2.run=" + run,
            "--format",
            "{{.ID}}",
        ]
        ids = subprocess.check_output(args, text=True, timeout=10).split()
        matched = []
        for ident in ids:
            ports = json.loads(
                subprocess.check_output(
                    [
                        "docker",
                        "inspect",
                        "--format",
                        "{{json .NetworkSettings.Ports}}",
                        ident,
                    ],
                    text=True,
                )
            )
            if any(
                v.get("HostPort") == os.environ["PGPORT"]
                for v in (ports.get("5432/tcp") or [])
            ):
                matched.append(ident)
        if (
            len(matched) != 1
            or self.run("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")
            != "t"
        ):
            raise ValueError("Could not bind the exact governed PostgreSQL fixture")
        self.container = matched[0]
        self.directory = "/tmp/hz-report-cost-" + run
        self.fixture(
            [
                "install",
                "-d",
                "-m",
                "700",
                "-o",
                "postgres",
                "-g",
                "postgres",
                self.directory,
            ]
        )
        self.run("CREATE TABLESPACE hz_cost_disk LOCATION '" + self.directory + "'")
        self.env["PGOPTIONS"] += " -c default_tablespace=hz_cost_disk"
        # Only data/WAL remain on the fixture's 1 GiB PGDATA tmpfs. Flush
        # between independent trials to bound recycled WAL on that device.
        self.run("ALTER SYSTEM SET max_wal_size='128MB'")
        self.run("ALTER SYSTEM SET min_wal_size='32MB'")
        self.run("SELECT pg_reload_conf(); CHECKPOINT")
        self.storage = (
            self.fixture(["df", "-Pk", self.directory]).strip().splitlines()[-1]
        )
        if int(self.storage.split()[3]) * 1024 < 6 * 1024**3:
            raise ValueError("Insufficient disk-backed rehearsal workspace")

    def fixture(self, cmd):
        return subprocess.check_output(
            ["docker", "exec", self.container, *cmd], text=True, timeout=12
        )

    def run(self, q, data=None):
        p = subprocess.run(
            [*self.cmd, "-c", q],
            input=data,
            capture_output=True,
            env=self.env,
            timeout=320,
        )
        if p.returncode:
            raise RuntimeError(
                "PostgreSQL rehearsal failed: "
                + p.stderr.decode(errors="replace")[-1000:]
            )
        return p.stdout.decode().strip()

    def value(self, q):
        return json.loads(self.run(q))


def copy(pg, root, pages, destination):
    for page in pages:
        name = page["file"]
        if not re.fullmatch(r"(?:rows|payload)-[0-9]+\.copy\.gz", name):
            raise ValueError("Invalid capture page")
        wire = (root / name).read_bytes()
        if (
            hashlib.sha256(wire).hexdigest() != page["sha256"]
            or not 0 < page["bytes"] <= 64 * MIB
        ):
            raise ValueError("Changed or oversized page")
        data = gzip.decompress(wire)
        if len(data) != page["bytes"]:
            raise ValueError("Incomplete COPY")
        pg.run(f"COPY hz_cost.{destination} FROM STDIN (FORMAT binary)", data)


def load_corpus(pg, root):
    m = json.loads((root / "manifest.json").read_text())
    if (
        m["version"] != 1
        or not m["capturedReadOnly"]
        or not 0 < len(m["records"]) <= 288
    ):
        raise ValueError("Expected bounded read-only sample")
    pg.run("""CREATE SCHEMA hz_cost;
      CREATE TABLE hz_cost.source(sim_job_id uuid,sequence bigint,created_at timestamptz,acknowledged_at timestamptz,
      content_signature text,assignment_signature text,stopped_engine_job_id text,report jsonb NOT NULL,result_payload_hash text,
      archive_bundle_id uuid,archived_at timestamptz,closed boolean,original_sha text,original_bytes bigint,stored_sha text,
      PRIMARY KEY(sim_job_id,sequence));
      CREATE TABLE hz_cost.imported_payload(hash text PRIMARY KEY,result jsonb,bytes bigint);""")
    copy(pg, root, m["pages"], "source")
    copy(pg, root, m["payloads"], "imported_payload")
    pg.run(
        "INSERT INTO public.progressive_report_result_payloads(content_hash,result,byte_size) SELECT * FROM hz_cost.imported_payload ON CONFLICT DO NOTHING"
    )
    indexes = pg.value("""SELECT jsonb_agg(jsonb_build_object('name',c.relname,'def',pg_get_indexdef(c.oid),'predicate',pg_get_expr(i.indpred,i.indrelid),
      'body',EXISTS(SELECT FROM pg_depend dep JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=dep.refobjsubid
      WHERE dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.refobjid=i.indrelid AND a.attname='report')) ORDER BY c.oid)
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.progressive_worker_reports'::regclass""")
    defs = lambda entries: {e["name"]: (e["def"], e["predicate"]) for e in entries}
    if defs(indexes) != defs(m["catalog"]["indexes"]):
        raise ValueError("Live and migrated PG16 definitions differ")
    # Only distinct, genuinely adjacent original sequences qualify. Artificial
    # storage repetitions cannot be used as a second scientific witness.
    pg.run("""CREATE TABLE hz_cost.pairs AS WITH eligible AS MATERIALIZED(
      SELECT * FROM hz_cost.source WHERE closed AND acknowledged_at IS NOT NULL AND archive_bundle_id IS NULL
      AND result_payload_hash IS NULL AND pg_column_size(report)>=262144 AND jsonb_typeof(report->'result')='object'),
      equal AS (SELECT a.sim_job_id,a.sequence,b.sequence next FROM eligible a JOIN eligible b ON b.sim_job_id=a.sim_job_id AND b.sequence=a.sequence+1
      WHERE pg_catalog.record_image_eq(ROW(a.report->'result'),ROW(b.report->'result'))),
      keys AS (SELECT sim_job_id,sequence FROM equal UNION SELECT sim_job_id,next FROM equal)
      SELECT s.sim_job_id,s.sequence,public.store_progressive_report_result(s.report->'result') AS hash FROM keys JOIN eligible s USING(sim_job_id,sequence);
      ALTER TABLE hz_cost.pairs ADD PRIMARY KEY(sim_job_id,sequence)""")
    return m, indexes


def full_rewrite(pg):
    start = time.monotonic()
    samples = []
    env = dict(pg.env, PGAPPNAME="hz_full_index_rehearsal")
    p = subprocess.Popen(
        [*pg.cmd, "-c", "VACUUM (FULL, ANALYZE) hz_cost.measured"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        while p.poll() is None:
            age = time.monotonic() - start
            if age > 310:
                raise TimeoutError("Disposable rewrite deadline")
            # Resolve the OID before launch. A name lookup would take an
            # AccessShareLock on the target being rewritten.
            observation = pg.value("""SELECT coalesce((SELECT jsonb_build_object('phase',v.phase,'indexes',v.index_rebuild_count,'blocks',v.heap_blks_scanned,
              'total',v.heap_blks_total,'tuples',v.heap_tuples_written) FROM pg_stat_activity a JOIN pg_stat_progress_cluster v USING(pid)
              WHERE a.application_name='hz_full_index_rehearsal'),'null'::jsonb)""")
            if observation and (
                not samples
                or any(samples[-1][k] != observation[k] for k in ("phase", "indexes"))
            ):
                samples.append(dict(observation, seconds=age))
            time.sleep(0.1)
        if p.returncode:
            raise RuntimeError(p.stderr.read().decode()[-500:])
    finally:
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
    return {
        "seconds": time.monotonic() - start,
        "firstIndexSeconds": next(
            (s["seconds"] for s in samples if s["phase"] == "rebuilding index"), None
        ),
        "phases": samples,
    }


def measure(pg, indexes, mode, copies):
    metadata = mode in ("metadata", "combined")
    normalize = mode in ("normalized", "combined")
    pg.run(
        "DROP TABLE IF EXISTS hz_cost.measured; DROP TABLE IF EXISTS hz_cost.template"
    )
    fields = []
    for k in FIELDS:
        if normalize and k == "report":
            fields.append(
                "CASE WHEN p.hash IS NOT NULL THEN jsonb_set(s.report,'{result}',public.progressive_report_result_header(s.report->'result'),false) ELSE s.report END AS report"
            )
        elif normalize and k == "result_payload_hash":
            fields.append(
                "coalesce(p.hash,s.result_payload_hash) AS result_payload_hash"
            )
        else:
            fields.append("s." + k)
    pg.run(
        f"CREATE TABLE hz_cost.template AS SELECT {','.join(fields)},s.original_sha,s.original_bytes,s.stored_sha,s.report AS prior FROM hz_cost.source s LEFT JOIN hz_cost.pairs p USING(sim_job_id,sequence)"
    )
    predicates = {}
    for idx in indexes:
        if idx["body"]:
            expr = idx["predicate"]
            if not expr:
                raise ValueError("Unsupported full expression index")
            if expr not in predicates:
                predicates[expr] = "membership_" + str(len(predicates) + 1)
    if metadata:
        for expr, flag in predicates.items():
            pg.run(
                f"ALTER TABLE hz_cost.template ADD COLUMN {flag} boolean; UPDATE hz_cost.template SET {flag}=({expr}) IS TRUE"
            )
    cols = [*FIELDS, *(predicates.values() if metadata else [])]
    columns = ",".join(cols)
    truth = pg.value("""WITH t AS MATERIALIZED(SELECT *,CASE WHEN archive_bundle_id IS NULL THEN public.resolve_progressive_report(report,result_payload_hash)::text END original FROM hz_cost.template)
     SELECT jsonb_build_object('rows',count(*),'cold',count(*) FILTER(WHERE archive_bundle_id IS NOT NULL),'changed',count(*) FILTER(WHERE original_sha IS NULL OR original_bytes<=0
      OR (archive_bundle_id IS NULL AND (encode(sha256(convert_to(original,'UTF8')),'hex')<>original_sha OR octet_length(original)<>original_bytes))
      OR (archive_bundle_id IS NOT NULL AND (NOT pg_catalog.record_image_eq(ROW(prior),ROW(report)) OR encode(sha256(convert_to(report::text,'UTF8')),'hex')<>stored_sha)))) FROM t""")
    assert truth["changed"] == 0, truth
    for idx in indexes:
        expr = idx["predicate"] or "true"
        target = predicates[expr] if metadata and expr in predicates else expr
        bad = pg.run(f"""SELECT count(*) FROM (SELECT sim_job_id,sequence,({expr}) IS TRUE included FROM hz_cost.source)a
          JOIN (SELECT sim_job_id,sequence,({target}) IS TRUE included FROM hz_cost.template)b USING(sim_job_id,sequence) WHERE a.included<>b.included""")
        if bad != "0":
            raise ValueError("Index membership changed: " + idx["name"])
    # copy_no only scales physical storage. Original job/sequence and report
    # content/signature remain exact in each copy, even for rejected results.
    table = "hz_cost.measured"
    dead = max(1, (copies + 2) // 3)
    pg.run(
        f"CREATE TABLE {table} WITH(autovacuum_enabled=false,toast.autovacuum_enabled=false) AS SELECT 0::int copy_no,{columns} FROM hz_cost.template WITH NO DATA"
    )
    pg.run(
        f"INSERT INTO {table} SELECT n,{columns} FROM hz_cost.template CROSS JOIN generate_series(1,{copies + dead})n ORDER BY sim_job_id,sequence,n"
    )
    for idx in indexes:
        if idx["name"] == PREFIX + "pkey":
            pg.run(
                f"ALTER TABLE {table} ADD CONSTRAINT {PREFIX}pkey PRIMARY KEY(sim_job_id,sequence,copy_no)"
            )
        else:
            ddl = idx["def"].replace(
                " ON public.progressive_worker_reports ", f" ON {table} "
            )
            if metadata and idx["body"]:
                ddl = (
                    ddl.split(" WHERE ", 1)[0]
                    + " WHERE "
                    + predicates[idx["predicate"]]
                )
            pg.run(ddl)
    pg.run(f"DELETE FROM {table} WHERE copy_no>{copies}; ANALYZE {table}")

    def physical():
        return pg.value(f"""SELECT jsonb_build_object('oid',c.oid::bigint,'file',pg_relation_filenode(c.oid)::bigint,
          'heap',pg_relation_size(c.oid),'toast',pg_relation_size(c.reltoastrelid),'indexes',pg_indexes_size(c.oid)+pg_indexes_size(c.reltoastrelid),
          'allocated',pg_total_relation_size(c.oid),'indexCount',(SELECT count(*) FROM pg_index WHERE indrelid=c.oid),
          'wal',pg_current_wal_lsn()::text) FROM pg_class c WHERE c.oid='{table}'::regclass""")

    args = ",".join("t." + c for c in cols)
    pg.run(
        f"ALTER TABLE hz_cost.template ADD COLUMN witness bytea; UPDATE hz_cost.template t SET witness=sha256(record_send(ROW({args})))"
    )

    def prove():
        start = time.monotonic()
        row = pg.value(f"""SELECT jsonb_build_object('rows',count(*),'different',count(*) FILTER(WHERE k.witness IS DISTINCT FROM sha256(record_send(ROW({args})))
           OR t.copy_no NOT BETWEEN 1 AND {copies})) FROM {table} t LEFT JOIN hz_cost.template k USING(sim_job_id,sequence)""")
        row["seconds"] = time.monotonic() - start
        if row["rows"] != copies * truth["rows"] or row["different"] != 0:
            raise ValueError(f"Row identity differs: {row}")
        return row

    before = physical()
    pre = prove()
    result = full_rewrite(pg)
    post = prove()
    after = physical()
    assert (
        before["oid"] == after["oid"]
        and before["file"] != after["file"]
        and before["indexCount"] == after["indexCount"] == len(indexes)
    )
    if (
        pg.run(
            f"SELECT count(*) FROM pg_index WHERE indrelid='{table}'::regclass AND (NOT indisvalid OR NOT indisready)"
        )
        != "0"
    ):
        raise ValueError("Missing usable index after rewrite")
    start = time.monotonic()
    pg.run("REINDEX INDEX hz_cost." + REFERENCE)
    return dict(
        mode=mode,
        copies=copies,
        deadCopies=dead,
        before=before,
        after=after,
        sourceProof=truth,
        priorProof=pre,
        afterProof=post,
        spaceReturned=before["allocated"] - after["allocated"],
        referenceIndexSeconds=time.monotonic() - start,
        **result,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--copies", type=int, default=16)
    parser.add_argument("--trials", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.copies <= 64 or not 1 <= args.trials <= 3:
        parser.error("Invalid bounded sample size")
    pg = PG()
    pg.use_fixture_disk()
    start = time.monotonic()
    manifest, indexes = load_corpus(pg, args.corpus)
    out = {
        "corpusSha256": hashlib.sha256(
            (args.corpus / "manifest.json").read_bytes()
        ).hexdigest(),
        "sourceAt": manifest["catalog"]["at"],
        "indexes": indexes,
        "sourceRows": len(manifest["records"]),
        "tablespace": pg.storage,
        "realNormalizedTransitions": int(pg.run("SELECT count(*) FROM hz_cost.pairs")),
        "settings": pg.value(
            "SELECT jsonb_build_object('version',current_setting('server_version_num'),'maintenanceMemory',current_setting('maintenance_work_mem'),'parallelMaintenance',current_setting('max_parallel_maintenance_workers'),'blockSize',current_setting('block_size'))"
        ),
        "trials": [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for i in range(args.trials):
        for mode in MODES if i % 2 == 0 else reversed(MODES):
            print(
                f"trial {i + 1} / {mode}: full rewrite, analyze, identity and membership checks",
                flush=True,
            )
            pg.run("CHECKPOINT")
            row = measure(pg, indexes, mode, args.copies)
            out["trials"].append(dict(trial=i + 1, **row))
            out["elapsedSeconds"] = time.monotonic() - start
            args.output.write_text(json.dumps(out, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        k: row[k]
                        for k in (
                            "mode",
                            "seconds",
                            "firstIndexSeconds",
                            "referenceIndexSeconds",
                            "spaceReturned",
                        )
                    }
                ),
                flush=True,
            )
    pg.run("DROP SCHEMA hz_cost CASCADE")
    pg.run("CHECKPOINT")
    pg.run("DROP TABLESPACE hz_cost_disk")
    pg.fixture(["rmdir", pg.directory])


if __name__ == "__main__":
    main()
