/**
 * Where prices come from.
 *
 * The paper broker is an execution simulator with no opinion about what things
 * cost — `paper.market_prices` was only ever written by tests and demos, so in
 * production nothing was priced, no strategy could form a view, and the
 * benchmark could not be drawn. This fills that table from a real feed, which
 * leaves the simulation honest about everything except the fills themselves.
 *
 * **The dangerous part of this file is the currency, not the network.** London
 * quotes some instruments in pounds and others in pence, and the difference
 * between them is a factor of one hundred. A price taken at the wrong scale
 * does not fail — it produces an equity figure that is wrong by 100×, in a
 * ledger whose whole purpose is that its numbers can be trusted. A feed that
 * is merely down is a visible problem; a feed that is confidently wrong is the
 * failure this codebase exists to prevent.
 *
 * So the currency is checked on every quote, and anything that is not sterling
 * is refused rather than converted. The ledger is single-currency by schema —
 * converting here would put an exchange rate inside a valuation with no record
 * of which rate, which is the same class of mistake one level down.
 */

export interface FeedQuote {
  symbol: string;
  /** Pence. Integer, like every other money value in this system. */
  priceMinor: bigint;
  asOf: Date;
}

export interface RejectedQuote {
  symbol: string;
  reason: string;
}

export interface FeedResult {
  quotes: FeedQuote[];
  rejected: RejectedQuote[];
}

/**
 * The feed's name for a symbol, and the venue it trades on.
 *
 * The ledger holds bare tickers because that is what the owner types and what
 * a broker will eventually want. London is assumed, since the ledger is
 * sterling. A symbol written `TICKER.VENUE` names its venue explicitly, for
 * the day one of them is not on the LSE.
 */
export function feedSymbol(symbol: string): { symbol: string; exchange: string } {
  const [ticker = symbol, venue] = symbol.split('.');
  return { symbol: ticker.toUpperCase(), exchange: (venue ?? 'LSE').toUpperCase() };
}

/**
 * The key for the market data provider.
 *
 * There is deliberately no fallback and no default source. The keyless
 * endpoints that serve a browser — Yahoo, Stooq — refuse datacenter traffic
 * with 429 and 404 respectively, so a "free" feed here would be one that
 * silently priced nothing in production while looking fine in development.
 * Better to require the key and do nothing without it.
 */
export function apiKey(): string | undefined {
  return process.env['MARKET_DATA_API_KEY']?.trim() || undefined;
}

/**
 * Convert a quoted price to pence, or explain why it cannot be.
 *
 * `GBP` is pounds and `GBp` (also written GBX) is pence — the case of that
 * final letter is the entire difference, which is a poor way to carry a
 * factor of a hundred, so both are handled explicitly and nothing else is
 * accepted at all.
 *
 * The result is rounded to the nearest penny. That is fine here and only here:
 * a mark is a valuation, used to say what a holding is worth today. Fills post
 * exact integers and never go through this.
 */
export function toPence(price: number, currency: string): bigint | string {
  if (!Number.isFinite(price) || price <= 0) {
    return `implausible price ${price}`;
  }

  switch (currency) {
    // Not Math.round(price * 100): 1.005 * 100 is 100.49999999999999 in binary
    // floating point, so that rounds a penny *down* on values whose decimal
    // form ends in 5. Fixing the product to six places first discards the
    // representation noise and leaves the decimal the feed meant, which is
    // then rounded once.
    case 'GBP':
      return BigInt(Math.round(Number((price * 100).toFixed(6))));
    case 'GBp':
    case 'GBX':
      return BigInt(Math.round(Number(price.toFixed(6))));
    default:
      return (
        `quoted in ${currency}, and this ledger is sterling. Converting here would ` +
        'bury an exchange rate inside a valuation with no record of which rate was used.'
      );
  }
}

/** Twelve Data's quote shape, plus the error shape it uses instead. */
interface QuoteResponse {
  close?: string;
  currency?: string;
  timestamp?: number;
  status?: string;
  message?: string;
}

/**
 * Ask the feed for one symbol.
 *
 * Deliberately one request per symbol rather than a batch: a batch endpoint
 * that half-fails gives you a partial answer that is easy to mistake for a
 * complete one, and there are a handful of symbols here, not thousands.
 */
async function fetchOne(
  symbol: string,
  key: string,
  fetchImpl: typeof fetch,
  now: () => Date,
): Promise<FeedQuote | RejectedQuote> {
  const { symbol: ticker, exchange } = feedSymbol(symbol);
  const url =
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}` +
    `&exchange=${encodeURIComponent(exchange)}&apikey=${encodeURIComponent(key)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      symbol,
      reason: `could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return { symbol, reason: `the feed answered ${response.status}` };
  }

  let body: QuoteResponse;
  try {
    body = (await response.json()) as QuoteResponse;
  } catch {
    return { symbol, reason: 'the feed did not return JSON' };
  }

  // Twelve Data reports failures as a 200 with status:"error", so a bare
  // status check would read a rate-limit notice as a price.
  if (body.status === 'error') {
    return { symbol, reason: body.message ?? 'the feed reported an error' };
  }

  const { close, currency } = body;
  if (typeof close !== 'string' || typeof currency !== 'string') {
    return { symbol, reason: 'the feed returned no price or no currency' };
  }

  const price = Number(close);
  const pence = toPence(price, currency);
  if (typeof pence === 'string') return { symbol, reason: pence };

  // The feed's own timestamp where it has one. A quote stamped with the moment
  // it was fetched claims to be fresher than it is, and staleness is exactly
  // what a mark needs to be honest about.
  const asOf = typeof body.timestamp === 'number' ? new Date(body.timestamp * 1000) : now();

  return { symbol: symbol.toUpperCase(), priceMinor: pence, asOf };
}

const isQuote = (value: FeedQuote | RejectedQuote): value is FeedQuote => 'priceMinor' in value;

export async function fetchQuotes(
  symbols: readonly string[],
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  key = apiKey(),
): Promise<FeedResult> {
  if (!key) {
    // Not an error worth throwing: an unconfigured feed is a state the owner
    // can be in on purpose. It must not be a state that quietly invents marks.
    return {
      quotes: [],
      rejected: symbols.map((symbol) => ({
        symbol,
        reason: 'no market data provider configured (set MARKET_DATA_API_KEY)',
      })),
    };
  }

  const settled = await Promise.all(symbols.map((symbol) => fetchOne(symbol, key, fetchImpl, now)));

  return {
    quotes: settled.filter(isQuote),
    rejected: settled.filter((r): r is RejectedQuote => !isQuote(r)),
  };
}
