/**
 * The comparison the whole app is for: each agent against the same money put
 * into VWRP on the same days.
 *
 * The version this replaces anchored VWRP as a lump sum on day one, so every
 * top-up afterwards counted as the agent beating the market. Most of these
 * tests are some form of "money in is not a gain".
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closePool, getPool, inTransaction } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { buildSeries, performanceView } from '../src/api/performance.js';
import { readiness, activity } from '../src/api/insights.js';
import { controlPanelView } from '../src/api/view.js';
import { allocate, recordDeposit } from '../src/ledger/allocation.js';
import { PaperBroker } from '../src/broker/paper.js';
import { resetData, fundedAgent, trade, newAgent } from './helpers.js';
import { start } from '../src/ledger/control.js';

const gbp = (pounds: number) => BigInt(Math.round(pounds * 100));
const at = (iso: string) => new Date(iso);
const noTimes = new Map<string, Date>();

describe('the same-money comparison', () => {
  it('does not count a top-up as a gain', () => {
    // £1,000 on Monday, £500 more on Tuesday, and the market did nothing.
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(1500), bench: gbp(100) },
      ],
      [
        { at: at('2026-09-28T09:00:00Z'), amount: gbp(1000) },
        { at: at('2026-09-29T09:00:00Z'), amount: gbp(500) },
      ],
      [],
      noTimes,
    );

    expect(points[1]).toMatchObject({ twrPct: 0, dayPnlMinor: '0', putInMinor: '150000', shadowMinor: '150000' });
  });

  it('buys VWRP with each top-up at that day’s price', () => {
    // VWRP rises 10%, and £500 more goes in at the higher price. Doing nothing
    // would have made £1,000 × 1.1 + £500 = £1,600.
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(1650), bench: gbp(110) },
      ],
      [{ at: at('2026-09-29T09:00:00Z'), amount: gbp(500) }],
      [],
      noTimes,
    );

    expect(points[1]!.shadowMinor).toBe('160000');
    expect(points[1]!.dayPnlMinor).toBe(String(gbp(150)));
    expect(points[1]!.benchPct).toBeCloseTo(10, 6);
    expect(points[1]!.twrPct).toBeCloseTo(15, 6);
  });

  it('files money moved on a day with no snapshot under the next snapshot', () => {
    // Tuesday's check failed, so there is no Tuesday point. The £500 given on
    // Tuesday belongs to Wednesday's — filed under Tuesday it would land
    // nowhere and turn up as Wednesday's "gain".
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-30', equity: gbp(1500), bench: gbp(100) },
      ],
      [{ at: at('2026-09-29T09:00:00Z'), amount: gbp(500) }],
      [],
      noTimes,
    );

    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ twrPct: 0, dayPnlMinor: '0', putInMinor: '50000' });
  });

  it('counts money moved after the evening check towards the next day', () => {
    // The snapshot is taken at the check. A transfer recorded at 23:00 is not
    // in that evening's figures.
    const times = new Map([['2026-09-28', at('2026-09-28T22:37:00Z')]]);
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(1500), bench: gbp(100) },
      ],
      [
        { at: at('2026-09-28T09:00:00Z'), amount: gbp(1000) },
        { at: at('2026-09-28T23:00:00Z'), amount: gbp(500) },
      ],
      [],
      times,
    );

    expect(points[0]!.putInMinor).toBe('100000');
    expect(points[1]).toMatchObject({ putInMinor: '150000', dayPnlMinor: '0', twrPct: 0 });
  });

  it('holds money for VWRP until there is a price to buy it at', () => {
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(1500), bench: null },
        { day: '2026-09-30', equity: gbp(1500), bench: gbp(120) },
      ],
      [{ at: at('2026-09-29T09:00:00Z'), amount: gbp(500) }],
      [],
      noTimes,
    );

    expect(points[1]!.shadowMinor).toBeNull();
    expect(points[1]!.benchPct).toBeNull();
    // £1,000 at 100 → 10 units, worth 1,200 at 120; £500 bought at 120.
    expect(points[2]!.shadowMinor).toBe('170000');
  });

  it('takes capital back out of the shadow too', () => {
    const points = buildSeries(
      [
        { day: '2026-09-28', equity: gbp(1000), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(600), bench: gbp(100) },
      ],
      [{ at: at('2026-09-29T09:00:00Z'), amount: -gbp(400) }],
      [],
      noTimes,
    );
    expect(points[1]).toMatchObject({ shadowMinor: '60000', dayPnlMinor: '0', twrPct: 0 });
  });

  it('starts the comparison at the first day VWRP has a price', () => {
    const points = buildSeries(
      [
        { day: '2026-09-25', equity: gbp(1000), bench: null },
        { day: '2026-09-28', equity: gbp(1010), bench: gbp(100) },
        { day: '2026-09-29', equity: gbp(1010), bench: gbp(101) },
      ],
      [{ at: at('2026-09-25T09:00:00Z'), amount: gbp(1000) }],
      [],
      noTimes,
    );

    expect(points.map((p) => p.date)).toEqual(['2026-09-28', '2026-09-29']);
    expect(points[0]).toMatchObject({ twrPct: 0, benchPct: 0, shadowMinor: '101000', putInMinor: '100000' });
  });

  it('draws nothing at all without a VWRP price', () => {
    expect(buildSeries([{ day: '2026-09-28', equity: gbp(1000), bench: null }], [], [], noTimes)).toEqual([]);
  });
});

describe('the read models, against the ledger', () => {
  beforeEach(async () => {
    await resetData();
    await getPool().query(`truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`);
    await getPool().query(`update paper.account set cash_minor = 0`);
  });
  afterAll(closePool);

  async function snapshot(agentId: string | null, day: string, equity: string, bench: string): Promise<void> {
    await getPool().query(
      `insert into ledger.equity_snapshots (agent_id, as_of, equity_minor, cash_minor, positions_minor, benchmark_symbol, benchmark_minor)
       values ($1, $2, $3, 0, 0, 'VWRP', $4)`,
      [agentId, day, parseMoney(equity).toString(), parseMoney(bench).toString()],
    );
  }

  /** An agent given money on the dates given, as the ledger would have recorded it. */
  async function datedAgent(id: string, moves: [string, string][]): Promise<void> {
    await inTransaction(async (tx) => {
      await newAgent(tx, id);
      const total = moves.reduce((sum, [, amount]) => sum + parseMoney(amount), 0n);
      await recordDeposit(tx, total, at(moves[0]![0]), `deposit-${id}`);
      for (const [when, amount] of moves) await allocate(tx, id, parseMoney(amount), at(when));
      await start(tx, id, 'test');
    });
  }

  it('builds a series per agent from its own allocations', async () => {
    await datedAgent('momentum-1', [
      ['2026-09-28T09:00:00Z', '1000.00'],
      ['2026-09-29T09:00:00Z', '500.00'],
    ]);
    await snapshot('momentum-1', '2026-09-28', '1000.00', '100.00');
    await snapshot('momentum-1', '2026-09-29', '1500.00', '100.00');

    const view = await inTransaction((tx) => performanceView(tx));
    const series = view.agents.find((a) => a.id === 'momentum-1');
    expect(series?.points.map((p) => [p.date, p.putInMinor, p.twrPct, p.shadowMinor])).toEqual([
      ['2026-09-28', '100000', 0, '100000'],
      ['2026-09-29', '150000', 0, '150000'],
    ]);
  });

  it('counts a clean-night streak back from the latest weekday', async () => {
    const night = (iso: string, status: string) =>
      getPool().query(
        `insert into ledger.reconciliations (run_at, as_of, broker_cash_minor, broker_equity_minor, computed_cash_minor,
           computed_equity_minor, cash_diff_minor, equity_diff_minor, status)
         values ($1, $1, 0, 0, 0, ${status === 'ok' ? '0' : 'null'}, 0, ${status === 'ok' ? '0' : 'null'}, $2)`,
        [iso, status],
      );
    // Mon–Thu clean, Fri clean then an error that same evening: Friday counts
    // as an error night, and the streak stops before it.
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) await night(`${d}T22:37:00Z`, 'ok');
    await night('2026-10-02T22:37:00Z', 'ok');
    await night('2026-10-02T22:38:00Z', 'error');

    const r = await inTransaction((tx) => readiness(tx, new Date('2026-10-03T10:00:00Z')));
    expect(r.cleanStreak).toBe(0);

    await getPool().query(`delete from ledger.reconciliations where status = 'error'`);
    const again = await inTransaction((tx) => readiness(tx, new Date('2026-10-03T10:00:00Z')));
    expect(again.cleanStreak).toBe(5);
  });

  it('splits a shared holding between its owners, beside what the broker holds', async () => {
    const broker = new PaperBroker(getPool());
    await broker.fundAccount(parseMoney('2000.00'));
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await fundedAgent(tx, 'meanrev-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'meanrev-1', 'buy', 'AAPL', '3', '100.00');
    });

    const view = await inTransaction((tx) => controlPanelView(tx));
    const aapl = view.ownership.symbols.find((s) => s.symbol === 'AAPL');
    expect(aapl?.owners.map((o) => [o.agentId, o.qty])).toEqual([
      ['meanrev-1', '3.00000000'],
      ['momentum-1', '4.00000000'],
    ]);
    expect(aapl?.ledgerQty).toBe('7.00000000');
    // Trades written straight to the ledger never reached the broker: the
    // mismatch is exactly what this table exists to show.
    expect(aapl?.brokerQty).toBe('0.00000000');
    expect(parseQty(aapl!.ledgerQty)).toBeGreaterThan(0n);
  });

  it("does not report a top-up as today's gain", async () => {
    await datedAgent('momentum-1', [['2020-01-01T09:00:00Z', '1000.00']]);
    await snapshot('momentum-1', '2020-01-01', '1000.00', '100.00');
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('500.00'), new Date(), 'more');
      await allocate(tx, 'momentum-1', parseMoney('500.00'));
    });

    const view = await inTransaction((tx) => controlPanelView(tx));
    const agent = view.agents.find((a) => a.id === 'momentum-1');
    expect(agent?.todayMinor).toBe('0');
    expect(agent?.pnlPctToday).toBe(0);
  });

  it('lists money, controls and checks as one feed, newest first', async () => {
    await inTransaction((tx) => fundedAgent(tx, 'momentum-1', '1000.00'));
    const items = await inTransaction((tx) => activity(tx));
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Started');
    expect(titles).toContain('Gave it £1,000.00 from the pool');
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse());
  });
});
