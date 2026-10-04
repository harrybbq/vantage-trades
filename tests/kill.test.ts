/**
 * Kill, end to end against the simulated broker.
 *
 * Kill used to refuse whenever the agent held anything — which is every time
 * it matters — and leave the agent running. These are the cases that have to
 * work before an agent is ever switched on: positions held, a share another
 * agent also owns, a halted agent, a holding with no price, and a kill on top
 * of an order still in flight.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { PaperBroker } from '../src/broker/paper.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { halt, start, globalHalt } from '../src/ledger/control.js';
import { createOrder } from '../src/ledger/orders.js';
import { submitOrder } from '../src/pipeline/submit.js';
import { syncFills } from '../src/pipeline/sync.js';
import { kill } from '../src/pipeline/kill.js';
import { runDailyReconcile } from '../src/jobs/daily-reconcile.js';
import { resetData, newAgent } from './helpers.js';

const broker = () => new PaperBroker(getPool());
let n = 0;

beforeEach(async () => {
  await resetData();
  await getPool().query(`truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`);
  await getPool().query(`update paper.account set cash_minor = 0`);
  await broker().fundAccount(parseMoney('10000.00'));
  await inTransaction((tx) => recordDeposit(tx, parseMoney('10000.00'), new Date(), 'bank-transfer'));
  await broker().setPrice('AAPL', parseMoney('100.00'));
  await broker().setPrice('MSFT', parseMoney('200.00'));
});
afterAll(closePool);

async function runningAgent(id: string, capital = '2000.00'): Promise<void> {
  await inTransaction(async (tx) => {
    await newAgent(tx, id);
    await allocate(tx, id, parseMoney(capital));
    await start(tx, id, 'test');
  });
}

async function buy(agentId: string, symbol: string, qty: string): Promise<void> {
  const r = await submitOrder(broker(), { agentId, symbol, side: 'buy', qty: parseQty(qty), idempotencyKey: `t${n++}` });
  expect(r.rejectedReason).toBeUndefined();
  await syncFills(broker());
}

const status = async (id: string) =>
  (await getPool().query<{ status: string }>('select status from ledger.agents where id = $1', [id])).rows[0]?.status;
const brokerQty = async (symbol: string) =>
  (await getPool().query<{ qty: string }>('select qty::text as qty from paper.positions where symbol = $1', [symbol])).rows[0]?.qty ?? '0';
const ledgerQty = async (agentId: string, symbol: string) =>
  (await getPool().query<{ qty: string }>('select qty::text as qty from ledger.agent_positions where agent_id = $1 and symbol = $2', [agentId, symbol])).rows[0]?.qty ?? '0';
const poolMinor = async () =>
  (await getPool().query<{ balance_minor: bigint }>(`select balance_minor from ledger.account_balances where kind = 'pool'`)).rows[0]?.balance_minor;

describe('killing an agent', () => {
  it('sells everything it holds, returns its cash to the pool, and reconciles', async () => {
    await runningAgent('momentum-1');
    await buy('momentum-1', 'AAPL', '4');
    await buy('momentum-1', 'MSFT', '2');

    const outcome = await kill(broker(), 'momentum-1', 'owner');

    expect(outcome.done).toBe(true);
    expect(outcome.sold.map((s) => s.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(await status('momentum-1')).toBe('killed');
    expect(Number(await brokerQty('AAPL'))).toBe(0);
    expect(Number(await brokerQty('MSFT'))).toBe(0);
    // 8000 never allocated plus whatever the sales and leftover cash came to.
    expect(await poolMinor()).toBe(800000n + outcome.returnedMinor);
    expect(outcome.returnedMinor).toBeGreaterThan(190000n);
    expect(await runDailyReconcile(broker())).toBe(true);
  });

  it("sells only its own shares when another agent owns the same one", async () => {
    // The broker sees one AAPL holding of 7. Selling the broker's figure would
    // take mean-reversion's 3 with it.
    await runningAgent('momentum-1');
    await runningAgent('meanrev-1');
    await buy('momentum-1', 'AAPL', '4');
    await buy('meanrev-1', 'AAPL', '3');
    expect(await brokerQty('AAPL')).toBe('7.00000000');

    const outcome = await kill(broker(), 'momentum-1', 'owner');

    expect(outcome.done).toBe(true);
    expect(outcome.sold).toEqual([{ symbol: 'AAPL', qty: parseQty('4') }]);
    expect(await brokerQty('AAPL')).toBe('3.00000000');
    expect(await ledgerQty('meanrev-1', 'AAPL')).toBe('3.00000000');
    expect(await status('meanrev-1')).toBe('running');
    expect(await runDailyReconcile(broker())).toBe(true);
  });

  it('works on a halted agent, which until now could not sell at all', async () => {
    await runningAgent('momentum-1');
    await buy('momentum-1', 'AAPL', '4');
    await inTransaction((tx) => halt(tx, 'momentum-1', 'owner', 'looks wrong'));

    const outcome = await kill(broker(), 'momentum-1', 'owner');

    expect(outcome.done).toBe(true);
    expect(await status('momentum-1')).toBe('killed');
    expect(Number(await brokerQty('AAPL'))).toBe(0);
  });

  it('works on an agent that holds nothing', async () => {
    await runningAgent('momentum-1');
    const outcome = await kill(broker(), 'momentum-1', 'owner');
    expect(outcome.done).toBe(true);
    expect(outcome.returnedMinor).toBe(200000n);
  });

  it('leaves an unpriced holding unsold, says why, and finishes on a second press', async () => {
    await runningAgent('momentum-1');
    await buy('momentum-1', 'AAPL', '4');
    await buy('momentum-1', 'MSFT', '2');
    await getPool().query(`delete from paper.market_prices where symbol = 'MSFT'`);

    const first = await kill(broker(), 'momentum-1', 'owner');

    expect(first.done).toBe(false);
    expect(first.sold.map((s) => s.symbol)).toEqual(['AAPL']);
    expect(first.unsold).toEqual([expect.objectContaining({ symbol: 'MSFT', reason: expect.stringMatching(/no price/) })]);
    expect(first.summary).toMatch(/Kill not finished/);
    expect(await status('momentum-1')).toBe('killing');

    await broker().setPrice('MSFT', parseMoney('200.00'));
    const second = await kill(broker(), 'momentum-1', 'owner');
    expect(second.done).toBe(true);
    expect(await status('momentum-1')).toBe('killed');
    expect(await runDailyReconcile(broker())).toBe(true);
  });

  it('refuses while an order is still open, rather than selling the same shares twice', async () => {
    await runningAgent('momentum-1');
    await buy('momentum-1', 'AAPL', '4');
    // An order written to the ledger whose fate the broker has not confirmed.
    await inTransaction((tx) =>
      createOrder(tx, { agentId: 'momentum-1', symbol: 'AAPL', side: 'sell', qty: parseQty('4'), idempotencyKey: 'in-flight' }),
    );

    await expect(kill(broker(), 'momentum-1', 'owner')).rejects.toThrow(/still open/);
    expect(await brokerQty('AAPL')).toBe('4.00000000');
    expect(await status('momentum-1')).toBe('running');
  });
});

describe('an agent part-way through a kill', () => {
  async function stuck(): Promise<void> {
    await runningAgent('momentum-1');
    await buy('momentum-1', 'AAPL', '4');
    await getPool().query(`delete from paper.market_prices where symbol = 'AAPL'`);
    const outcome = await kill(broker(), 'momentum-1', 'owner');
    expect(outcome.done).toBe(false);
  }

  it('cannot buy', async () => {
    await stuck();
    await expect(
      inTransaction((tx) =>
        createOrder(tx, { agentId: 'momentum-1', symbol: 'MSFT', side: 'buy', qty: parseQty('1'), idempotencyKey: 'sneaky' }),
      ),
    ).rejects.toThrow(/may only sell/);
  });

  it('cannot be restarted', async () => {
    await stuck();
    await expect(inTransaction((tx) => start(tx, 'momentum-1', 'owner'))).rejects.toThrow(/part-way through being killed/);
  });

  it('can be halted, and the global halt catches it', async () => {
    await stuck();
    const halted = await inTransaction((tx) => globalHalt(tx, 'owner', 'stop everything'));
    expect(halted).toContain('momentum-1');
    expect(await status('momentum-1')).toBe('halted');
  });
});

describe('an order the broker turns down', () => {
  it('is recorded as rejected, with the reason, not as submitted', async () => {
    await runningAgent('momentum-1');
    // £10,000 in the account; 200 shares at £100 is £20,000.
    const r = await submitOrder(broker(), { agentId: 'momentum-1', symbol: 'AAPL', side: 'buy', qty: parseQty('200'), idempotencyKey: 'too-big' });

    expect(r.rejectedReason).toMatch(/insufficient buying power/);
    const row = await getPool().query<{ status: string; reject_reason: string }>(
      `select status, reject_reason from ledger.orders where idempotency_key = 'too-big'`,
    );
    expect(row.rows[0]).toEqual({ status: 'rejected', reject_reason: expect.stringMatching(/insufficient buying power/) });
  });
});
