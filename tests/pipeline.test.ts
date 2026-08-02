/**
 * End to end, against the simulated broker.
 *
 * This is the test the build order asks for: prove a hand-placed trade
 * attributes correctly and reconciles against the broker's own equity figure.
 * Until this passes, nothing further should be built on top.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty, formatGBP } from '../src/money.js';
import { PaperBroker, DEFAULT_COSTS } from '../src/broker/paper.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { halt, start } from '../src/ledger/control.js';
import { agentEquity } from '../src/ledger/equity.js';
import { submitOrder, findOrphanedOrders } from '../src/pipeline/submit.js';
import { syncFills, syncMarks } from '../src/pipeline/sync.js';
import { runDailyReconcile } from '../src/jobs/daily-reconcile.js';
import { resetData, newAgent } from './helpers.js';

async function resetPaper(): Promise<void> {
  await getPool().query(`
    truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade
  `);
  await getPool().query(`update paper.account set cash_minor = 0`);
}

beforeEach(async () => {
  await resetData();
  await resetPaper();
});
afterAll(closePool);

function broker(): PaperBroker {
  return new PaperBroker(getPool());
}

/**
 * Fund the brokerage account and mirror it into the ledger.
 *
 * Two separate acts, because they are two separate things: cash physically
 * arriving (a manual bank transfer, simulated here) and the ledger being told
 * that it did.
 */
async function fundBoth(amount: string): Promise<void> {
  await broker().fundAccount(parseMoney(amount));
  await inTransaction((tx) =>
    recordDeposit(tx, parseMoney(amount), new Date(), `bank-transfer-${amount}`),
  );
}

describe('a hand-placed trade, end to end', () => {
  it('attributes to the right agent and reconciles against the broker', async () => {
    await fundBoth('5000.00');

    await inTransaction(async (tx) => {
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('2000.00'));
      await start(tx, 'momentum-1', 'owner');
    });

    await broker().setPrice('AAPL', parseMoney('100.00'));

    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('4'),
      idempotencyKey: 'e2e-buy-1',
    });

    const synced = await syncFills(broker());
    expect(synced.recorded).toBe(1);
    expect(synced.unattributable).toEqual([]);

    await syncMarks(broker());

    // The fill is attributed, priced above mid because of spread and slippage,
    // and carries the commission.
    const equity = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    expect(equity.holdings).toHaveLength(1);
    expect(equity.holdings[0]?.symbol).toBe('AAPL');
    expect(equity.feesMinor).toBe(DEFAULT_COSTS.commissionMinor);
    expect(equity.positionsBookMinor).toBeGreaterThan(parseMoney('400.00'));

    const clean = await runDailyReconcile(broker());
    expect(clean).toBe(true);
  });

  it('reconciles with two agents holding the same symbol', async () => {
    await fundBoth('5000.00');

    await inTransaction(async (tx) => {
      for (const id of ['momentum-1', 'value-1']) {
        await newAgent(tx, id);
        await allocate(tx, id, parseMoney('2000.00'));
        await start(tx, id, 'owner');
      }
    });

    await broker().setPrice('AAPL', parseMoney('100.00'));

    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('4'),
      idempotencyKey: 'e2e-shared-1',
    });

    await broker().setPrice('AAPL', parseMoney('80.00'));
    await submitOrder(broker(), {
      agentId: 'value-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('5'),
      idempotencyKey: 'e2e-shared-2',
    });

    await syncFills(broker());
    await syncMarks(broker());

    // The broker sees one position of 9. The ledger knows whose is whose.
    const brokerPositions = await broker().getPositions();
    expect(brokerPositions).toEqual([{ symbol: 'AAPL', qty: parseQty('9') }]);

    const momentum = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    const value = await inTransaction((tx) => agentEquity(tx, 'value-1'));
    expect(momentum.holdings[0]?.qty).toBe(parseQty('4'));
    expect(value.holdings[0]?.qty).toBe(parseQty('5'));

    // Bought at different prices, so different cost bases behind one broker
    // position. This difference is the entire product.
    //
    // Compared per share, not per holding: 4 at ~£100 and 5 at ~£80 come to
    // almost the same total, which would make a total-value comparison pass or
    // fail on a rounding penny rather than on the thing being tested.
    const momentumUnitCost = momentum.positionsBookMinor / 4n;
    const valueUnitCost = value.positionsBookMinor / 5n;
    expect(momentumUnitCost).toBeGreaterThan(valueUnitCost);
    expect(momentumUnitCost).toBe(parseMoney('100.07'));
    expect(valueUnitCost).toBe(parseMoney('80.06'));

    expect(await runDailyReconcile(broker())).toBe(true);
  });

  it('still reconciles after a partial sell', async () => {
    await fundBoth('5000.00');
    await inTransaction(async (tx) => {
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('2000.00'));
      await start(tx, 'momentum-1', 'owner');
    });

    await broker().setPrice('AAPL', parseMoney('100.00'));
    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('10'),
      idempotencyKey: 'e2e-partial-buy',
    });
    await syncFills(broker());

    await broker().setPrice('AAPL', parseMoney('130.00'));
    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'sell',
      qty: parseQty('3'),
      idempotencyKey: 'e2e-partial-sell',
    });
    await syncFills(broker());
    await syncMarks(broker());

    const equity = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    expect(equity.holdings[0]?.qty).toBe(parseQty('7'));
    expect(equity.realisedMinor).toBeGreaterThan(0n);

    expect(await runDailyReconcile(broker())).toBe(true);
  });
});

