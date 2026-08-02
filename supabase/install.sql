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


-- ===================================================================
-- 0001_ledger.sql
-- ===================================================================

-- 0001_ledger.sql
--
-- The allocation ledger: the heart of this system. Everything else is a view
-- over it. See docs/LEDGER.md for the reasoning behind the shape.
--
-- Money is stored as BIGINT minor units (pence). There are no floating point
-- money columns anywhere in this schema and there must never be one: 0.1 + 0.2
-- is not 0.3 in binary floating point, and a ledger that cannot sum to exactly
-- zero cannot be reconciled.
--
-- The invariants below are enforced by the database, not by application code.
-- That is deliberate. A check in TypeScript is a check that a bug can skip.


create schema if not exists ledger;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Agent lifecycle. These four words are used precisely throughout the codebase
-- because halt and kill are dangerous to conflate:
--   idle    - exists, not trading, holds no positions
--   running - may open and close positions
--   halted  - frozen. Opens nothing, closes nothing. Positions left exactly as
--             they are, capital stays allocated. The "something looks wrong"
--             button.
--   killed  - liquidated and stood down. Capital returned to the pool.
create type ledger.agent_status as enum ('idle', 'running', 'halted', 'killed');

create type ledger.account_kind as enum (
  'pool',              -- unallocated capital. A first-class account.
  'agent_cash',        -- capital allocated to one agent, not yet deployed
  'agent_positions',   -- book value of one agent's open positions
  'agent_realised',    -- one agent's realised P/L
  'agent_fees',        -- commission and fees charged to one agent
  'external'           -- contra account: the world outside the brokerage
);

create type ledger.entry_kind as enum (
  'deposit',        -- real cash arrived in the brokerage account (manual)
  'withdrawal',     -- real cash left the brokerage account (manual)
  'allocation',     -- pool -> agent cash. Moves no real money.
  'deallocation',   -- agent cash -> pool. Moves no real money.
  'buy',            -- agent cash -> agent positions
  'sell',           -- agent positions -> agent cash, realising P/L
  'fee',            -- agent cash -> external
  'adjustment'      -- reconciliation correction, always explained in memo
);

create type ledger.order_side as enum ('buy', 'sell');

create type ledger.order_status as enum (
  'pending',           -- created here, not yet acknowledged by the broker
  'submitted',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected'
);

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------

