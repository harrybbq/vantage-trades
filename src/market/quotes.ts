/**
 * Where prices come from: Alpha Vantage.
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
 * Alpha Vantage makes this harder than it should be: its quote carries no
 * currency at all. The currency comes from its symbol search, asked once per
 * symbol and remembered (see `CurrencyBook`), and a symbol it cannot find is
 * refused rather than assumed to be pounds. Anything that is not sterling is
 * refused rather than converted. The ledger is single-currency by schema —
 * converting here would put an exchange rate inside a valuation with no record
 * of which rate, which is the same class of mistake one level down.
 *
 * The free plan allows 25 requests a day and about one a second. Requests are
 * made one at a time with a pause between them, and the first sign of the daily
 * limit stops the run: every request after it would fail the same way, and
 * there is nothing to be gained by spending them on finding that out.
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
  /** How many requests this run made, out of a small daily allowance. */
  requests: number;
}

/**
 * The currency each symbol is quoted in, as the feed's symbol search reported
 * it. Kept between runs so the daily allowance is spent on prices: a symbol's
 * quoting currency does not change from one day to the next.
 */
export interface CurrencyBook {
  get(symbol: string): Promise<string | undefined>;
  set(symbol: string, feedSymbol: string, currency: string): Promise<void>;
}

/** A book that forgets everything when the process ends. Tests and probes. */
export function memoryBook(seed: Record<string, string> = {}): CurrencyBook {
  const known = new Map(Object.entries(seed).map(([k, v]) => [k.toUpperCase(), v]));
  return {
    get: async (symbol) => known.get(symbol.toUpperCase()),
    set: async (symbol, _feedSymbol, currency) => void known.set(symbol.toUpperCase(), currency),
  };
}

/**
 * The feed's name for a symbol, or why it cannot have one.
 *
 * The ledger holds bare tickers because that is what the owner types and what
 * a broker will eventually want. London is assumed, since the ledger is
 * sterling; Alpha Vantage names London listings `TICKER.LON`. A symbol written
 * `TICKER.VENUE` for any other venue is refused: it would not be quoted in
 * sterling, and this ledger has nowhere to put anything else.
 */
export function feedSymbol(symbol: string): string | { refused: string } {
  const [ticker = symbol, venue = 'LSE'] = symbol.toUpperCase().split('.');
  if (venue !== 'LSE' && venue !== 'LON') {
    return { refused: `listed on ${venue}, and this feed is only used for London listings` };
  }
  return `${ticker}.LON`;
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
        `quoted in ${currency || 'an unstated currency'}, and this ledger is sterling. Converting ` +
        'here would bury an exchange rate inside a valuation with no record of which rate was used.'
      );
  }
}

type Answer = { body: Record<string, unknown> } | { reason: string; limited?: boolean };

/**
 * One request to the feed.
 *
 * Alpha Vantage answers almost everything with HTTP 200: a bad symbol is
 * `{"Error Message": …}`, and the daily limit is `{"Information": …}` or
 * `{"Note": …}`. Trusting the status code would read the limit notice as an
 * empty quote, so each of those is read and quoted as the reason.
 */
async function ask(params: Record<string, string>, key: string, fetchImpl: typeof fetch): Promise<Answer> {
  const query = new URLSearchParams({ ...params, apikey: key });
  let response: Response;
  try {
    response = await fetchImpl(`https://www.alphavantage.co/query?${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { reason: `could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }

  const text = await response.text().catch(() => '');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      reason: response.ok ? 'the feed did not return JSON' : `the feed answered ${response.status}: ${text.slice(0, 160)}`,
    };
  }
  if (!response.ok) return { reason: `the feed answered ${response.status}` };
  if (typeof body !== 'object' || body === null) return { reason: 'the feed returned something that is not a quote' };

  const error = body['Error Message'];
  if (typeof error === 'string') return { reason: `the feed refused it: ${error}` };

  const notice = body['Information'] ?? body['Note'];
  if (typeof notice === 'string') {
    return { reason: `the feed said: ${notice}`, limited: /per day|rate limit|limit|spreading out/i.test(notice) };
  }

  return { body };
}

