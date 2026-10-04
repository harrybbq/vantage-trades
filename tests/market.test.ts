/**
 * The price feed.
 *
 * Almost all of this is about currency, because that is where the damage is.
 * London quotes some instruments in pounds and others in pence, and the two
 * differ by a factor of a hundred with nothing but the case of a letter to
 * tell them apart. A price taken at the wrong scale does not fail — it values
 * the book at 100× or 1/100 of the truth, reconciles cleanly against a broker
 * that was told the same wrong number, and is very hard to notice.
 *
 * A feed that is down is a visible problem. A feed that is confidently wrong
 * is the thing this ledger exists to prevent.
 */

import { describe, it, expect, vi } from 'vitest';
import { toPence, feedSymbol, fetchQuotes, memoryBook } from '../src/market/quotes.js';
import { implausibleMove, lastCloseDay } from '../src/market/feed.js';

const KEY = 'test-key';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Alpha Vantage's symbol search and quote, shaped as it sends them. */
const search = (listing: string, currency: string) =>
  json({ bestMatches: [{ '1. symbol': listing, '4. region': 'United Kingdom', '8. currency': currency }] });
const quote = (price: string, day = '2026-10-02') =>
  json({ 'Global Quote': { '01. symbol': 'X.LON', '05. price': price, '07. latest trading day': day } });

/** Route by the function the request names. */
const feed = (answers: { search?: () => Response; quote?: () => Response }) =>
  vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('SYMBOL_SEARCH')) return Promise.resolve(answers.search?.() ?? search('VWRP.LON', 'GBP'));
    return Promise.resolve(answers.quote?.() ?? quote('102.34'));
  });

const noPause = { pause: async () => undefined };
const run = (symbols: string[], fake: ReturnType<typeof vi.fn>, opts = {}) =>
  fetchQuotes(symbols, fake as unknown as typeof fetch, () => new Date('2026-10-04T12:00:00Z'), KEY, { ...noPause, ...opts });

describe('turning a quote into pence', () => {
  it('reads pounds as pounds', () => {
    expect(toPence(102.34, 'GBP')).toBe(10234n);
  });

  it('reads pence as pence', () => {
    // The same number in GBp is one hundredth of the value. Getting this
    // backwards is the whole risk.
    expect(toPence(102.34, 'GBp')).toBe(102n);
    expect(toPence(645, 'GBp')).toBe(645n);
    expect(toPence(645, 'GBX')).toBe(645n);
  });

  it('never confuses the two', () => {
    expect(toPence(500, 'GBP')).toBe(50_000n);
    expect(toPence(500, 'GBp')).toBe(500n);
  });

  it('refuses any other currency rather than converting', () => {
    // Converting here would put an exchange rate inside a valuation with no
    // record of which rate, which is the same mistake one level down.
    for (const currency of ['USD', 'EUR', 'JPY', '', 'gbp']) {
      const result = toPence(100, currency);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/sterling|implausible/i);
    }
  });

  it('refuses a price that cannot be one', () => {
    for (const price of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(typeof toPence(price, 'GBP')).toBe('string');
    }
  });

  it('rounds to the nearest penny', () => {
    // Acceptable for a mark, which says what a holding is worth. Fills post
    // exact integers and never come through here.
    expect(toPence(1.005, 'GBP')).toBe(101n);
    expect(toPence(1.004, 'GBP')).toBe(100n);
  });
});

describe('naming a symbol for the feed', () => {
  it('assumes London, because the ledger is sterling', () => {
    expect(feedSymbol('VWRP')).toBe('VWRP.LON');
    expect(feedSymbol('hsba')).toBe('HSBA.LON');
  });

  it('honours an explicit London venue', () => {
    expect(feedSymbol('VWRP.LSE')).toBe('VWRP.LON');
  });

  it('refuses other venues rather than pricing them in another currency', () => {
    expect(feedSymbol('AAPL.NASDAQ')).toEqual({ refused: expect.stringMatching(/NASDAQ/) });
  });
});

describe('without a provider key', () => {
  it('prices nothing and says why, rather than inventing a mark', async () => {
    const fake = vi.fn();
    const { quotes, rejected } = await fetchQuotes(['VWRP'], fake as unknown as typeof fetch, undefined, undefined);

    expect(fake).not.toHaveBeenCalled();
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/MARKET_DATA_API_KEY/);
  });
});

