CREATE TABLE progressive_cfd_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES progressive_work(id) ON DELETE CASCADE,
  aoa_deg double precision NOT NULL CHECK (aoa_deg BETWEEN -180 AND 180),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  purpose text NOT NULL CHECK (purpose IN ('initial', 'adaptive', 'precise')),
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
  reason text NOT NULL,
  policy_version text NOT NULL,
  active_budget_seconds double precision NOT NULL CHECK (active_budget_seconds > 0 AND active_budget_seconds <= 43200),
  active_seconds double precision NOT NULL DEFAULT 0 CHECK (active_seconds >= 0 AND active_seconds < 'Infinity'::double precision),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'blocked', 'complete', 'gap', 'cancelled')),
  lease_token uuid,
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error text,
  UNIQUE (work_id, aoa_deg),
  UNIQUE (work_id, ordinal),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX progressive_cfd_units_pending_idx ON progressive_cfd_units (work_id, ordinal) WHERE state = 'pending';
CREATE TABLE progressive_cfd_attempts (
  token uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES progressive_cfd_units(id) ON DELETE CASCADE,
  owner text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'complete', 'failed', 'expired', 'cancelled')),
  active_seconds double precision NOT NULL DEFAULT 0 CHECK (active_seconds >= 0 AND active_seconds < 'Infinity'::double precision),
  finished_at timestamptz,
  error text
);
CREATE UNIQUE INDEX progressive_cfd_attempts_running_uq ON progressive_cfd_attempts (unit_id) WHERE outcome = 'running';
CREATE TRIGGER progressive_cfd_units_changed AFTER INSERT OR UPDATE ON progressive_cfd_units
FOR EACH STATEMENT EXECUTE FUNCTION notify_progressive_work_changed();
CREATE FUNCTION preserve_progressive_cfd_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.aoa_deg, NEW.ordinal, NEW.purpose, NEW.recipe, NEW.reason, NEW.policy_version, NEW.active_budget_seconds)
    IS DISTINCT FROM (OLD.work_id, OLD.aoa_deg, OLD.ordinal, OLD.purpose, OLD.recipe, OLD.reason, OLD.policy_version, OLD.active_budget_seconds)
    THEN RAISE EXCEPTION 'CFD unit scope and numerical recipe are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER progressive_cfd_scope_immutable BEFORE UPDATE ON progressive_cfd_units
FOR EACH ROW EXECUTE FUNCTION preserve_progressive_cfd_scope();
