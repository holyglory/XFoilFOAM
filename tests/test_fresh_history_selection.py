import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from scripts.materials.freeze_fresh_history_selection import TEMPLATE, build_selection_sql


def cohort(path: Path, *profiles: str) -> None:
    path.write_text(json.dumps({
        "kind": "retained-polar-cohort-export-v1",
        "sources": [{"physical": {"airfoilId": profile,"geometry":[[1,0.01],[0,0],[1,-0.01]]}} for profile in profiles],
    }))


def test_builds_unique_exclusion_sql_and_protocol_hashes(tmp_path: Path) -> None:
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    cohort(first, "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002")
    cohort(second, "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003")
    query, protocol = build_selection_sql(TEMPLATE, [first, second], 26)
    assert protocol["profile_exclusion_count"]==3
    assert protocol["geometry_exclusion_count"]==1
    assert "ordinal<=26" in query
    assert query.count('"00000000-0000-0000-0000-000000000002"') == 1
    assert "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" in query
    assert protocol["read_only"] is True
    assert len(protocol["input_sha256"]) == 3
    assert len(protocol["query_sha256"]) == 64


def test_refuses_missing_template_or_unbounded_selection(tmp_path: Path) -> None:
    template = tmp_path / "template.sql"
    template.write_text("SELECT 1")
    source = tmp_path / "source.json"
    cohort(source, "00000000-0000-0000-0000-000000000001")
    with pytest.raises(ValueError, match="reviewed read-only"):
        build_selection_sql(template, [source], 26)
    with pytest.raises(ValueError, match="between"):
        build_selection_sql(tmp_path / "template.sql", [source], 65)


@pytest.mark.parametrize("bad",["uuid","geometry","nan","template"])
def test_rejects_untrusted_identity_geometry_and_sql(tmp_path,bad):
    source=tmp_path/"source.json"
    cohort(source,"00000000-0000-0000-0000-000000000001")
    payload=json.loads(source.read_text())
    if bad=="uuid": payload["sources"][0]["physical"]["airfoilId"]="x'); DELETE FROM sim_jobs; --"
    if bad=="geometry": payload["sources"][0]["physical"]["geometry"]=[[1,True],[0,0],[1,0]]
    if bad=="nan": payload["sources"][0]["physical"]["geometry"][0][0]=float("nan")
    source.write_text(json.dumps(payload))
    template=TEMPLATE
    if bad=="template":
        template=tmp_path/"bad.sql"
        template.write_text(TEMPLATE.read_text()+"DELETE FROM sim_jobs;")
    with pytest.raises(ValueError): build_selection_sql(template,[source],26)


def test_transfer_study_and_diagnosed_profiles_are_retained_as_explicit_exclusions(tmp_path):
    source=tmp_path/"transfer.json"
    source.write_text(json.dumps({"kind":"frozen-history-transfer-export-v1","sources":[{"source":{
        "physical":{"airfoilId":"00000000-0000-0000-0000-000000000008","geometry":[[1,0.01],[0,0],[1,-0.01]]}
    }}]}))
    diagnosis=tmp_path/"diagnosis.json"
    diagnosis.write_text(json.dumps({"kind":"production-polar-diagnosis-v1","baseline_to_composite_reversals":{
        "records":[{"slug":"sg6051"},{"slug":"quoted'profile"}]
    }}))
    query,protocol=build_selection_sql(TEMPLATE,[source],2,diagnosis)
    assert protocol["profile_exclusion_count"]==1
    assert protocol["diagnosed_slug_count"]==2
    assert "quoted''profile" in query
    assert str(diagnosis) in protocol["input_sha256"]
    assert "prior.geometry=target.physical->'geometry'" in query


