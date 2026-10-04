/**
 * Kill: sell everything the agent owns, then stand it down.
 *
 * The sequence, and why each step is where it is:
 *
 *   1. pull fills       so "what it owns" is the broker's latest, not the
 *                       ledger's last guess
 *   2. lock + check     the agent row is locked, any open order refuses the
 *                       kill, and the agent moves to `killing` — from here it
 *                       can sell and nothing else, by trigger
 *   3. write the sells  one per holding, for exactly the quantity the LEDGER
 *                       attributes to this agent. Never the broker's total:
 *                       the broker shows one ULVR position for two agents,
 *                       and selling the total would sell the other agent's
 *                       shares too
 *   4. place them       outside any transaction, as every order is
 *   5. pull fills       so the ledger sees the sales
 *   6. stand down       only if nothing is left; the cash goes back to the pool
 *
 * Any holding that cannot be sold — no price, the broker refusing — leaves the
 * agent in `killing` with the reason. That is safe: it cannot buy, its strategy
 * does not run, and pressing Kill again tries the rest.
 */

import { randomUUID } from 'node:crypto';
import { inTransaction } from '../db.js';
import type { BrokerAdapter } from '../broker/types.js';
import { beginKill, standDown } from '../ledger/control.js';
import { createOrder, markRejected, markSubmitted } from '../ledger/orders.js';
import { formatGBP, formatQty, parseQty, type Minor, type Qty } from '../money.js';
import { syncFills } from './sync.js';

export interface KillOutcome {
  /** True once the agent is `killed` and its cash is back in the pool. */
  done: boolean;
  sold: { symbol: string; qty: Qty }[];
  /** Holdings still owned, each with why it was not sold. */
  unsold: { symbol: string; qty: Qty; reason: string }[];
  returnedMinor: Minor;
  /** Ready to show the owner. */
  summary: string;
}

async function holdings(agentId: string): Promise<{ symbol: string; qty: Qty }[]> {
  return inTransaction(async (tx) => {
    const r = await tx.query<{ symbol: string; qty: string }>(
      `select symbol, qty::text as qty from ledger.agent_positions where agent_id = $1 order by symbol`,
      [agentId],
    );
    return r.rows.map((row) => ({ symbol: row.symbol, qty: parseQty(row.qty) }));
  });
}

export async function kill(broker: BrokerAdapter, agentId: string, actor: string): Promise<KillOutcome> {
  await syncFills(broker);

  const owned = await holdings(agentId);

  // A market sell with no price to fill at would be refused by the simulator
  // and filled at anything by a real broker. Neither is a sale worth making
  // blind, so an unpriced holding is left for a second attempt.
  const quotes = owned.length ? await broker.getQuotes(owned.map((h) => h.symbol)) : [];
  const priced = new Set(quotes.map((q) => q.symbol.toUpperCase()));
  const unsold: KillOutcome['unsold'] = owned
    .filter((h) => !priced.has(h.symbol))
    .map((h) => ({ ...h, reason: 'no price, so it cannot be sold safely yet' }));
  const toSell = owned.filter((h) => priced.has(h.symbol));

  const attempt = randomUUID();
  const orders = await inTransaction(async (tx) => {
    await beginKill(tx, agentId, actor);
    const written: { orderId: string; symbol: string; qty: Qty; key: string }[] = [];
    for (const h of toSell) {
      const key = `kill:${agentId}:${attempt}:${h.symbol}`;
      const orderId = await createOrder(tx, { agentId, symbol: h.symbol, side: 'sell', qty: h.qty, idempotencyKey: key });
      written.push({ orderId, symbol: h.symbol, qty: h.qty, key });
    }
    return written;
  });

  for (const order of orders) {
    try {
      const placed = await broker.placeOrder({
        agentId,
        symbol: order.symbol,
        side: 'sell',
        qty: order.qty,
        idempotencyKey: order.key,
      });
      if (placed.rejectedReason !== undefined) {
        await inTransaction((tx) => markRejected(tx, order.orderId, placed.brokerOrderId, placed.rejectedReason!));
        unsold.push({ symbol: order.symbol, qty: order.qty, reason: `the broker refused: ${placed.rejectedReason}` });
      } else {
        await inTransaction((tx) => markSubmitted(tx, order.orderId, placed.brokerOrderId));
      }
    } catch (error) {
      // Left pending on purpose. Whether the broker saw it is unknown, and
      // marking it rejected would invite a second sale of the same shares.
      // An open order also blocks the next Kill until it is resolved.
      unsold.push({
        symbol: order.symbol,
        qty: order.qty,
        reason: `could not confirm the sale (${error instanceof Error ? error.message : String(error)}); check the broker before trying again`,
      });
    }
  }

  await syncFills(broker);

  const left = await holdings(agentId);
  const sold = owned
    .map((h) => ({ symbol: h.symbol, qty: h.qty - (left.find((l) => l.symbol === h.symbol)?.qty ?? 0n) }))
    .filter((s) => s.qty > 0n);

  if (left.length > 0) {
    // Anything still held that no reason was recorded for — a partial fill,
    // most likely — gets one, so the owner is never told "not sold" without why.
    for (const l of left) {
      if (!unsold.some((u) => u.symbol === l.symbol)) {
        unsold.push({ ...l, reason: 'the sale has not completed yet' });
      }
    }
    const shares = (q: Qty) => formatQty(q).replace(/\.?0+$/, '');
    const lines = unsold.map((u) => `${u.symbol} ×${shares(u.qty)}: ${u.reason}`).join('; ');
    return {
      done: false,
      sold,
      unsold,
      returnedMinor: 0n,
      summary:
        `Kill not finished. ${sold.length ? `Sold ${sold.map((s) => s.symbol).join(', ')}. ` : ''}` +
        `Still held: ${lines}. The agent stays in "killing": it can only sell, and pressing Kill again tries the rest.`,
    };
  }

  const returnedMinor = await inTransaction((tx) => standDown(tx, agentId, actor, 'kill finished'));
  return {
    done: true,
    sold,
    unsold: [],
    returnedMinor,
    summary:
      `${agentId} is stood down. ${sold.length ? `Sold ${sold.map((s) => s.symbol).join(', ')}; ` : ''}` +
      `${formatGBP(returnedMinor)} went back to the pool.`,
  };
}
