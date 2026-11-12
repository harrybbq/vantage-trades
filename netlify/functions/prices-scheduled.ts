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
import { notify } from '../../src/alerts/notify.js';

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

    // Told once a day, in the evening: by then a price that is merely late
    // has had its chance, and the morning run would only repeat the news.
    if (result.rejected.length > 0 && new Date().getUTCHours() >= 12) {
      await notify({
        title: 'Vantage Trades: some prices did not arrive',
        body:
          result.rejected.map((r) => `${r.symbol}: ${r.reason}`).join('\n') +
          '\n\nThe last known price is kept, so nothing is wrong yet, but a holding with an old price is valued at an old price.',
        urgent: broken,
      });
    }
    return new Response(summary, { status: broken ? 500 : 200 });
  } catch (error) {
    console.error('the price refresh failed:', error);
    return new Response('the price refresh failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * Twice a day: late evening, and early the next morning.
 *
 * The free feed serves end-of-day prices and allows 25 requests a day. It was
 * asked once at 17:12, just after the close, and the one time this was looked
 * at (11 Nov 2026) the stored price was still the previous day's: the close
 * seems to be published later than that. So 21:42 UTC asks for today's
 * close, in time for the 22:37 check, and 07:42
 * picks up anything that was still late, before the agents decide at 09:11.
 * A symbol already priced since the last close is not asked about again, so
 * the second run costs nothing when the first one worked.
 */
export const config = { schedule: '42 7,21 * * 1-5' };
