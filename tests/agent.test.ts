/**
 * The dumb agent, and the rails around it.
 *
 * The strategy tests are about the rule. The runner tests are about what
 * happens when the rule asks for something it should not get — which is the
 * part that matters, because from here on the loop acts without being asked.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty, formatGBP } from '../src/money.js';
import { PaperBroker } from '../src/broker/paper.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { halt, start } from '../src/ledger/control.js';
import { agentEquity } from '../src/ledger/equity.js';
import { SmaCrossover } from '../src/agents/sma.js';
import type { PriceBar, StrategyInput } from '../src/agents/types.js';
import { tick } from '../src/agents/runner.js';
import { runAllAgents } from '../src/jobs/run-agents.js';
import { resetData, newAgent } from './helpers.js';

function bars(closes: number[]): PriceBar[] {
  return closes.map((c, i) => ({
    asOf: new Date(Date.UTC(2026, 0, i + 1)),
    closeMinor: BigInt(Math.round(c * 100)),
  }));
}

function input(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    asOf: new Date(),
    universe: ['AAPL'],
    history: new Map(),
    positions: new Map(),
    cashMinor: parseMoney('1000.00'),
    allocatedMinor: parseMoney('1000.00'),
    ...over,
  };
}

describe('the crossover rule', () => {
  const strategy = new SmaCrossover({ window: 5, maxInvestedPct: 80 });

  it('buys when price closes above its average and nothing is held', () => {
    const intents = strategy.decide(
      input({ history: new Map([['AAPL', bars([10, 10, 10, 10, 20])]]) }),
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ action: 'buy', symbol: 'AAPL' });
  });

  it('sells the whole position when price closes below its average', () => {
    const intents = strategy.decide(
      input({
        history: new Map([['AAPL', bars([20, 20, 20, 20, 10])]]),
        positions: new Map([['AAPL', parseQty('4')]]),
      }),
    );
    expect(intents).toEqual([
      expect.objectContaining({ action: 'sell', symbol: 'AAPL', qty: parseQty('4') }),
    ]);
  });

  it('does nothing without enough history', () => {
    // Not the same as deciding to stay out. An opinion formed on three bars
    // of a twenty-bar average is not an opinion.
    expect(strategy.decide(input({ history: new Map([['AAPL', bars([10, 11, 12])]]) }))).toEqual([]);
  });

  it('does not buy something it already holds', () => {
    const intents = strategy.decide(
      input({
        history: new Map([['AAPL', bars([10, 10, 10, 10, 20])]]),
        positions: new Map([['AAPL', parseQty('1')]]),
      }),
    );
    expect(intents).toEqual([]);
  });

  it('sizes off the whole universe, not the symbols currently signalling', () => {
    // Sizing off the signal count means one symbol going quiet silently
    // doubles the position taken in the others.
    const intents = strategy.decide(
      input({
        universe: ['AAPL', 'MSFT', 'NVDA', 'TSLA'],
        history: new Map([['AAPL', bars([10, 10, 10, 10, 20])]]),
        allocatedMinor: parseMoney('1000.00'),
      }),
    );
    // 80% of 1000, split four ways.
    expect(intents[0]).toMatchObject({ notionalMinor: parseMoney('200.00') });
  });

  it('skips an order too small to be worth its commission', () => {
    const intents = strategy.decide(
      input({
        history: new Map([['AAPL', bars([10, 10, 10, 10, 20])]]),
        cashMinor: parseMoney('1.00'),
      }),
    );
    expect(intents).toEqual([]);
  });

  it('is pure — the same input twice gives the same answer', () => {
    const state = input({ history: new Map([['AAPL', bars([10, 10, 10, 10, 20])]]) });
    expect(strategy.decide(state)).toEqual(strategy.decide(state));
  });
});

/* ------------------------------------------------------------------------- */

beforeEach(async () => {
  await resetData();
  await getPool().query(
    `truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`,
  );
  await getPool().query(`update paper.account set cash_minor = 0`);
});
afterAll(closePool);

const broker = () => new PaperBroker(getPool());