@pytest.mark.skipif(not os.environ.get("DATABASE_URL"),reason="Requires governed PostgreSQL")
def test_real_selection_excludes_alias_geometry_and_requires_independent_source_preserving_evidence(tmp_path):
    schema="fresh_selection_"+uuid4().hex
    environment={**os.environ,"PGOPTIONS":f"-c search_path={schema}"}
    profile="00000000-0000-0000-0000-000000000100"
    history="00000000-0000-0000-0000-000000000201"
    reference="00000000-0000-0000-0000-000000000202"
    prior=tmp_path/"prior.json"
    cohort(prior,"00000000-0000-0000-0000-000000000999")

    def query(statement):
        return subprocess.run(["psql","-X","-qAt","-v","ON_ERROR_STOP=1"],input=statement,
                              env=environment,text=True,capture_output=True,check=True,timeout=35).stdout.strip()

    def selected(source=prior):
        statement,_=build_selection_sql(TEMPLATE,[source],26)
        return json.loads(query(statement))

    try:
        query(f"""
CREATE SCHEMA {schema};
CREATE TABLE airfoils(id uuid,slug text);
CREATE TABLE polar_analysis_targets(id text,airfoil_id uuid,physical jsonb);
CREATE TABLE progressive_polar_fit_work(state text,model_id text,prediction_id text);
CREATE TABLE progressive_polar_models(id text,prediction_id text,source_signature text,request jsonb,response jsonb);
CREATE TABLE neuralfoil_predictions(id text,target_id text,epoch_id uuid);
CREATE TABLE calculation_epochs(id uuid,current boolean);
CREATE TABLE progressive_polar_geometry_verifications(model_id text,policy_version int,source_geometry_compatible boolean);
CREATE TABLE progressive_polar_model_evidence(model_id text,result_attempt_id uuid,attempt_token uuid);
CREATE TABLE progressive_cfd_attempts(token uuid,sim_job_id uuid,unit_id uuid);
CREATE TABLE progressive_cfd_evidence(attempt_token uuid,result_attempt_id uuid,evidence_signature text);
CREATE TABLE result_attempts(id uuid,sim_job_id uuid,solver_implementation_id uuid,evidence_payload jsonb);
CREATE TABLE result_classifications(result_attempt_id uuid,state text,classifier_version text);
INSERT INTO airfoils VALUES('{profile}','unseen-profile');
INSERT INTO polar_analysis_targets VALUES('target','{profile}','{{"geometry":[[1,0.02],[0,0],[1,-0.02]],"derived":{{"mach":0.1,"reynolds":200000}}}}');
INSERT INTO progressive_polar_fit_work VALUES('ready','model','prediction');
INSERT INTO progressive_polar_models VALUES('model','prediction','source','{{"histories":[{{"coordinate_kind":"iteration","observation":{{"attempt_id":"{history}","method":"openfoam_fast","eligible":true}}}}]}}','{{"request_signature":"request","estimate":{{"signature":"estimate","contributors":[{{"attempt_id":"{history}","method":"openfoam_fast"}}]}}}}');
INSERT INTO neuralfoil_predictions VALUES('prediction','target','00000000-0000-0000-0000-000000000001');
INSERT INTO calculation_epochs VALUES('00000000-0000-0000-0000-000000000001',true);
INSERT INTO progressive_polar_geometry_verifications VALUES('model',1,true);
INSERT INTO progressive_polar_model_evidence VALUES('model','{history}','00000000-0000-0000-0000-000000000301'),('model','{reference}','00000000-0000-0000-0000-000000000302');
INSERT INTO progressive_cfd_attempts VALUES('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000401','00000000-0000-0000-0000-000000000501'),('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000402','00000000-0000-0000-0000-000000000502');
INSERT INTO progressive_cfd_evidence VALUES('00000000-0000-0000-0000-000000000301','{history}','history'),('00000000-0000-0000-0000-000000000302','{reference}','reference');
INSERT INTO result_attempts VALUES('{history}','00000000-0000-0000-0000-000000000401','2f8bc764-09ae-4ff3-8fd2-260600000002','{{"mesh_recovery_version":3}}'),('{reference}','00000000-0000-0000-0000-000000000402','2f8bc764-09ae-4ff3-8fd2-260600000002','{{"mesh_recovery_version":3}}');
INSERT INTO result_classifications VALUES('{reference}','accepted','fixture-classification');
""")
        initial=selected()
        assert len(initial["selected"])==1
        assert initial["selected"][0]["cohort"]=="iteration"
        assert initial["selected"][0]["eligiblePairs"][0]["referenceAttemptId"]==reference
        for mutation,restore in [
            ("UPDATE progressive_polar_fit_work SET state='pending'","UPDATE progressive_polar_fit_work SET state='ready'"),
            ("UPDATE progressive_polar_geometry_verifications SET source_geometry_compatible=false","UPDATE progressive_polar_geometry_verifications SET source_geometry_compatible=true"),
            (f"UPDATE result_attempts SET evidence_payload='{{\"mesh_recovery_version\":2}}' WHERE id='{reference}'",f"UPDATE result_attempts SET evidence_payload='{{\"mesh_recovery_version\":3}}' WHERE id='{reference}'"),
            ("UPDATE result_classifications SET state='rejected'","UPDATE result_classifications SET state='accepted'"),
            ("UPDATE progressive_cfd_attempts SET unit_id='00000000-0000-0000-0000-000000000501'","UPDATE progressive_cfd_attempts SET unit_id='00000000-0000-0000-0000-000000000502' WHERE token='00000000-0000-0000-0000-000000000302'"),
        ]:
            query(mutation)
            assert selected()["selected"]==[]
            query(restore)
        alias=tmp_path/"alias.json"
        cohort(alias,"00000000-0000-0000-0000-000000000888")
        payload=json.loads(alias.read_text())
        payload["sources"][0]["physical"]["geometry"]=[[1,0.02],[0,0],[1,-0.02]]
        alias.write_text(json.dumps(payload))
        assert selected(alias)["selected"]==[]
        with pytest.raises(subprocess.CalledProcessError):
            query("BEGIN READ ONLY; DELETE FROM result_attempts; COMMIT;")
        assert query("SELECT count(*) FROM result_attempts")=="2"
    finally:
        query(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