/** The currency the feed lists a symbol in, from its symbol search. */
async function lookUpCurrency(
  ticker: string,
  listing: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<{ currency: string } | { reason: string; limited?: boolean }> {
  const answer = await ask({ function: 'SYMBOL_SEARCH', keywords: ticker }, key, fetchImpl);
  if ('reason' in answer) return answer;

  const matches = Array.isArray(answer.body['bestMatches']) ? (answer.body['bestMatches'] as Record<string, unknown>[]) : [];
  const match = matches.find((m) => String(m['1. symbol'] ?? '').toUpperCase() === listing);
  const currency = match?.['8. currency'];
  if (typeof currency !== 'string' || currency === '') {
    // Not found is not the same as pounds. Guessing here is the 100× mistake.
    return { reason: `the feed does not list ${listing}, so its currency is unknown` };
  }
  return { currency };
}

/**
 * When a quote is from.
 *
 * The feed gives a trading day, not a time. It is stamped just after that day's
 * London close, so a quote from Friday reads as Friday's close on Monday
 * morning rather than claiming to be as fresh as the request.
 */
function stampFor(day: unknown, now: () => Date): Date {
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const stamp = new Date(`${day}T16:35:00Z`);
    if (!Number.isNaN(stamp.getTime()) && stamp.getTime() <= now().getTime() + 86_400_000) return stamp;
  }
  return now();
}

const isQuote = (value: FeedQuote | RejectedQuote): value is FeedQuote => 'priceMinor' in value;

export interface FetchOptions {
  book?: CurrencyBook;
  /** Wait between requests. The free plan allows about one a second. */
  pause?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchQuotes(
  symbols: readonly string[],
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  key = apiKey(),
  { book = memoryBook(), pause = sleep }: FetchOptions = {},
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
      requests: 0,
    };
  }

  const settled: (FeedQuote | RejectedQuote)[] = [];
  let requests = 0;
  let stoppedBy: string | null = null;

  const request = async <T>(call: () => Promise<T>): Promise<T> => {
    if (requests > 0) await pause(1_100);
    requests += 1;
    return call();
  };

  for (const raw of symbols) {
    const symbol = raw.toUpperCase();
    if (stoppedBy) {
      settled.push({ symbol, reason: `not asked: ${stoppedBy}` });
      continue;
    }

    const listing = feedSymbol(symbol);
    if (typeof listing !== 'string') {
      settled.push({ symbol, reason: listing.refused });
      continue;
    }
    const ticker = listing.slice(0, -'.LON'.length);

    // Currency first. A symbol already known to be quoted in dollars then
    // costs nothing on later runs, instead of a quote request that will be
    // refused anyway.
    let currency = await book.get(symbol);
    if (currency === undefined) {
      const found = await request(() => lookUpCurrency(ticker, listing, key, fetchImpl));
      if ('reason' in found) {
        if ('limited' in found && found.limited) stoppedBy = 'the daily request limit was reached';
        settled.push({ symbol, reason: found.reason });
        continue;
      }
      currency = found.currency;
      await book.set(symbol, listing, currency);
    }

    const unusable = toPence(1, currency);
    if (typeof unusable === 'string') {
      settled.push({ symbol, reason: unusable });
      continue;
    }

    const answer = await request(() => ask({ function: 'GLOBAL_QUOTE', symbol: listing }, key, fetchImpl));
    if ('reason' in answer) {
      if (answer.limited) stoppedBy = 'the daily request limit was reached';
      settled.push({ symbol, reason: answer.reason });
      continue;
    }

    const quote = answer.body['Global Quote'];
    const price = typeof quote === 'object' && quote !== null ? (quote as Record<string, unknown>)['05. price'] : undefined;
    if (typeof price !== 'string') {
      settled.push({ symbol, reason: `the feed returned no price for ${listing}` });
      continue;
    }

    const pence = toPence(Number(price), currency);
    if (typeof pence === 'string') {
      settled.push({ symbol, reason: pence });
      continue;
    }

    settled.push({ symbol, priceMinor: pence, asOf: stampFor((quote as Record<string, unknown>)['07. latest trading day'], now) });
  }

  return {
    quotes: settled.filter(isQuote),
    rejected: settled.filter((r): r is RejectedQuote => !isQuote(r)),
    requests,
  };
}