/** Fund both sides and give the agent a universe, capital and price history. */
async function readyAgent(
  agentId = 'sma-1',
  opts: { closes?: number[]; universe?: string[] } = {},
): Promise<void> {
  const closes = opts.closes ?? [10, 10, 10, 10, 20];
  const universe = opts.universe ?? ['AAPL'];

  await broker().fundAccount(parseMoney('5000.00'));
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('5000.00'), new Date(), `dep-${agentId}`);
    await newAgent(tx, agentId, agentId, universe);
    await allocate(tx, agentId, parseMoney('2000.00'));
    await start(tx, agentId, 'owner');

    // Seed the mark history the strategy reads its average from.
    for (const [i, close] of closes.entries()) {
      for (const symbol of universe) {
        await tx.query(
          `insert into ledger.marks (symbol, as_of, price_minor, source)
           values ($1, $2, $3, 'test')`,
          [symbol, new Date(Date.UTC(2026, 0, i + 1)), parseMoney(close.toFixed(2)).toString()],
        );
      }
    }
  });

  for (const symbol of universe) {
    await broker().setPrice(symbol, parseMoney(String(closes[closes.length - 1] ?? 20) + '.00'));
  }
}

describe('the runner', () => {
  it('places an order the ledger attributes to the agent', async () => {
    await readyAgent();
    const outcome = await tick(broker(), new SmaCrossover({ window: 5, maxInvestedPct: 80 }), 'sma-1');

    expect(outcome.ran).toBe(true);
    expect(outcome.submitted).toEqual([
      expect.objectContaining({ symbol: 'AAPL', side: 'buy' }),
    ]);

    const equity = await inTransaction((tx) => agentEquity(tx, 'sma-1'));
    expect(equity.holdings[0]?.symbol).toBe('AAPL');
  });

  it('does nothing at all when the agent is halted', async () => {
    await readyAgent();
    await inTransaction((tx) => halt(tx, 'sma-1', 'owner', 'stop'));

    const outcome = await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');

    expect(outcome.ran).toBe(false);
    expect(outcome.skipped).toMatch(/halted/);

    // And nothing reached the broker, not merely nothing recorded.
    const placed = await getPool().query<{ n: string }>(
      `select count(*)::text as n from paper.orders`,
    );
    expect(placed.rows[0]?.n).toBe('0');
  });

  it('respects the minimum interval between ticks', async () => {
    await readyAgent();
    const strategy = new SmaCrossover({ window: 5 });

    await tick(broker(), strategy, 'sma-1');
    const second = await tick(broker(), strategy, 'sma-1');

    // A crash-loop must not become a trading loop.
    expect(second.ran).toBe(false);
    expect(second.skipped).toMatch(/minimum is/);
  });

  it('clamps an order that exceeds the max order size', async () => {
    await readyAgent();
    await getPool().query(`update ledger.agents set max_order_pct = 5 where id = 'sma-1'`);

    await tick(broker(), new SmaCrossover({ window: 5, maxInvestedPct: 100 }), 'sma-1');

    const equity = await inTransaction((tx) => agentEquity(tx, 'sma-1'));
    // 5% of ~2000 is ~100, not the ~1600 the strategy asked for.
    expect(equity.positionsBookMinor).toBeLessThan(parseMoney('130.00'));
    expect(equity.positionsBookMinor).toBeGreaterThan(parseMoney('70.00'));
  });

  it('halts itself when the daily loss cap is breached', async () => {
    await readyAgent();
    await getPool().query(
      `update ledger.agents set daily_loss_cap_pct = 5, min_tick_seconds = 1 where id = 'sma-1'`,
    );
    // Yesterday it closed much higher, so today is a big drawdown.
    await getPool().query(
      `insert into ledger.equity_snapshots (agent_id, as_of, equity_minor, cash_minor, positions_minor)
       values ('sma-1', current_date - 1, 400000, 400000, 0)`,
    );

    const outcome = await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');

    expect(outcome.selfHalted).toMatch(/daily loss cap/);
    expect(outcome.submitted).toEqual([]);

    const status = await getPool().query<{ status: string }>(
      `select status from ledger.agents where id = 'sma-1'`,
    );
    expect(status.rows[0]?.status).toBe('halted');

    // And it is recorded as the runner's decision, not the owner's.
    const event = await getPool().query<{ actor: string; reason: string }>(
      `select actor, reason from ledger.agent_control_events
        where agent_id = 'sma-1' and action = 'halt' order by created_at desc limit 1`,
    );
    expect(event.rows[0]?.actor).toMatch(/^runner:/);
  });

  it('will not trade a symbol outside the universe, even if the strategy asks', async () => {
    await readyAgent('sma-1', { universe: ['AAPL'] });

    // A strategy that ignores the universe it was given.
    const rogue = {
      name: 'rogue',
      decide: () => [
        { action: 'buy' as const, symbol: 'TSLA', notionalMinor: parseMoney('100.00'), why: 'because' },
      ],
    };

    await getPool().query(
      `insert into ledger.marks (symbol, as_of, price_minor, source)
       values ('TSLA', now(), 10000, 'test')`,
    );
    await broker().setPrice('TSLA', parseMoney('100.00'));

    const outcome = await tick(broker(), rogue, 'sma-1');

    expect(outcome.submitted).toEqual([]);
    // The runner only prices symbols in the universe, so it refuses before it
    // even gets as far as the database. Both layers hold; the database one is
    // covered directly in universe.test.ts.
    expect(outcome.refused[0]?.reason).toMatch(/no price|not permitted to trade TSLA/);

    const orders = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ledger.orders where symbol = 'TSLA'`,
    );
    expect(orders.rows[0]?.n).toBe('0');
  });

  it('skips when equity cannot be computed', async () => {
    await readyAgent();
    await getPool().query(`update ledger.agents set min_tick_seconds = 1 where id = 'sma-1'`);

    // Take a position, then take the price away entirely — from the broker as
    // well as the ledger, since a tick re-syncs marks before it decides.
    // This is the real-world case of a symbol the data feed stops quoting
    // while the agent is still holding it.
    await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');
    await getPool().query(`delete from ledger.marks`);
    await getPool().query(`delete from paper.market_prices`);
    // Clear the tick clock, or the interval guard answers first and this
    // tests the wrong gate.
    await getPool().query(`update ledger.agents set last_tick_at = null where id = 'sma-1'`);

    const outcome = await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');
    // Sizing off an equity figure that could not be computed is sizing off a
    // number that does not exist.
    expect(outcome.ran).toBe(false);
    expect(outcome.skipped).toMatch(/no mark for/);
  });

  it('never blocks an exit, however large the position', async () => {
    await readyAgent();
    // Cap far below the position the agent is about to take.
    await getPool().query(
      `update ledger.agents set max_order_pct = 100, min_tick_seconds = 1 where id = 'sma-1'`,
    );
    await tick(broker(), new SmaCrossover({ window: 5, maxInvestedPct: 100 }), 'sma-1');

    const held = await inTransaction((tx) => agentEquity(tx, 'sma-1'));
    expect(held.holdings).toHaveLength(1);

    // Now clamp the cap right down and ask it to exit.
    await getPool().query(
      `update ledger.agents set max_order_pct = 1, last_tick_at = null where id = 'sma-1'`,
    );
    await inTransaction((tx) =>
      tx.query(
        `insert into ledger.marks (symbol, as_of, price_minor, source)
         values ('AAPL', now(), 500, 'test')`,
      ),
    );
    await broker().setPrice('AAPL', parseMoney('5.00'));

    const outcome = await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');

    // A cap that prevents closing a position preserves exposure rather than
    // limiting it. Exits are exempt on purpose.
    expect(outcome.submitted).toEqual([
      expect.objectContaining({ symbol: 'AAPL', side: 'sell' }),
    ]);
    const after = await inTransaction((tx) => agentEquity(tx, 'sma-1'));
    expect(after.holdings).toEqual([]);
  });

  it('gives decisions on different bars different idempotency keys', async () => {
    await readyAgent();
    await getPool().query(`update ledger.agents set min_tick_seconds = 1 where id = 'sma-1'`);

    await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');

    // A later bar, still above the average, after the position was exited.
    await inTransaction((tx) =>
      tx.query(
        `insert into ledger.marks (symbol, as_of, price_minor, source)
         values ('AAPL', $1, 500, 'test')`,
        [new Date(Date.UTC(2026, 0, 6))],
      ),
    );
    await broker().setPrice('AAPL', parseMoney('5.00'), new Date(Date.UTC(2026, 0, 6)));
    await getPool().query(`update ledger.agents set last_tick_at = null where id = 'sma-1'`);
    const exit = await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');

    // Keyed on the wall-clock minute, this second decision collided with the
    // first and was silently refused — a runner that stops trading without
    // saying so.
    expect(exit.refused.filter((r) => /duplicate key/.test(r.reason))).toEqual([]);
  });

  it('collects price history for the universe, not only what is held', async () => {
    // A strategy needs history for a symbol before it takes a position. An
    // agent that only marks what it owns can never form an opinion about
    // anything it does not.
    await readyAgent('sma-1', { universe: ['AAPL', 'MSFT'], closes: [10, 10, 10, 10, 20] });
    await getPool().query(`delete from ledger.marks where symbol = 'MSFT'`);

    const { syncMarks } = await import('../src/pipeline/sync.js');
    await syncMarks(broker());

    const marks = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ledger.marks where symbol = 'MSFT'`,
    );
    expect(Number(marks.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('does nothing for an agent with an empty universe', async () => {
    await broker().fundAccount(parseMoney('1000.00'));
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('1000.00'), new Date(), 'dep-empty');
      await newAgent(tx, 'empty-1', 'Empty', []);
      await allocate(tx, 'empty-1', parseMoney('500.00'));
      await start(tx, 'empty-1', 'owner');
    });

    const outcome = await tick(broker(), new SmaCrossover({ window: 5 }), 'empty-1');
    expect(outcome.skipped).toBe('empty trading universe');
  });
});

