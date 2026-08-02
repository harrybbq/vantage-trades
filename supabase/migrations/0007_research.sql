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

begin;

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

commit;
