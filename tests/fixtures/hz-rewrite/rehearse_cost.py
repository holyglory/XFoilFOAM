"""Full disposable PostgreSQL 16 rewrite with actual report bytes and index definitions."""

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

MIB = 1024**2
PREFIX = "progressive_worker_reports_"
REFERENCE = PREFIX + "staging_candidate_idx"
host_source = (
    Path(__file__).resolve().parents[3]
    / "scripts/deploy/hz-worker-report-rewrite-host.py"
)
spec = importlib.util.spec_from_file_location("hz_rewrite_host", host_source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
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
        self.directory = "/tmp/hz-pg16-index-cost-" + run
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

    def cold_sources(self, physical):
        # The helper is shared with the governed index-crossover rehearsal.
        # It accepts only postgres-owned source segments of this fixture.
        source = Path(__file__).parents[1] / "hz_pg16_index_cache.c"
        binary = self.directory + "/fadvise"
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "fadvise"
            subprocess.run(
                ["cc", "-O2", "-Wall", "-static", str(source), "-o", str(exe)],
                check=True,
                timeout=35,
            )
            subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    "-u",
                    "postgres",
                    self.container,
                    "sh",
                    "-ec",
                    'umask 077; cat > "$1" && chmod 700 "$1"',
                    "fixture",
                    binary,
                ],
                input=exe.read_bytes(),
                check=True,
                timeout=15,
            )
        root = Path(physical["heapFile"]).parent
        if not re.fullmatch(r"pg_tblspc/[0-9]+/PG_16_[0-9]+/[0-9]+", str(root)):
            raise ValueError("Expected dedicated fixture disk tablespace")
        base = Path(self.directory).joinpath(*root.parts[2:])
        paths = [
            str(base / str(n))
            for n in (
                physical["file"],
                physical["toastFilenode"],
                *physical["toastIndexFiles"].values(),
            )
        ]
        self.run("CHECKPOINT")
        out = subprocess.check_output(
            [
                "docker",
                "exec",
                "-u",
                "postgres",
                self.container,
                binary,
                "evict-fixture-sources",
                *paths,
            ],
            timeout=25,
            text=True,
        )
        observed = json.loads(out)
        if (
            observed["sourceBytes"] < physical["toast"]
            or observed["residentAfterBytes"] >= observed["sourceBytes"]
        ):
            raise ValueError(
                "Targeted fixture cold-read preparation did not remove cached source pages"
            )
        self.fixture(["rm", "--", binary])
        return observed

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


