"""Fences on exact native job rows and their concrete evidence references."""
from __future__ import annotations

from contextlib import contextmanager
import json
import subprocess
import uuid


def _values(ids):
    return ",".join("('%s'::uuid)" % uuid.UUID(j) for j in ids)


class Database:
    def __init__(self, command):
        self.process=subprocess.Popen([*command,"-XqAt","-v","ON_ERROR_STOP=1"],stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE,text=True,bufsize=1)

    def query(self, sql):
        end="CORE_QUERY_"+uuid.uuid4().hex
        self.process.stdin.write(sql.rstrip(";\n")+";\n\\echo "+end+"\n")
        self.process.stdin.flush()
        rows=[]
        for line in self.process.stdout:
            if line.rstrip("\n")==end:return rows
            if line.strip():rows.append(json.loads(line))
        raise RuntimeError("closed-job database fence was lost")

    def close(self):
        try:self.process.stdin.close()
        except BrokenPipeError:pass
        self.process.wait(timeout=8)

    @contextmanager
    def fence(self, ids):
        self.query("BEGIN")
        try:
            self.query("SET LOCAL statement_timeout='75s'; SET LOCAL jit=off; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL lock_timeout='300ms'; SET LOCAL idle_in_transaction_session_timeout='120s'")
            vals=_values(ids)
            sql=f"""WITH wanted(native) AS(VALUES {vals}), owners AS MATERIALIZED(
              SELECT w.native,j.id FROM wanted w JOIN public.sim_jobs j ON j.engine_job_id=w.native::text OR j.id=w.native
            ), locked AS MATERIALIZED(
              SELECT j.id,j.engine_job_id,j.status,j."ingestedAt",j.ingest_lease_token,j.ingest_lease_expires_at,
                 j.request_payload->>'syncPromiseId' promise
              FROM public.sim_jobs j WHERE j.id IN(SELECT id FROM owners) FOR UPDATE SKIP LOCKED
            ), promises AS MATERIALIZED(
              SELECT p.id,p.status FROM public.sync_sweep_promises p WHERE p.id IN (
                 SELECT CASE WHEN promise ~* '^[a-f0-9]{{8}}(-[a-f0-9]{{4}}){{3}}-[a-f0-9]{{12}}$' THEN promise::uuid END FROM locked
                 UNION SELECT d.promise_id FROM public.progressive_remote_dispatches d JOIN locked l ON l.id=d.sim_job_id
              ) FOR SHARE SKIP LOCKED
            )
            SELECT jsonb_build_object('native',w.native,'id',l.id,'engine',l.engine_job_id,'status',l.status,'ingested',l."ingestedAt" IS NOT NULL,
             'activeLease',l.ingest_lease_token IS NOT NULL AND l.ingest_lease_expires_at>clock_timestamp(),
             'owners',(SELECT count(*) FROM owners o WHERE o.native=w.native),
             'promiseClosed',l.promise IS NULL OR EXISTS(SELECT FROM promises p WHERE p.id::text=l.promise AND p.status IN('expired','cancelled','fulfilled')),
             'dispatchesClosed',NOT EXISTS(SELECT FROM public.progressive_remote_dispatches d WHERE d.sim_job_id=l.id
                AND NOT EXISTS(SELECT FROM promises p WHERE p.id=d.promise_id AND p.status IN('expired','cancelled','fulfilled'))),
             'forensic',EXISTS(SELECT FROM public.solver_evidence_orphan_quarantines q WHERE q.sim_job_id=l.id OR q.engine_job_id=w.native::text)
                  OR EXISTS(SELECT FROM public.solver_evidence_incomplete_quarantines q WHERE q.sim_job_id=l.id OR q.engine_job_id=w.native::text))
            FROM wanted w LEFT JOIN owners o ON o.native=w.native LEFT JOIN locked l ON l.id=o.id"""
            rows={v["native"]:v for v in self.query(sql)}
            result={}
            for j in ids:
                row=rows[j]
                closed=(row["owners"]==1 and row["id"] and row["engine"]==j and row["status"] in ("done","failed","cancelled")
                        and row["ingested"] and not row["activeLease"] and row["promiseClosed"] and row["dispatchesClosed"] and not row["forensic"])
                result[j]={"owner":row,"closed":bool(closed),"refs":[]}
            ok={j:v["owner"]["id"] for j,v in result.items() if v["closed"]}
            if ok:
                refs=self.references(ok)
                for v in refs:result[v["native"]]["refs"].append((v["case"],v["ref"]))
            yield result
        finally:
            # This operator only locks and reads; it never writes solver records.
            if self.process.poll() is None:
                try:self.query("ROLLBACK")
                except (BrokenPipeError,RuntimeError):
                    if self.process.poll() is None:raise

    def references(self, mapping):
        vals=",".join("('%s'::uuid,'%s'::uuid)"%(uuid.UUID(j),uuid.UUID(db)) for j,db in mapping.items())
        # Case-scoped catalogs are authoritative even if raw data was already
        # moved. Only potentially relevant path declarations leave the database.
        return self.query(f"""WITH k(native,id) AS(VALUES {vals}), matched AS MATERIALIZED(
           SELECT a.id,a.sim_job_id,a.engine_job_id,a.engine_case_slug,a.storage_key,a.engine_url,a.metadata
           FROM public.solver_evidence_artifacts a WHERE a.sim_job_id IN (SELECT id FROM k)
             OR a.engine_job_id IN (SELECT native::text FROM k)
        ), artifacts AS MATERIALIZED(
           SELECT k.native,a.id,a.engine_case_slug AS slug,a.storage_key,a.engine_url,a.metadata
           FROM matched a JOIN k ON a.sim_job_id=k.id OR a.engine_job_id=k.native::text
        ), attempts AS MATERIALIZED(
           SELECT k.native,a.id,a.result_id FROM k JOIN public.result_attempts a ON a.sim_job_id=k.id OR a.engine_job_id=k.native::text
        ), refs AS (
           SELECT a.native,a.slug,t.ref FROM artifacts a CROSS JOIN LATERAL(VALUES
             (to_jsonb(a.storage_key)),(to_jsonb(a.engine_url)),(a.metadata)) t(ref)
           UNION ALL SELECT a.native,a.slug,to_jsonb(m.member_path) FROM artifacts a JOIN public.solver_evidence_artifact_members m ON m.artifact_id=a.id
           UNION ALL SELECT t.native,NULL,to_jsonb(m.storage_key) FROM attempts t JOIN public.result_media m ON m.result_attempt_id=t.id
           UNION ALL SELECT t.native,NULL,to_jsonb(m.storage_key) FROM k t JOIN public.results r ON r.sim_job_id=t.id
              JOIN public.result_media m ON m.result_id=r.id AND m.result_attempt_id IS NULL
           UNION ALL SELECT k.native,NULL,i.metadata FROM k JOIN public.sim_solver_incidents i ON i.sim_job_id=k.id
           UNION ALL SELECT t.native,r.engine_case_slug,r.evidence_payload FROM attempts t
             JOIN public.result_attempts r ON r.id=t.id
           UNION ALL SELECT t.native,NULL,to_jsonb(rr.local_storage_key) FROM attempts t
             JOIN public.remote_asset_references rr ON rr.result_attempt_id=t.id
           UNION ALL SELECT a.native,a.slug,to_jsonb(r.local_storage_key) FROM artifacts a
             JOIN public.remote_asset_references r ON r.local_kind='evidence_artifact' AND r.local_row_id=a.id
        ) SELECT jsonb_build_object('native',native,'case',slug,'ref',ref) FROM refs WHERE ref::text ~ '(^|[/\" ])core([.][0-9]+)?([\"?# /]|$)'""")

    def science(self, native, owner):
        j=str(uuid.UUID(native)); db=str(uuid.UUID(owner))
        return self.query(f"""WITH ats AS MATERIALIZED(SELECT id,result_id,status,regime,aoa_deg,cl,cd,cm,converged FROM result_attempts
         WHERE sim_job_id='{db}'::uuid OR engine_job_id='{j}'), points AS MATERIALIZED(
         SELECT id,current_result_attempt_id,aoa_deg,cl,cd,cm,status FROM results WHERE sim_job_id='{db}'::uuid OR id IN(SELECT result_id FROM ats)),
         signed AS (SELECT e.result_attempt_id,e.evidence_signature FROM progressive_cfd_evidence e JOIN ats ON ats.id=e.result_attempt_id)
         SELECT jsonb_build_object('attempts',(SELECT count(*) FROM ats),'results',(SELECT count(*) FROM points),
         'signed',(SELECT count(*) FROM signed),'digest',encode(sha256(convert_to(jsonb_build_array(
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM ats t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM points t),
         (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.result_attempt_id,t.evidence_signature) FROM signed t))::text,'UTF8')),'hex'))""")[0]
