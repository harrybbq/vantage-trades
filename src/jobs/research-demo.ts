#!/usr/bin/env node
/**
 * What searching for a strategy actually looks like.
 *
 *   npm run demo:research
 *
 * Registers a dozen variants of the same rule, runs them all on the training
 * window, and picks the winner — the exact thing everybody does. Then it shows
 * two things that are usually invisible:
 *
 *   1. how much worse the winner's result looks once you account for having
 *      tried twelve things to find it
 *   2. how it does on data it has never seen
 *
 * The gap between those two numbers is the whole reason this tooling exists.
 */

import { getPool, closePool, inTransaction } from '../db.js';
import { formatGBP, parseMoney } from '../money.js';
import type { PriceBar } from '../agents/types.js';
import { SmaCrossover } from '../agents/sma.js';
import { backtest } from '../research/backtest.js';
import {
  registerExperiment,
  completeExperiment,
  createHoldout,
  unlockHoldout,
  assertNotLocked,
  trialCount,
  currentSignificance,
  HoldoutLockedError,
} from '../research/register.js';

const TRAIN_DAYS = 400;
const HOLDOUT_DAYS = 200;
const WINDOWS = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80];

function assertLocal(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`demo wipes data and refuses to run against ${url || '(unset DATABASE_URL)'}`);
  }
}

function walk(seed: number, days: number, start: number, drift: number, vol: number): number[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  let price = start;
  for (let i = 0; i < days; i += 1) {
    price = Math.max(1, price * (1 + drift + (random() - 0.5) * vol));
    out.push(Math.round(price * 100) / 100);
  }
  return out;
}