describe('the paper broker models costs rather than idealising them', () => {
  it('fills a buy above mid and a sell below it', async () => {
    await broker().fundAccount(parseMoney('10000.00'));
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await broker().placeOrder({
      agentId: 'x',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('1'),
      idempotencyKey: 'cost-buy',
    });
    await broker().placeOrder({
      agentId: 'x',
      symbol: 'AAPL',
      side: 'sell',
      qty: parseQty('1'),
      idempotencyKey: 'cost-sell',
    });

    const fills = await broker().getFills(new Date(0));
    const buy = fills.find((f) => f.side === 'buy');
    const sell = fills.find((f) => f.side === 'sell');

    // A round trip at an unchanged price must lose money. A simulator that
    // fills at mid makes negative-expectancy strategies look profitable.
    expect(buy!.pricePerUnitMinor).toBeGreaterThan(parseMoney('100.00'));
    expect(sell!.pricePerUnitMinor).toBeLessThan(parseMoney('100.00'));

    const account = await broker().getAccount();
    expect(account.cashMinor).toBeLessThan(parseMoney('10000.00'));
  });

  it('refuses a buy the account cannot afford', async () => {
    await broker().fundAccount(parseMoney('100.00'));
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await broker().placeOrder({
      agentId: 'x',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('10'),
      idempotencyKey: 'too-big',
    });

    const orders = await getPool().query<{ status: string; reject_reason: string }>(
      `select status, reject_reason from paper.orders`,
    );
    expect(orders.rows[0]?.status).toBe('rejected');
    expect(orders.rows[0]?.reject_reason).toMatch(/insufficient buying power/);
  });

  it('refuses to short', async () => {
    await broker().fundAccount(parseMoney('1000.00'));
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await broker().placeOrder({
      agentId: 'x',
      symbol: 'AAPL',
      side: 'sell',
      qty: parseQty('1'),
      idempotencyKey: 'short-it',
    });

    const orders = await getPool().query<{ status: string; reject_reason: string }>(
      `select status, reject_reason from paper.orders`,
    );
    expect(orders.rows[0]?.reject_reason).toMatch(/insufficient position/);
  });

  it('treats a repeated idempotency key as the same order', async () => {
    await broker().fundAccount(parseMoney('10000.00'));
    await broker().setPrice('AAPL', parseMoney('100.00'));

    const request = {
      agentId: 'x',
      symbol: 'AAPL',
      side: 'buy' as const,
      qty: parseQty('1'),
      idempotencyKey: 'retry-me',
    };

    const first = await broker().placeOrder(request);
    const second = await broker().placeOrder(request);

    expect(second.brokerOrderId).toBe(first.brokerOrderId);
    const fills = await broker().getFills(new Date(0));
    expect(fills).toHaveLength(1);
  });
});

