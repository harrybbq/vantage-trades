/**
 * The trading universe: the boundary between what the owner decides and what
 * the agent decides.
 *
 * The owner picks which symbols an agent may ever touch. The agent picks when
 * and how much, within that. These tests are about the boundary holding even
 * when the strategy would rather it did not.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { createAgent } from '../src/ledger/agents.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { createOrder } from '../src/ledger/orders.js';
import { addToUniverse, removeFromUniverse, listUniverse } from '../src/ledger/universe.js';
import { resetData, fundedAgent, trade } from './helpers.js';

beforeEach(resetData);
afterAll(closePool);

describe('an agent can only buy inside its universe', () => {
  it('refuses a buy in a symbol that was never permitted', async () => {
    await inTransaction((tx) => fundedAgent(tx, 'momentum-1', '1000.00', ['AAPL']));

    await expect(
      inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'TSLA', '1', '100.00')),
    ).rejects.toThrow(/not permitted to trade TSLA/);
  });

  it('refuses everything when the universe is empty', async () => {
    // The default for a newly created agent. It has to be given a universe
    // before it can act at all.
    await inTransaction(async (tx) => {
      await createAgent(tx, { id: 'fresh-1', name: 'Fresh' });
      await recordDeposit(tx, parseMoney('1000.00'), new Date(), 'dep-fresh');
      await allocate(tx, 'fresh-1', parseMoney('1000.00'));
      await start(tx, 'fresh-1', 'owner');
    });

    await expect(
      inTransaction((tx) =>
        createOrder(tx, {
          agentId: 'fresh-1',
          symbol: 'AAPL',
          side: 'buy',
          qty: parseQty('1'),
          idempotencyKey: 'empty-universe',
        }),
      ),
    ).rejects.toThrow(/empty trading universe/);
  });

  it('allows a buy once the symbol is added', async () => {
    await inTransaction((tx) => fundedAgent(tx, 'momentum-1', '1000.00', ['AAPL']));

    await expect(
      inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'MSFT', '1', '100.00')),
    ).rejects.toThrow(/not permitted/);

    await inTransaction((tx) => addToUniverse(tx, 'momentum-1', 'MSFT', 'owner'));

    await inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'MSFT', '1', '100.00'));

    const held = await getPool().query<{ symbol: string }>(
      `select symbol from ledger.agent_positions where agent_id = 'momentum-1'`,
    );
    expect(held.rows.map((r) => r.symbol)).toEqual(['MSFT']);
  });

  it('is per-agent, not global', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('4000.00'), new Date(), 'dep-per-agent');
      await createAgent(tx, { id: 'tech-1', name: 'Tech' });
      await addToUniverse(tx, 'tech-1', 'AAPL', 'owner');
      await allocate(tx, 'tech-1', parseMoney('2000.00'));
      await start(tx, 'tech-1', 'owner');

      await createAgent(tx, { id: 'energy-1', name: 'Energy' });
      await addToUniverse(tx, 'energy-1', 'SHEL', 'owner');
      await allocate(tx, 'energy-1', parseMoney('2000.00'));
      await start(tx, 'energy-1', 'owner');
    });

    await inTransaction((tx) => trade(tx, 'tech-1', 'buy', 'AAPL', '1', '100.00'));
    await expect(
      inTransaction((tx) => trade(tx, 'energy-1', 'buy', 'AAPL', '1', '100.00')),
    ).rejects.toThrow(/not permitted to trade AAPL/);
  });
});

describe('narrowing a universe never traps an agent in a position', () => {
  it('still allows a sell after the symbol is removed', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00', ['AAPL']);
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
    });

    const result = await inTransaction((tx) => removeFromUniverse(tx, 'momentum-1', 'AAPL'));
    expect(result).toEqual({ removed: true, stillHeld: true });

    // Buying more is now refused...
    await expect(
      inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'AAPL', '1', '100.00')),
    ).rejects.toThrow(/not permitted|empty trading universe/);

    // ...but exiting what it already holds must always be possible. Anything
    // else would leave the owner unable to unwind a position, which is a worse
    // failure than the one the universe is guarding against.
    await inTransaction((tx) => trade(tx, 'momentum-1', 'sell', 'AAPL', '4', '110.00'));

    const held = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ledger.agent_positions where agent_id = 'momentum-1'`,
    );
    expect(held.rows[0]?.n).toBe('0');
  });

  it('reports whether a removed symbol is still held, so the UI can warn', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00', ['AAPL', 'MSFT']);
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '1', '100.00');
    });

    expect(await inTransaction((tx) => removeFromUniverse(tx, 'momentum-1', 'MSFT'))).toEqual({
      removed: true,
      stillHeld: false,
    });
    expect(await inTransaction((tx) => removeFromUniverse(tx, 'momentum-1', 'AAPL'))).toEqual({
      removed: true,
      stillHeld: true,
    });
  });
});

describe('universe bookkeeping', () => {
  it('normalises and de-duplicates symbols', async () => {
    await inTransaction(async (tx) => {
      await createAgent(tx, { id: 'a-1', name: 'A' });
      await addToUniverse(tx, 'a-1', ' aapl ', 'owner');
      await addToUniverse(tx, 'a-1', 'AAPL', 'owner');
      await addToUniverse(tx, 'a-1', 'msft', 'owner');
    });

    expect(await inTransaction((tx) => listUniverse(tx, 'a-1'))).toEqual(['AAPL', 'MSFT']);
  });

  it('rejects a symbol that is not usable', async () => {
    await inTransaction((tx) => createAgent(tx, { id: 'a-1', name: 'A' }));

    for (const bad of ['', '   ', 'WAY-TOO-LONG-SYMBOL', 'AA PL', 'drop table']) {
      await expect(
        inTransaction((tx) => addToUniverse(tx, 'a-1', bad, 'owner')),
      ).rejects.toThrow(/not a usable symbol/);
    }
  });

  it('records who added each symbol', async () => {
    await inTransaction(async (tx) => {
      await createAgent(tx, { id: 'a-1', name: 'A' });
      await addToUniverse(tx, 'a-1', 'AAPL', 'owner');
    });

    const rows = await getPool().query<{ added_by: string }>(
      `select added_by from ledger.agent_universe where agent_id = 'a-1'`,
    );
    expect(rows.rows[0]?.added_by).toBe('owner');
  });
});
