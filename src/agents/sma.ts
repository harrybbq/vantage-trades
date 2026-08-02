/**
 * The dumb agent: a moving-average crossover. A fixed rule, no model.
 *
 * Buy a symbol when its price closes above its own N-day average and we do not
 * hold it; sell when it closes below and we do. Equal-weight sizing across the
 * universe.
 *
 * This exists to prove the loop, the halt, the kill and the ledger under
 * live-ish conditions. It is deliberately NOT expected to make money.
 *
 * Why it probably loses: a crossover rule trades often, and the dominant cost
 * on a small account is spread and slippage rather than being wrong about
 * direction. Every round trip pays that cost twice. Automation does not create
 * an edge — it industrialises whatever edge you have, and this rule has none.
 *
 * That is the useful part. If the benchmark chart cannot show this losing to
 * buy-and-hold, the benchmark is broken, and it is far better to discover that
 * with a rule nobody believes in than with one somebody does.
 */

import type { Minor, Qty } from '../money.js';
import type { Intent, PriceBar, Strategy, StrategyInput } from './types.js';

export interface SmaConfig {
  /** Averaging window, in bars. */
  window: number;
  /** Most of the allocation the agent will hold at once, as a percent. */
  maxInvestedPct: number;
}

export const DEFAULT_SMA: SmaConfig = { window: 20, maxInvestedPct: 80 };

function average(bars: readonly PriceBar[]): Minor {
  const total = bars.reduce((sum, b) => sum + b.closeMinor, 0n);
  return total / BigInt(bars.length);
}

export class SmaCrossover implements Strategy {
  readonly name: string;
  private readonly config: SmaConfig;

  /**
   * Partial config is merged over the defaults. Requiring every field meant a
   * caller supplying only `window` silently got `undefined` for the sizing
   * percentage, which became NaN and then a thrown BigInt conversion — a
   * position size is not a field to leave to chance.
   */
  constructor(config: Partial<SmaConfig> = {}) {
    this.config = { ...DEFAULT_SMA, ...config };
    this.name = `sma-${this.config.window}`;
  }

  decide(input: StrategyInput): Intent[] {
    const intents: Intent[] = [];

    // Equal weight across the whole universe, not across what is currently
    // signalling. Sizing off the signal count means one symbol going quiet
    // silently doubles the position size in the others.
    const slots = BigInt(Math.max(1, input.universe.length));
    const budget =
      (input.allocatedMinor * BigInt(Math.round(this.config.maxInvestedPct))) / 100n / slots;

    for (const symbol of input.universe) {
      const bars = input.history.get(symbol) ?? [];
      const held = input.positions.get(symbol) ?? 0n;

      // Not enough history to have an opinion. Doing nothing is the correct
      // move, and is very different from deciding to stay out.
      if (bars.length < this.config.window) continue;

      const window = bars.slice(-this.config.window);
      const last = window[window.length - 1];
      if (!last) continue;

      const sma = average(window);
      const price = last.closeMinor;

      if (price > sma && held === 0n) {
        const size = budget < input.cashMinor ? budget : input.cashMinor;
        // Skip rather than place a token order: a tiny order pays the same
        // commission as a real one and is pure cost.
        if (size <= 0n || size < budget / 4n) continue;

        intents.push({
          action: 'buy',
          symbol,
          notionalMinor: size,
          why: `close ${price} above ${this.config.window}-bar average ${sma}`,
        });
        continue;
      }

      if (price < sma && held > 0n) {
        intents.push({
          action: 'sell',
          symbol,
          qty: held as Qty,
          why: `close ${price} below ${this.config.window}-bar average ${sma}`,
        });
      }
    }

    return intents;
  }
}
