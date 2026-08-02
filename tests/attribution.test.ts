/**
 * Per-agent attribution and reconciliation.
 *
 * The scenario that justifies this entire schema: two agents both buy AAPL,
 * the broker shows one AAPL position, and the control panel still has to show
 * two different P/L figures. If these tests pass, the numbers are real.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty, formatMoney } from '../src/money.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { agentEquity, unallocatedPool } from '../src/ledger/equity.js';
import { reconcile } from '../src/ledger/reconcile.js';
import { resetData, fundedAgent, newAgent, trade, setMark } from './helpers.js';

beforeEach(resetData);
afterAll(closePool);

async function twoAgents(): Promise<void> {
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'dep-two-agents');
    for (const id of ['momentum-1', 'value-1']) {
      await newAgent(tx, id);
      await allocate(tx, id, parseMoney('2000.00'));
      await start(tx, id, 'test');
    }
  });
}

describe('two agents holding the same symbol', () => {
  it('keeps separate cost bases the broker cannot see', async () => {
    await twoAgents();

    await inTransaction(async (tx) => {
      // Same symbol, different prices. The broker will show 9 AAPL and one
      // blended average; only this ledger knows who paid what.
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'value-1', 'buy', 'AAPL', '5', '80.00');
      await setMark(tx, 'AAPL', '110.00');
    });

    const momentum = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    const value = await inTransaction((tx) => agentEquity(tx, 'value-1'));

    // momentum: 2000 - 400 cash, 4 @ 110 = 440 market
    expect(formatMoney(momentum.cashMinor)).toBe('1600.00');
    expect(formatMoney(momentum.equityMinor!)).toBe('2040.00');

    // value: 2000 - 400 cash, 5 @ 110 = 550 market
    expect(formatMoney(value.cashMinor)).toBe('1600.00');
    expect(formatMoney(value.equityMinor!)).toBe('2150.00');

    // Same symbol, same mark, different P/L. That difference is the product.
    expect(momentum.equityMinor).not.toBe(value.equityMinor);
  });

  it('sells only the selling agent\'s lots', async () => {
    await twoAgents();

    await inTransaction(async (tx) => {
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'value-1', 'buy', 'AAPL', '5', '80.00');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '4', '120.00');
    });

    const positions = await getPool().query<{ agent_id: string; qty: string }>(
      `select agent_id, qty::text as qty from ledger.agent_positions order by agent_id`,
    );

    // value-1's holding is untouched by momentum-1's sale.
    expect(positions.rows).toEqual([{ agent_id: 'value-1', qty: '5.00000000' }]);

    const momentum = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    expect(formatMoney(momentum.realisedMinor)).toBe('80.00'); // 4 x (120 - 100)
  });
});

describe('cost basis', () => {
  it('closes lots FIFO', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '2', '100.00'); // lot 1
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '2', '150.00'); // lot 2
      // Selling 2 should release lot 1 at 100, not an average of 125.
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '2', '200.00');
    });

    const equity = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    expect(formatMoney(equity.realisedMinor)).toBe('200.00'); // 2 x (200 - 100)

    const remaining = await getPool().query<{ cost_basis_minor: bigint }>(
      `select cost_basis_minor from ledger.agent_positions where agent_id = 'momentum-1'`,
    );
    expect(remaining.rows[0]?.cost_basis_minor).toBe(30000n); // lot 2, 2 x 150
  });

  it('does not strand basis across repeated partial sells', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      // A price that does not divide evenly, sold off in awkward slices.
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '3', '33.33');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '1', '40.00');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '1', '40.00');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '1', '40.00');
    });

    // Every penny of the original 99.99 basis must have been released.
    const lots = await getPool().query<{ basis: bigint; qty: string }>(
      `select coalesce(sum(basis_remaining_minor), 0)::bigint as basis,
              coalesce(sum(qty_remaining), 0)::text as qty
         from ledger.position_lots where agent_id = 'momentum-1'`,
    );
    expect(lots.rows[0]?.basis).toBe(0n);

    const equity = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    expect(formatMoney(equity.realisedMinor)).toBe('20.01'); // 120.00 - 99.99
    expect(formatMoney(equity.positionsBookMinor)).toBe('0.00');
  });

  it('charges fees without folding them into cost basis', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '1', '100.00', '1.50');
    });

    const equity = await inTransaction((tx) => agentEquity(tx, 'momentum-1'));
    // Costs stay visible as costs: spread and commission are the dominant
    // drag on a small account, and burying them in basis hides that.
    expect(formatMoney(equity.feesMinor)).toBe('1.50');
    expect(formatMoney(equity.positionsBookMinor)).toBe('100.00');
    expect(formatMoney(equity.cashMinor)).toBe('898.50');
  });
});

describe('reconciliation', () => {
  it('passes when the ledger agrees with the broker', async () => {
    await twoAgents();
    await inTransaction(async (tx) => {
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'value-1', 'buy', 'AAPL', '5', '80.00');
      await setMark(tx, 'AAPL', '110.00');
    });

    const result = await inTransaction(async (tx) => {
      const pool = await unallocatedPool(tx);
      const m = await agentEquity(tx, 'momentum-1');
      const v = await agentEquity(tx, 'value-1');

      return reconcile(tx, {
        asOf: new Date(),
        cashMinor: m.cashMinor + v.cashMinor + pool,
        equityMinor: m.equityMinor! + v.equityMinor! + pool,
        positions: [{ symbol: 'AAPL', qty: parseQty('9') }],
      });
    });

    expect(result.status).toBe('ok');
    expect(result.cashDiffMinor).toBe(0n);
    expect(result.symbolDiffs).toEqual([]);
  });

  it('catches a quantity that does not match the broker', async () => {
    await twoAgents();
    await inTransaction(async (tx) => {
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await setMark(tx, 'AAPL', '100.00');
    });

    const result = await inTransaction(async (tx) => {
      const pool = await unallocatedPool(tx);
      const m = await agentEquity(tx, 'momentum-1');
      const v = await agentEquity(tx, 'value-1');

      return reconcile(tx, {
        asOf: new Date(),
        cashMinor: m.cashMinor + v.cashMinor + pool,
        equityMinor: m.equityMinor! + v.equityMinor! + pool,
        // The broker says 5. We think 4. Something is unattributed.
        positions: [{ symbol: 'AAPL', qty: parseQty('5') }],
      });
    });

    expect(result.status).toBe('diverged');
    expect(result.symbolDiffs).toEqual([
      { symbol: 'AAPL', brokerQty: '5.00000000', computedQty: '4.00000000' },
    ]);
    expect(result.summary).toContain('investigate today');
  });

  it('catches a cash difference of a single penny', async () => {
    await twoAgents();

    const result = await inTransaction(async (tx) => {
      const pool = await unallocatedPool(tx);
      return reconcile(tx, {
        asOf: new Date(),
        cashMinor: pool + parseMoney('4000.00') + 1n,
        equityMinor: pool + parseMoney('4000.00') + 1n,
        positions: [],
      });
    });

    // No tolerance band. A penny a day is a bug, and a tolerance is how it
    // goes unnoticed for a quarter.
    expect(result.status).toBe('diverged');
    expect(result.cashDiffMinor).toBe(1n);
  });

  it('refuses to report a clean run when a position has no mark', async () => {
    await twoAgents();
    await inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00'));
    // No mark set for AAPL.

    const result = await inTransaction(async (tx) => {
      const pool = await unallocatedPool(tx);
      const m = await agentEquity(tx, 'momentum-1');
      const v = await agentEquity(tx, 'value-1');
      return reconcile(tx, {
        asOf: new Date(),
        cashMinor: m.cashMinor + v.cashMinor + pool,
        equityMinor: parseMoney('5000.00'),
        positions: [{ symbol: 'AAPL', qty: parseQty('4') }],
      });
    });

    // A green tick that means nothing is worse than a red one.
    expect(result.status).toBe('diverged');
    expect(result.unpricedSymbols).toEqual(['AAPL']);
    expect(result.summary).toContain('proves nothing');
  });
});

describe('the fundamental identity', () => {
  it('sum(agent equities) + unallocated == total, through a full trading day', async () => {
    await twoAgents();

    await inTransaction(async (tx) => {
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00', '1.00');
      await trade(tx, 'value-1', 'buy', 'AAPL', '5', '80.00', '1.00');
      await trade(tx, 'momentum-1', 'buy', 'MSFT', '2', '150.00');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '2', '120.00', '0.50');
      await setMark(tx, 'AAPL', '115.00');
      await setMark(tx, 'MSFT', '155.00');
    });

    await inTransaction(async (tx) => {
      const pool = await unallocatedPool(tx);
      const m = await agentEquity(tx, 'momentum-1');
      const v = await agentEquity(tx, 'value-1');

      const total = m.equityMinor! + v.equityMinor! + pool;

      // 5000 deposited, minus 2.50 of fees, plus unrealised movement.
      const unrealised =
        // momentum: 2 AAPL at 115 vs 100 basis, 2 MSFT at 155 vs 150
        2n * (parseMoney('115.00') - parseMoney('100.00')) +
        2n * (parseMoney('155.00') - parseMoney('150.00')) +
        // value: 5 AAPL at 115 vs 80
        5n * (parseMoney('115.00') - parseMoney('80.00'));
      const realised = 2n * (parseMoney('120.00') - parseMoney('100.00'));

      expect(total).toBe(parseMoney('5000.00') - parseMoney('2.50') + unrealised + realised);
    });
  });

  it('holds after every single posting, not just at the end', async () => {
    await twoAgents();

    const steps = [
      () => inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00', '1.00')),
      () => inTransaction((tx) => trade(tx, 'value-1', 'buy', 'AAPL', '5', '80.00')),
      () => inTransaction((tx) => trade(tx, 'momentum-1', 'sell', 'AAPL', '1', '110.00', '0.25')),
      () => inTransaction((tx) => trade(tx, 'value-1', 'sell', 'AAPL', '5', '85.00')),
    ];

    for (const step of steps) {
      await step();

      // Every journal entry balances, so the whole ledger must sum to zero
      // across all accounts at all times.
      const total = await getPool().query<{ total: bigint }>(
        `select coalesce(sum(amount_minor), 0)::bigint as total from ledger.postings`,
      );
      expect(total.rows[0]?.total).toBe(0n);
    }
  });
});
