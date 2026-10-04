-- 0009_feed_instruments.sql
--
-- The currency each symbol is quoted in, as the price feed reported it.
--
-- Alpha Vantage's quote carries a price and no currency. London quotes some
-- instruments in pounds and others in pence, a factor of one hundred apart, so
-- a price without its currency is a number that cannot be safely read. The
-- currency comes from the feed's symbol search instead, which costs a request
-- out of a daily allowance of 25 — so it is asked once and kept here.
--
-- A wrong row here values a holding at 100× or 1/100 of the truth. If a price
-- on the panel looks a hundred times off, this is the first place to look; the
-- fix is to delete the row, and the next price run asks again.

begin;

create table paper.feed_instruments (
  symbol      text primary key check (symbol = upper(symbol)),
  -- What the feed calls it, e.g. VWRP.LON.
  feed_symbol text not null,
  -- As the feed reported it. Only GBP and GBX are usable; anything else is
  -- kept so it is not asked about again, and refused every time it is priced.
  currency    text not null check (currency ~ '^[A-Za-z]{3}$'),
  checked_at  timestamptz not null default now()
);

comment on table paper.feed_instruments is
  'Quoting currency per symbol, from the price feed''s symbol search. GBP is '
  'pounds, GBX is pence. Delete a row to have the feed asked again.';

alter table paper.feed_instruments enable row level security;

commit;
