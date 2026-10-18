#!/usr/bin/env bash
set -euo pipefail

# The statements carry the role passwords, so psql prints nothing on success.
# Errors still go to stderr, and ON_ERROR_STOP still stops the script.
psql_args=(
  --set=ON_ERROR_STOP=1
  --quiet
  --output=/dev/null
  --username "${POSTGRES_USER:-postgres}"
  --dbname "${POSTGRES_DB:-lobbystack}"
)

if [[ -n "${PGHOST:-}" ]]; then
  psql_args+=(--host "$PGHOST")
fi
if [[ -n "${PGPORT:-}" ]]; then
  psql_args+=(--port "$PGPORT")
fi

ensure_role() {
  local role_name="$1"
  local role_password="$2"

  # Each \gexec sends the SELECT above it and runs the statement it returns.
  # Ending the SELECT with ";" would also run it as a plain query that outputs
  # the statement.
  psql "${psql_args[@]}" \
    --set="role_name=$role_name" \
    --set="role_password=$role_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOBYPASSRLS', :'role_name', :'role_password')
\gexec
SQL
}

ensure_role lobbystack_migrator "${LOBBYSTACK_MIGRATOR_PASSWORD:-migrator}"
ensure_role lobbystack_auth "${LOBBYSTACK_AUTH_PASSWORD:-auth}"
ensure_role lobbystack_app "${LOBBYSTACK_APP_PASSWORD:-app}"
ensure_role lobbystack_worker "${LOBBYSTACK_WORKER_PASSWORD:-worker}"
ensure_role lobbystack_dispatcher "${LOBBYSTACK_DISPATCHER_PASSWORD:-dispatcher}"
ensure_role lobbystack_readonly "${LOBBYSTACK_READONLY_PASSWORD:-readonly}"
