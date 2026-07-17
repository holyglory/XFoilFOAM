#!/usr/bin/env bash
# Prove that migration 0072 was applied by the staged Node image before the
# OpenCFD 2606 execution pool can be enabled.  The incident wrapper supplies
# the independently reviewed migration hash; this hook never derives trust
# from the same staged file it is checking.
set -Eeuo pipefail

DEPLOY_SCRIPT_DIR="${DEPLOY_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ENV_FILE="${ENV_FILE:?ENV_FILE is required}"
COMPOSE_FILE="${COMPOSE_FILE:?COMPOSE_FILE is required}"
COMPOSE_PROJECT_DIRECTORY="${COMPOSE_PROJECT_DIRECTORY:?COMPOSE_PROJECT_DIRECTORY is required}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
EXPECTED_OPENCFD2606_MIGRATION_SHA256="${EXPECTED_OPENCFD2606_MIGRATION_SHA256:?EXPECTED_OPENCFD2606_MIGRATION_SHA256 is required}"
OPENCFD2606_MIGRATION_FILE="${OPENCFD2606_MIGRATION_FILE:-$DEPLOY_SCRIPT_DIR/../../packages/db/migrations/0072_canary_evidence_database_ack.sql}"

if [[ ! "$EXPECTED_OPENCFD2606_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Expected migration 0072 SHA-256 must be an exact lowercase digest." >&2
  exit 14
fi
if [[ ! -f "$OPENCFD2606_MIGRATION_FILE" || -L "$OPENCFD2606_MIGRATION_FILE" ]]; then
  echo "Migration 0072 is missing or unsafe: $OPENCFD2606_MIGRATION_FILE" >&2
  exit 14
fi
actual_migration_sha256="$(sha256sum "$OPENCFD2606_MIGRATION_FILE" | awk '{print $1}')"
if [[ "$actual_migration_sha256" != "$EXPECTED_OPENCFD2606_MIGRATION_SHA256" ]]; then
  echo "Migration 0072 bytes differ from the independently reviewed digest." >&2
  exit 14
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" -f "$COMPOSE_FILE" "$@"
}

verification_json="$(
  compose exec -T postgres sh -ec \
    'psql -X -A -t -v ON_ERROR_STOP=1 -v expected_hash="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    sh "$EXPECTED_OPENCFD2606_MIGRATION_SHA256" <<'SQL'
SELECT json_build_object(
  'registration_table', to_regclass('public.solver_engine_canary_evidence_registrations') IS NOT NULL,
  'cleanup_table', to_regclass('public.solver_engine_canary_evidence_cleanup_proofs') IS NOT NULL,
  'registration_trigger', EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'solver_engine_canary_evidence_registrations_immutable'
      AND NOT tgisinternal
  ),
  'cleanup_trigger', EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'solver_engine_canary_evidence_cleanup_proofs_immutable'
      AND NOT tgisinternal
  ),
  'attestation_registration_column', EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'solver_engine_canary_attestations'
      AND column_name = 'evidence_registration_id'
      AND is_nullable = 'NO'
  ),
  'attestation_registration_unique', to_regclass('public.solver_engine_canary_attestations_evidence_registration_idx') IS NOT NULL,
  'migration_ledger', EXISTS (
    SELECT 1
    FROM drizzle.__drizzle_migrations
    WHERE hash = :'expected_hash'
      AND created_at = 1787097600000
  ),
  'registration_count', (SELECT count(*) FROM solver_engine_canary_evidence_registrations),
  'cleanup_proof_count', (SELECT count(*) FROM solver_engine_canary_evidence_cleanup_proofs),
  'attestation_count', (SELECT count(*) FROM solver_engine_canary_attestations)
);
SQL
)"

printf '%s' "$verification_json" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
required = (
    "registration_table",
    "cleanup_table",
    "registration_trigger",
    "cleanup_trigger",
    "attestation_registration_column",
    "attestation_registration_unique",
    "migration_ledger",
)
failed = [name for name in required if payload.get(name) is not True]
if failed:
    raise SystemExit(f"migration 0072 database proof failed: {failed}")
for name in ("registration_count", "cleanup_proof_count", "attestation_count"):
    value = payload.get(name)
    if type(value) is not int or value < 0:
        raise SystemExit(f"migration 0072 returned an invalid {name}")
'
