/**
 * The money-safety properties, tested as behaviour rather than asserted in a
 * comment. Each of these is something that, if it ever stopped holding, would
 * let the system place an order nobody asked for, place a larger order than
 * intended, or lose track of a position.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { createAgent } from '../src/ledger/agents.js';
import { accountId } from '../src/ledger/accounts.js';
import { postEntry } from '../src/ledger/journal.js';
import { allocate, recordDeposit } from '../src/ledger/allocation.js';
import { halt, start, globalHalt, standDown, previewKill } from '../src/ledger/control.js';
import { createOrder, AgentNotRunningError } from '../src/ledger/orders.js';
import { recordFill } from '../src/ledger/fills.js';
import { resetData, fundedAgent, trade } from './helpers.js';

beforeEach(resetData);
afterAll(closePool);

describe('halt is authoritative, not advisory', () => {
  it('refuses an order from a halted agent at the database level', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await halt(tx, 'momentum-1', 'owner', 'looks wrong');
    });

    await expect(
      inTransaction((tx) =>
        createOrder(tx, {
          agentId: 'momentum-1',
          symbol: 'AAPL',
          side: 'buy',
          qty: parseQty('1'),
          idempotencyKey: 'after-halt',
        }),
      ),
    ).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it('refuses an order from an agent that was never started', async () => {
    await inTransaction((tx) => createAgent(tx, { id: 'idle-1', name: 'Idle' }));

    await expect(
      inTransaction((tx) =>
        createOrder(tx, {
          agentId: 'idle-1',
          symbol: 'AAPL',
          side: 'buy',
          qty: parseQty('1'),
          idempotencyKey: 'never-started',
        }),
      ),
    ).rejects.toThrow(/not running/);
  });

  it('leaves positions and capital untouched when halting', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await halt(tx, 'momentum-1', 'owner');
    });

    // A halted agent holding AAPL keeps holding AAPL. Halt is a freeze, not a
    // wind-down: confusing the two sells positions nobody asked to sell.
    const positions = await getPool().query(
      `select symbol, qty::text as qty from ledger.agent_positions where agent_id = 'momentum-1'`,
    );
    expect(positions.rows).toEqual([{ symbol: 'AAPL', qty: '4.00000000' }]);

    const cash = await getPool().query(
      `select balance_minor from ledger.account_balances
        where agent_id = 'momentum-1' and kind = 'agent_cash'`,
    );
    expect(cash.rows[0]?.balance_minor).toBe(60000n);
  });

  it('global halt stops every agent at once', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('3000.00'), new Date(), 'dep-global');
      for (const id of ['a-1', 'b-2', 'c-3']) {
        await createAgent(tx, { id, name: id });
        await allocate(tx, id, parseMoney('1000.00'));
        await start(tx, id, 'test');
      }
    });

    const halted = await inTransaction((tx) => globalHalt(tx, 'owner', 'kill switch'));
    expect(halted.sort()).toEqual(['a-1', 'b-2', 'c-3']);

    for (const id of ['a-1', 'b-2', 'c-3']) {
      await expect(
        inTransaction((tx) =>
          createOrder(tx, {
            agentId: id,
            symbol: 'AAPL',
            side: 'buy',
            qty: parseQty('1'),
            idempotencyKey: `post-global-${id}`,
          }),
        ),
      ).rejects.toThrow(/not running/);
    }
  });

  it('records who halted an agent and why', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '100.00');
      await halt(tx, 'momentum-1', 'owner', 'drawdown looked wrong');
    });

    const events = await getPool().query<{ action: string; actor: string; reason: string }>(
      `select action, actor, reason from ledger.agent_control_events
        where agent_id = 'momentum-1' and action = 'halt'`,
    );
    expect(events.rows[0]).toMatchObject({
      action: 'halt',
      actor: 'owner',
      reason: 'drawdown looked wrong',
    });
  });
});

describe('every order is attributed to an agent', () => {
  it('cannot write an order without an agent', async () => {
    // Rejected by the may-trade trigger before NOT NULL is even reached, but
    // rejected either way: an unattributed order cannot be written.
    await expect(
      getPool().query(
        `insert into ledger.orders (agent_id, symbol, side, qty, idempotency_key)
         values (null, 'AAPL', 'buy', 1, 'no-agent')`,
      ),
    ).rejects.toThrow();

    // And the column itself is NOT NULL, so the guarantee does not depend on
    // that trigger continuing to exist.
    const column = await getPool().query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'ledger' and table_name = 'orders' and column_name = 'agent_id'`,
    );
    expect(column.rows[0]?.is_nullable).toBe('NO');
  });

  it('refuses a fill that disagrees with its order about the agent', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('2000.00'), new Date(), 'dep-attr');
      for (const id of ['agent-a', 'agent-b']) {
        await createAgent(tx, { id, name: id });
        await allocate(tx, id, parseMoney('1000.00'));
        await start(tx, id, 'test');
      }
    });

    const orderId = await inTransaction((tx) =>
      createOrder(tx, {
        agentId: 'agent-a',
        symbol: 'AAPL',
        side: 'buy',
        qty: parseQty('1'),
        idempotencyKey: 'attr-mismatch',
      }),
    );

    await expect(
      inTransaction((tx) =>
        recordFill(tx, {
          orderId,
          agentId: 'agent-b', // wrong agent
          symbol: 'AAPL',
          side: 'buy',
          qty: parseQty('1'),
          pricePerUnitMinor: parseMoney('100.00'),
          brokerFillId: 'mismatch-1',
          filledAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/belongs to agent/);
  });

  it('refuses a duplicate broker fill, so a replayed webhook cannot double-book', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
    });

    const orderId = await inTransaction((tx) =>
      createOrder(tx, {
        agentId: 'momentum-1',
        symbol: 'AAPL',
        side: 'buy',
        qty: parseQty('1'),
        idempotencyKey: 'dupe-fill-order',
      }),
    );

    const fill = {
      orderId,
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy' as const,
      qty: parseQty('1'),
      pricePerUnitMinor: parseMoney('100.00'),
      brokerFillId: 'broker-fill-repeated',
      filledAt: new Date(),
    };

    await inTransaction((tx) => recordFill(tx, fill));
    await expect(inTransaction((tx) => recordFill(tx, fill))).rejects.toThrow(/duplicate key/i);

    const count = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ledger.fills`,
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('refuses a reused idempotency key, so a retried submission cannot open a second position', async () => {
    await inTransaction((tx) => fundedAgent(tx, 'momentum-1', '1000.00'));

    const request = {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy' as const,
      qty: parseQty('1'),
      idempotencyKey: 'retry-after-timeout',
    };

    await inTransaction((tx) => createOrder(tx, request));
    await expect(inTransaction((tx) => createOrder(tx, request))).rejects.toThrow(/duplicate key/i);
  });
});

describe('an agent cannot deploy capital it was never allocated', () => {
  it('refuses a buy larger than the allocation', async () => {
    await inTransaction((tx) => fundedAgent(tx, 'momentum-1', '100.00'));

    await expect(
      inTransaction((tx) => trade(tx, 'momentum-1', 'buy', 'AAPL', '10', '50.00')),
    ).rejects.toThrow(/overdraw its allocation/);
  });

  it('refuses to allocate more than the pool holds', async () => {
    await inTransaction(async (tx) => {
      await createAgent(tx, { id: 'momentum-1', name: 'Momentum' });
      await recordDeposit(tx, parseMoney('100.00'), new Date(), 'dep-small');
    });

    await expect(
      inTransaction((tx) => allocate(tx, 'momentum-1', parseMoney('500.00'))),
    ).rejects.toThrow(/pool would go negative/);
  });

  it('refuses to return capital that is currently in positions', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '9', '100.00');
    });

    // 900 is invested, 100 is uninvested. Returning 500 would need a sale, and
    // deallocation must never quietly sell anything.
    await expect(
      inTransaction((tx) => allocate(tx, 'momentum-1', parseMoney('0.00'))),
    ).rejects.toThrow();

    const { deallocate } = await import('../src/ledger/allocation.js');
    await expect(
      inTransaction((tx) => deallocate(tx, 'momentum-1', parseMoney('500.00'))),
    ).rejects.toThrow(/must be unwound/);
  });

  it('refuses to sell more than the agent holds', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '2', '100.00');
    });

    await expect(
      inTransaction((tx) => trade(tx, 'momentum-1', 'sell', 'AAPL', '5', '100.00')),
    ).rejects.toThrow(/does not hold enough/);
  });
});

describe('the journal cannot be corrupted', () => {
  it('rejects an entry that does not balance', async () => {
    await inTransaction((tx) => createAgent(tx, { id: 'momentum-1', name: 'M' }));

    // Bypass postEntry's own check to prove the database is the real guard.
    await expect(
      inTransaction(async (tx) => {
        const pool = await accountId(tx, 'pool');
        const cash = await accountId(tx, 'agent_cash', 'momentum-1');
        const entry = await tx.query<{ id: string }>(
          `insert into ledger.journal_entries (kind, occurred_at) values ('allocation', now()) returning id`,
        );
        const entryId = entry.rows[0]!.id;
        await tx.query(
          `insert into ledger.postings (entry_id, account_id, amount_minor) values ($1, $2, -100)`,
          [entryId, pool],
        );
        await tx.query(
          `insert into ledger.postings (entry_id, account_id, amount_minor) values ($1, $2, 90)`,
          [entryId, cash],
        );
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a single-sided entry', async () => {
    await expect(
      inTransaction(async (tx) => {
        const pool = await accountId(tx, 'pool');
        const entry = await tx.query<{ id: string }>(
          `insert into ledger.journal_entries (kind, occurred_at) values ('adjustment', now()) returning id`,
        );
        await tx.query(
          `insert into ledger.postings (entry_id, account_id, amount_minor) values ($1, $2, 100)`,
          [entry.rows[0]!.id, pool],
        );
      }),
    ).rejects.toThrow(/at least 2|does not balance/);
  });

  it('is append-only: postings cannot be updated or deleted', async () => {
    await inTransaction(async (tx) => {
      await recordDeposit(tx, parseMoney('100.00'), new Date(), 'dep-immutable');
    });

    await expect(
      getPool().query(`update ledger.postings set amount_minor = 1`),
    ).rejects.toThrow(/append-only/);

    await expect(getPool().query(`delete from ledger.postings`)).rejects.toThrow(/append-only/);
  });

  it('refuses to post the same external movement twice', async () => {
    await inTransaction((tx) =>
      recordDeposit(tx, parseMoney('100.00'), new Date(), 'bank-ref-1'),
    );

    await expect(
      inTransaction((tx) => recordDeposit(tx, parseMoney('100.00'), new Date(), 'bank-ref-1')),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('rejects an account of an agent kind with no agent', async () => {
    await expect(
      getPool().query(
        `insert into ledger.accounts (kind, agent_id, currency) values ('agent_cash', null, 'GBP')`,
      ),
    ).rejects.toThrow(/account_agent_presence/);
  });
});

describe('kill', () => {
  it('names what will actually be sold', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'momentum-1', 'buy', 'MSFT', '2', '150.00');
    });

    const preview = await inTransaction((tx) => previewKill(tx, 'momentum-1'));

    // "Are you sure?" is not enough. The prompt has to let the owner notice it
    // is about to liquidate the wrong agent.
    expect(preview.summary).toContain('AAPL');
    expect(preview.summary).toContain('MSFT');
    expect(preview.summary).toContain('2 position(s)');
    expect(preview.positions).toHaveLength(2);
  });

  it('refuses to stand an agent down while it still holds something', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
    });

    await expect(
      inTransaction((tx) => standDown(tx, 'momentum-1', 'owner')),
    ).rejects.toThrow(/still holds 1 position/);
  });

  it('returns capital to the pool once liquidated', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '1000.00');
      await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
      await trade(tx, 'momentum-1', 'sell', 'AAPL', '4', '110.00');
      await standDown(tx, 'momentum-1', 'owner', 'done');
    });

    const pool = await getPool().query<{ balance_minor: bigint }>(
      `select balance_minor from ledger.account_balances where kind = 'pool'`,
    );
    // 1000 allocated, bought 400, sold for 440: 1040 comes back.
    expect(pool.rows[0]?.balance_minor).toBe(104000n);

    const status = await getPool().query<{ status: string }>(
      `select status from ledger.agents where id = 'momentum-1'`,
    );
    expect(status.rows[0]?.status).toBe('killed');
  });

  it('will not silently restart a killed agent', async () => {
    await inTransaction(async (tx) => {
      await fundedAgent(tx, 'momentum-1', '100.00');
      await standDown(tx, 'momentum-1', 'owner');
    });

    // Whether a restarted agent resumes its P/L history or starts fresh is an
    // open decision. Until it is settled, this must not be a one-click action.
    await expect(inTransaction((tx) => start(tx, 'momentum-1', 'owner'))).rejects.toThrow(
      /was killed/,
    );
  });
});
