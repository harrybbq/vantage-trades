-- 0004_equity_snapshots.sql
--
-- A daily equity point per agent, plus one for the fund as a whole.
--
-- Two things need this. "P/L today" is meaningless without a prior close to
-- measure from. And the equity curve has to be tracked against a
-- buy-and-hold benchmark from the first day an agent runs — retrofitting an
-- honest benchmark later never happens, because by then the flattering
-- comparison is the one already on screen.
--
-- The benchmark column is here from the start for exactly that reason, even
-- though nothing populates it yet.

begin;

create table ledger.equity_snapshots (
  -- Null agent_id is the whole fund: agent equities plus the unallocated pool.
  agent_id        text references ledger.agents (id) on delete cascade,
  as_of           date not null,

  equity_minor    bigint not null,
  cash_minor      bigint not null,
  positions_minor bigint not null,

  -- Price of the benchmark instrument (VWRP/SPY) on the same date, in minor
  -- units. Stored rather than computed so the comparison cannot be quietly
  -- re-based later.
  benchmark_symbol text,
  benchmark_minor  bigint check (benchmark_minor is null or benchmark_minor > 0),

  created_at      timestamptz not null default now()
);

-- One row per agent per day, and one fund row per day. A partial unique index
-- each, because null agent_id does not collide in a plain unique constraint.
create unique index equity_snapshots_agent_day
  on ledger.equity_snapshots (agent_id, as_of)
  where agent_id is not null;

create unique index equity_snapshots_fund_day
  on ledger.equity_snapshots (as_of)
  where agent_id is null;

create index equity_snapshots_recent on ledger.equity_snapshots (as_of desc);

alter table ledger.equity_snapshots enable row level security;
alter table ledger.equity_snapshots force row level security;

commit;
