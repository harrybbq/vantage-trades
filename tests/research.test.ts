/**
 * The research discipline.
 *
 * These tests are about the register refusing to let you fool yourself: the
 * hypothesis cannot be edited after the result, the bar rises with the number
 * of things tried, and held-out data cannot be quietly re-locked once seen.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney } from '../src/money.js';
import { SmaCrossover } from '../src/agents/sma.js';
import type { PriceBar } from '../src/agents/types.js';
import { backtest } from '../src/research/backtest.js';
import { computeMetrics, assessSignificance, normalQuantile } from '../src/research/metrics.js';
import {
  registerExperiment,
  completeExperiment,
  trialCount,
  createHoldout,
  unlockHoldout,
  assertNotLocked,
  getHoldout,
  currentSignificance,
  HoldoutLockedError,
} from '../src/research/register.js';

function series(closes: number[]): PriceBar[] {
  return closes.map((c, i) => ({
    asOf: new Date(Date.UTC(2026, 0, i + 1)),
    closeMinor: BigInt(Math.round(c * 100)),
  }));
}

beforeEach(async () => {
  await getPool().query(`truncate research.experiments, research.holdouts cascade`);
});
afterAll(closePool);

describe('metrics', () => {
  it('reports a flat curve as no Sharpe rather than an infinite one', () => {
    const flat = computeMetrics([100000n, 100000n, 100000n], 0);
    // Zero variance is an absence of evidence, not perfect risk-adjusted return.
    expect(flat.sharpe).toBeNull();
    expect(flat.returnPct).toBe(0);
  });

  it('measures drawdown from the peak, not from the start', () => {
    const m = computeMetrics([100000n, 120000n, 60000n, 90000n], 0);
    expect(m.maxDrawdownPct).toBe(50); // 120k down to 60k
  });

  it('computes a plausible normal quantile', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.96, 2);
    expect(normalQuantile(0.995)).toBeCloseTo(2.576, 2);
  });
});

describe('significance', () => {
  it('raises the bar as more strategies are tried', () => {
    const one = assessSignificance(1.0, 252, 1);
    const twenty = assessSignificance(1.0, 252, 20);

    // Test twenty things and the winner has to clear a visibly higher bar,
    // because one of twenty clears the ordinary bar by luck.
    expect(twenty.requiredT).toBeGreaterThan(one.requiredT);
    expect(one.requiredT).toBeCloseTo(1.96, 1);
  });

  it('says how many years a Sharpe would need', () => {
    const s = assessSignificance(0.5, 252, 1);
    // t = S x sqrt(years); for t = 1.96 at S = 0.5 that is about 15 years.
    expect(s.yearsNeeded).toBeGreaterThan(13);
    expect(s.yearsNeeded).toBeLessThan(18);
    expect(s.significant).toBe(false);
  });

  it('refuses to call a short winning run significant', () => {
    // Six months of daily decisions has essentially no power, however good
    // the number looks.
    const s = assessSignificance(1.2, 125, 8);
    expect(s.significant).toBe(false);
    expect(s.verdict).toMatch(/not distinguishable from luck/i);
  });

  it('says nothing at all when there is no Sharpe', () => {
    const s = assessSignificance(null, 0, 1);
    expect(s.significant).toBe(false);
    expect(s.tStat).toBeNull();
  });

  it('does not test a losing strategy for significance', () => {
    const s = assessSignificance(-0.4, 500, 3);
    expect(s.significant).toBe(false);
    expect(s.verdict).toMatch(/nothing here to test/);
  });
});

describe('the backtester', () => {
  const strategy = new SmaCrossover({ window: 5, maxInvestedPct: 80 });

  it('charges costs, so a whipsawing series loses money', () => {
    // Up and down through its own average repeatedly: many round trips, no
    // net move in the price.
    const closes: number[] = [];
    for (let i = 0; i < 60; i += 1) closes.push(i % 10 < 5 ? 100 : 108);

    const result = backtest({
      strategy,
      bars: new Map([['AAPL', series(closes)]]),
      universe: ['AAPL'],
      startingCashMinor: parseMoney('2000.00'),
    });

    expect(result.trades).toBeGreaterThan(2);
    expect(BigInt(result.feesMinor)).toBeGreaterThan(0n);
    // Automation industrialises whatever edge you have. With none, it just
    // industrialises the costs.
    expect(result.returnPct).toBeLessThan(0);
  });

  it('compares against buy-and-hold over the same dates', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const result = backtest({
      strategy,
      bars: new Map([['AAPL', series(closes)]]),
      universe: ['AAPL'],
      startingCashMinor: parseMoney('2000.00'),
      benchmark: series(closes),
    });

    expect(result.benchmarkReturnPct).toBeCloseTo(39, 0);
    expect(result.excessPct).not.toBeNull();
    // A rule that is only ever partly invested cannot beat a straight line up.
    expect(result.excessPct!).toBeLessThan(0);
  });

  it('refuses misaligned series rather than silently shifting prices', () => {
    expect(() =>
      backtest({
        strategy,
        bars: new Map([
          ['AAPL', series([1, 2, 3])],
          ['MSFT', series([1, 2])],
        ]),
        universe: ['AAPL', 'MSFT'],
        startingCashMinor: parseMoney('1000.00'),
      }),
    ).toThrow(/same dates/);
  });

  it('never lets a strategy see a bar that has not happened yet', () => {
    // A strategy that would be extremely profitable if it could peek.
    const seen: number[] = [];
    const spy = {
      name: 'spy',
      decide: (state: { history: Map<string, PriceBar[]> }) => {
        seen.push(state.history.get('AAPL')?.length ?? 0);
        return [];
      },
    };

    backtest({
      strategy: spy,
      bars: new Map([['AAPL', series([1, 2, 3, 4, 5])]]),
      universe: ['AAPL'],
      startingCashMinor: parseMoney('1000.00'),
    });

    // One bar on the first day, five on the last. Never six.
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the experiment register', () => {
  const base = {
    name: 'sma-20 on AAPL',
    strategy: 'sma',
    params: { window: 20 },
    hypothesis: 'A 20-day crossover beats buy-and-hold after costs on this universe.',
    universe: ['AAPL'],
    trainFrom: new Date('2026-01-01'),
    trainTo: new Date('2026-06-01'),
    registeredBy: 'owner',
  };

  it('requires a hypothesis worth writing down', async () => {
    await expect(
      inTransaction((tx) => registerExperiment(tx, { ...base, hypothesis: 'it works' })),
    ).rejects.toThrow(/real hypothesis/);
  });

  it('freezes the hypothesis once registered', async () => {
    const id = await inTransaction((tx) => registerExperiment(tx, base));

    // Editing the hypothesis after seeing the result is the exact failure this
    // table exists to prevent.
    await expect(
      getPool().query(`update research.experiments set hypothesis = $2 where id = $1`, [
        id,
        'I always thought this one would lose, actually.',
      ]),
    ).rejects.toThrow(/fixed at registration/);
  });

  it('refuses to change the parameters after the fact', async () => {
    const id = await inTransaction((tx) => registerExperiment(tx, base));
    await expect(
      getPool().query(`update research.experiments set params = '{"window": 30}' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/fixed at registration/);
  });

  it('cannot be deleted', async () => {
    await inTransaction((tx) => registerExperiment(tx, base));
    await expect(getPool().query(`delete from research.experiments`)).rejects.toThrow(
      /permanent record/,
    );
  });

  it('refuses a second result, so a bad run cannot be re-rolled', async () => {
    const id = await inTransaction((tx) => registerExperiment(tx, base));
    const result = backtest({
      strategy: new SmaCrossover({ window: 5 }),
      bars: new Map([['AAPL', series(Array.from({ length: 30 }, (_, i) => 100 + i))]]),
      universe: ['AAPL'],
      startingCashMinor: parseMoney('2000.00'),
    });

    await inTransaction((tx) => completeExperiment(tx, id, result));
    await expect(inTransaction((tx) => completeExperiment(tx, id, result))).rejects.toThrow(
      /already has a result/,
    );
  });

  it('judges each result against everything tried so far', async () => {
    const result = backtest({
      strategy: new SmaCrossover({ window: 5 }),
      bars: new Map([['AAPL', series(Array.from({ length: 300 }, (_, i) => 100 + i * 0.3))]]),
      universe: ['AAPL'],
      startingCashMinor: parseMoney('2000.00'),
    });

    const first = await inTransaction(async (tx) => {
      const id = await registerExperiment(tx, base);
      return completeExperiment(tx, id, result);
    });

    for (let i = 0; i < 15; i += 1) {
      await inTransaction((tx) => registerExperiment(tx, { ...base, name: `variant ${i}` }));
    }

    const later = await inTransaction(async (tx) => {
      const id = await registerExperiment(tx, { ...base, name: 'the winner' });
      return completeExperiment(tx, id, result);
    });

    // Same result, higher bar, because sixteen more things were tried.
    expect(later.significance.requiredT).toBeGreaterThan(first.significance.requiredT);
    expect(await inTransaction((tx) => trialCount(tx))).toBe(17);

    // And the FIRST experiment is now judged against all seventeen too. It
    // was completed when only one existed, but if it were picked as the best
    // of the search, the size of that search is what matters — not the order
    // things happened to run in.
    const reassessed = await inTransaction((tx) => currentSignificance(tx, first.id));
    expect(reassessed.trials).toBe(17);
    expect(reassessed.requiredT).toBeGreaterThan(first.significance.requiredT);
  });
});

describe('the hold-out lock', () => {
  it('refuses a window that overlaps locked data', async () => {
    await inTransaction((tx) =>
      createHoldout(tx, '2026-H2', new Date('2026-07-01'), new Date('2026-12-31'), 'owner'),
    );

    await expect(
      inTransaction((tx) =>
        assertNotLocked(tx, new Date('2026-06-01'), new Date('2026-08-01')),
      ),
    ).rejects.toBeInstanceOf(HoldoutLockedError);

    // A window entirely before it is fine.
    await expect(
      inTransaction((tx) => assertNotLocked(tx, new Date('2026-01-01'), new Date('2026-06-30'))),
    ).resolves.toBeUndefined();
  });

  it('requires a reason to unlock', async () => {
    await inTransaction((tx) =>
      createHoldout(tx, '2026-H2', new Date('2026-07-01'), new Date('2026-12-31'), 'owner'),
    );
    await expect(
      inTransaction((tx) => unlockHoldout(tx, '2026-H2', 'owner', 'why not')),
    ).rejects.toThrow(/reason worth reading/);
  });

  it('lets the window through once unlocked, and records who did it', async () => {
    await inTransaction((tx) =>
      createHoldout(tx, '2026-H2', new Date('2026-07-01'), new Date('2026-12-31'), 'owner'),
    );
    await inTransaction((tx) =>
      unlockHoldout(tx, '2026-H2', 'owner', 'Committed to the sma-20 rule; evaluating it once.'),
    );

    await expect(
      inTransaction((tx) => assertNotLocked(tx, new Date('2026-06-01'), new Date('2026-08-01'))),
    ).resolves.toBeUndefined();

    const holdout = await inTransaction((tx) => getHoldout(tx, '2026-H2'));
    expect(holdout?.unlockedAt).not.toBeNull();
  });

  it('cannot be re-locked once seen', async () => {
    await inTransaction((tx) =>
      createHoldout(tx, '2026-H2', new Date('2026-07-01'), new Date('2026-12-31'), 'owner'),
    );
    await inTransaction((tx) =>
      unlockHoldout(tx, '2026-H2', 'owner', 'Committed to the rule; evaluating it once.'),
    );

    // Once looked at, a period is in-sample forever. Pretending otherwise
    // later is the whole failure mode.
    await expect(
      getPool().query(`update research.holdouts set unlocked_at = null where label = '2026-H2'`),
    ).rejects.toThrow(/already been unlocked/);
  });

  it('cannot have its window moved', async () => {
    await inTransaction((tx) =>
      createHoldout(tx, '2026-H2', new Date('2026-07-01'), new Date('2026-12-31'), 'owner'),
    );
    await expect(
      getPool().query(`update research.holdouts set to_date = '2026-09-01' where label = '2026-H2'`),
    ).rejects.toThrow(/cannot be moved/);
  });
});
