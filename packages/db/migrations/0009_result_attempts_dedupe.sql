CREATE UNIQUE INDEX "result_attempts_job_aoa_regime_uq" ON "result_attempts" USING btree ("sim_job_id","engine_job_id","aoa_deg","regime");
