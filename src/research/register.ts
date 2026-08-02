/**
 * The experiment register, and the hold-out lock.
 *
 * Register before you run. The count of registered experiments is your
 * multiple-comparisons burden, and it is fed straight into the significance
 * test — so the twentieth variant has to clear a visibly higher bar than the
 * first, which is exactly right and exactly what nobody does by hand.
 */

import type { Sql } from '../db.js';
import { assessSignificance, type Significance } from './metrics.js';
import type { BacktestResult } from './backtest.js';

export interface RegisterInput {
  name: string;
  strategy: string;
  params: Record<string, unknown>;
  /** What you expect to happen, written before you know. */
  hypothesis: string;
  universe: string[];
  trainFrom: Date;
  trainTo: Date;
  registeredBy: string;
}

export class HoldoutLockedError extends Error {}

export async function registerExperiment(tx: Sql, input: RegisterInput): Promise<string> {
  if (input.hypothesis.trim().length < 10) {
    // A hypothesis you cannot be wrong about is not one. Forcing it into words
    // before the run is most of the value of this table.
    throw new Error('write a real hypothesis: what do you expect, and what would disprove it?');
  }

  const result = await tx.query<{ id: string }>(
    `insert into research.experiments
       (name, strategy, params, hypothesis, universe, train_from, train_to, registered_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      input.name,
      input.strategy,
      JSON.stringify(input.params),
      input.hypothesis,
      input.universe,
      input.trainFrom,
      input.trainTo,
      input.registeredBy,
    ],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to register experiment');
  return id;
}

/** How many experiments have been registered. The denominator. */
export async function trialCount(tx: Sql): Promise<number> {
  const result = await tx.query<{ n: string }>(
    `select count(*)::text as n from research.experiments`,
  );
  return Number(result.rows[0]?.n ?? '0');
}

export interface CompletedExperiment {
  id: string;
  result: BacktestResult;
  significance: Significance;
}

/**
 * Record a result against a registered experiment.
 *
 * Judged against the number of experiments registered so far, not against
 * one. The schema refuses a second result for the same experiment, so a run
 * that came out badly cannot be quietly re-run until it does not.
 */
export async function completeExperiment(
  tx: Sql,
  experimentId: string,
  result: BacktestResult,
): Promise<CompletedExperiment> {
  // Snapshot only. The honest figure is `currentSignificance`, which counts
  // every trial in the search — including the ones registered after this one.
  const trials = await trialCount(tx);
  const significance = assessSignificance(result.sharpe, result.days, trials);

  await tx.query(
    `update research.experiments
        set completed_at = now(), result = $2
      where id = $1`,
    [experimentId, JSON.stringify({ ...result, significance })],
  );

  return { id: experimentId, result, significance };
}

/**
 * Re-judge a stored result against every trial registered to date.
 *
 * This, not the snapshot taken at completion, is the number to look at. The
 * seventh of twelve variants was judged against seven when it finished, but
 * it was chosen as the best of twelve — and it is the size of the search you
 * picked from that determines how impressive winning it is.
 *
 * Using the snapshot would make an early winner look stronger than a late one
 * with identical results, purely from running order.
 */
export async function currentSignificance(tx: Sql, experimentId: string): Promise<Significance> {
  const stored = await tx.query<{ result: { sharpe: number | null; days: number } | null }>(
    `select result from research.experiments where id = $1`,
    [experimentId],
  );
  const result = stored.rows[0]?.result;
  if (!result) throw new Error(`experiment ${experimentId} has no result yet`);

  return assessSignificance(result.sharpe, result.days, await trialCount(tx));
}

/* ------------------------------------------------------------------------- */

export interface Holdout {
  id: string;
  label: string;
  fromDate: Date;
  toDate: Date;
  unlockedAt: Date | null;
}

export async function createHoldout(
  tx: Sql,
  label: string,
  fromDate: Date,
  toDate: Date,
  createdBy: string,
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `insert into research.holdouts (label, from_date, to_date, created_by)
     values ($1, $2, $3, $4) returning id`,
    [label, fromDate, toDate, createdBy],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to create hold-out');
  return id;
}

export async function getHoldout(tx: Sql, label: string): Promise<Holdout | null> {
  const result = await tx.query<{
    id: string;
    label: string;
    from_date: Date;
    to_date: Date;
    unlocked_at: Date | null;
  }>(`select id, label, from_date, to_date, unlocked_at from research.holdouts where label = $1`, [
    label,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    fromDate: row.from_date,
    toDate: row.to_date,
    unlockedAt: row.unlocked_at,
  };
}

/**
 * Refuse to proceed if a window overlaps a hold-out that is still locked.
 *
 * Called by anything that reads price history for research. The point is that
 * looking at held-out data has to be a deliberate act with a reason attached,
 * not something that happens because a date range was widened by accident.
 */
export async function assertNotLocked(tx: Sql, from: Date, to: Date): Promise<void> {
  const clashes = await tx.query<{ label: string; from_date: Date; to_date: Date }>(
    `select label, from_date, to_date
       from research.holdouts
      where unlocked_at is null
        and from_date <= $2 and to_date >= $1`,
    [from, to],
  );

  const clash = clashes.rows[0];
  if (clash) {
    throw new HoldoutLockedError(
      `that window overlaps the locked hold-out "${clash.label}" ` +
        `(${clash.from_date.toISOString().slice(0, 10)} to ${clash.to_date.toISOString().slice(0, 10)}). ` +
        'Unlocking is one-way: once seen, the period is in-sample forever.',
    );
  }
}

/**
 * Unlock a hold-out. One-way, recorded, and requires a reason.
 *
 * There is no re-locking. A period that has been looked at cannot be presented
 * as fresh evidence later, and the register should make that impossible to
 * forget rather than merely inadvisable.
 */
export async function unlockHoldout(
  tx: Sql,
  label: string,
  unlockedBy: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length < 10) {
    throw new Error('unlocking a hold-out needs a reason worth reading later');
  }

  const result = await tx.query(
    `update research.holdouts
        set unlocked_at = now(), unlocked_by = $2, unlock_reason = $3
      where label = $1 and unlocked_at is null`,
    [label, unlockedBy, reason],
  );

  if (result.rowCount === 0) {
    throw new Error(`no locked hold-out called "${label}"`);
  }
}
