-- 0008_report_tokens.sql
--
-- Tokens for the read-only reporting endpoint that Vantage pulls from.
--
-- Only the SHA-256 hash is stored. A leaked database backup then yields
-- nothing usable, and there is no path by which the app can print an existing
-- token back out — it is shown once, at creation, or not at all.
--
-- Rotation IS the revocation mechanism: mint a new token, put it in Vantage,
-- revoke the old one. Revoked rows are kept rather than deleted so "when did
-- that token stop working, and had it been used since" stays answerable.
--
-- These three properties exist because Vantage's health-sync token got the
-- first two wrong and had to be fixed retroactively.

begin;

create table ledger.report_tokens (
  id           uuid primary key default gen_random_uuid(),
  -- SHA-256 of the token, hex. Never the token itself.
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label        text not null,
  created_at   timestamptz not null default now(),
  created_by   text not null,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   text
);

create index report_tokens_active on ledger.report_tokens (revoked_at) where revoked_at is null;

comment on table ledger.report_tokens is
  'Bearer tokens for the read-only report endpoint. Hash only. Rotation is '
  'how a token is revoked.';

-- A revoked token stays revoked. Un-revoking would quietly bring a token back
-- that may already have been pasted somewhere it should not have been.
create or replace function ledger.protect_report_token() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'revoke report tokens rather than deleting them; the history is the point'
      using errcode = 'restrict_violation';
  end if;

  if old.token_hash is distinct from new.token_hash then
    raise exception 'a token cannot be changed in place; mint a new one'
      using errcode = 'restrict_violation';
  end if;

  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'token % is revoked and cannot be reinstated', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

create trigger report_tokens_protected
  before update or delete on ledger.report_tokens
  for each row execute function ledger.protect_report_token();

alter table ledger.report_tokens enable row level security;
alter table ledger.report_tokens force row level security;

commit;
