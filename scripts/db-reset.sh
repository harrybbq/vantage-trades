#!/usr/bin/env bash
# Drop and rebuild the local ledger database from migrations.
#
# Local development only. It destroys the database it points at, so it refuses
# to run against anything that does not look local.
set -euo pipefail

DB_NAME="${DB_NAME:-vantage_trades}"
DB_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/${DB_NAME}}"

case "$DB_URL" in
  *localhost*|*127.0.0.1*) ;;
  *)
    echo "refusing to reset a non-local database: ${DB_URL%%\?*}" >&2
    exit 1
    ;;
esac

ADMIN_URL="${DB_URL%/*}/postgres"

psql "$ADMIN_URL" -q -c "drop database if exists ${DB_NAME} with (force)"
psql "$ADMIN_URL" -q -c "create database ${DB_NAME}"

for migration in "$(dirname "$0")"/../supabase/migrations/*.sql; do
  echo "applying $(basename "$migration")"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$migration"
done

echo "ledger database ready: ${DB_NAME}"
