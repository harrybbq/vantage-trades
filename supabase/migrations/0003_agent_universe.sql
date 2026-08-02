-- 0003_agent_universe.sql
--
-- The trading universe: which symbols an agent is allowed to touch at all.
--
-- The owner decides *what* an agent may trade. The agent decides *when* and
-- *how much* within that. This is the boundary between those two, and like
-- every other money rule in this schema it is enforced by the database rather
-- than by the UI or the strategy code — a list the strategy could talk itself
-- out of is not a boundary.
--
-- An agent with an empty universe can buy nothing. That is the deliberate
-- default for a new agent: it has to be given a universe before it can act.

begin;

create table ledger.agent_universe (
  agent_id   text not null references ledger.agents (id) on delete cascade,
  symbol     text not null
               check (symbol = upper(symbol) and length(symbol) between 1 and 12),
  added_at   timestamptz not null default now(),
  added_by   text not null,
  primary key (agent_id, symbol)
);

create index agent_universe_agent_idx on ledger.agent_universe (agent_id);

comment on table ledger.agent_universe is
  'Symbols each agent may open a position in. Enforced on buys only - see '
  'ledger.assert_symbol_in_universe().';

-- ---------------------------------------------------------------------------
-- Invariant: an agent can only BUY inside its universe
-- ---------------------------------------------------------------------------
--
-- Buys are constrained; sells are not. That asymmetry is deliberate and
-- important: removing a symbol from an agent's universe must not trap it in a
-- position it can no longer exit. Narrowing the universe stops it opening
-- anything new in that symbol, and unwinding what it already holds stays
-- possible — including via kill, which has to be able to liquidate everything
-- regardless of what the universe currently says.

create or replace function ledger.assert_symbol_in_universe() returns trigger
language plpgsql as $$
declare
  v_allowed boolean;
  v_size    int;
begin
  if new.side <> 'buy' then
    return new;
  end if;

  select exists (
    select 1 from ledger.agent_universe u
     where u.agent_id = new.agent_id and u.symbol = new.symbol
  ) into v_allowed;

  if v_allowed then
    return new;
  end if;

  select count(*) into v_size from ledger.agent_universe where agent_id = new.agent_id;

  if v_size = 0 then
    raise exception
      'agent % has an empty trading universe: it may not open a position in % or anything else',
      new.agent_id, new.symbol
      using errcode = 'check_violation';
  end if;

  raise exception
    'agent % is not permitted to trade %; its universe is limited to % symbol(s)',
    new.agent_id, new.symbol, v_size
    using errcode = 'check_violation';
end $$;

-- Fires after the may-trade (halt) check, so a halted agent still reports as
-- halted rather than as a universe problem. Trigger order within a table is
-- alphabetical by name, and 'orders_agent_may_trade' sorts before this.
create trigger orders_symbol_in_universe
  before insert on ledger.orders
  for each row execute function ledger.assert_symbol_in_universe();

alter table ledger.agent_universe enable row level security;
alter table ledger.agent_universe force row level security;

commit;
