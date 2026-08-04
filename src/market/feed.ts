/**
 * Putting real prices in front of the simulator.
 *
 * The paper broker keeps its own price table, so this writes there rather than
 * straight into `ledger.marks`. That layering is the point: the feed plays the
 * part of the outside world telling the broker what things cost, and the
 * ledger goes on learning prices the same way it will from a real broker —
 * through `syncMarks`. When a real adapter arrives, this stops running and
 * nothing downstream changes.
 */

import { inTransaction } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import { usingPaperBroker } from '../broker/config.js';
import { benchmarkSymbol } from '../ledger/snapshots.js';
import { fetchQuotes } from './quotes.js';

export interface RefreshResult {
  priced: number;
  rejected: { symbol: string; reason: string }[];
  symbols: string[];
}

/**
 * Everything worth a price.
 *
 * Held positions and every agent's permitted universe, for the reason
 * `syncMarks` gives — a strategy needs history for a symbol before it takes a
 * position, so pricing only what is held means never forming an opinion about
 * anything else.
 *
 * Plus the benchmark, which nothing holds and nothing trades. Without it the
 * equity curve has no honest comparison drawn on it, and the one number that
 * matters is whether this beats doing nothing.
 */
export async function symbolsToPrice(): Promise<string[]> {
  return inTransaction(async (tx) => {
    const result = await tx.query<{ symbol: string }>(
      `select symbol from ledger.agent_positions
       union
       select symbol from ledger.agent_universe`,
    );

    const symbols = new Set(result.rows.map((r) => r.symbol.toUpperCase()));
    symbols.add(benchmarkSymbol().toUpperCase());
    return [...symbols].sort();
  });
}

/**
 * Fetch prices and hand them to the simulator.
 *
 * A rejected symbol writes nothing at all. Leaving the previous price in place
 * is the right failure: a stale mark is visibly stale — reconciliation and the
 * panel both show when a holding was last priced — whereas a wrong one is
 * indistinguishable from a right one and silently poisons every figure derived
 * from it.
 */
export async function refreshPrices(fetchImpl: typeof fetch = fetch): Promise<RefreshResult> {
  if (!usingPaperBroker()) {
    // Against a real broker, prices come from the broker. Writing to the
    // simulator's table then would be inventing a second source of truth.
    return { priced: 0, rejected: [], symbols: [] };
  }

  const symbols = await symbolsToPrice();
  if (symbols.length === 0) return { priced: 0, rejected: [], symbols: [] };

  const { quotes, rejected } = await fetchQuotes(symbols, fetchImpl);

  await inTransaction(async (tx) => {
    const broker = new PaperBroker(tx);
    for (const quote of quotes) {
      await broker.setPrice(quote.symbol, quote.priceMinor, quote.asOf);
    }
  });

  return { priced: quotes.length, rejected, symbols };
}
