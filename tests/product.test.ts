/**
 * What the first real paper run depends on: the do-nothing agent, limits the
 * owner can set, alerts, and a checklist that an empty ledger cannot pass.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { closePool, getPool, inTransaction } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { PaperBroker } from '../src/broker/paper.js';
import { HoldBenchmark } from '../src/agents/hold.js';
import type { StrategyInput } from '../src/agents/types.js';
import { createAgent } from '../src/ledger/agents.js';
import { allocate, recordDeposit } from '../src/ledger/allocation.js';
import { start, setLimits } from '../src/ledger/control.js';
import { runAllAgents, strategyFor } from '../src/jobs/run-agents.js';
import { runDailyReconcile } from '../src/jobs/daily-reconcile.js';
import { agentEquity } from '../src/ledger/equity.js';
import { readiness, activity } from '../src/api/insights.js';
import { doSetLimits, doCreateAgent, ValidationError } from '../src/api/actions.js';
import { notify, alertChannel } from '../src/alerts/notify.js';
import { weeklyDigest } from '../src/alerts/digest.js';
import { resetData, fundedAgent, trade } from './helpers.js';

const broker = () => new PaperBroker(getPool());

beforeEach(async () => {
  await resetData();
  await getPool().query(`truncate ledger.equity_snapshots`);
  await getPool().query(`truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`);
  await getPool().query(`update paper.account set cash_minor = 0`);
});
afterAll(closePool);

const input = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  asOf: new Date(),
  universe: ['VWRP'],
  history: new Map([['VWRP', [{ asOf: new Date(), closeMinor: 14000n }]]]),
  positions: new Map(),
  cashMinor: parseMoney('500.00'),
  allocatedMinor: parseMoney('500.00'),
  ...over,
});

describe('the hold-the-benchmark rule', () => {
  const hold = new HoldBenchmark('VWRP');

  it('puts its cash into the benchmark', () => {
    expect(hold.decide(input())).toEqual([
      expect.objectContaining({ action: 'buy', symbol: 'VWRP', notionalMinor: parseMoney('500.00') }),
    ]);
  });

  it('never sells, whatever the price has done', () => {
    const intents = hold.decide(
      input({ cashMinor: 0n, positions: new Map([['VWRP', parseQty('3')]]), history: new Map([['VWRP', [{ asOf: new Date(), closeMinor: 7000n }]]]) }),
    );
    expect(intents).toEqual([]);
  });

  it('does not churn the few pounds left over after a buy', () => {
    // £15 of a £500 allocation: investing it would pay a commission on pennies.
    expect(hold.decide(input({ cashMinor: parseMoney('15.00') }))).toEqual([]);
  });

  it('buys again when it is given real new money', () => {
    expect(hold.decide(input({ cashMinor: parseMoney('200.00'), allocatedMinor: parseMoney('700.00') }))).toHaveLength(1);
  });

  it('does nothing without a price, or without permission', () => {
    expect(hold.decide(input({ history: new Map() }))).toEqual([]);
    expect(hold.decide(input({ universe: ['AAPL'] }))).toEqual([]);
  });
});

describe('a hold agent, end to end', () => {
  async function ready(): Promise<void> {
    await broker().fundAccount(parseMoney('500.00'));
    await broker().setPrice('VWRP', parseMoney('140.00'));
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('500.00'), new Date(), 'first');
      await createAgent(tx, { id: 'hold-1', name: 'Hold VWRP', strategy: 'hold' });
      await allocate(tx, 'hold-1', parseMoney('500.00'));
      await start(tx, 'hold-1', 'owner');
    });
  }

  it('is created with the benchmark as its only permitted share, no cap, and one order allowed to be everything', async () => {
    await inTransaction((tx) => createAgent(tx, { id: 'hold-1', name: 'Hold VWRP', strategy: 'hold' }));
    const row = await getPool().query(
      `select strategy, max_order_pct::text as ord, daily_loss_cap_pct as cap, status from ledger.agents where id = 'hold-1'`,
    );
    expect(row.rows[0]).toEqual({ strategy: 'hold', ord: '100.00', cap: null, status: 'idle' });
    const uni = await getPool().query(`select symbol from ledger.agent_universe where agent_id = 'hold-1'`);
    expect(uni.rows).toEqual([{ symbol: 'VWRP' }]);
  });

  it('buys the benchmark once, holds it, and reconciles', async () => {
    await ready();
    await runAllAgents(broker());

    const equity = await inTransaction((tx) => agentEquity(tx, 'hold-1'));
    expect(equity.holdings.map((h) => h.symbol)).toEqual(['VWRP']);
    // Almost all of it invested; a few percent held back for the spread.
    expect(equity.cashMinor).toBeLessThan(parseMoney('30.00'));
    expect(equity.cashMinor).toBeGreaterThanOrEqual(0n);

    // A second run on the same day's price places nothing more.
    await getPool().query(`update ledger.agents set last_tick_at = null`);
    await runAllAgents(broker());
    const orders = await getPool().query<{ n: string }>(`select count(*)::text as n from ledger.orders`);
    expect(orders.rows[0]?.n).toBe('1');
    expect(await runDailyReconcile(broker())).toBe(true);
  });

  it('refuses to run an agent whose rule it does not know', () => {
    expect(() => strategyFor({ id: 'x-1', strategy: 'martingale' })).toThrow(/unknown strategy/);
  });
});

describe('new agents', () => {
  it('get a daily loss cap by default', async () => {
    await inTransaction((tx) => createAgent(tx, { id: 'momentum-1', name: 'Momentum' }));
    const row = await getPool().query(`select daily_loss_cap_pct::text as cap, strategy from ledger.agents`);
    expect(row.rows[0]).toEqual({ cap: '3.00', strategy: 'sma' });
  });

  it('cannot be created with a rule that does not exist', async () => {
    await expect(doCreateAgent({ id: 'x-1', name: 'X', strategy: 'yolo' }, 'owner')).rejects.toThrow(ValidationError);
  });
});

describe('setting limits', () => {
  beforeEach(() => inTransaction((tx) => createAgent(tx, { id: 'momentum-1', name: 'Momentum' })));

  it('changes them and records what they were and became', async () => {
    const view = await doSetLimits({ agentId: 'momentum-1', dailyLossCapPct: '2.5', maxOrderPct: 20 }, 'owner');
    const agent = view.agents.find((a) => a.id === 'momentum-1');
    expect(agent).toMatchObject({ dailyLossCapPct: 2.5, maxOrderPct: 20 });

    const feed = await inTransaction((tx) => activity(tx));
    const item = feed.find((i) => i.title === 'Changed its limits');
    expect(item?.tags.join(' ')).toMatch(/daily loss cap 3% → 2.5%; largest order 25% → 20%/);
  });

  it('allows the cap to be removed, and says so in the record', async () => {
    await doSetLimits({ agentId: 'momentum-1', dailyLossCapPct: null, maxOrderPct: 25 }, 'owner');
    const feed = await inTransaction((tx) => activity(tx));
    expect(feed.find((i) => i.title === 'Changed its limits')?.tags.join(' ')).toMatch(/3% → none/);
  });

  it('refuses nonsense', async () => {
    for (const bad of [
      { dailyLossCapPct: 0, maxOrderPct: 25 },
      { dailyLossCapPct: 101, maxOrderPct: 25 },
      { dailyLossCapPct: 3, maxOrderPct: 0 },
      { dailyLossCapPct: 3, maxOrderPct: 150 },
      { dailyLossCapPct: 'lots', maxOrderPct: 25 },
      { dailyLossCapPct: 3, maxOrderPct: '1e2' },
    ]) {
      await expect(doSetLimits({ agentId: 'momentum-1', ...bad }, 'owner')).rejects.toThrow(ValidationError);
    }
    await expect(inTransaction((tx) => setLimits(tx, 'momentum-1', { dailyLossCapPct: 2.555, maxOrderPct: 25 }, 'owner'))).rejects.toThrow(/two decimal/);
  });
});

describe('the real-money checklist', () => {
  const night = (iso: string) =>
    getPool().query(
      `insert into ledger.reconciliations (run_at, as_of, broker_cash_minor, broker_equity_minor, computed_cash_minor,
         computed_equity_minor, cash_diff_minor, equity_diff_minor, status) values ($1, $1, 0, 0, 0, 0, 0, 0, 'ok')`,
      [iso],
    );
  const fundDay = (day: string) =>
    getPool().query(
      `insert into ledger.equity_snapshots (agent_id, as_of, equity_minor, cash_minor, positions_minor) values (null, $1, 0, 0, 0)`,
      [day],
    );

  it('gives an empty ledger no credit, however long it has reconciled clean', async () => {
    // What the live database looked like: months of snapshots and clean
    // checks on a fund that had never held anything.
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
      await night(`${d}T22:37:00Z`);
      await fundDay(d);
    }
    const r = await inTransaction((tx) => readiness(tx, new Date('2026-10-03T10:00:00Z')));
    expect(r.tradingDays).toBe(0);
    expect(r.cleanStreak).toBe(0);
  });

  it('starts counting at the first trade', async () => {
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
      await night(`${d}T22:37:00Z`);
      await fundDay(d);
    }
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '1', '100.00');
    });
    await getPool().query(`update ledger.fills set filled_at = '2026-09-30T10:00:00Z'`);

    const r = await inTransaction((tx) => readiness(tx, new Date('2026-10-03T10:00:00Z')));
    expect(r.tradingDays).toBe(3);
    expect(r.cleanStreak).toBe(3);
  });

  it('does not ask a hold agent for a loss cap', async () => {
    await inTransaction(async (tx) => {
      await createAgent(tx, { id: 'hold-1', name: 'Hold', strategy: 'hold' });
      await createAgent(tx, { id: 'momentum-1', name: 'Momentum' });
    });
    const r = await inTransaction((tx) => readiness(tx));
    expect([r.agentsWithLimits, r.agentsActive]).toEqual([1, 1]);
  });
});

describe('alerts', () => {
  const ok = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const TOPIC = 'vt-9f3k2m7q8x1c5v6b4n0z';

  it('says nothing is configured rather than pretending to send', async () => {
    const fake = ok();
    expect(await notify({ title: 't', body: 'b' }, {}, fake as unknown as typeof fetch)).toBe('unconfigured');
    expect(fake).not.toHaveBeenCalled();
    expect(alertChannel({})).toBeNull();
  });

  it('pushes to the topic, with an ASCII title', async () => {
    const fake = ok();
    const result = await notify({ title: 'Vantage Trades: check — failed', body: 'détail', urgent: true }, { ALERT_NTFY_TOPIC: TOPIC }, fake as unknown as typeof fetch);
    expect(result).toBe('sent');
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(init.headers.Title).toBe('Vantage Trades: check  failed');
    expect(init.headers.Priority).toBe('high');
    expect(init.body).toBe('détail');
  });

  it('refuses a topic short enough to guess', async () => {
    const fake = ok();
    expect(await notify({ title: 't', body: 'b' }, { ALERT_NTFY_TOPIC: 'harry' }, fake as unknown as typeof fetch)).toBe('failed');
    expect(fake).not.toHaveBeenCalled();
  });

  it('emails when that is what is set up', async () => {
    const fake = ok();
    const env = { RESEND_API_KEY: 're_test', ALERT_EMAIL: 'owner@example.com' };
    expect(alertChannel(env)).toBe('email');
    expect(await notify({ title: 'Subject', body: 'Body' }, env, fake as unknown as typeof fetch)).toBe('sent');
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(init.body)).toMatchObject({ to: ['owner@example.com'], subject: 'Subject', text: 'Body' });
  });

  it('never throws, even when the service is down', async () => {
    const down = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await notify({ title: 't', body: 'b' }, { ALERT_NTFY_TOPIC: TOPIC }, down as unknown as typeof fetch)).toBe('failed');
    const refused = vi.fn().mockResolvedValue(new Response('no', { status: 429 }));
    expect(await notify({ title: 't', body: 'b' }, { ALERT_NTFY_TOPIC: TOPIC }, refused as unknown as typeof fetch)).toBe('failed');
  });
});

describe('the weekly summary', () => {
  it('is not sent for an empty fund', async () => {
    expect(await inTransaction((tx) => weeklyDigest(tx))).toBeNull();
  });

  it('says what each agent is, what needs the owner, and that it is paper', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('500.00'), new Date(), 'first');
      await createAgent(tx, { id: 'hold-1', name: 'Hold VWRP', strategy: 'hold' });
      await allocate(tx, 'hold-1', parseMoney('400.00'));
      await start(tx, 'hold-1', 'owner');
      await fundedAgent(tx, 'momentum-1', '100.00');
    });
    await getPool().query(`update ledger.agents set status = 'halted' where id = 'momentum-1'`);

    const digest = await inTransaction((tx) => weeklyDigest(tx));
    expect(digest?.title).toMatch(/needs you/);
    expect(digest?.body).toMatch(/Hold VWRP \(running\): £400\.00.*it is the benchmark/);
    expect(digest?.body).toMatch(/momentum-1 is halted/);
    expect(digest?.body).toMatch(/never been checked/);
    expect(digest?.body).toMatch(/Paper money/);
  });
});
