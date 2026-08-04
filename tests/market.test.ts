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
import { toPence, feedSymbol, fetchQuotes } from '../src/market/quotes.js';

const KEY = 'test-key';

/** A response shaped like the feed's. */
const chart = (price: unknown, currency: unknown, time?: number) =>
  new Response(JSON.stringify({ close: price, currency, timestamp: time }), { status: 200 });

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
    expect(feedSymbol('VWRP')).toEqual({ symbol: 'VWRP', exchange: 'LSE' });
    expect(feedSymbol('HSBA')).toEqual({ symbol: 'HSBA', exchange: 'LSE' });
  });

  it('honours an explicit venue', () => {
    expect(feedSymbol('VWRP.LSE')).toEqual({ symbol: 'VWRP', exchange: 'LSE' });
    expect(feedSymbol('AAPL.NASDAQ')).toEqual({ symbol: 'AAPL', exchange: 'NASDAQ' });
  });
});

describe('without a provider key', () => {
  it('prices nothing and says why, rather than inventing a mark', async () => {
    const fake = vi.fn();
    const { quotes, rejected } = await fetchQuotes(
      ['VWRP'],
      fake as unknown as typeof fetch,
      undefined,
      undefined,
    );

    expect(fake).not.toHaveBeenCalled();
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/MARKET_DATA_API_KEY/);
  });
});

describe('fetching', () => {
  it('returns a quote in minor units', async () => {
    const fake = vi.fn().mockResolvedValue(chart('102.34', 'GBP', 1_785_000_000));
    const { quotes, rejected } = await fetchQuotes(['VWRP'], fake as unknown as typeof fetch, undefined, KEY);

    expect(rejected).toEqual([]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ symbol: 'VWRP', priceMinor: 10234n });
    // The feed's own timestamp, not the moment of the request: a quote stamped
    // now claims to be fresher than it is.
    expect(quotes[0]?.asOf.toISOString()).toBe(new Date(1_785_000_000_000).toISOString());
  });

  it('asks the feed for the London listing', async () => {
    const fake = vi.fn().mockResolvedValue(chart('1', 'GBP'));
    await fetchQuotes(['VWRP'], fake as unknown as typeof fetch, undefined, KEY);
    const url = String(fake.mock.calls[0]?.[0]);
    expect(url).toContain('symbol=VWRP');
    expect(url).toContain('exchange=LSE');
  });

  it('reads an error reported as a 200, rather than as a price', async () => {
    // The provider answers rate limits and bad symbols with HTTP 200 and
    // status:"error". Trusting the status code alone would store the notice.
    const fake = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', message: 'API credits exceeded' }), {
        status: 200,
      }),
    );
    const { quotes, rejected } = await fetchQuotes(
      ['VWRP'],
      fake as unknown as typeof fetch,
      undefined,
      KEY,
    );
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/credits exceeded/);
  });

  it('rejects a dollar-quoted instrument and prices nothing', async () => {
    const fake = vi.fn().mockResolvedValue(chart('210.5', 'USD'));
    const { quotes, rejected } = await fetchQuotes(['SPY'], fake as unknown as typeof fetch, undefined, KEY);

    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/sterling/);
  });

  it('keeps the good symbols when one fails', async () => {
    // A partial answer must not be mistaken for a complete one, and one bad
    // symbol must not cost the rest their prices.
    const fake = vi
      .fn()
      .mockResolvedValueOnce(chart('102.34', 'GBP'))
      .mockResolvedValueOnce(new Response('nope', { status: 404 }));

    const { quotes, rejected } = await fetchQuotes(
      ['VWRP', 'NOSUCH'],
      fake as unknown as typeof fetch,
      undefined,
      KEY,
    );

    expect(quotes.map((q) => q.symbol)).toEqual(['VWRP']);
    expect(rejected.map((r) => r.symbol)).toEqual(['NOSUCH']);
  });

  it('survives the feed being unreachable', async () => {
    const fake = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { quotes, rejected } = await fetchQuotes(['VWRP'], fake as unknown as typeof fetch, undefined, KEY);

    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/could not be fetched/);
  });

  it('quotes the reason from a body served with an error status', async () => {
    // This provider answers "symbol not found" and "your plan does not cover
    // this exchange" with a 404 and a JSON body. The status code alone says
    // only that something was missing, which is the least useful half.
    const fake = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ code: 404, message: '**symbol** not found: VWRP. Please specify a valid symbol', status: 'error' }),
        { status: 404 },
      ),
    );
    const { quotes, rejected } = await fetchQuotes(
      ['VWRP'],
      fake as unknown as typeof fetch,
      undefined,
      KEY,
    );
    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toContain('not found: VWRP');
  });

  it('still reports an error status with no usable body', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const { rejected } = await fetchQuotes(
      ['VWRP'],
      fake as unknown as typeof fetch,
      undefined,
      KEY,
    );
    expect(rejected[0]?.reason).toContain('502');
  });

  it('survives a reply that is not the shape it should be', async () => {
    for (const body of ['not json', '{}', '{"close":"1"}', '{"currency":"GBP"}']) {
      const fake = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      const { quotes, rejected } = await fetchQuotes(
        ['VWRP'],
        fake as unknown as typeof fetch,
        undefined,
        KEY,
      );
      expect(quotes).toEqual([]);
      expect(rejected).toHaveLength(1);
    }
  });

  it('refuses a quote with a price but no currency', async () => {
    // The dangerous shape: a plausible number with nothing saying what it
    // means. Guessing sterling here is exactly the 100× mistake.
    const fake = vi.fn().mockResolvedValue(chart('645', undefined));
    const { quotes, rejected } = await fetchQuotes(['HSBA'], fake as unknown as typeof fetch, undefined, KEY);

    expect(quotes).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/no price or no currency/);
  });
});
