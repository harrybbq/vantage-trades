/**
 * The performance view.
 *
 * Mostly about the benchmark being an honest comparison: same start date,
 * same units, and "we don't know" rather than a plausible zero.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney } from '../src/money.js';
import { statsView } from '../src/api/stats.js';
import { handle, serialise } from '../src/server/handler.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { resetData, newAgent, trade } from './helpers.js';

beforeAll(() => {
  process.env['AUTH_MODE'] = 'insecure-local';
});
beforeEach(resetData);
afterAll(closePool);

async function snapshot(
  agentId: string | null,
  day: string,
  equity: string,
  benchmark: string | null,
): Promise<void> {
  await getPool().query(
    `insert into ledger.equity_snapshots
       (agent_id, as_of, equity_minor, cash_minor, positions_minor, benchmark_symbol, benchmark_minor)
     values ($1, $2, $3, $3, 0, 'VWRP', $4)`,
    [agentId, day, parseMoney(equity).toString(), benchmark === null ? null : parseMoney(benchmark).toString()],
  );
}

describe('the equity curve', () => {
  it('says so rather than drawing a line through one point', async () => {
    const view = await inTransaction((tx) => statsView(tx));
    expect(view.fund).toEqual([]);
    expect(view.note).toMatch(/at least two reconciled days/);
  });

  it('rebases the benchmark into the same money, from the same start', async () => {
    await snapshot(null, '2026-01-01', '5000.00', '100.00');
    await snapshot(null, '2026-02-01', '5100.00', '110.00');

    const view = await inTransaction((tx) => statsView(tx));

    // £5,000 left in an index that rose 10% would be £5,500. Comparing the
    // fund's pounds against an index level of 110 would be meaningless.
    expect(view.fund[0]?.benchmarkMinor).toBe('500000');
    expect(view.fund[1]?.benchmarkMinor).toBe('550000');

    expect(view.fundReturnPct).toBe(2);
    expect(view.benchmarkReturnPct).toBe(10);
    expect(view.excessPct).toBe(-8);
  });

  it('anchors on the first point that has a benchmark price', async () => {
    // Snapshots taken before a benchmark price was available must not become
    // the baseline, or the two series end up measured over different windows.
    await snapshot(null, '2026-01-01', '5000.00', null);
    await snapshot(null, '2026-01-02', '4000.00', '100.00');
    await snapshot(null, '2026-02-01', '4400.00', '120.00');

    const view = await inTransaction((tx) => statsView(tx));

    expect(view.fund[0]?.benchmarkMinor).toBeNull();
    expect(view.fund[1]?.benchmarkMinor).toBe('400000');
    expect(view.fund[2]?.benchmarkMinor).toBe('480000');
    expect(view.benchmarkReturnPct).toBe(20);
  });

  it('reports no comparison when nothing recorded a benchmark price', async () => {
    await snapshot(null, '2026-01-01', '5000.00', null);
    await snapshot(null, '2026-02-01', '5500.00', null);

    const view = await inTransaction((tx) => statsView(tx));

    // 0% would read as "level with the index", which is a claim.
    expect(view.benchmarkReturnPct).toBeNull();
    expect(view.excessPct).toBeNull();
    expect(view.note).toMatch(/nothing to compare against/);
  });

  it('builds a curve per agent as well as for the fund', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'stats-dep');
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('2000.00'));
      await start(tx, 'momentum-1', 'owner');
    });

    await snapshot('momentum-1', '2026-01-01', '2000.00', '100.00');
    await snapshot('momentum-1', '2026-02-01', '2200.00', '110.00');
    await snapshot(null, '2026-01-01', '5000.00', '100.00');
    await snapshot(null, '2026-02-01', '5200.00', '110.00');

    const view = await inTransaction((tx) => statsView(tx));

    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.name).toBe('Momentum');
    expect(view.agents[0]?.returnPct).toBe(10);
    // Rebased against the agent's own starting capital, not the fund's.
    expect(view.agents[0]?.points[1]?.benchmarkMinor).toBe('220000');
  });
});

describe('costs and the reconciliation log', () => {
  it('totals the fees actually charged', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'fees-dep');
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('2000.00'));
      await start(tx, 'momentum-1', 'owner');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '1', '100.00', '1.50');
    });

    const view = await inTransaction((tx) => statsView(tx));
    expect(view.totalFeesMinor).toBe('150');
    expect(view.totalTrades).toBe(1);
  });

  it('shows the reconciliation history newest first', async () => {
    await getPool().query(
      `insert into ledger.reconciliations
         (run_at, as_of, broker_cash_minor, broker_equity_minor, computed_cash_minor,
          computed_equity_minor, cash_diff_minor, equity_diff_minor, status, detail)
       values
         (now() - interval '1 day', now() - interval '1 day',
          100, 100, 100, 100, 0, 0, 'ok', '{"summary":"clean"}'),
         (now(), now(), 99, 99, 100, 100, -1, -1, 'diverged', '{"summary":"a penny out"}')`,
    );

    const view = await inTransaction((tx) => statsView(tx));
    expect(view.reconciliations[0]?.status).toBe('diverged');
    expect(view.reconciliations[0]?.cashDiffMinor).toBe('-1');
  });
});

describe('over the wire', () => {
  it('serves stats as a serialisable payload', async () => {
    await snapshot(null, '2026-01-01', '5000.00', '100.00');
    await snapshot(null, '2026-02-01', '5100.00', '110.00');

    const result = await handle({
      method: 'POST',
      path: '/',
      headers: { authorization: 'Bearer local' },
      body: { action: 'stats' },
    });

    expect(result.status).toBe(200);
    expect(() => serialise(result.body)).not.toThrow();

    const parsed = JSON.parse(serialise(result.body)) as { fund: { equityMinor: unknown }[] };
    expect(typeof parsed.fund[0]?.equityMinor).toBe('string');
  });

  it('refuses stats without authentication', async () => {
    delete process.env['AUTH_MODE'];
    const result = await handle({
      method: 'POST',
      path: '/',
      headers: {},
      body: { action: 'stats' },
    });
    expect(result.status).toBe(401);
    process.env['AUTH_MODE'] = 'insecure-local';
  });
});