describe('fetching', () => {
  it('returns a quote in minor units, stamped with its trading day', async () => {
    const { quotes, rejected } = await run(['VWRP'], feed({}));

    expect(rejected).toEqual([]);
    expect(quotes[0]).toMatchObject({ symbol: 'VWRP', priceMinor: 10234n });
    // The trading day's close, not the moment of the request: a quote
    // stamped now claims to be fresher than it is.
    expect(quotes[0]?.asOf.toISOString()).toBe('2026-10-02T16:35:00.000Z');
  });

  it('reads a pence-quoted share as pence', async () => {
    // AZN at 11234 GBX is £112.34. Read as pounds it would be £11,234 — the
    // whole risk in one number.
    const { quotes } = await run(['AZN'], feed({ search: () => search('AZN.LON', 'GBX'), quote: () => quote('11234.0000') }));
    expect(quotes[0]?.priceMinor).toBe(11234n);
  });

  it('asks for the London listing', async () => {
    const fake = feed({});
    await run(['VWRP'], fake);
    const urls = fake.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toContain('function=SYMBOL_SEARCH');
    expect(urls[0]).toContain('keywords=VWRP');
    expect(urls[1]).toContain('function=GLOBAL_QUOTE');
    expect(urls[1]).toContain('symbol=VWRP.LON');
  });

  it('asks for the currency once and remembers it', async () => {
    const book = memoryBook();
    const fake = feed({});
    await run(['VWRP'], fake, { book });
    await run(['VWRP'], fake, { book });
    const searches = fake.mock.calls.filter(([u]) => String(u).includes('SYMBOL_SEARCH'));
    expect(searches).toHaveLength(1);
    expect(await book.get('VWRP')).toBe('GBP');
  });

  it('refuses a symbol the search cannot find, rather than assuming pounds', async () => {
    // Not found is not the same as GBP. Guessing here is the 100× mistake.
    const fake = feed({ search: () => json({ bestMatches: [{ '1. symbol': 'VWRP.DEX', '8. currency': 'EUR' }] }) });
    const { quotes, rejected } = await run(['VWRP'], fake);

    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/does not list VWRP\.LON/);
    expect(fake.mock.calls.some(([u]) => String(u).includes('GLOBAL_QUOTE'))).toBe(false);
  });

  it('refuses a dollar-quoted instrument without asking for its price', async () => {
    const fake = feed({ search: () => search('SPY.LON', 'USD') });
    const { quotes, rejected } = await run(['SPY'], fake);

    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/sterling/);
    expect(fake.mock.calls.some(([u]) => String(u).includes('GLOBAL_QUOTE'))).toBe(false);
  });

  it('reads an error reported as a 200, rather than as a price', async () => {
    const fake = feed({ quote: () => json({ 'Error Message': 'Invalid API call.' }) });
    const { quotes, rejected } = await run(['VWRP'], fake);
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/Invalid API call/);
  });

  it('stops at the daily limit instead of spending the rest of the run on it', async () => {
    const limit = () => json({ Information: 'Our standard API rate limit is 25 requests per day.' });
    const fake = feed({ search: limit });
    const { quotes, rejected, requests } = await run(['AZN', 'GSK', 'VWRP'], fake);

    expect(quotes).toEqual([]);
    expect(requests).toBe(1);
    expect(rejected.map((r) => r.symbol)).toEqual(['AZN', 'GSK', 'VWRP']);
    expect(rejected[0]?.reason).toMatch(/25 requests per day/);
    expect(rejected[1]?.reason).toMatch(/not asked: the daily request limit/);
  });

  it('waits between requests', async () => {
    const pause = vi.fn(async () => undefined);
    await run(['VWRP'], feed({}), { pause });
    // Two requests, one pause between them.
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(1_100);
  });

  it('treats an empty quote as no price', async () => {
    // Alpha Vantage answers an unknown symbol with {"Global Quote": {}}.
    const { quotes, rejected } = await run(['VWRP'], feed({ quote: () => json({ 'Global Quote': {} }) }));
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/no price/);
  });

  it('keeps the good symbols when one fails', async () => {
    const fake = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('SYMBOL_SEARCH')) return Promise.resolve(u.includes('NOSUCH') ? json({ bestMatches: [] }) : search('VWRP.LON', 'GBP'));
      return Promise.resolve(quote('102.34'));
    });
    const { quotes, rejected } = await run(['VWRP', 'NOSUCH'], fake);

    expect(quotes.map((q) => q.symbol)).toEqual(['VWRP']);
    expect(rejected.map((r) => r.symbol)).toEqual(['NOSUCH']);
  });

  it('survives the feed being unreachable', async () => {
    const fake = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { quotes, rejected } = await run(['VWRP'], fake);
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/could not be fetched/);
  });

  it('still reports an error status with no usable body', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const { rejected } = await run(['VWRP'], fake);
    expect(rejected[0]?.reason).toContain('502');
  });

  it('survives a reply that is not the shape it should be', async () => {
    for (const body of ['not json', '{}', '{"Global Quote":{"05. price":5}}', '[]']) {
      const fake = feed({ quote: () => new Response(body, { status: 200 }) });
      const { quotes, rejected } = await run(['VWRP'], fake);
      expect(quotes).toEqual([]);
      expect(rejected).toHaveLength(1);
    }
  });
});

describe('refusing a price that cannot be right', () => {
  it('accepts an ordinary day', () => {
    expect(implausibleMove(10_000n, 10_300n)).toBeNull();
    expect(implausibleMove(10_000n, 7_000n)).toBeNull();
  });

  it('refuses a move that looks like pounds read as pence', () => {
    // The same share, quoted at 112.34 one day and 11234 the next.
    expect(implausibleMove(11_234n, 1_123_400n)).toMatch(/pounds and pence/);
    expect(implausibleMove(1_123_400n, 11_234n)).toMatch(/pounds and pence/);
  });
});

describe('knowing when there is nothing new to ask for', () => {
  it('uses yesterday before the close and today after it', () => {
    expect(lastCloseDay(new Date('2026-10-01T12:00:00Z'))).toBe('2026-09-30');
    expect(lastCloseDay(new Date('2026-10-01T17:30:00Z'))).toBe('2026-10-01');
  });

  it('carries Friday through the weekend', () => {
    expect(lastCloseDay(new Date('2026-10-03T10:00:00Z'))).toBe('2026-10-02');
    expect(lastCloseDay(new Date('2026-10-05T09:00:00Z'))).toBe('2026-10-02');
  });
});