function toBars(closes: number[], offset = 0): PriceBar[] {
  return closes.map((c, i) => ({
    asOf: new Date(Date.UTC(2024, 0, 1 + offset + i)),
    closeMinor: BigInt(Math.round(c * 100)),
  }));
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(70)}\n${text}\n${'='.repeat(70)}`);
}

async function main(): Promise<void> {
  assertLocal();
  await getPool().query(`truncate research.experiments, research.holdouts cascade`);

  // One price path. The first stretch is what you get to look at; the rest is
  // sealed until you have committed to something.
  const all = walk(2026, TRAIN_DAYS + HOLDOUT_DAYS, 100, 0.0004, 0.035);
  const trainCloses = all.slice(0, TRAIN_DAYS);
  const holdoutCloses = all.slice(TRAIN_DAYS);

  const trainBars = toBars(trainCloses);
  const holdoutBars = toBars(holdoutCloses, TRAIN_DAYS);

  const holdFrom = holdoutBars[0]!.asOf;
  const holdTo = holdoutBars[holdoutBars.length - 1]!.asOf;

  heading('1. SEAL THE HOLD-OUT BEFORE LOOKING AT ANYTHING');
  await inTransaction((tx) => createHoldout(tx, 'phase-1', holdFrom, holdTo, 'owner'));
  console.log(
    `${HOLDOUT_DAYS} days sealed (${holdFrom.toISOString().slice(0, 10)} to ${holdTo.toISOString().slice(0, 10)}).`,
  );
  console.log('Unlocking is one-way. Once seen, it is in-sample forever.');

  heading(`2. SEARCH: ${WINDOWS.length} VARIANTS ON THE TRAINING WINDOW`);
  const results: { window: number; id: string; returnPct: number; sharpe: number | null }[] = [];

  for (const window of WINDOWS) {
    const strategy = new SmaCrossover({ window });

    // Registered BEFORE it runs, with what you expect. Doing this after the
    // fact is how the hypothesis drifts to match the result.
    const id = await inTransaction((tx) =>
      registerExperiment(tx, {
        name: `sma-${window} on SYNTH`,
        strategy: 'sma',
        params: { window },
        hypothesis: `A ${window}-day crossover beats buy-and-hold after costs on the training window.`,
        universe: ['SYNTH'],
        trainFrom: trainBars[0]!.asOf,
        trainTo: trainBars[trainBars.length - 1]!.asOf,
        registeredBy: 'owner',
      }),
    );

    const result = backtest({
      strategy,
      bars: new Map([['SYNTH', trainBars]]),
      universe: ['SYNTH'],
      startingCashMinor: parseMoney('2000.00'),
      benchmark: trainBars,
    });

    await inTransaction((tx) => completeExperiment(tx, id, result));
    results.push({ window, id, returnPct: result.returnPct, sharpe: result.sharpe });

    console.log(
      `  sma-${String(window).padStart(2)}   return ${result.returnPct.toFixed(2).padStart(7)}%   ` +
        `sharpe ${(result.sharpe ?? 0).toFixed(2).padStart(6)}   trades ${String(result.trades).padStart(3)}`,
    );
  }

  const benchmarkTrain = backtest({
    strategy: new SmaCrossover({ window: 5 }),
    bars: new Map([['SYNTH', trainBars]]),
    universe: ['SYNTH'],
    startingCashMinor: parseMoney('2000.00'),
    benchmark: trainBars,
  }).benchmarkReturnPct;

  console.log(`\n  buy and hold  ${(benchmarkTrain ?? 0).toFixed(2)}%`);

  const winner = [...results].sort((a, b) => (b.sharpe ?? -99) - (a.sharpe ?? -99))[0]!;

  heading('3. THE WINNER, AND WHAT IT IS WORTH');
  console.log(`Best of ${WINDOWS.length}: sma-${winner.window}`);
  console.log(`  return ${winner.returnPct.toFixed(2)}%   sharpe ${(winner.sharpe ?? 0).toFixed(2)}`);

  // Judged against all twelve, not against however many had finished when
  // this one did. It was chosen as the best of twelve.
  const significance = await inTransaction((tx) => currentSignificance(tx, winner.id));
  console.log(`\n  trials registered: ${await inTransaction((tx) => trialCount(tx))}`);
  console.log(`  ${significance.verdict}`);

  heading('4. TRY TO PEEK AT THE HOLD-OUT');
  try {
    await inTransaction((tx) => assertNotLocked(tx, holdFrom, holdTo));
    console.log('  !! the lock let it through, which should be impossible');
  } catch (error) {
    if (error instanceof HoldoutLockedError) console.log(`  refused: ${error.message}`);
    else throw error;
  }

  heading('5. COMMIT, UNLOCK ONCE, AND SEE');
  await inTransaction((tx) =>
    unlockHoldout(
      tx,
      'phase-1',
      'owner',
      `Committed to sma-${winner.window} after the search above. Evaluating it once.`,
    ),
  );
  await inTransaction((tx) => assertNotLocked(tx, holdFrom, holdTo));

  const outOfSample = backtest({
    strategy: new SmaCrossover({ window: winner.window }),
    bars: new Map([['SYNTH', holdoutBars]]),
    universe: ['SYNTH'],
    startingCashMinor: parseMoney('2000.00'),
    benchmark: holdoutBars,
  });

  console.log(`  sma-${winner.window} on data it has never seen:`);
  console.log(`    return          ${outOfSample.returnPct.toFixed(2)}%`);
  console.log(`    buy and hold    ${(outOfSample.benchmarkReturnPct ?? 0).toFixed(2)}%`);
  console.log(`    difference      ${(outOfSample.excessPct ?? 0).toFixed(2)}%`);
  console.log(`    costs paid      ${formatGBP(BigInt(outOfSample.feesMinor))} over ${outOfSample.trades} trades`);

  const inSample = winner.returnPct;
  const out = outOfSample.returnPct;

  heading('WHAT THIS MEANS');
  console.log(`in sample (chosen from ${WINDOWS.length})   ${inSample.toFixed(2)}%`);
  console.log(`out of sample                  ${out.toFixed(2)}%`);
  console.log(`decay                          ${(out - inSample).toFixed(2)} points`);
  console.log(
    '\nThe in-sample number was picked as the best of twelve. Some of what\n' +
      'made it best was the rule, and some was luck fitting this particular\n' +
      'path. Only the out-of-sample number was not chosen for looking good,\n' +
      'and even that is one path through one market.\n\n' +
      'The hold-out is now spent. Judging anything else on it means judging\n' +
      'it on data that has been seen.',
  );
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
