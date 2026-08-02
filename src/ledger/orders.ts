/**
 * Order submission, ledger side.
 *
 * Writing the order row is the last checkpoint before anything reaches a
 * broker, so it is where halt is enforced — by a trigger in the schema, not by
 * a check here. A flag checked once per loop is a request; a constraint at the
 * point of writing is a stop.
 *
 * The intended sequence is: record the order here, then place it with the
 * broker. That order matters. Placing first and recording second leaves a live
 * order that this system has no row for if the process dies in between, which
 * is the one failure that loses track of a position.
 */

import type { Sql } from '../db.js';
import type { Minor, Qty } from '../money.js';

export interface CreateOrderInput {
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: Qty;
  limitPriceMinor?: Minor;
  /** Stable across retries of the same intent. Unique forever. */
  idempotencyKey: string;
}

export class AgentNotRunningError extends Error {}

export async function createOrder(tx: Sql, input: CreateOrderInput): Promise<string> {
  if (input.qty <= 0n) throw new Error('an order must have positive quantity');

  const qty = formatQtyForPg(input.qty);

  try {
    const result = await tx.query<{ id: string }>(
      `insert into ledger.orders
         (agent_id, symbol, side, qty, limit_price_minor, idempotency_key, status)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       returning id`,
      [
        input.agentId,
        input.symbol.toUpperCase(),
        input.side,
        qty,
        input.limitPriceMinor?.toString() ?? null,
        input.idempotencyKey,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('failed to create order');
    return id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not running')) {
      throw new AgentNotRunningError(message);
    }
    throw error;
  }
}

export async function markSubmitted(
  tx: Sql,
  orderId: string,
  brokerOrderId: string,
): Promise<void> {
  await tx.query(
    `update ledger.orders
        set status = 'submitted', broker_order_id = $2, submitted_at = now(), updated_at = now()
      where id = $1`,
    [orderId, brokerOrderId],
  );
}

function formatQtyForPg(qty: Qty): string {
  const whole = qty / 100000000n;
  const frac = (qty % 100000000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}
