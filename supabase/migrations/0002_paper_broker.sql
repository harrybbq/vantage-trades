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

begin;

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

commit;
