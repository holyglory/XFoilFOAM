-- Hub-owned scheduling intent. The worker's heartbeat cannot set or rearm it.
CREATE TABLE public.registered_short_work_windows (
  id uuid PRIMARY KEY,
  solver_id uuid NOT NULL REFERENCES public.registered_remote_solvers(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES public.progressive_work(id) ON DELETE CASCADE,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- Historical issued identity survives ordinary job retention and cannot rearm the preference.
  issued_job_id uuid,
  issued_at timestamptz,
  CONSTRAINT registered_short_work_windows_deadline_check CHECK (expires_at > opened_at AND expires_at <= opened_at + interval '1 hour'),
  CONSTRAINT registered_short_work_windows_issued_check CHECK ((issued_job_id IS NULL) = (issued_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX registered_short_work_windows_open_solver_uq
  ON public.registered_short_work_windows (solver_id) WHERE ended_at IS NULL;
