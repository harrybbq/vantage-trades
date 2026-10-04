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

import type pg from 'pg';
import { inTransaction } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import { usingPaperBroker } from '../broker/config.js';
import { benchmarkSymbol } from '../ledger/snapshots.js';
import { fetchQuotes, type CurrencyBook, type FeedQuote, type FetchOptions } from './quotes.js';

export interface RefreshResult {
  priced: number;
  rejected: { symbol: string; reason: string }[];
  symbols: string[];
  /** Already priced since the last close, so not asked about again. */
  skipped: string[];
  requests: number;
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
 * The most recent London close a free end-of-day feed can have published.
 *
 * Taken as 17:00 UTC on a weekday, which is after the close in both summer and
 * winter time. A price already stamped on or after that day cannot be improved
 * on by asking again, so asking would only spend the daily allowance. Bank
 * holidays are not modelled: on one, a symbol is asked about and the feed
 * returns the previous close, which costs a request and nothing else.
 */
export function lastCloseDay(now: Date): string {
  const d = new Date(now);
  if (d.getUTCHours() < 17) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * How far a price may move from the last one before it is refused.
 *
 * Large companies do not triple or lose two thirds in a day. A move that size
 * is far more likely to be pounds read as pence, or the reverse, than a real
 * price — and storing it would value the holding at 100× the truth. Refused,
 * the previous price stays, shows as stale, and the reason is logged.
 */
export const MAX_DAILY_MOVE = 3;

export function implausibleMove(previous: bigint, next: bigint): string | null {
  const up = Number(next) / Number(previous);
  if (up > MAX_DAILY_MOVE || up < 1 / MAX_DAILY_MOVE) {
    return (
      `price moved from ${previous}p to ${next}p, more than ${MAX_DAILY_MOVE}× in one step. ` +
      'That looks like pounds and pence mixed up, so the previous price was kept. If the move is ' +
      'real, delete the symbol from paper.market_prices and it will be priced afresh.'
    );
  }
  return null;
}

/** The currency book, kept in `paper.feed_instruments`. */
export function databaseBook(): CurrencyBook {
  return {
    get: (symbol) =>
      inTransaction(async (tx) => {
        const r = await tx.query<{ currency: string }>(
          'select currency from paper.feed_instruments where symbol = $1',
          [symbol.toUpperCase()],
        );
        return r.rows[0]?.currency;
      }),
    set: (symbol, feedSymbol, currency) =>
      inTransaction(async (tx) => {
        await tx.query(
          `insert into paper.feed_instruments (symbol, feed_symbol, currency) values ($1, $2, $3)
           on conflict (symbol) do update
             set feed_symbol = excluded.feed_symbol, currency = excluded.currency, checked_at = now()`,
          [symbol.toUpperCase(), feedSymbol, currency],
        );
      }),
  };
}

async function storedPrices(tx: pg.PoolClient): Promise<Map<string, { price: bigint; at: Date }>> {
  const r = await tx.query<{ symbol: string; price_minor: string; updated_at: Date }>(
    'select symbol, price_minor::text, updated_at from paper.market_prices',
  );
  return new Map(r.rows.map((row) => [row.symbol, { price: BigInt(row.price_minor), at: row.updated_at }]));
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
export async function refreshPrices(
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  options: FetchOptions = {},
): Promise<RefreshResult> {
  const nothing = { priced: 0, rejected: [], symbols: [], skipped: [], requests: 0 };
  if (!usingPaperBroker()) {
    // Against a real broker, prices come from the broker. Writing to the
    // simulator's table then would be inventing a second source of truth.
    return nothing;
  }

  const symbols = await symbolsToPrice();
  if (symbols.length === 0) return nothing;

  const before = await inTransaction(storedPrices);
  const close = lastCloseDay(now());
  const skipped = symbols.filter((s) => {
    const held = before.get(s);
    return held !== undefined && held.at.toISOString().slice(0, 10) >= close;
  });
  const wanted = symbols.filter((s) => !skipped.includes(s));

  const { quotes, rejected, requests } = await fetchQuotes(wanted, fetchImpl, now, undefined, {
    book: databaseBook(),
    ...options,
  });

  const accepted: FeedQuote[] = [];
  for (const quote of quotes) {
    const previous = before.get(quote.symbol);
    const odd = previous ? implausibleMove(previous.price, quote.priceMinor) : null;
    if (odd) rejected.push({ symbol: quote.symbol, reason: odd });
    else accepted.push(quote);
  }

  await inTransaction(async (tx) => {
    const broker = new PaperBroker(tx);
    for (const quote of accepted) {
      await broker.setPrice(quote.symbol, quote.priceMinor, quote.asOf);
    }
  });

  return { priced: accepted.length, rejected, symbols, skipped, requests };
}