def full_rewrite(pg, toast_only=False, cancel_probe=None):
    start = time.monotonic()
    samples = []
    cancelled = None
    env = dict(pg.env, PGAPPNAME="hz_full_index_rehearsal")
    p = subprocess.Popen(
        [
            *pg.cmd,
            "-c",
            (host.TOAST_VACUUM if toast_only else host.VACUUM).replace(
                host.TABLE, "hz_cost.measured"
            ),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        while p.poll() is None:
            age = time.monotonic() - start
            if age > 310:
                raise TimeoutError("Disposable rewrite deadline")
            # Avoid a target name lookup while PostgreSQL holds its exclusive lock.
            observation = pg.value("""SELECT coalesce((SELECT jsonb_build_object('pid',v.pid,'relation',v.relid::bigint,'phase',v.phase,'indexes',v.index_rebuild_count,'blocks',v.heap_blks_scanned,
              'total',v.heap_blks_total,'tuples',v.heap_tuples_written) FROM pg_stat_activity a JOIN pg_stat_progress_cluster v USING(pid)
              WHERE a.application_name='hz_full_index_rehearsal'),'null'::jsonb)""")
            if observation and (
                not samples
                or any(samples[-1][k] != observation[k] for k in ("phase", "indexes"))
            ):
                samples.append(dict(observation, seconds=age))
            if (
                cancel_probe
                and observation
                and observation["tuples"] > 0
                and cancelled is None
            ):
                cancelled = cancel_probe(observation)
            time.sleep(0.1)
        stderr = p.stderr.read().decode()[-500:]
        if cancel_probe:
            if (
                not cancelled
                or not p.returncode
                or "canceling statement due to user request" not in stderr
            ):
                raise AssertionError(
                    f"Missing a genuine in-flight PostgreSQL cancellation: {stderr}"
                )
        elif p.returncode:
            raise RuntimeError(stderr)
    finally:
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
    return {
        "cancelled": cancelled,
        "seconds": time.monotonic() - start,
        "firstIndexSeconds": next(
            (s["seconds"] for s in samples if s["phase"] == "rebuilding index"), None
        ),
        "phases": samples,
    }


def science(pg):
    # One source per original stable key. The full-record proof independently
    # checks every storage copy, including all unknown fields and numeric scale.
    return pg.value("""WITH originals AS MATERIALIZED(
      SELECT t.sim_job_id AS j,t.sequence AS n,t.content_signature AS sig,k.original_sha,k.original_bytes,
        CASE WHEN t.archive_bundle_id IS NULL THEN public.resolve_progressive_report(t.report,t.result_payload_hash) END AS original
      FROM hz_cost.measured t JOIN hz_cost.template k USING(sim_job_id,sequence) WHERE t.copy_no=1),
      data AS MATERIALIZED(SELECT j,n,sig,original_sha,original_bytes,original::text AS text,original->'result' AS result FROM originals),
      points AS MATERIALIZED(SELECT j,n,p.ordinal AS polar,x.ordinal AS ordinal,x.pt FROM data
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(result->'polars')='array' THEN result->'polars' ELSE '[]' END)
          WITH ORDINALITY p(value,ordinal)
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.value->'points','[]')||coalesce(p.value->'attempts','[]'))
          WITH ORDINALITY x(pt,ordinal)),
      subsets AS MATERIALIZED(SELECT j,n,polar,ordinal,
        (SELECT jsonb_object_agg(k,v) FROM jsonb_each(pt) p(k,v) WHERE k IN('cl','cd','cm','cl_std','cd_std','cm_std','converged','unsteady','stalled')) coefficients,
        (SELECT jsonb_object_agg(k,v) FROM jsonb_each(pt) p(k,v) WHERE k LIKE '%history%' OR k IN ('frame_track','frameTrack')) histories
        FROM points)
      SELECT jsonb_build_object('sources',count(*),'hotOrShared',count(text),'coldBindings',count(*)-count(text),
        'badOriginals',count(*) FILTER(WHERE text IS NOT NULL AND
         (encode(sha256(convert_to(text,'UTF8')),'hex')<>original_sha OR octet_length(text)<>original_bytes)),
        'allSourceHash',encode(sha256(string_agg(record_send(ROW(j,n,sig,original_sha,original_bytes)),''::bytea ORDER BY j,n)),'hex'),
        'scientificHash',encode(sha256(string_agg(sha256(record_send(ROW(j,n,result))),''::bytea ORDER BY j,n)),'hex'),
        'coefficients',(SELECT jsonb_build_object('points',count(coefficients),'sha256',encode(sha256(string_agg(sha256(record_send(ROW(j,n,polar,ordinal,coefficients))),''::bytea ORDER BY j,n,polar,ordinal)),'hex')) FROM subsets),
        'histories',(SELECT jsonb_build_object('points',count(histories),'sha256',encode(sha256(string_agg(sha256(record_send(ROW(j,n,polar,ordinal,histories))),''::bytea ORDER BY j,n,polar,ordinal)),'hex')) FROM subsets))
      FROM data""")


def measure(pg, indexes, mode, copies, toast_only=False, cancel_trial=False):
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
          'toastOid',c.reltoastrelid::bigint,'toastFilenode',pg_relation_filenode(c.reltoastrelid)::bigint,
          'parentIndexFiles',(SELECT jsonb_object_agg(indexrelid::text,pg_relation_filenode(indexrelid)::bigint) FROM pg_index WHERE indrelid=c.oid),
          'toastIndexFiles',(SELECT jsonb_object_agg(indexrelid::text,pg_relation_filenode(indexrelid)::bigint) FROM pg_index WHERE indrelid=c.reltoastrelid),
          'heapFile',pg_relation_filepath(c.oid),'toastFile',pg_relation_filepath(c.reltoastrelid),
          'toastIndexBytes',pg_indexes_size(c.reltoastrelid),'parentIndexBytes',pg_indexes_size(c.oid),
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
    initial_science = science(pg) if toast_only else None
    if toast_only:
        assert (
            initial_science["badOriginals"] == 0
            and initial_science["coefficients"]["points"] > 0
            and initial_science["histories"]["points"] > 0
        )

    def data_files():
        path = Path(before["heapFile"]).parent.as_posix()
        if not re.fullmatch(r"pg_tblspc/[0-9]+/PG_16_[0-9]+/[0-9]+", path):
            raise ValueError("Expected the fixture's exclusive disk tablespace")
        raw = pg.fixture(
            [
                "sh",
                "-ec",
                'cd "$PGDATA/$1"; for f in [0-9]*; do test -f "$f" && stat -c "%n|%i|%b|%s" "$f"; done',
                "fixture",
                path,
            ]
        )
        return {
            name: {
                "inode": int(inode),
                "allocated": int(blocks) * 512,
                "size": int(size),
            }
            for name, inode, blocks, size in (
                line.split("|") for line in raw.splitlines()
            )
        }

    base_files = data_files()

    def relation_files(inv, values):
        nodes = {
            str(x)
            for x in [
                inv["file"],
                inv["toastFilenode"],
                *inv["parentIndexFiles"].values(),
                *inv["toastIndexFiles"].values(),
            ]
        }
        return {k: v for k, v in values.items() if re.split(r"[_.]", k, 1)[0] in nodes}

    def cancel(observation):
        current = data_files()
        transient = {
            k: v
            for k, v in current.items()
            if k not in base_files and v["allocated"] > 0
        }
        if not transient:
            return None
        pid = int(observation["pid"])
        locks = pg.value(f"""SELECT jsonb_agg(jsonb_build_object('oid',relation::bigint,'mode',mode,'granted',granted))
          FROM pg_locks WHERE pid={pid} AND relation IN({int(before["oid"])},{int(before["toastOid"])})""")
        assert observation["relation"] == before["toastOid"] and all(
            any(
                l["oid"] == oid and l["granted"] and l["mode"] == "AccessExclusiveLock"
                for l in locks
            )
            for oid in (before["oid"], before["toastOid"])
        )
        assert (
            pg.run(
                f"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid={pid} AND datname=current_database() AND application_name='hz_full_index_rehearsal'"
            )
            == "t"
        )
        return {"observed": observation, "locks": locks, "files": transient}

    cancel_result = None
    if cancel_trial:
        cancel_result = full_rewrite(pg, True, cancel)
        stable = physical()
        files = data_files()
        assert all(
            before[k] == stable[k]
            for k in (
                "allocated",
                "oid",
                "file",
                "toastOid",
                "toastFilenode",
                "parentIndexFiles",
                "toastIndexFiles",
            )
        )
        assert all(
            files.get(k, {}).get("allocated", 0) == 0
            for k in cancel_result["cancelled"]["files"]
        )
        cancel_result["proofAfterRollback"] = prove()
        assert science(pg) == initial_science

    def file_bytes(o):
        return pg.value(f"""SELECT jsonb_build_object('main',coalesce((pg_stat_file('{o["heapFile"]}',true)).size,0),
           'toast',coalesce((pg_stat_file('{o["toastFile"]}',true)).size,0))""")

    def available():
        return (
            int(pg.fixture(["df", "-Pk", pg.directory]).splitlines()[-1].split()[3])
            * 1024
        )

    old_physical = file_bytes(before)

    def chunks(inv):
        rel = pg.run(f"SELECT {int(inv['toastOid'])}::regclass::text")
        if not re.fullmatch(r"pg_toast\.pg_toast_[0-9]+", rel):
            raise ValueError("Unknown disposable TOAST name")
        start = time.monotonic()
        v = pg.value(f"""SET enable_seqscan=off; SET enable_bitmapscan=off;
          WITH chunks_by_value AS MATERIALIZED(SELECT c.chunk_id,count(*) AS n,sum(octet_length(c.chunk_data)) AS bytes,
           {host.chunk_value_digest()} AS digest FROM {rel} c GROUP BY c.chunk_id)
          SELECT jsonb_build_object('datums',count(*),'chunks',sum(n),'bytes',sum(bytes),
            'digest',encode(sha256(string_agg(digest,''::bytea ORDER BY chunk_id)),'hex')) FROM chunks_by_value""")
        return v, time.monotonic() - start

    prior_chunks = chunks(before) if toast_only else None
    cold = pg.cold_sources(before) if toast_only else None
    free_before = available()
    result = full_rewrite(pg, toast_only)
    free_after = available()
    post = prove()
    post_science = science(pg) if toast_only else None
    assert post_science == initial_science
    after = physical()
    assert (
        before["oid"] == after["oid"]
        and (before["file"] == after["file"]) == toast_only
        and before["indexCount"] == after["indexCount"] == len(indexes)
    )
    if (
        pg.run(
            f"SELECT count(*) FROM pg_index WHERE indrelid='{table}'::regclass AND (NOT indisvalid OR NOT indisready)"
        )
        != "0"
    ):
        raise ValueError("Missing usable index after rewrite")
    old_files_after = file_bytes(before)
    new_files = file_bytes(after)
    after_chunks = chunks(after) if toast_only else None
    if toast_only:
        assert before["indexCount"] == 11 and after_chunks[0] == prior_chunks[0]
        assert (
            before["toastOid"] == after["toastOid"]
            and before["toastFilenode"] != after["toastFilenode"]
        )
        assert (
            before["parentIndexFiles"] == after["parentIndexFiles"]
            and before["parentIndexBytes"] == after["parentIndexBytes"]
        )
        assert (
            old_files_after["toast"] == 0
            and old_files_after["main"] == old_physical["main"] == new_files["main"]
        )
        assert (
            new_files["toast"] == after["toast"]
            and old_physical["toast"] == before["toast"]
        )
        assert before["toastIndexFiles"].keys() == after[
            "toastIndexFiles"
        ].keys() and all(
            before["toastIndexFiles"][k] != after["toastIndexFiles"][k]
            for k in before["toastIndexFiles"]
        )
    current_files = data_files()
    old_alloc = relation_files(before, base_files)
    new_alloc = relation_files(after, current_files)
    if toast_only:
        assert all(
            current_files.get(k, {}).get("allocated", 0) == 0
            for k in old_alloc.keys() - new_alloc.keys()
        )
        assert all(
            old_alloc[k] == new_alloc[k] for k in old_alloc.keys() & new_alloc.keys()
        )
        assert sum(v["allocated"] for v in old_alloc.values()) > sum(
            v["allocated"] for v in new_alloc.values()
        )
    start = time.monotonic()
    if not toast_only:
        pg.run("REINDEX INDEX hz_cost." + REFERENCE)
    return dict(
        mode=mode,
        toastOnly=toast_only,
        oldPhysical=old_physical,
        oldFilesAfter=old_files_after,
        newPhysical=new_files,
        filesystemBefore=free_before,
        filesystemAfter=free_after,
        filesystemDelta=free_after - free_before,
        copies=copies,
        deadCopies=dead,
        before=before,
        after=after,
        sourceProof=truth,
        priorProof=pre,
        afterProof=post,
        spaceReturned=before["allocated"] - after["allocated"],
        referenceIndexSeconds=None if toast_only else time.monotonic() - start,
        allocatedFilesBefore=old_alloc,
        allocatedFilesAfter=new_alloc,
        allocatedFilesystemBytesReturned=sum(v["allocated"] for v in old_alloc.values())
        - sum(v["allocated"] for v in new_alloc.values()),
        cancellation=cancel_result,
        scientificBefore=initial_science,
        scientificAfter=post_science,
        chunkProofBefore=prior_chunks,
        chunkProofAfter=after_chunks,
        coldSource=cold,
        **result,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--copies", type=int, default=16)
    parser.add_argument("--trials", type=int, default=2)
    parser.add_argument("--toast-only", action="store_true")
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
        for mode in (
            ("current",)
            if args.toast_only
            else (MODES if i % 2 == 0 else reversed(MODES))
        ):
            print(
                f"trial {i + 1} / {mode}: {'TOAST-only rewrite' if args.toast_only else 'full rewrite and analyze'}, identity and membership checks",
                flush=True,
            )
            pg.run("CHECKPOINT")
            row = measure(
                pg,
                indexes,
                mode,
                args.copies,
                args.toast_only,
                cancel_trial=args.toast_only and i == 0,
            )
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
