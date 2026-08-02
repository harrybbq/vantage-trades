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

begin;

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

commit;
