#!/usr/bin/env node
/**
 * Run the dumb agent over a simulated stretch of days.
 *
 *   npm run demo:agent
 *
 * The point of this is not to show the agent working. It is to show the agent
 * being measured — the equity curve against buy-and-hold, on the same axis,
 * from the same start date. Build the thing that can prove the agents wrong
 * before building the agents.
 *
 * The price path is a fixed pseudo-random walk with a mild upward drift, so
 * the run is deterministic and buy-and-hold has something to earn. The
 * crossover rule pays spread, slippage and commission on every round trip.
 * Expect it to lose. If it does not, look harder at why before believing it.
 */

import { getPool, closePool, inTransaction } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import { formatGBP, parseMoney, type Minor } from '../money.js';
import { createAgent } from '../ledger/agents.js';
import { recordDeposit, allocate } from '../ledger/allocation.js';
import { start } from '../ledger/control.js';
import { addToUniverse } from '../ledger/universe.js';
import { agentEquity } from '../ledger/equity.js';
import { recordSnapshots, benchmarkComparison, benchmarkSymbol } from '../ledger/snapshots.js';
import { SmaCrossover } from '../agents/sma.js';
import { tick } from '../agents/runner.js';

const DAYS = 120;
const SYMBOL = 'AAPL';
const AGENT = 'sma-1';

function assertLocal(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`demo wipes data and refuses to run against ${url || '(unset DATABASE_URL)'}`);
  }
}

/** Deterministic walk: same series every run, so results are comparable. */
function walk(seed: number, days: number, start: number, drift: number, vol: number): number[] {
  let state = seed;
  const random = () => {
    // Mulberry32. Small, deterministic, good enough for a price path.
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

async function wipe(): Promise<void> {
  await getPool().query(`
    truncate ledger.postings, ledger.journal_entries, ledger.position_lots, ledger.fills,
             ledger.orders, ledger.accounts, ledger.agent_control_events,
             ledger.reconciliations, ledger.marks, ledger.equity_snapshots, ledger.agents
    restart identity cascade
  `);
  await getPool().query(
    `truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`,
  );
  await getPool().query(`update paper.account set cash_minor = 0`);
}

async function main(): Promise<void> {
  assertLocal();
  await wipe();

  const broker = new PaperBroker(getPool());
  const prices = walk(7, DAYS, 100, 0.0006, 0.05);
  const benchmark = walk(99, DAYS, 100, 0.0006, 0.012);

  await broker.fundAccount(parseMoney('5000.00'));
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'agent-demo');
    await createAgent(tx, { id: AGENT, name: 'Momentum' });
    await addToUniverse(tx, AGENT, SYMBOL, 'owner');
    await allocate(tx, AGENT, parseMoney('2000.00'));
    await start(tx, AGENT, 'owner');
    // Daily decisions in a simulation that runs in seconds.
    await tx.query(`update ledger.agents set min_tick_seconds = 1 where id = $1`, [AGENT]);
  });

  console.log(`Running ${AGENT} (${new SmaCrossover().name}) over ${DAYS} simulated days\n`);

  const strategy = new SmaCrossover();
  let trades = 0;

  for (let day = 0; day < DAYS; day += 1) {
    const asOf = new Date(Date.UTC(2026, 0, 1 + day));
    const price = prices[day] ?? 100;

    // Only the broker's price is set. The tick's own syncMarks writes the
    // mark, dated to the simulated day — the same path production uses, so
    // the demo is exercising the real pipeline rather than a shortcut.
    await broker.setPrice(SYMBOL, parseMoney(price.toFixed(2)), asOf);

    // The runner enforces min_tick_seconds against the wall clock, which a
    // simulated day does not advance.
    await getPool().query(`update ledger.agents set last_tick_at = null where id = $1`, [AGENT]);

    const outcome = await tick(broker, strategy, AGENT);
    for (const s of outcome.submitted) {
      trades += 1;
      console.log(`  day ${String(day).padStart(3)}  ${s.side.padEnd(4)} ${s.symbol}  ${s.why}`);
    }
    // Refusals are printed, not swallowed. A demo that only shows what went
    // through hides the case where a rail is quietly stopping the agent from
    // trading at all — which is exactly the bug this printing found.
    for (const r of outcome.refused) {
      console.log(`  day ${String(day).padStart(3)}  REFUSED ${r.symbol}  ${r.reason}`);
    }
    if (outcome.selfHalted) {
      console.log(`  day ${String(day).padStart(3)}  SELF-HALTED  ${outcome.selfHalted}`);
    }

    await inTransaction((tx) =>
      recordSnapshots(tx, parseMoney((benchmark[day] ?? 100).toFixed(2)) as Minor, asOf),
    );
  }

  const equity = await inTransaction((tx) => agentEquity(tx, AGENT));
  const comparison = await inTransaction((tx) => benchmarkComparison(tx));

  console.log(`\n${'='.repeat(64)}\nRESULT AFTER ${DAYS} DAYS\n${'='.repeat(64)}`);
  console.log(`trades placed      ${trades}`);
  console.log(`commission + fees  ${formatGBP(equity.feesMinor)}`);
  console.log(`realised P/L       ${formatGBP(equity.realisedMinor)}`);
  console.log(`agent equity       ${formatGBP(equity.equityMinor ?? 0n)} of £2000.00 allocated`);

  if (comparison) {
    console.log(`\nfund                    ${comparison.fundReturnPct.toFixed(2)}%`);
    console.log(
      `${benchmarkSymbol().padEnd(23)} ${comparison.benchmarkReturnPct.toFixed(2)}%   (buy and hold, same dates)`,
    );
    console.log(
      `difference              ${comparison.excessPct > 0 ? '+' : ''}${comparison.excessPct.toFixed(2)}%`,
    );
    console.log(
      comparison.excessPct > 0
        ? '\nAhead of buy-and-hold over this path. One path is not evidence -\nre-run with a different seed before believing it.'
        : '\nBehind buy-and-hold, which is the expected outcome. The costs above\nare most of the reason, and they are charged on every round trip.',
    );
  }
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
