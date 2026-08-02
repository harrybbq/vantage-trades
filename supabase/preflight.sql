-- preflight.sql
--
-- Run this FIRST, in the SQL editor of whatever database you are about to put
-- the ledger in — especially if that database already holds something else,
-- like Vantage.
--
-- It creates nothing and changes nothing. It answers one question: would
-- applying migrations 0001-0008 here collide with anything already present?
--
-- Every row it returns is either OK or a reason to stop.

with checks as (

  -- The migrations use gen_random_uuid() unqualified. It lives in pg_catalog
  -- on Postgres 13+, so it cannot be shadowed by a user schema — but if this
  -- database is older, the default on every primary key would fail.
  select
    1 as ord,
    'postgres version' as item,
    current_setting('server_version') as found,
    case when current_setting('server_version_num')::int >= 130000
         then 'OK' else 'STOP - needs 13 or newer for gen_random_uuid()' end as verdict

  union all
  select 2, 'gen_random_uuid() resolves',
    coalesce((select n.nspname from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where p.proname = 'gen_random_uuid' limit 1), 'not found'),
    case when exists (select 1 from pg_proc where proname = 'gen_random_uuid')
         then 'OK' else 'STOP - enable pgcrypto' end

  -- The three schemas the ledger creates. If any already exists, something
  -- else owns that name and the migrations must not run here.
  union all
  select 3, 'schema "ledger" is free',
    coalesce((select 'already exists' from information_schema.schemata
               where schema_name = 'ledger'), 'free'),
    case when exists (select 1 from information_schema.schemata where schema_name = 'ledger')
         then 'STOP - a schema called ledger already exists' else 'OK' end

  union all
  select 4, 'schema "paper" is free',
    coalesce((select 'already exists' from information_schema.schemata
               where schema_name = 'paper'), 'free'),
    case when exists (select 1 from information_schema.schemata where schema_name = 'paper')
         then 'STOP - a schema called paper already exists' else 'OK' end

  union all
  select 5, 'schema "research" is free',
    coalesce((select 'already exists' from information_schema.schemata
               where schema_name = 'research'), 'free'),
    case when exists (select 1 from information_schema.schemata where schema_name = 'research')
         then 'STOP - a schema called research already exists' else 'OK' end

  -- The ledger creates its enum types inside its own schema, so a type of the
  -- same name in public is harmless. Reported anyway, because seeing it is
  -- better than wondering.
  union all
  select 6, 'no type-name surprises in public',
    coalesce((select string_agg(t.typname, ', ') from pg_type t
                join pg_namespace n on n.oid = t.typnamespace
               where n.nspname = 'public'
                 and t.typname in ('agent_status','account_kind','entry_kind',
                                   'order_side','order_status')), 'none'),
    'OK - the ledger''s types are created inside its own schema'

  -- What is already here. Not a pass/fail: it is so you can see, before you
  -- run anything, exactly whose data shares this database.
  union all
  select 7, 'tables already in public',
    (select count(*)::text from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'),
    'FYI - these belong to the other app and the migrations never touch them'

)
select item, found, verdict from checks order by ord;
