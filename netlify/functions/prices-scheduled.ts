/**
 * Fetch prices on a schedule.
 *
 * Places no orders and touches no ledger table. It updates the simulator's
 * view of what things cost; `syncMarks`, during reconciliation, is what copies
 * that into the ledger.
 *
 * A symbol the feed refuses is logged and left at its previous price. That is
 * the safe failure: a stale mark shows as stale everywhere it is used, while a
 * wrong one looks exactly like a right one.
 */

import { refreshPrices } from '../../src/market/feed.js';
import { closePool } from '../../src/db.js';

export default async function pricesScheduled(): Promise<Response> {
  try {
    const result = await refreshPrices();

    for (const { symbol, reason } of result.rejected) {
      console.warn(`no price for ${symbol}: ${reason}`);
    }

    const summary =
      `priced ${result.priced} of ${result.symbols.length}` +
      (result.rejected.length ? `, refused ${result.rejected.map((r) => r.symbol).join(', ')}` : '');
    console.log(summary);

    // Non-2xx when nothing could be priced but something should have been, so
    // a feed that has quietly stopped working shows as a failed run rather
    // than a successful one that logged a warning nobody reads.
    const broken = result.symbols.length > 0 && result.priced === 0;
    return new Response(summary, { status: broken ? 500 : 200 });
  } catch (error) {
    console.error('the price refresh failed:', error);
    return new Response('the price refresh failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * Hourly through the London session, plus once before the nightly
 * reconciliation.
 *
 * 08:00–17:00 UTC covers 08:00–16:30 London across both daylight and standard
 * time. The 22:00 run is so reconciliation at 22:37 values the book against a
 * closing price fetched minutes earlier rather than one from the afternoon.
 */
export const config = { schedule: '22 8-17,22 * * 1-5' };
