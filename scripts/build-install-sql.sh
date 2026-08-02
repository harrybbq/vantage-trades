#!/usr/bin/env bash
# Concatenate the migrations into one paste-once installer.
#
# Generated rather than hand-maintained, so it cannot drift from the
# migrations it is built from. Re-run after adding a migration:
#
#   ./scripts/build-install-sql.sh
#
# The output wraps everything in a SINGLE transaction. Postgres does DDL
# transactionally, so a failure anywhere rolls the whole thing back and leaves
# the database exactly as it was — which is what you want when pasting into a
# database that also holds another app.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=supabase/install.sql

{
  cat <<'HEADER'
-- install.sql — GENERATED, do not edit by hand.
--
-- Built from supabase/migrations/ by scripts/build-install-sql.sh.
-- Every migration, in order, inside one transaction.
--
-- Paste this into the SQL editor of the database that will hold the ledger.
-- Run supabase/preflight.sql first if that database holds anything else.
--
-- All or nothing: Postgres applies DDL transactionally, so if any statement
-- fails the whole thing rolls back and the database is untouched. There is no
-- half-applied state to clean up.
--
-- Everything lives in three schemas of its own — ledger, paper, research. No
-- extensions, no roles, no grants, no search_path changes, and nothing in
-- public is read or written.

begin;
HEADER

  for migration in supabase/migrations/*.sql; do
    printf '\n\n-- ===================================================================\n'
    printf -- '-- %s\n' "$(basename "$migration")"
    printf -- '-- ===================================================================\n\n'
    # Strip each file's own transaction control; the whole set shares one.
    sed -E '/^[[:space:]]*(begin|commit)[[:space:]]*;[[:space:]]*$/d' "$migration"
  done

  cat <<'FOOTER'


-- ---------------------------------------------------------------------------
-- Proof it worked. If this returns anything other than the expected counts,
-- the transaction below will not have committed.
-- ---------------------------------------------------------------------------

do $install_check$
declare
  v_tables int;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema in ('ledger', 'paper', 'research') and table_type = 'BASE TABLE';

  if v_tables < 18 then
    raise exception 'expected at least 18 ledger tables, found %', v_tables;
  end if;

  raise notice 'installed: % tables across ledger, paper and research', v_tables;
end $install_check$;

commit;

-- Confirm afterwards with:
--   select table_schema, count(*) from information_schema.tables
--    where table_schema in ('ledger','paper','research') and table_type='BASE TABLE'
--    group by 1 order by 1;
FOOTER
} > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines from $(ls supabase/migrations/*.sql | wc -l) migrations)"
