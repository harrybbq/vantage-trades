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
 * The feed's name for a symbol.
 *
 * The ledger holds bare tickers because that is what the owner types and what
 * a broker will eventually want. This appends the London suffix, since the
 * ledger is sterling and an instrument priced in pounds is on the LSE by
 * definition. A symbol that already carries a suffix is passed through, so a
 * different venue can be named explicitly when one is ever needed.
 */
export function feedSymbol(symbol: string): string {
  return symbol.includes('.') ? symbol : `${symbol}.L`;
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

interface ChartResponse {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        currency?: string;
        regularMarketTime?: number;
        symbol?: string;
      };
    }[];
    error?: { description?: string } | null;
  };
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
  fetchImpl: typeof fetch,
  now: () => Date,
): Promise<FeedQuote | RejectedQuote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feedSymbol(symbol))}?interval=1d&range=1d`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { symbol, reason: `could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    return { symbol, reason: `the feed answered ${response.status}` };
  }

  let body: ChartResponse;
  try {
    body = (await response.json()) as ChartResponse;
  } catch {
    return { symbol, reason: 'the feed did not return JSON' };
  }

  const meta = body.chart?.result?.[0]?.meta;
  if (!meta) {
    return { symbol, reason: body.chart?.error?.description ?? 'no result for this symbol' };
  }

  const { regularMarketPrice: price, currency } = meta;
  if (typeof price !== 'number' || typeof currency !== 'string') {
    return { symbol, reason: 'the feed returned no price or no currency' };
  }

  const pence = toPence(price, currency);
  if (typeof pence === 'string') return { symbol, reason: pence };

  // The feed's own timestamp where it has one. A quote stamped with the moment
  // it was fetched claims to be fresher than it is, and staleness is exactly
  // what a mark needs to be honest about.
  const asOf =
    typeof meta.regularMarketTime === 'number' ? new Date(meta.regularMarketTime * 1000) : now();

  return { symbol: symbol.toUpperCase(), priceMinor: pence, asOf };
}

const isQuote = (value: FeedQuote | RejectedQuote): value is FeedQuote => 'priceMinor' in value;

export async function fetchQuotes(
  symbols: readonly string[],
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<FeedResult> {
  const settled = await Promise.all(symbols.map((symbol) => fetchOne(symbol, fetchImpl, now)));

  return {
    quotes: settled.filter(isQuote),
    rejected: settled.filter((r): r is RejectedQuote => !isQuote(r)),
  };
}