describe('the submission path', () => {
  it('will not place an order for a halted agent', async () => {
    await fundBoth('1000.00');
    await inTransaction(async (tx) => {
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('500.00'));
      await start(tx, 'momentum-1', 'owner');
      await halt(tx, 'momentum-1', 'owner', 'stop');
    });
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await expect(
      submitOrder(broker(), {
        agentId: 'momentum-1',
        symbol: 'AAPL',
        side: 'buy',
        qty: parseQty('1'),
        idempotencyKey: 'halted-submit',
      }),
    ).rejects.toThrow(/not running/);

    // Nothing reached the broker: the ledger write is first for exactly this
    // reason.
    const orders = await getPool().query<{ n: string }>(
      `select count(*)::text as n from paper.orders`,
    );
    expect(orders.rows[0]?.n).toBe('0');
  });

  it('reports an unattributable fill rather than guessing whose it is', async () => {
    await fundBoth('5000.00');
    await broker().setPrice('AAPL', parseMoney('100.00'));

    // A fill placed directly at the broker, with no corresponding ledger order
    // — what a manual trade in the broker's own UI would look like.
    await broker().placeOrder({
      agentId: 'not-in-the-ledger',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('1'),
      idempotencyKey: 'placed-outside',
    });

    const result = await syncFills(broker());
    expect(result.recorded).toBe(0);
    expect(result.unattributable).toHaveLength(1);

    // And it must not quietly pass reconciliation.
    expect(await runDailyReconcile(broker())).toBe(false);
  });

  it('leaves no orphaned orders on the happy path', async () => {
    await fundBoth('2000.00');
    await inTransaction(async (tx) => {
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('1000.00'));
      await start(tx, 'momentum-1', 'owner');
    });
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('1'),
      idempotencyKey: 'clean-submit',
    });

    expect(await findOrphanedOrders(0)).toEqual([]);
  });
});

describe('reconciliation catches real divergence', () => {
  it('notices when the broker holds something the ledger does not', async () => {
    await fundBoth('5000.00');
    await inTransaction(async (tx) => {
      await newAgent(tx, 'momentum-1', 'Momentum');
      await allocate(tx, 'momentum-1', parseMoney('2000.00'));
      await start(tx, 'momentum-1', 'owner');
    });
    await broker().setPrice('AAPL', parseMoney('100.00'));

    await submitOrder(broker(), {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('4'),
      idempotencyKey: 'diverge-buy',
    });
    await syncFills(broker());
    await syncMarks(broker());
    expect(await runDailyReconcile(broker())).toBe(true);

    // Now something happens at the broker that the ledger never hears about:
    // a corporate action, a manual trade, a bug.
    await getPool().query(
      `update paper.positions set qty = qty + 1, cost_total_minor = cost_total_minor + 10000
        where symbol = 'AAPL'`,
    );

    expect(await runDailyReconcile(broker())).toBe(false);

    const last = await getPool().query<{ status: string; detail: { symbolDiffs: unknown[] } }>(
      `select status, detail from ledger.reconciliations order by run_at desc limit 1`,
    );
    expect(last.rows[0]?.status).toBe('diverged');
    expect(last.rows[0]?.detail.symbolDiffs).toHaveLength(1);
  });

  it('notices a single missing penny of cash', async () => {
    await fundBoth('1000.00');
    await getPool().query(`update paper.account set cash_minor = cash_minor - 1`);

    expect(await runDailyReconcile(broker())).toBe(false);

    const last = await getPool().query<{ cash_diff_minor: bigint }>(
      `select cash_diff_minor from ledger.reconciliations order by run_at desc limit 1`,
    );
    expect(last.rows[0]?.cash_diff_minor).toBe(-1n);
  });
});

describe('fractional shares across two agents', () => {
  it('reconciles despite per-agent rounding', async () => {
    await fundBoth('5000.00');
    await inTransaction(async (tx) => {
      for (const id of ['a-1', 'b-2']) {
        await newAgent(tx, id);
        await allocate(tx, id, parseMoney('2000.00'));
        await start(tx, id, 'owner');
      }
    });

    // A price and quantities chosen so that rounding each agent's slice
    // separately does not equal rounding the total.
    await broker().setPrice('AAPL', parseMoney('33.33'));
    await submitOrder(broker(), {
      agentId: 'a-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('0.5'),
      idempotencyKey: 'frac-a',
    });
    await submitOrder(broker(), {
      agentId: 'b-2',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('0.5'),
      idempotencyKey: 'frac-b',
    });

    await syncFills(broker());
    await syncMarks(broker());

    expect(await runDailyReconcile(broker())).toBe(true);
  });
});

describe('the money the owner actually sees', () => {
  it('reports in pounds', async () => {
    await fundBoth('1234.56');
    const account = await broker().getAccount();
    expect(formatGBP(account.cashMinor)).toBe('£1234.56');
  });
});
