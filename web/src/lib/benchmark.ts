/**
 * What the panel calls the benchmark.
 *
 * The owner is new to this, and "VWRP" is a stock-market code, not a name
 * anyone recognises. On screen it is called by a plain name; the code appears
 * only where the actual share is listed (holdings, trades, the share list),
 * because that is what a broker will call it.
 *
 * The server is the source (`BENCHMARK_NAME`, `BENCHMARK_SYMBOL`) and sends
 * both with every view. The defaults here match the server's and are only
 * what shows before the first view arrives.
 */

let label = 'World index fund';
let symbol = 'VWRP';

export function setBenchmark(name: string | undefined, code: string | undefined): void {
  if (name?.trim()) label = name.trim();
  if (code?.trim()) symbol = code.trim().toUpperCase();
}

/** As a label or heading: "World index fund". */
export const benchLabel = (): string => label;

/** Inside a sentence: "the world index fund". */
export const bench = (): string => `the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

/** Where there is room for one word, such as the end of a chart line. */
export const benchShort = (): string => 'Index';

/** The real code, for the places a share is actually listed. */
export const benchSymbol = (): string => symbol;
