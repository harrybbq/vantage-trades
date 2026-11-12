/**
 * The "do nothing" agent: buy the benchmark and keep it.
 *
 * Every other agent is judged against the same money put into VWRP. This one
 * simply is that money put into VWRP. It exists so capital that no strategy
 * has earned the right to manage still earns the market's return, instead of
 * sitting idle in the pool — and so the default outcome of this whole system
 * is the benchmark rather than nothing.
 *
 * It never sells. Getting out is a decision for the owner, through Kill or by
 * taking capital back, not something a rule should do on a bad day.
 */

import { benchmarkSymbol } from '../ledger/snapshots.js';
import type { Intent, Strategy, StrategyInput } from './types.js';

/**
 * Cash is only put to work once it is a real slice of the allocation.
 *
 * The runner holds back a few percent on every buy to cover the spread, so
 * there is always a little cash left over. Without this floor the agent would
 * buy the leftover the next day, and the leftover's leftover the day after —
 * each order paying a commission to invest pennies.
 */
const MIN_CASH_PCT = 5n;
const MIN_CASH_MINOR = 1_000n;

export class HoldBenchmark implements Strategy {
  readonly name = 'hold';

  constructor(private readonly symbol: string = benchmarkSymbol().toUpperCase()) {}

  decide(input: StrategyInput): Intent[] {
    // The universe is the owner's permission. Without the benchmark in it,
    // this agent has nothing it may buy, and says so by doing nothing.
    if (!input.universe.includes(this.symbol)) return [];

    // No price yet means no idea what it would be paying.
    if ((input.history.get(this.symbol) ?? []).length === 0) return [];

    const floor = (input.allocatedMinor * MIN_CASH_PCT) / 100n;
    if (input.cashMinor < MIN_CASH_MINOR || input.cashMinor < floor) return [];

    return [
      {
        action: 'buy',
        symbol: this.symbol,
        notionalMinor: input.cashMinor,
        why: `hold: put uninvested cash into ${this.symbol}`,
      },
    ];
  }
}