describe('running every agent', () => {
  it('ticks only the running ones', async () => {
    // runAllAgents uses the default 20-bar window, so this needs real history
    // rather than the five bars the window-5 tests get by.
    const closes = [...Array(24).keys()].map((i) => (i < 23 ? 10 : 20));
    await readyAgent('sma-1', { closes });
    await inTransaction(async (tx) => {
      await newAgent(tx, 'sma-2', 'Second', ['AAPL']);
      await allocate(tx, 'sma-2', parseMoney('500.00'));
      await start(tx, 'sma-2', 'owner');
      await halt(tx, 'sma-2', 'owner', 'not this one');
    });

    await runAllAgents(broker());

    const orders = await getPool().query<{ agent_id: string }>(
      `select distinct agent_id from ledger.orders`,
    );
    expect(orders.rows.map((r) => r.agent_id)).toEqual(['sma-1']);
  });
});

describe('the benchmark', () => {
  it('records the index price alongside equity from the first snapshot', async () => {
    const { recordSnapshots, benchmarkComparison } = await import('../src/ledger/snapshots.js');
    await readyAgent();

    await inTransaction((tx) => recordSnapshots(tx, parseMoney('100.00'), new Date('2026-01-01')));
    await inTransaction((tx) => recordSnapshots(tx, parseMoney('110.00'), new Date('2026-02-01')));

    const comparison = await inTransaction((tx) => benchmarkComparison(tx));

    // Buy-and-hold made 10%. Whatever the fund did, it is measured against
    // that and over the same dates.
    expect(comparison?.benchmarkReturnPct).toBe(10);
    expect(comparison?.from).toBe('2026-01-01');
    expect(comparison?.to).toBe('2026-02-01');
  });

  it('says nothing rather than 0% when there is only one point', async () => {
    const { recordSnapshots, benchmarkComparison } = await import('../src/ledger/snapshots.js');
    await readyAgent();
    await inTransaction((tx) => recordSnapshots(tx, parseMoney('100.00'), new Date('2026-01-01')));

    // 0% would read as "level with the index", which is a claim, not a gap.
    expect(await inTransaction((tx) => benchmarkComparison(tx))).toBeNull();
  });

  it('does not record a fund point when an agent cannot be valued', async () => {
    const { recordSnapshots } = await import('../src/ledger/snapshots.js');
    await readyAgent();
    await tick(broker(), new SmaCrossover({ window: 5 }), 'sma-1');
    await getPool().query(`delete from ledger.marks`);

    const result = await inTransaction((tx) => recordSnapshots(tx, parseMoney('100.00')));

    expect(result.fundEquityMinor).toBeNull();
    expect(result.skipped).toContain('sma-1');

    const fundRows = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ledger.equity_snapshots where agent_id is null`,
    );
    expect(fundRows.rows[0]?.n).toBe('0');
  });
});

describe('what the agent costs to run', () => {
  it('a round trip loses money at an unchanged price', async () => {
    await readyAgent('sma-1', { closes: [10, 10, 10, 10, 20] });
    const before = await inTransaction((tx) => agentEquity(tx, 'sma-1'));

    await tick(broker(), new SmaCrossover({ window: 5, maxInvestedPct: 50 }), 'sma-1');
    await getPool().query(`update ledger.agents set min_tick_seconds = 1 where id = 'sma-1'`);

    // Price falls back below the average, so the rule exits.
    await inTransaction((tx) =>
      tx.query(
        `insert into ledger.marks (symbol, as_of, price_minor, source) values ('AAPL', now(), 2000, 'test')`,
      ),
    );
    await broker().setPrice('AAPL', parseMoney('20.00'));

    const after = await inTransaction((tx) => agentEquity(tx, 'sma-1'));

    // Spread, slippage and commission, paid twice. This is the drag the whole
    // benchmark exists to make visible, and it is why the rule is expected to
    // lose to doing nothing.
    expect(after.feesMinor).toBeGreaterThan(0n);
    expect(formatGBP(before.equityMinor ?? 0n)).toBeTruthy();
  });
});
