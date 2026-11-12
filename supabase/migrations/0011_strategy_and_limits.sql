-- 0011_strategy_and_limits.sql
--
-- Three things the first real paper run needs.
--
-- 1. Which rule an agent runs. Until now every agent ran the moving-average
--    rule, chosen in code. `hold` is the other one: it buys the benchmark with
--    whatever it is given and never sells. It is "doing nothing" as an agent,
--    so money can sit in the thing every other agent is measured against
--    instead of sitting idle in the pool.
--
-- 2. A daily loss cap by default. New agents had none, so a new agent could
--    have a bad day with nothing to stop it. 3% is the default; the owner can
--    change it from the panel. Existing agents with no cap get the default too
--    — it only ever stops trading, never starts it. A `hold` agent has no cap
--    on purpose: it makes no decisions to stop, and halting it on the day the
--    market falls would only send an alarm on the day least worth acting on.
--
-- 3. A record of limit changes, in the same log as halt and start. Loosening
--    a limit is a control action and should be as visible afterwards as one.

begin;

alter table ledger.agents
  add column strategy text not null default 'sma'
    check (strategy in ('sma', 'hold'));

comment on column ledger.agents.strategy is
  'Which rule the agent runs. sma: moving-average crossover. hold: buy the '
  'benchmark and keep it.';

alter table ledger.agents alter column daily_loss_cap_pct set default 3.00;

update ledger.agents
   set daily_loss_cap_pct = 3.00, updated_at = now()
 where daily_loss_cap_pct is null and status <> 'killed';

alter table ledger.agent_control_events
  drop constraint agent_control_events_action_check;

alter table ledger.agent_control_events
  add constraint agent_control_events_action_check
  check (action in ('start', 'halt', 'kill', 'global_halt', 'set_limits'));

commit;
