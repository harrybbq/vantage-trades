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

begin;

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

commit;
