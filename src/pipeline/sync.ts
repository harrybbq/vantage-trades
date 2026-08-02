/**
 * Pulling broker state into the ledger: fills, and the prices used to value
 * positions.
 *
 * Attribution happens here, and it works by looking up which agent's order the
 * broker's fill belongs to. A fill whose order is unknown is never guessed at
 * — it is reported and left alone. Attributing it to the wrong agent would
 * corrupt both agents' numbers and be very hard to unpick later, whereas an
 * unattributed fill is a loud reconciliation failure that gets investigated.
 */

import type { Sql } from '../db.js';
import { inTransaction } from '../db.js';
import type { BrokerAdapter } from '../broker/types.js';
import { recordFill } from '../ledger/fills.js';

export interface SyncFillsResult {
  recorded: number;
  alreadyKnown: number;
  /** Broker fills with no matching order. Each one needs a human. */
  unattributable: { brokerFillId: string; brokerOrderId: string; symbol: string }[];
}

/**
 * Overlap window on each poll. Fills that share a timestamp, or arrive out of
 * order, would otherwise be missed by a strict `since`. Re-reading them is
 * free: the unique broker fill id makes a repeat a no-op.
 */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function syncFills(broker: BrokerAdapter): Promise<SyncFillsResult> {
  const since = await inTransaction(async (tx) => {
    const result = await tx.query<{ latest: Date | null }>(
      `select max(filled_at) as latest from ledger.fills`,
    );
    const latest = result.rows[0]?.latest;
    return latest ? new Date(latest.getTime() - LOOKBACK_MS) : new Date(0);
  });

  const fills = await broker.getFills(since);

  const result: SyncFillsResult = { recorded: 0, alreadyKnown: 0, unattributable: [] };

  for (const fill of fills) {
    const outcome = await inTransaction(async (tx) => recordOne(tx, fill));

    if (outcome === 'recorded') result.recorded += 1;
    else if (outcome === 'known') result.alreadyKnown += 1;
    else {
      result.unattributable.push({
        brokerFillId: fill.brokerFillId,
        brokerOrderId: fill.brokerOrderId,
        symbol: fill.symbol,
      });
    }
  }

  return result;
}

async function recordOne(
  tx: Sql,
  fill: Awaited<ReturnType<BrokerAdapter['getFills']>>[number],
): Promise<'recorded' | 'known' | 'unattributable'> {
  const known = await tx.query(`select 1 from ledger.fills where broker_fill_id = $1`, [
    fill.brokerFillId,
  ]);
  if (known.rowCount) return 'known';

  const order = await tx.query<{ id: string; agent_id: string }>(
    `select id, agent_id from ledger.orders where broker_order_id = $1`,
    [fill.brokerOrderId],
  );
  const matched = order.rows[0];
  if (!matched) return 'unattributable';

  await recordFill(tx, {
    orderId: matched.id,
    agentId: matched.agent_id,
    symbol: fill.symbol,
    side: fill.side,
    qty: fill.qty,
    pricePerUnitMinor: fill.pricePerUnitMinor,
    feeMinor: fill.feeMinor,
    brokerFillId: fill.brokerFillId,
    filledAt: fill.filledAt,
  });

  // An order is only 'filled' once the fills add up to what was ordered.
  //
  // Marking it filled on the first fill was wrong: the simulator always fills
  // completely, so nothing caught it, but a real broker filling 4 of 10 would
  // have closed the order and left the remaining 6 arriving against something
  // already done.
  await tx.query(
    `update ledger.orders o
        set status = case
              when (select coalesce(sum(f.qty), 0) from ledger.fills f where f.order_id = o.id) >= o.qty
                then 'filled'::ledger.order_status
              else 'partially_filled'::ledger.order_status
            end,
            updated_at = now()
      where o.id = $1`,
    [matched.id],
  );

  return 'recorded';
}

/**
 * Store a price for every symbol the ledger currently attributes to an agent.
 *
 * Marks are stored rather than fetched at display time so that a figure shown
 * in the UI can be reproduced later, and so reconciliation compares like with
 * like instead of against whatever the market was doing when the job ran.
 */
export async function syncMarks(broker: BrokerAdapter): Promise<number> {
  const symbols = await inTransaction(async (tx) => {
    // Everything held, plus everything any agent is permitted to trade.
    //
    // Held-only would be enough to value the book, but not to decide: a
    // strategy needs price history for a symbol *before* it takes a position,
    // and an agent that only accumulates history for what it already owns can
    // never form an opinion about anything it does not.
    const result = await tx.query<{ symbol: string }>(
      `select symbol from ledger.agent_positions
       union
       select symbol from ledger.agent_universe`,
    );
    return result.rows.map((r) => r.symbol);
  });

  if (symbols.length === 0) return 0;

  const quotes = await broker.getQuotes(symbols);
  const missing = symbols.filter((s) => !quotes.some((q) => q.symbol === s));
  if (missing.length) {
    // Not fatal here, but reconciliation will refuse to report a clean run
    // while any held symbol is unpriced.
    console.warn(`no quote from ${broker.name} for: ${missing.join(', ')}`);
  }

  await inTransaction(async (tx) => {
    for (const quote of quotes) {
      await tx.query(
        `insert into ledger.marks (symbol, as_of, price_minor, source)
         values ($1, $2, $3, $4)
         on conflict (symbol, as_of) do update set price_minor = excluded.price_minor`,
        [quote.symbol, quote.asOf, quote.pricePerUnitMinor.toString(), broker.name],
      );
    }
  });

  return quotes.length;
}
