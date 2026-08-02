/**
 * The execution cost model, in one place.
 *
 * The paper broker and the backtester both price fills through this. If they
 * had their own copies, a backtest could report a profit the simulator would
 * not reproduce, and the disagreement would be invisible — the worst kind of
 * bug in this system, because the flattering number is the one you would keep.
 */

import type { Minor } from '../money.js';

export interface ExecutionCosts {
  /** Half-spread in basis points, paid on every trade in both directions. */
  spreadBps: bigint;
  /** Additional adverse movement in basis points, on market orders. */
  slippageBps: bigint;
  /** Flat commission per fill, in minor units. */
  commissionMinor: Minor;
}

/**
 * Defaults sit near the pessimistic end on purpose. A simulator that flatters
 * a strategy is worse than no simulator, because it produces a number that
 * feels earned.
 */
export const DEFAULT_COSTS: ExecutionCosts = {
  spreadBps: 5n,
  slippageBps: 2n,
  commissionMinor: 100n,
};

const BPS = 10_000n;

/**
 * The price a market order actually fills at. Moves against you in both
 * directions, and the adjustment rounds up rather than truncating — integer
 * division would quietly make trading cheaper than configured.
 */
export function executionPrice(
  midMinor: Minor,
  side: 'buy' | 'sell',
  costs: ExecutionCosts,
): Minor {
  const adverseBps = costs.spreadBps + costs.slippageBps;
  const numerator = midMinor * adverseBps;
  const adjustment = numerator === 0n ? 0n : (numerator + BPS - 1n) / BPS;
  const price = side === 'buy' ? midMinor + adjustment : midMinor - adjustment;
  return price > 0n ? price : 1n;
}
