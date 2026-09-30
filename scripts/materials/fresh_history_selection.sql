BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
WITH prior_profiles(airfoil_id) AS (
  SELECT value::uuid FROM jsonb_array_elements_text('__PROFILE_IDS__'::jsonb)
), prior_geometries(geometry) AS (
  SELECT value FROM jsonb_array_elements('__GEOMETRIES__'::jsonb)
), diagnosed_slugs(slug) AS (
  SELECT value FROM jsonb_array_elements_text('__DIAGNOSED_SLUGS__'::jsonb)
), diagnosed AS MATERIALIZED (
  SELECT DISTINCT target.airfoil_id,target.physical->'geometry' AS geometry
  FROM polar_analysis_targets target JOIN airfoils airfoil ON airfoil.id=target.airfoil_id
  JOIN diagnosed_slugs prior ON prior.slug=airfoil.slug
), current_models AS MATERIALIZED (
  SELECT model.id,model.prediction_id,model.source_signature,model.request,model.response,target.id AS target_id,
    target.airfoil_id,target.physical,prediction.epoch_id
  FROM progressive_polar_fit_work fit JOIN progressive_polar_models model ON model.id=fit.model_id AND model.prediction_id=fit.prediction_id
  JOIN neuralfoil_predictions prediction ON prediction.id=model.prediction_id
  JOIN calculation_epochs epoch ON epoch.id=prediction.epoch_id AND epoch.current
  JOIN polar_analysis_targets target ON target.id=prediction.target_id
  JOIN progressive_polar_geometry_verifications verification ON verification.model_id=model.id
    AND verification.policy_version=1 AND verification.source_geometry_compatible
  WHERE fit.state='ready'
    AND NOT EXISTS(SELECT 1 FROM prior_profiles prior WHERE prior.airfoil_id=target.airfoil_id)
    AND NOT EXISTS(SELECT 1 FROM prior_geometries prior WHERE prior.geometry=target.physical->'geometry')
    AND NOT EXISTS(SELECT 1 FROM diagnosed prior WHERE prior.airfoil_id=target.airfoil_id OR prior.geometry=target.physical->'geometry')
), histories AS MATERIALIZED (
  SELECT model.id AS model_id,history->>'coordinate_kind' AS cohort,
    raw.id AS history_attempt_id,raw.sim_job_id AS history_job_id,claim.unit_id AS history_lineage_id
  FROM current_models model CROSS JOIN LATERAL jsonb_array_elements(coalesce(model.request->'histories','[]')) history
  JOIN progressive_polar_model_evidence link ON link.model_id=model.id AND link.result_attempt_id=(history#>>'{observation,attempt_id}')::uuid
  JOIN progressive_cfd_attempts claim ON claim.token=link.attempt_token
  JOIN progressive_cfd_evidence receipt ON receipt.attempt_token=claim.token AND receipt.result_attempt_id=link.result_attempt_id
  JOIN result_attempts raw ON raw.id=link.result_attempt_id AND raw.sim_job_id=claim.sim_job_id
  WHERE history#>>'{observation,eligible}'='true' AND history#>>'{observation,method}'='openfoam_fast'
    AND history->>'coordinate_kind' IN ('iteration','physical_time')
    AND raw.solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000002'
    AND raw.evidence_payload->>'mesh_recovery_version'='3'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(model.response#>'{estimate,contributors}') contributor
      WHERE contributor->>'attempt_id'=raw.id::text AND contributor->>'method'='openfoam_fast')
), eligible AS MATERIALIZED (
  SELECT history.*,reference.id AS reference_attempt_id,reference.sim_job_id AS reference_job_id,
    reference_claim.unit_id AS reference_lineage_id,classification.classifier_version
  FROM histories history
  JOIN progressive_polar_model_evidence link ON link.model_id=history.model_id
  JOIN progressive_cfd_attempts reference_claim ON reference_claim.token=link.attempt_token
  JOIN progressive_cfd_evidence receipt ON receipt.attempt_token=reference_claim.token AND receipt.result_attempt_id=link.result_attempt_id
  JOIN result_attempts reference ON reference.id=link.result_attempt_id AND reference.sim_job_id=reference_claim.sim_job_id
  JOIN result_classifications classification ON classification.result_attempt_id=reference.id AND classification.state='accepted'
  WHERE reference.sim_job_id<>history.history_job_id AND reference_claim.unit_id<>history.history_lineage_id
    AND reference.solver_implementation_id='2f8bc764-09ae-4ff3-8fd2-260600000002'
    AND reference.evidence_payload->>'mesh_recovery_version'='3'
), candidates AS MATERIALIZED (
  SELECT DISTINCT model.id AS model_id,model.target_id,model.prediction_id,model.epoch_id,model.source_signature,
    model.airfoil_id,model.physical->'geometry' AS geometry,model.response->>'request_signature' AS request_signature,
    model.response#>>'{estimate,signature}' AS estimate_signature,eligible.cohort,
    (model.physical#>>'{derived,mach}')::float8 AS mach,(model.physical#>>'{derived,reynolds}')::float8 AS reynolds
  FROM eligible JOIN current_models model ON model.id=eligible.model_id
), profiles AS (
  SELECT *,row_number() OVER(PARTITION BY airfoil_id ORDER BY cohort,model_id COLLATE "C") AS profile_rank FROM candidates
), geometries AS (
  SELECT DISTINCT ON(geometry) * FROM profiles WHERE profile_rank=1 ORDER BY geometry,cohort,airfoil_id,model_id COLLATE "C"
), numbered AS (
  SELECT *,row_number() OVER(PARTITION BY cohort ORDER BY md5('fresh-lineage-covariance-v1:'||airfoil_id::text),airfoil_id,model_id COLLATE "C") AS ordinal FROM geometries
)
SELECT jsonb_build_object('kind','fresh-history-selection-v2','observedAt',clock_timestamp(),'readOnly',true,
  'solverImplementationId','2f8bc764-09ae-4ff3-8fd2-260600000002','perCohort',__PER_COHORT__,
  'priorProfileCount',(SELECT count(*) FROM prior_profiles),'priorGeometryCount',(SELECT count(*) FROM prior_geometries),
  'diagnosedProfileCount',(SELECT count(DISTINCT airfoil_id) FROM diagnosed),
  'eligibleModels',(SELECT count(DISTINCT model_id) FROM candidates),'eligibleProfiles',(SELECT count(DISTINCT airfoil_id) FROM candidates),
  'selected',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'modelId',model_id,'targetId',target_id,'predictionId',prediction_id,'epochId',epoch_id,'airfoilId',airfoil_id,
    'geometry',geometry,'sourceSignature',source_signature,'requestSignature',request_signature,'estimateSignature',estimate_signature,
    'cohort',cohort,'ordinal',ordinal,'mach',mach,'reynolds',reynolds,
    'eligiblePairs',(SELECT jsonb_agg(jsonb_build_object('historyAttemptId',pair.history_attempt_id,'historyJobId',pair.history_job_id,
      'historyLineageId',pair.history_lineage_id,'referenceAttemptId',pair.reference_attempt_id,'referenceJobId',pair.reference_job_id,
      'referenceLineageId',pair.reference_lineage_id,'classifierVersion',pair.classifier_version)
      ORDER BY pair.history_attempt_id,pair.reference_attempt_id) FROM eligible pair WHERE pair.model_id=numbered.model_id AND pair.cohort=numbered.cohort)
  ) ORDER BY cohort,ordinal) FROM numbered WHERE ordinal<=__PER_COHORT__),'[]'::jsonb));
COMMIT;
