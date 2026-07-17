#!/usr/bin/env bash
# Shared, role-gated Compose identity. Source this file after ENV_FILE,
# APP_DIR, and AIRFOILS_PRO_STATE_DIR have been established and preflighted.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "deployment-compose-profile.sh must be sourced" >&2
  exit 2
fi

read_deployment_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

configure_deployment_compose_profile() {
  local env_role env_project env_override requested_project requested_override
  env_role="$(read_deployment_env_value AIRFOILFOAM_DEPLOYMENT_ROLE || true)"
  env_project="$(read_deployment_env_value COMPOSE_PROJECT_NAME || true)"
  env_override="$(read_deployment_env_value COMPOSE_OVERRIDE_FILE || true)"
  requested_project="${COMPOSE_PROJECT_NAME:-}"
  requested_override="${COMPOSE_OVERRIDE_FILE:-}"

  DEPLOYMENT_ROLE="${env_role:-hub}"
  case "$DEPLOYMENT_ROLE" in
    hub)
      env_project="${env_project:-app}"
      if [[ "$env_project" != "app" || -n "$env_override" ]]; then
        echo "The hub deployment must use COMPOSE_PROJECT_NAME=app and no Compose override." >&2
        return 2
      fi
      ;;
    remote-solver)
      if [[ "$env_project" != "hz-solver2" ]]; then
        echo "The remote-solver deployment must use COMPOSE_PROJECT_NAME=hz-solver2." >&2
        return 2
      fi
      if [[ "$env_override" != "$AIRFOILS_PRO_STATE_DIR/docker-compose.remote-solver.yml" ]]; then
        echo "The remote-solver Compose override must be the external state file $AIRFOILS_PRO_STATE_DIR/docker-compose.remote-solver.yml." >&2
        return 2
      fi
      ;;
    *)
      echo "AIRFOILFOAM_DEPLOYMENT_ROLE must be hub or remote-solver." >&2
      return 2
      ;;
  esac

  if [[ -n "$requested_project" && "$requested_project" != "$env_project" ]]; then
    echo "Process COMPOSE_PROJECT_NAME conflicts with the authoritative deployment env." >&2
    return 2
  fi
  if [[ -n "$requested_override" && "$requested_override" != "$env_override" ]]; then
    echo "Process COMPOSE_OVERRIDE_FILE conflicts with the authoritative deployment env." >&2
    return 2
  fi

  COMPOSE_PROJECT_NAME="$env_project"
  COMPOSE_OVERRIDE_FILE="$env_override"
  COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
  COMPOSE_FILE_ARGS=(-f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_OVERRIDE_FILE" ]]; then
    COMPOSE_FILE_ARGS+=(-f "$COMPOSE_OVERRIDE_FILE")
  fi
}
