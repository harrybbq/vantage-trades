-- 0010_kill_liquidates.sql
--
-- Kill has to be able to sell.
--
-- Until now an order was only accepted from a running agent. Kill liquidates
-- and then stands the agent down, but standing down refuses while anything is
-- still held — so Kill on an agent with positions failed and left the agent
-- running, and on a halted agent it could not sell at all, because a halted
-- agent may not place orders. The button for "get out of everything" did
-- nothing for exactly the agents it exists for.
--
-- `killing` is the state between the two: the agent may sell what it holds and
-- nothing else. It cannot buy, its strategy does not run, and it ends in
-- `killed` only once every position is gone and its cash is back in the pool.
-- If a sale fails it stays `killing`, says so, and Kill can be pressed again.

alter type ledger.agent_status add value if not exists 'killing' after 'halted';

begin;

-- Why the broker turned an order down. Until now a rejected order was recorded
-- as submitted, so it looked like something still in flight and nothing said
-- why it never filled.
alter table ledger.orders add column reject_reason text;

create or replace function ledger.assert_agent_may_trade() returns trigger
language plpgsql as $$
declare
  v_status ledger.agent_status;
begin
  select status into v_status from ledger.agents where id = new.agent_id;

  if v_status = 'running' then
    return new;
  end if;

  -- Selling what it holds, and only that, is how a kill finishes. Compared as
  -- text because the enum value is new in this migration.
  if v_status::text = 'killing' and new.side = 'sell' then
    return new;
  end if;

  if v_status::text = 'killing' then
    raise exception 'agent % is being killed and may only sell; it is not running',
      new.agent_id
      using errcode = 'check_violation';
  end if;

  raise exception 'agent % is %, not running: refusing to record an order',
    new.agent_id, coalesce(v_status::text, 'unknown')
    using errcode = 'check_violation';
end $$;

commit;
