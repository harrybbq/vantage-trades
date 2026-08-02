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

begin;

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

commit;
