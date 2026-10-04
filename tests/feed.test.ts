/**
 * The price feed against a real database: what it stores, what it refuses to
 * store, and when it does not ask at all.
 *
 * The daily allowance is 25 requests, so "does not ask" is a feature with a
 * test, not an optimisation.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { closePool, getPool } from '../src/db.js';
import { refreshPrices } from '../src/market/feed.js';
import { resetData } from './helpers.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** VWRP in pounds, at whatever price the test wants. */
const vwrp = (price: string) =>
  vi.fn().mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('SYMBOL_SEARCH')
        ? json({ bestMatches: [{ '1. symbol': 'VWRP.LON', '8. currency': 'GBP' }] })
        : json({ 'Global Quote': { '05. price': price, '07. latest trading day': '2026-10-02' } }),
    ),
  );

const AFTER_FRIDAY_CLOSE = () => new Date('2026-10-02T18:00:00Z');
const MONDAY_EVENING = () => new Date('2026-10-05T18:00:00Z');
const noPause = { pause: async () => undefined };

const stored = async () =>
  (await getPool().query<{ symbol: string; price_minor: string }>('select symbol, price_minor::text from paper.market_prices')).rows;

beforeEach(async () => {
  await resetData();
  await getPool().query('truncate paper.market_prices, paper.feed_instruments');
  process.env['MARKET_DATA_API_KEY'] = 'test-key';
});

afterAll(async () => {
  delete process.env['MARKET_DATA_API_KEY'];
  await closePool();
});

describe('refreshing prices', () => {
  it('prices the benchmark and remembers its currency', async () => {
    const result = await refreshPrices(vwrp('145.62') as unknown as typeof fetch, AFTER_FRIDAY_CLOSE, noPause);

    expect(result.priced).toBe(1);
    expect(await stored()).toEqual([{ symbol: 'VWRP', price_minor: '14562' }]);
    const book = await getPool().query('select symbol, feed_symbol, currency from paper.feed_instruments');
    expect(book.rows).toEqual([{ symbol: 'VWRP', feed_symbol: 'VWRP.LON', currency: 'GBP' }]);
  });

  it('does not ask again for a price it already has from the last close', async () => {
    await refreshPrices(vwrp('145.62') as unknown as typeof fetch, AFTER_FRIDAY_CLOSE, noPause);

    // Saturday morning, and then "Check now" pressed twice: Friday's close is
    // still the newest there is, so asking would only spend the allowance.
    const again = vwrp('145.62');
    const result = await refreshPrices(again as unknown as typeof fetch, () => new Date('2026-10-03T09:00:00Z'), noPause);

    expect(again).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(['VWRP']);
    expect(result.requests).toBe(0);
  });

  it('asks again once there has been a new close, without repeating the currency search', async () => {
    await refreshPrices(vwrp('145.62') as unknown as typeof fetch, AFTER_FRIDAY_CLOSE, noPause);

    const monday = vi.fn().mockImplementation(() =>
      Promise.resolve(json({ 'Global Quote': { '05. price': '146.10', '07. latest trading day': '2026-10-05' } })),
    );
    const result = await refreshPrices(monday as unknown as typeof fetch, MONDAY_EVENING, noPause);

    expect(result.priced).toBe(1);
    expect(result.requests).toBe(1);
    expect(monday.mock.calls.every(([u]) => String(u).includes('GLOBAL_QUOTE'))).toBe(true);
    expect(await stored()).toEqual([{ symbol: 'VWRP', price_minor: '14610' }]);
  });

  it('keeps the old price when the new one is a hundred times off', async () => {
    await refreshPrices(vwrp('145.62') as unknown as typeof fetch, AFTER_FRIDAY_CLOSE, noPause);

    // The same share, now reported as 14562 "pounds" — pence read as pounds.
    // Stored, it would value the holding at £14,562 a share.
    const wrong = vi.fn().mockImplementation(() =>
      Promise.resolve(json({ 'Global Quote': { '05. price': '14562', '07. latest trading day': '2026-10-05' } })),
    );
    const result = await refreshPrices(wrong as unknown as typeof fetch, MONDAY_EVENING, noPause);

    expect(result.priced).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/pounds and pence/);
    expect(await stored()).toEqual([{ symbol: 'VWRP', price_minor: '14562' }]);
  });
});
