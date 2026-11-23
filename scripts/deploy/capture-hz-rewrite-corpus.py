#!/usr/bin/env python3
"""Capture a bounded, read-only HZ storage sample from a reviewed list of IDs."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import struct
import subprocess
import uuid


def binary_rows(raw):
    stream = io.BytesIO(raw)
    if stream.read(19) != b"PGCOPY\n\xff\r\n\x00" + bytes(8):
        raise ValueError("Not a standard PostgreSQL binary COPY")
    while True:
        count = struct.unpack("!h", stream.read(2))[0]
        if count == -1:
            break
        row = []
        for _ in range(count):
            length = struct.unpack("!i", stream.read(4))[0]
            row.append(None if length == -1 else stream.read(length))
        yield row
    if stream.read():
        raise ValueError("Unconsumed PostgreSQL COPY bytes")


def worker(statement):
    opts = "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=500 -c max_parallel_workers_per_gather=0 -c jit=off"
    command = [
        "docker",
        "exec",
        "-i",
        "-e",
        opts,
        "hz-solver2-postgres-1",
        "psql",
        "-XwqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "aerodb",
        "-d",
        "aerodb",
        "-c",
        statement,
    ]
    return subprocess.check_output(
        [
            "ssh",
            "-C",
            "-T",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "hz-solver2",
            shlex.join(command),
        ],
        timeout=35,
    )


def capture(reference, dest):
    picks = json.loads(reference.read_text())["rows"]
    if not 1 <= len(picks) <= 96:
        raise ValueError("Supply 1–96 reviewed HZ report identities")
    keys = {(str(uuid.UUID(p["job"])), int(p["seq"])) for p in picks}
    if any(n < 1 for _, n in keys):
        raise ValueError("Invalid report sequence")
    # An adjacent source sequence is necessary to prove real historical reuse.
    wanted = sorted({(j, num) for j, n in keys for num in (n - 1, n, n + 1) if num > 0})
    dest.mkdir(mode=0o700)
    pages = []
    records = []
    shared = set()
    decoded = 0

    def page(name, raw):
        nonlocal decoded
        decoded += len(raw)
        if decoded > 256 * 1024**2:
            raise ValueError("Exceeded the private corpus byte limit")
        path = dest / name
        path.write_bytes(gzip.compress(raw, compresslevel=1, mtime=0))
        return {
            "file": name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": len(raw),
        }

    for start in range(0, len(wanted), 3):
        keys_sql = ",".join(
            f"('{j}'::uuid,{n}::bigint)" for j, n in wanted[start : start + 3]
        )
        query = f"""COPY (WITH keys(j,n) AS(VALUES {keys_sql}), samples AS MATERIALIZED (
          SELECT r.*,m.report_sha256 AS archive_sha,m.report_byte_size AS archive_bytes,
          j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL AND j.engine_job_id=j.id::text
          AND j.request_payload->>'remoteSolver'='true' AND p.status IN ('fulfilled','expired','cancelled')
          AND(j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
          AND EXISTS(SELECT FROM progressive_worker_reports stopped WHERE stopped.sim_job_id=j.id AND stopped.stopped_engine_job_id=j.id::text)
          AND NOT EXISTS(SELECT FROM progressive_worker_reports pending WHERE pending.sim_job_id=j.id AND pending.acknowledged_at IS NULL)
          AS closed, payload.byte_size AS shared_bytes
          FROM keys JOIN public.progressive_worker_reports r ON (r.sim_job_id,r.sequence)=(keys.j,keys.n)
          JOIN public.sim_jobs j ON j.id=r.sim_job_id LEFT JOIN public.sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
          LEFT JOIN public.progressive_report_result_payloads payload ON payload.content_hash=r.result_payload_hash
          LEFT JOIN public.progressive_report_archive_members m ON m.bundle_id=r.archive_bundle_id AND m.source_kind='worker'
           AND m.member_kind='report' AND m.sim_job_id=r.sim_job_id AND m.sequence=r.sequence AND m.content_signature=r.content_signature
          WHERE pg_column_size(r.report)<=3145728 AND (r.result_payload_hash IS NULL OR payload.byte_size<=16777216)),
        material AS MATERIALIZED(SELECT s.*,CASE WHEN s.archive_bundle_id IS NULL THEN public.resolve_progressive_report(s.report,s.result_payload_hash)::text END AS fulltext FROM samples s)
        SELECT sim_job_id,sequence,created_at,acknowledged_at,content_signature,assignment_signature,stopped_engine_job_id,report,result_payload_hash,
          archive_bundle_id,archived_at,closed,coalesce(archive_sha,encode(sha256(convert_to(fulltext,'UTF8')),'hex')),
          coalesce(archive_bytes,octet_length(fulltext)::bigint),encode(sha256(convert_to(report::text,'UTF8')),'hex')
        FROM material WHERE (fulltext IS NULL OR octet_length(fulltext)<=16777216) AND (archive_bundle_id IS NULL OR archive_sha IS NOT NULL)
        ORDER BY sim_job_id,sequence) TO STDOUT (FORMAT binary)"""
        raw = worker(query)
        for row in binary_rows(raw):
            if (
                len(row) != 15
                or row[7][:1] != b"\1"
                or hashlib.sha256(row[7][1:]).hexdigest() != row[14].decode()
            ):
                raise ValueError("Stored PostgreSQL JSONB digest mismatch")
            if row[8]:
                shared.add(row[8].decode())
            records.append(
                {
                    "job": str(uuid.UUID(bytes=row[0])),
                    "seq": int.from_bytes(row[1], "big", signed=True),
                    "sig": row[4].decode(),
                    "stored": row[14].decode(),
                    "original": row[12].decode(),
                    "originBytes": int.from_bytes(row[13], "big", signed=True),
                    "kind": "archived" if row[9] else "shared" if row[8] else "inline",
                }
            )
        pages.append(page(f"rows-{start:03d}.copy.gz", raw))
    payloads = []
    for i, key in enumerate(sorted(shared)):
        if not re.fullmatch("[0-9a-f]{64}", key):
            raise ValueError("Invalid shared hash")
        raw = worker(
            f"COPY (SELECT content_hash,result,byte_size FROM public.progressive_report_result_payloads WHERE content_hash='{key}' AND byte_size<=16777216) TO STDOUT (FORMAT binary)"
        )
        (row,) = list(binary_rows(raw))
        if (
            row[1][:1] != b"\1"
            or hashlib.sha256(row[1][1:]).hexdigest() != key
            or len(row[1]) - 1 != int.from_bytes(row[2], "big", signed=True)
        ):
            raise ValueError("Shared result byte or length mismatch")
        payloads.append(page(f"payload-{i:02d}.copy.gz", raw))
    # Only public catalog definitions, settings and revision; no case paths or credentials.
    catalog = json.loads(
        worker("""SELECT jsonb_build_object('at',clock_timestamp(),'version',current_setting('server_version_num'),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'def',pg_get_indexdef(c.oid),'predicate',pg_get_expr(i.indpred,i.indrelid)) ORDER BY c.oid)
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.progressive_worker_reports'::regclass),
      'blockSize',current_setting('block_size'),'maintenanceMemory',current_setting('maintenance_work_mem'));""")
    )
    manifest = {
        "version": 1,
        "capturedReadOnly": True,
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "requestedKeys": len(wanted),
        "records": records,
        "pages": pages,
        "payloads": payloads,
        "catalog": catalog,
        "binaryBytes": decoded,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        json.dumps(
            {
                "rows": len(records),
                "jobs": len({r["job"] for r in records}),
                "binaryBytes": decoded,
                "sharedResults": len(payloads),
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reference",
        type=Path,
        required=True,
        help="reviewed sample manifest with rows [{job,seq}, ...]",
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="new private directory"
    )
    args = parser.parse_args()
    os.umask(0o077)
    capture(args.reference, args.output)
