import { getPool } from '../src/db.js';
import { parseMoney, parseQty } from '../src/money.js';
import { createAgent } from '../src/ledger/agents.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { createOrder } from '../src/ledger/orders.js';
import { recordFill } from '../src/ledger/fills.js';
import type { Sql } from '../src/db.js';

process.env['DATABASE_URL'] ??= 'postgres://postgres:postgres@localhost:5432/vantage_trades';

/**
 * Wipe every ledger table. TRUNCATE rather than DELETE, because the journal
 * tables reject DELETE by design.
 */
export async function resetData(): Promise<void> {
  await getPool().query(`
    truncate ledger.postings,
             ledger.journal_entries,
             ledger.position_lots,
             ledger.fills,
             ledger.orders,
             ledger.accounts,
             ledger.agent_control_events,
             ledger.reconciliations,
             ledger.marks,
             ledger.agents
    restart identity cascade
  `);
}

let fillCounter = 0;

/** Create an agent, fund the pool, allocate to it, and start it. */
export async function fundedAgent(
  tx: Sql,
  agentId: string,
  amount: string,
): Promise<void> {
  await createAgent(tx, { id: agentId, name: agentId });
  await recordDeposit(tx, parseMoney(amount), new Date(), `deposit:${agentId}:${fillCounter++}`);
  await allocate(tx, agentId, parseMoney(amount));
  await start(tx, agentId, 'test');
}

/** Place and fill an order in one step, for tests that only care about the result. */
export async function trade(
  tx: Sql,
  agentId: string,
  side: 'buy' | 'sell',
  symbol: string,
  qty: string,
  price: string,
  fee = '0.00',
): Promise<{ realisedMinor: bigint; grossMinor: bigint }> {
  const key = `${agentId}:${side}:${symbol}:${fillCounter++}`;
  const orderId = await createOrder(tx, {
    agentId,
    symbol,
    side,
    qty: parseQty(qty),
    idempotencyKey: key,
  });

  const result = await recordFill(tx, {
    orderId,
    agentId,
    symbol,
    side,
    qty: parseQty(qty),
    pricePerUnitMinor: parseMoney(price),
    feeMinor: parseMoney(fee),
    brokerFillId: `broker-fill-${key}`,
    filledAt: new Date(),
  });

  return { realisedMinor: result.realisedMinor, grossMinor: result.grossMinor };
}

export async function setMark(tx: Sql, symbol: string, price: string): Promise<void> {
  await tx.query(
    `insert into ledger.marks (symbol, as_of, price_minor, source)
     values ($1, now(), $2, 'test')
     on conflict (symbol, as_of) do update set price_minor = excluded.price_minor`,
    [symbol, parseMoney(price).toString()],
  );
}
