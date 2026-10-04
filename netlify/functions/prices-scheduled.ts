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
      (result.skipped.length ? `, ${result.skipped.length} already priced since the last close` : '') +
      (result.rejected.length ? `, refused ${result.rejected.map((r) => r.symbol).join(', ')}` : '') +
      ` (${result.requests} feed requests)`;
    console.log(summary);

    // Non-2xx when nothing could be priced but something should have been, so
    // a feed that has quietly stopped working shows as a failed run rather
    // than a successful one that logged a warning nobody reads.
    const broken = result.symbols.length > result.skipped.length && result.priced === 0;
    return new Response(summary, { status: broken ? 500 : 200 });
  } catch (error) {
    console.error('the price refresh failed:', error);
    return new Response('the price refresh failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * Once a day, after the London close.
 *
 * The free feed allows 25 requests a day and serves end-of-day prices, so an
 * hourly run would exhaust the allowance by lunchtime and learn nothing new.
 * 17:12 UTC is after the close in summer and winter time, and well before the
 * nightly reconciliation at 22:37. "Check now" on the panel asks only about
 * symbols not yet priced since the last close, so it costs nothing on a day
 * this has already run.
 */
export const config = { schedule: '12 17 * * 1-5' };
