/**
 * The order submission path. Every order that reaches a broker goes through
 * here.
 *
 * The sequence matters and is not negotiable:
 *
 *   1. write the order to the ledger  (halt is enforced here, by the schema)
 *   2. place it with the broker
 *   3. record the broker's id against it
 *
 * Placing first and recording second would leave a live order this system has
 * no row for if the process died in between — the one failure mode that truly
 * loses track of a position. Doing it this way can instead leave an order row
 * with no broker id, which is recoverable: `findOrphanedOrders` lists them, and
 * the idempotency key means re-submitting cannot open a second position.
 *
 * Steps 1 and 3 are separate transactions on purpose. Holding a database
 * transaction open across a network call to a broker is how a slow broker
 * becomes a database outage.
 */

import { inTransaction } from '../db.js';
import type { Minor, Qty } from '../money.js';
import type { BrokerAdapter } from '../broker/types.js';
import { createOrder, markSubmitted } from '../ledger/orders.js';

export interface SubmitOrderInput {
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: Qty;
  limitPriceMinor?: Minor;
  /**
   * Stable across retries of the same intent. Both the ledger and the broker
   * reject a reuse, so a retry after a timeout cannot double up.
   */
  idempotencyKey: string;
}

export interface SubmitResult {
  orderId: string;
  brokerOrderId: string;
}

export async function submitOrder(
  broker: BrokerAdapter,
  input: SubmitOrderInput,
): Promise<SubmitResult> {
  const orderId = await inTransaction((tx) =>
    createOrder(tx, {
      agentId: input.agentId,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      ...(input.limitPriceMinor !== undefined ? { limitPriceMinor: input.limitPriceMinor } : {}),
      idempotencyKey: input.idempotencyKey,
    }),
  );

  const placed = await broker.placeOrder({
    agentId: input.agentId,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
    ...(input.limitPriceMinor !== undefined ? { limitPriceMinor: input.limitPriceMinor } : {}),
    idempotencyKey: input.idempotencyKey,
  });

  await inTransaction((tx) => markSubmitted(tx, orderId, placed.brokerOrderId));

  return { orderId, brokerOrderId: placed.brokerOrderId };
}

export interface OrphanedOrder {
  orderId: string;
  agentId: string;
  symbol: string;
  idempotencyKey: string;
  createdAt: Date;
}

/**
 * Orders written to the ledger that never got a broker id.
 *
 * Each one is either an order the broker never saw, or one it did see and we
 * lost the acknowledgement for. The two look identical from here, so resolving
 * them means asking the broker about the idempotency key rather than guessing.
 * Worth running before trusting a reconciliation result.
 */
export async function findOrphanedOrders(olderThanMinutes = 5): Promise<OrphanedOrder[]> {
  return inTransaction(async (tx) => {
    const result = await tx.query<{
      id: string;
      agent_id: string;
      symbol: string;
      idempotency_key: string;
      created_at: Date;
    }>(
      `select id, agent_id, symbol, idempotency_key, created_at
         from ledger.orders
        where status = 'pending'
          and broker_order_id is null
          and created_at < now() - make_interval(mins => $1)
        order by created_at`,
      [olderThanMinutes],
    );

    return result.rows.map((r) => ({
      orderId: r.id,
      agentId: r.agent_id,
      symbol: r.symbol,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at,
    }));
  });
}