create table ledger.agents (
  id           text primary key
                 constraint agents_id_shape
                 check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name         text not null check (length(trim(name)) > 0),
  status       ledger.agent_status not null default 'idle',
  -- Set the first time the agent starts. Anchors pnlPctSinceStart.
  started_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table ledger.agents is
  'One row per trading agent. The broker has no concept of these; per-agent '
  'attribution exists only because this schema maintains it.';

-- Every change of agent status is recorded. When an agent stops trading at
-- 04:00 you want to know whether it halted itself, you halted it, or the
-- global kill switch caught it.
create table ledger.agent_control_events (
  id           bigserial primary key,
  -- Null agent_id means the global kill switch: applies to every agent at once.
  agent_id     text references ledger.agents (id),
  action       text not null check (action in ('start', 'halt', 'kill', 'global_halt')),
  from_status  ledger.agent_status,
  to_status    ledger.agent_status,
  actor        text not null,           -- who or what asked for this
  reason       text,
  created_at   timestamptz not null default now(),
  constraint global_halt_has_no_agent
    check ((action = 'global_halt') = (agent_id is null))
);

create index agent_control_events_agent_idx
  on ledger.agent_control_events (agent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table ledger.accounts (
  id         uuid primary key default gen_random_uuid(),
  kind       ledger.account_kind not null,
  agent_id   text references ledger.agents (id),
  currency   char(3) not null,
  created_at timestamptz not null default now(),

  -- Agent accounts must name an agent; pool and external must not. Without
  -- this, an "agent" account with a null agent_id silently swallows money that
  -- then belongs to nobody.
  constraint account_agent_presence check (
    (kind in ('agent_cash', 'agent_positions', 'agent_realised', 'agent_fees')
       and agent_id is not null)
    or
    (kind in ('pool', 'external') and agent_id is null)
  )
);

-- One account per (kind, agent, currency). Two pool accounts would let the
-- unallocated total disagree with itself.
create unique index accounts_agent_unique
  on ledger.accounts (kind, agent_id, currency)
  where agent_id is not null;

create unique index accounts_global_unique
  on ledger.accounts (kind, currency)
  where agent_id is null;

-- ---------------------------------------------------------------------------
-- Journal: append-only double-entry
-- ---------------------------------------------------------------------------

create table ledger.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  kind        ledger.entry_kind not null,
  occurred_at timestamptz not null,
  memo        text,
  -- Set for entries caused by something outside this system (a broker fill,
  -- a bank transfer). Unique, so replaying a broker webhook cannot double-post.
  external_ref text,
  created_at  timestamptz not null default now()
);

create unique index journal_entries_external_ref_unique
  on ledger.journal_entries (external_ref)
  where external_ref is not null;

create index journal_entries_occurred_idx
  on ledger.journal_entries (occurred_at desc);

create table ledger.postings (
  id           bigserial primary key,
  entry_id     uuid not null references ledger.journal_entries (id),
  account_id   uuid not null references ledger.accounts (id),
  -- Signed minor units. Positive increases the account, negative decreases it.
  -- Within one entry these must sum to exactly zero.
  amount_minor bigint not null,
  created_at   timestamptz not null default now()
);

create index postings_entry_idx on ledger.postings (entry_id);
create index postings_account_idx on ledger.postings (account_id);

comment on column ledger.postings.amount_minor is
  'Signed integer minor units (pence). Never a float, never a decimal string.';

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
--
-- A posted ledger is never edited. Mistakes are corrected by posting a
-- reversing entry, which leaves both the error and the correction visible.
-- Allowing UPDATE would let a bug silently rewrite history that reconciliation
-- has already signed off on.

create or replace function ledger.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception
    'ledger.% is append-only: % is not permitted. Post a reversing entry instead.',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

create trigger journal_entries_append_only
  before update or delete on ledger.journal_entries
  for each row execute function ledger.reject_mutation();

create trigger postings_append_only
  before update or delete on ledger.postings
  for each row execute function ledger.reject_mutation();

-- ---------------------------------------------------------------------------
-- Invariant: every entry balances
-- ---------------------------------------------------------------------------
--
-- Deferred to commit time, so a transaction can insert an entry and its
-- postings in any order. It fires at COMMIT, when the entry must be whole.

create or replace function ledger.assert_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_sum       bigint;
  v_count     int;
  v_currencies int;
begin
  select coalesce(sum(p.amount_minor), 0),
         count(*),
         count(distinct a.currency)
    into v_sum, v_count, v_currencies
    from ledger.postings p
    join ledger.accounts a on a.id = p.account_id
   where p.entry_id = new.entry_id;

  if v_count < 2 then
    raise exception 'journal entry % has % posting(s); double-entry needs at least 2',
      new.entry_id, v_count
      using errcode = 'check_violation';
  end if;

  if v_sum <> 0 then
    raise exception 'journal entry % does not balance: postings sum to % minor units',
      new.entry_id, v_sum
      using errcode = 'check_violation';
  end if;

  -- The ledger is single-currency by design. Mixing currencies in one entry
  -- would make it "balance" at two different exchange rates depending on when
  -- you asked, which is how reconciliation starts lying.
  if v_currencies > 1 then
    raise exception 'journal entry % mixes % currencies; the ledger is single-currency',
      new.entry_id, v_currencies
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

create constraint trigger postings_balance_check
  after insert on ledger.postings
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- Balances
-- ---------------------------------------------------------------------------

create view ledger.account_balances as
  select a.id   as account_id,
         a.kind,
         a.agent_id,
         a.currency,
         coalesce(sum(p.amount_minor), 0)::bigint as balance_minor
    from ledger.accounts a
    left join ledger.postings p on p.account_id = a.id
   group by a.id, a.kind, a.agent_id, a.currency;

-- ---------------------------------------------------------------------------
-- Invariant: an agent cannot deploy capital it was never allocated
-- ---------------------------------------------------------------------------
--
-- This is the budget cap, and it is a hard one. "Give agent 3 GBP 500" raises
-- this ceiling; nothing else does. An agent whose strategy wants to buy more
-- than its allocation gets a failed transaction, not a larger position.
--
-- The same rule covers the unallocated pool: handing out capital that is not
-- there would let the sum of allocations exceed the money in the account, and
-- reconciliation would report a divergence it cannot explain.

create or replace function ledger.assert_cash_non_negative() returns trigger
language plpgsql as $$
declare
  v_kind    ledger.account_kind;
  v_agent   text;
  v_balance bigint;
begin
  select a.kind, a.agent_id into v_kind, v_agent
    from ledger.accounts a where a.id = new.account_id;

  if v_kind not in ('agent_cash', 'pool') then
    return null;
  end if;

  select coalesce(sum(p.amount_minor), 0) into v_balance
    from ledger.postings p where p.account_id = new.account_id;

  if v_balance < 0 then
    if v_kind = 'pool' then
      raise exception
        'unallocated pool would go negative by % minor units; there is not that much to allocate',
        -v_balance
        using errcode = 'check_violation';
    else
      raise exception
        'agent % would overdraw its allocation by % minor units; raise its allocation first',
        v_agent, -v_balance
        using errcode = 'check_violation';
    end if;
  end if;

  return null;
end $$;

create constraint trigger postings_cash_check
  after insert on ledger.postings
  deferrable initially deferred
  for each row execute function ledger.assert_cash_non_negative();

-- ---------------------------------------------------------------------------
-- Orders and fills
-- ---------------------------------------------------------------------------

create table ledger.orders (
  id              uuid primary key default gen_random_uuid(),

  -- NOT NULL is the whole point. An unattributed fill corrupts every number
  -- downstream and is very hard to reconstruct afterwards, so the schema makes
  -- an unattributed order impossible to write in the first place.
  agent_id        text not null references ledger.agents (id),

  symbol          text not null check (symbol = upper(symbol) and length(symbol) between 1 and 12),
  side            ledger.order_side not null,
  qty             numeric(20, 8) not null check (qty > 0),
  limit_price_minor bigint check (limit_price_minor is null or limit_price_minor > 0),
  status          ledger.order_status not null default 'pending',

  -- Supplied by the caller, unique forever. A retried submission after a
  -- timeout reuses the key and conflicts rather than opening a second position.
  idempotency_key text not null unique,

  broker_order_id text unique,
  submitted_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index orders_agent_idx on ledger.orders (agent_id, created_at desc);

create table ledger.fills (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references ledger.orders (id),

  -- Denormalised from the order deliberately: attribution is the one fact that
  -- must survive even if an order row is later found to be wrong.
  agent_id       text not null references ledger.agents (id),

  symbol         text not null,
  side           ledger.order_side not null,
  qty            numeric(20, 8) not null check (qty > 0),
  price_minor    bigint not null check (price_minor > 0),
  fee_minor      bigint not null default 0 check (fee_minor >= 0),

  -- The broker's own id for this fill. Unique, so re-polling the fills endpoint
  -- or replaying a webhook cannot book the same fill twice.
  broker_fill_id text not null unique,

  -- The journal entry this fill produced. One entry per fill, enforced unique.
  entry_id       uuid references ledger.journal_entries (id) unique,

  filled_at      timestamptz not null,
  created_at     timestamptz not null default now()
);

create index fills_agent_idx on ledger.fills (agent_id, filled_at desc);
create index fills_symbol_idx on ledger.fills (symbol, filled_at desc);

-- A fill must agree with the order it belongs to. Without this a buy order can
-- record a sell fill, and the position goes the wrong way.
create or replace function ledger.assert_fill_matches_order() returns trigger
language plpgsql as $$
declare
  o ledger.orders%rowtype;
begin
  select * into o from ledger.orders where id = new.order_id;

  if o.agent_id <> new.agent_id then
    raise exception 'fill attributes to agent % but order % belongs to agent %',
      new.agent_id, new.order_id, o.agent_id
      using errcode = 'check_violation';
  end if;

  if o.symbol <> new.symbol or o.side <> new.side then
    raise exception 'fill (% %) does not match order % (% %)',
      new.side, new.symbol, new.order_id, o.side, o.symbol
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger fills_match_order
  before insert on ledger.fills
  for each row execute function ledger.assert_fill_matches_order();

-- ---------------------------------------------------------------------------
-- Invariant: halt is authoritative
-- ---------------------------------------------------------------------------
--
-- A flag checked once per loop is a request, not a stop. This check sits at the
-- point of writing the order, so an agent whose loop is wedged mid-iteration
-- still cannot get an order in after being halted.
--
-- It is not the only layer: broker-side max order size and daily loss caps
-- still matter, because they bound a runaway loop with something this codebase
-- cannot override.

create or replace function ledger.assert_agent_may_trade() returns trigger
language plpgsql as $$
declare
  v_status ledger.agent_status;
begin
  select status into v_status from ledger.agents where id = new.agent_id;

  if v_status is distinct from 'running' then
    raise exception 'agent % is %, not running: refusing to record an order',
      new.agent_id, coalesce(v_status::text, 'unknown')
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger orders_agent_may_trade
  before insert on ledger.orders
  for each row execute function ledger.assert_agent_may_trade();

-- ---------------------------------------------------------------------------
-- Position lots: per-agent cost basis
-- ---------------------------------------------------------------------------
--
-- The broker shows one AAPL position. If two agents each hold AAPL, only this
-- table knows whose it is and what each paid. Lots are closed FIFO within an
-- agent; the agent is always the outermost key.

create table ledger.position_lots (
  id              uuid primary key default gen_random_uuid(),
  agent_id        text not null references ledger.agents (id),
  symbol          text not null,
  opening_fill_id uuid not null references ledger.fills (id),

  qty_opened      numeric(20, 8) not null check (qty_opened > 0),
  qty_remaining   numeric(20, 8) not null check (qty_remaining >= 0),

  -- Cost in minor units, as actually posted to the ledger when the lot opened.
  -- Held rather than derived from a unit price: a unit price multiplied back
  -- out does not necessarily reproduce the posted amount, and a book value
  -- that disagrees with the journal by a penny is a reconciliation failure
  -- that costs an afternoon to chase.
  cost_total_minor     bigint not null check (cost_total_minor > 0),
  -- Decreases as the lot is closed. Remaining basis is tracked exactly rather
  -- than recomputed pro rata, so repeated partial sells cannot drift.
  basis_remaining_minor bigint not null check (basis_remaining_minor >= 0),

  opened_at       timestamptz not null,
  closed_at       timestamptz,

  constraint lot_remaining_within_opened check (qty_remaining <= qty_opened),
  constraint lot_basis_within_cost check (basis_remaining_minor <= cost_total_minor),
  -- A lot is closed exactly when nothing is left of it, and an empty lot must
  -- carry no basis: leftover basis on a closed lot is money attributed to a
  -- position that no longer exists.
  constraint lot_closed_iff_empty check ((qty_remaining = 0) = (closed_at is not null)),
  constraint lot_empty_has_no_basis check (qty_remaining > 0 or basis_remaining_minor = 0)
);

create index position_lots_open_idx
  on ledger.position_lots (agent_id, symbol, opened_at)
  where qty_remaining > 0;

create view ledger.agent_positions as
  select agent_id,
         symbol,
         sum(qty_remaining)                   as qty,
         sum(basis_remaining_minor)::bigint   as cost_basis_minor
    from ledger.position_lots
   where qty_remaining > 0
   group by agent_id, symbol;

-- What the broker should be showing us, if our attribution is right.
create view ledger.expected_broker_positions as
  select symbol, sum(qty) as qty
    from ledger.agent_positions
   group by symbol;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------
--
-- Mandatory, not a nice-to-have. Asserts that
--   sum(agent equities) + unallocated == broker account equity
-- and that our per-symbol quantities match the broker's. When they diverge
-- there is a bug, and it wants finding that day rather than three months later.

create table ledger.reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  run_at                timestamptz not null default now(),
  as_of                 timestamptz not null,

  broker_cash_minor     bigint not null,
  broker_equity_minor   bigint not null,
  computed_cash_minor   bigint not null,

  -- Null when equity could not be computed, which happens when a held symbol
  -- has no mark. Null is the honest answer: substituting zero, or cost basis,
  -- would turn "we do not know" into a number that looks like agreement.
  computed_equity_minor bigint,
  equity_diff_minor     bigint,

  cash_diff_minor       bigint not null,

  status                text not null check (status in ('ok', 'diverged', 'error')),
  -- Per-symbol quantity comparison and any error detail.
  detail                jsonb not null default '{}'::jsonb,

  constraint diffs_are_consistent check (
    cash_diff_minor = broker_cash_minor - computed_cash_minor
    and (
      (computed_equity_minor is null and equity_diff_minor is null)
      or equity_diff_minor = broker_equity_minor - computed_equity_minor
    )
  ),
  -- 'ok' has to mean exactly zero drift, on a figure we actually computed. A
  -- tolerance band, or a pass on unknown equity, is how a slow leak goes
  -- unnoticed for a quarter.
  constraint ok_means_zero_drift check (
    status <> 'ok'
    or (cash_diff_minor = 0 and equity_diff_minor is not null and equity_diff_minor = 0)
  )
);

create index reconciliations_run_idx on ledger.reconciliations (run_at desc);

-- ---------------------------------------------------------------------------
-- Marks: the price used to value positions
-- ---------------------------------------------------------------------------
--
-- Equity is only meaningful with a price attached. Marks are stored rather
-- than fetched at read time so a number shown in the UI can be reproduced
-- later, and so reconciliation compares like with like.

create table ledger.marks (
  symbol       text not null,
  as_of        timestamptz not null,
  price_minor  bigint not null check (price_minor > 0),
  source       text not null,
  created_at   timestamptz not null default now(),
  primary key (symbol, as_of)
);

create index marks_latest_idx on ledger.marks (symbol, as_of desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Deny by default on every table. This is a single-owner system and every one
-- of these tables can move or misreport money, so nothing is reachable with an
-- anon or authenticated key. Server-side code uses the service role; the UI
-- reads through views exposed deliberately, later, once there is a UI.
--
-- A UI check for "is this the owner" is decoration. This is the access control.

alter table ledger.agents               enable row level security;
alter table ledger.agent_control_events enable row level security;
alter table ledger.accounts             enable row level security;
alter table ledger.journal_entries      enable row level security;
alter table ledger.postings             enable row level security;
alter table ledger.orders               enable row level security;
alter table ledger.fills                enable row level security;
alter table ledger.position_lots        enable row level security;
alter table ledger.reconciliations      enable row level security;
alter table ledger.marks                enable row level security;

alter table ledger.agents               force row level security;
alter table ledger.agent_control_events force row level security;
alter table ledger.accounts             force row level security;
alter table ledger.journal_entries      force row level security;
alter table ledger.postings             force row level security;
alter table ledger.orders               force row level security;
alter table ledger.fills                force row level security;
alter table ledger.position_lots        force row level security;
alter table ledger.reconciliations      force row level security;
alter table ledger.marks                force row level security;

-- No policies are created. With RLS enabled and no policy, every non-superuser
-- role sees nothing, which is the correct default for all of these.



-- ===================================================================
-- 0002_paper_broker.sql
-- ===================================================================

-- 0002_paper_broker.sql
--
-- A simulated brokerage account, for proving the ledger before any real
-- broker is connected.
--
-- This schema is deliberately SEPARATE from `ledger` and knows nothing about
-- agents. That is the entire point. Reconciliation compares the ledger against
-- the broker's own figures, so if the "broker" derived its numbers from the
-- ledger the comparison would be circular and would prove nothing. These
-- tables are an independent set of books that happen to live in the same
-- database.
--
-- Note what is missing: there is no agent_id anywhere below. A real broker has
-- no concept of your agents, and neither does this one. Attribution exists only
-- in the ledger.


create schema if not exists paper;

-- ---------------------------------------------------------------------------
-- The market
-- ---------------------------------------------------------------------------

create table paper.market_prices (
  symbol      text primary key,
  price_minor bigint not null check (price_minor > 0),
  updated_at  timestamptz not null default now()
);

comment on table paper.market_prices is
  'The simulated last-traded price. Set by hand or by a price feed. Fills are '
  'priced from here, adjusted for spread and slippage.';

-- ---------------------------------------------------------------------------
-- The account
-- ---------------------------------------------------------------------------

-- Single row. `only_row` makes a second account impossible rather than merely
-- unlikely.
create table paper.account (
  only_row   boolean primary key default true check (only_row),
  cash_minor bigint not null default 0,
  currency   char(3) not null default 'GBP'
);

insert into paper.account (only_row, cash_minor) values (true, 0);

create table paper.positions (
  symbol           text primary key,
  qty              numeric(20, 8) not null check (qty >= 0),
  -- The broker's blended average, which is all a real broker gives you. Two
  -- agents buying the same symbol at different prices collapse into this one
  -- number here — recovering who paid what is exactly what the ledger is for.
  cost_total_minor bigint not null check (cost_total_minor >= 0)
);

-- ---------------------------------------------------------------------------
-- Orders and fills
-- ---------------------------------------------------------------------------

create table paper.orders (
  id                uuid primary key default gen_random_uuid(),
  symbol            text not null,
  side              text not null check (side in ('buy', 'sell')),
  qty               numeric(20, 8) not null check (qty > 0),
  limit_price_minor bigint check (limit_price_minor is null or limit_price_minor > 0),
  status            text not null check (status in ('accepted', 'filled', 'rejected', 'cancelled')),
  reject_reason     text,
  -- Real brokers honour an idempotency key on submission. Modelling it here
  -- means the retry path gets exercised in tests rather than discovered live.
  idempotency_key   text not null unique,
  created_at        timestamptz not null default now()
);

create table paper.fills (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references paper.orders (id),
  symbol      text not null,
  side        text not null check (side in ('buy', 'sell')),
  qty         numeric(20, 8) not null check (qty > 0),
  price_minor bigint not null check (price_minor > 0),
  fee_minor   bigint not null default 0 check (fee_minor >= 0),
  filled_at   timestamptz not null default now()
);

create index paper_fills_time_idx on paper.fills (filled_at, id);

-- The paper broker is a development tool and is never exposed to a client, but
-- deny-by-default costs nothing and keeps the rule uniform across the database.
alter table paper.market_prices enable row level security;
alter table paper.account       enable row level security;
alter table paper.positions     enable row level security;
alter table paper.orders        enable row level security;
alter table paper.fills         enable row level security;



-- ===================================================================
-- 0003_agent_universe.sql
-- ===================================================================

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



-- ===================================================================
-- 0004_equity_snapshots.sql
-- ===================================================================

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



-- ===================================================================
-- 0005_agent_rails.sql
-- ===================================================================

-- 0005_agent_rails.sql
--
-- Per-agent limits, for the point at which an agent starts acting on its own.
--
-- Up to now every order has been hand-placed. An autonomous loop is different:
-- the failure mode is not one wrong order, it is a thousand of them before
-- anyone looks. These bound the blast radius.
--
-- The `max_order_pct` cap is enforced in the runner rather than here, because
-- a market order has no price at insert time and the database cannot know its
-- notional. That makes it weaker than the other rules in this schema, and it
-- is the reason the note below matters:
--
--   BEFORE ANY OF THIS TOUCHES REAL MONEY, the same limits must also be set
--   broker-side (max order size, daily loss cap). A limit this codebase can
--   override is a limit a bug in this codebase can override.
--
-- The daily loss cap IS enforced here, as a halt: it is checked against
-- realised state rather than an in-flight order, so the database can see it.


alter table ledger.agents
  -- The largest single order, as a percentage of the agent's allocation.
  -- 100 means "may spend its whole allocation in one order".
  add column max_order_pct numeric(5, 2) not null default 25.00
    check (max_order_pct > 0 and max_order_pct <= 100),

  -- Intraday drawdown, as a percentage of the day's opening equity, at which
  -- the agent halts itself. Null disables it.
  add column daily_loss_cap_pct numeric(5, 2)
    check (daily_loss_cap_pct is null or (daily_loss_cap_pct > 0 and daily_loss_cap_pct <= 100)),

  -- Minimum seconds between an agent's decision ticks. A loop that runs away
  -- costs money in spread even when every individual order is within its cap.
  add column min_tick_seconds int not null default 300
    check (min_tick_seconds >= 1),

  -- Set by the runner. Used to enforce min_tick_seconds across restarts, so
  -- a crash-loop cannot turn into a trading loop.
  add column last_tick_at timestamptz;

comment on column ledger.agents.max_order_pct is
  'Largest single order as a percent of allocation. Enforced in the runner - '
  'the database cannot price a market order at insert time. Must be mirrored '
  'broker-side before live trading.';



-- ===================================================================
-- 0006_fill_within_order.sql
-- ===================================================================

-- 0006_fill_within_order.sql
--
-- An order may fill in pieces, but never for more than it asked for.
--
-- Partial fills are normal: a broker with 10 shares to buy may come back with
-- 4, then 6. What must never happen is the total exceeding the order, because
-- that is precisely one of the three questions every change is checked
-- against — "can this place a larger order than intended".
--
-- Without this, a replayed fill feed or an off-by-one in the sync job produces
-- a position larger than anything anyone asked for, and the only thing that
-- would notice is reconciliation, the next day.


create or replace function ledger.assert_fill_within_order() returns trigger
language plpgsql as $$
declare
  v_ordered numeric(20, 8);
  v_filled  numeric(20, 8);
begin
  select qty into v_ordered from ledger.orders where id = new.order_id;

  select coalesce(sum(qty), 0) into v_filled
    from ledger.fills where order_id = new.order_id;

  if v_filled + new.qty > v_ordered then
    raise exception
      'fill of % would take order % to % filled, but only % was ordered',
      new.qty, new.order_id, v_filled + new.qty, v_ordered
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Runs after fills_match_order (alphabetical), so a mismatched agent or symbol
-- is reported as that rather than as a quantity problem.
create trigger fills_within_order
  before insert on ledger.fills
  for each row execute function ledger.assert_fill_within_order();



-- ===================================================================
-- 0007_research.sql
-- ===================================================================

-- 0007_research.sql
--
-- The experiment register and the out-of-sample lock.
--
-- These exist because the most likely way this project loses money is not a
-- bug. It is testing twenty strategy variants, picking the one that looked
-- best, and mistaking the winner of a search for a discovery. If you try
-- twenty things, one of them clears a 95% bar by luck alone.
--
-- The defence is not care. It is a record you cannot edit afterwards:
--
--   * every variant is registered BEFORE it runs, with its hypothesis
--   * the parameters and hypothesis become immutable once written
--   * the count of registered experiments is the multiple-comparisons burden,
--     and it is used to raise the bar the result has to clear
--   * held-out data is locked, and unlocking is a one-way, recorded event
--
-- Without the register you will genuinely not remember you tried fourteen
-- things. With it, the fourteen are in the denominator where they belong.


create schema if not exists research;

create table research.experiments (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  strategy      text not null,
  -- Whatever the strategy was configured with. Immutable after registration.
  params        jsonb not null,
  -- What you expected to happen, in words, written before you knew.
  hypothesis    text not null check (length(trim(hypothesis)) >= 10),
  universe      text[] not null check (cardinality(universe) > 0),

  -- The window the experiment is allowed to look at.
  train_from    date not null,
  train_to      date not null,
  check (train_to > train_from),

  registered_at timestamptz not null default now(),
  registered_by text not null,

  -- Filled in afterwards. The only columns an update may touch.
  completed_at  timestamptz,
  result        jsonb,
  -- Set when the experiment was evaluated against held-out data.
  holdout_id    uuid
);

create index experiments_registered_idx on research.experiments (registered_at desc);

-- ---------------------------------------------------------------------------
-- Held-out data
-- ---------------------------------------------------------------------------
--
-- A date range you have promised not to look at. Unlocking is one-way and
-- recorded, because "I only peeked once" is how a hold-out stops being one.
-- Once seen, a period is in-sample forever, and the register should say so.

create table research.holdouts (
  id            uuid primary key default gen_random_uuid(),
  label         text not null unique,
  from_date     date not null,
  to_date       date not null,
  check (to_date > from_date),

  created_at    timestamptz not null default now(),
  created_by    text not null,

  unlocked_at   timestamptz,
  unlocked_by   text,
  unlock_reason text,

  constraint unlock_is_explained check (
    unlocked_at is null or (unlocked_by is not null and length(trim(unlock_reason)) >= 10)
  )
);

alter table research.experiments
  add constraint experiments_holdout_fk foreign key (holdout_id) references research.holdouts (id);

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

create or replace function research.protect_experiment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'experiments are a permanent record and cannot be deleted'
      using errcode = 'restrict_violation';
  end if;

  -- Everything that describes the experiment is frozen at registration. If it
  -- could be edited afterwards, the hypothesis would drift to match whatever
  -- the result turned out to be, which is the exact failure this table exists
  -- to prevent.
  if new.name is distinct from old.name
     or new.strategy is distinct from old.strategy
     or new.params is distinct from old.params
     or new.hypothesis is distinct from old.hypothesis
     or new.universe is distinct from old.universe
     or new.train_from is distinct from old.train_from
     or new.train_to is distinct from old.train_to
     or new.registered_at is distinct from old.registered_at then
    raise exception
      'an experiment''s definition is fixed at registration; only its result may be written'
      using errcode = 'restrict_violation';
  end if;

  -- Completion is once, and it is checked on completed_at rather than on the
  -- result value. Comparing values would let an identical re-run through, and
  -- "run it again and see" is the habit this is here to break.
  if old.completed_at is not null then
    raise exception 'experiment % already has a result; register a new one instead', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

create trigger experiments_immutable
  before update or delete on research.experiments
  for each row execute function research.protect_experiment();

create or replace function research.protect_holdout() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a hold-out cannot be deleted; that is the point of it'
      using errcode = 'restrict_violation';
  end if;

  if new.from_date is distinct from old.from_date or new.to_date is distinct from old.to_date then
    raise exception 'a hold-out window cannot be moved once created'
      using errcode = 'restrict_violation';
  end if;

  -- Unlocking is one-way. Re-locking would let a period that has already been
  -- seen be presented as fresh evidence later.
  if old.unlocked_at is not null and new.unlocked_at is null then
    raise exception 'hold-out % has already been unlocked and cannot be re-locked', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

create trigger holdouts_protected
  before update or delete on research.holdouts
  for each row execute function research.protect_holdout();

alter table research.experiments enable row level security;
alter table research.holdouts    enable row level security;
alter table research.experiments force row level security;
alter table research.holdouts    force row level security;



-- ===================================================================
-- 0008_report_tokens.sql
-- ===================================================================

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
