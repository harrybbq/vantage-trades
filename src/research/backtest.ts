/**
 * The backtester.
 *
 * Runs the same `Strategy` interface the live runner uses, through the same
 * cost model the paper broker uses. Sharing both is deliberate: a backtester
 * with its own copy of either would eventually report a profit the live system
 * could not reproduce, and the flattering number is the one that survives.
 *
 * What it does NOT do, and cannot:
 *
 *   * account for market impact — irrelevant at GBP 1,000, not at 50,000
 *   * model queue position, partial fills or a venue saying no
 *   * know about splits, dividends or halts
 *   * protect you from survivorship bias in whatever data you feed it
 *   * protect you from having tried this nineteen times already — that is
 *     what the experiment register is for
 *
 * Treat the output as a way to reject bad ideas cheaply, never as evidence
 * that a good one works.
 */

import { executionPrice, DEFAULT_COSTS, type ExecutionCosts } from '../broker/costs.js';
import { notional, type Minor, type Qty } from '../money.js';
import type { PriceBar, Strategy, StrategyInput } from '../agents/types.js';
import { computeMetrics, type Metrics } from './metrics.js';

const QTY_SCALE = 100000000n;

export interface BacktestInput {
  strategy: Strategy;
  /** All series must share the same dates, oldest first. */
  bars: Map<string, PriceBar[]>;
  universe: string[];
  startingCashMinor: Minor;
  costs?: ExecutionCosts;
  /** Same dates as `bars`. Enables the buy-and-hold comparison. */
  benchmark?: PriceBar[];
  /** Only bars in this window are traded. Everything before it warms up. */
  from?: Date;
  to?: Date;
}

export interface BacktestResult extends Metrics {
  finalEquityMinor: string;
  feesMinor: string;
  /** Buy-and-hold over the same dates, or null with no benchmark series. */
  benchmarkReturnPct: number | null;
  excessPct: number | null;
  equityCurve: { asOf: string; equityMinor: string }[];
}

export function backtest(input: BacktestInput): BacktestResult {
  const costs = input.costs ?? DEFAULT_COSTS;
  const dates = datesOf(input.bars);

  if (dates.length === 0) throw new Error('no price history to test against');

  let cash = input.startingCashMinor;
  const positions = new Map<string, Qty>();
  const equity: bigint[] = [];
  const curve: { asOf: string; equityMinor: string }[] = [];
  let fees = 0n;
  let trades = 0;

  for (const [index, asOf] of dates.entries()) {
    const history = historyUpTo(input.bars, index);
    const closes = closesAt(input.bars, index);

    const tradeable =
      (input.from === undefined || asOf >= input.from) &&
      (input.to === undefined || asOf <= input.to);

    if (tradeable) {
      const holdings = new Map(positions);
      const marketValue = valueOf(holdings, closes);

      const state: StrategyInput = {
        asOf,
        universe: input.universe,
        history,
        positions: holdings,
        cashMinor: cash,
        allocatedMinor: cash + marketValue,
      };

      for (const intent of input.strategy.decide(state)) {
        const price = closes.get(intent.symbol);
        if (price === undefined) continue;

        if (intent.action === 'buy') {
          const fillPrice = executionPrice(price, 'buy', costs);
          // The same headroom the live runner leaves: sizing off the close
          // ignores that the fill lands above it, and commission is charged
          // on top of that.
          const affordable = ((cash - costs.commissionMinor) * 97n) / 100n;
          const spend = intent.notionalMinor < affordable ? intent.notionalMinor : affordable;
          if (spend <= 0n) continue;

          const qty = (spend * QTY_SCALE) / fillPrice;
          if (qty <= 0n) continue;

          const cost = notional(qty, fillPrice);
          if (cost + costs.commissionMinor > cash) continue;

          cash -= cost + costs.commissionMinor;
          fees += costs.commissionMinor;
          positions.set(intent.symbol, (positions.get(intent.symbol) ?? 0n) + qty);
          trades += 1;
          continue;
        }

        const held = positions.get(intent.symbol) ?? 0n;
        const qty = intent.qty < held ? intent.qty : held;
        if (qty <= 0n) continue;

        const fillPrice = executionPrice(price, 'sell', costs);
        const proceeds = notional(qty, fillPrice);

        cash += proceeds - costs.commissionMinor;
        fees += costs.commissionMinor;

        const left = held - qty;
        if (left > 0n) positions.set(intent.symbol, left);
        else positions.delete(intent.symbol);
        trades += 1;
      }
    }

    const point = cash + valueOf(positions, closes);
    equity.push(point);
    curve.push({ asOf: asOf.toISOString().slice(0, 10), equityMinor: point.toString() });
  }

  const metrics = computeMetrics(equity, trades);

  let benchmarkReturnPct: number | null = null;
  if (input.benchmark && input.benchmark.length >= 2) {
    const first = input.benchmark[0]?.closeMinor;
    const last = input.benchmark[input.benchmark.length - 1]?.closeMinor;
    if (first !== undefined && last !== undefined && first > 0n) {
      benchmarkReturnPct = Number(((last - first) * 10000n) / first) / 100;
    }
  }

  return {
    ...metrics,
    finalEquityMinor: (equity[equity.length - 1] ?? 0n).toString(),
    feesMinor: fees.toString(),
    benchmarkReturnPct,
    excessPct:
      benchmarkReturnPct === null
        ? null
        : Number((metrics.returnPct - benchmarkReturnPct).toFixed(2)),
    equityCurve: curve,
  };
}

function datesOf(bars: Map<string, PriceBar[]>): Date[] {
  const lengths = new Set([...bars.values()].map((b) => b.length));
  if (lengths.size > 1) {
    // Misaligned series silently shift one symbol's prices against another's,
    // which produces a backtest that is wrong in a way nothing will flag.
    throw new Error('all price series must cover the same dates');
  }
  return [...bars.values()][0]?.map((b) => b.asOf) ?? [];
}

function historyUpTo(bars: Map<string, PriceBar[]>, index: number): Map<string, PriceBar[]> {
  const out = new Map<string, PriceBar[]>();
  for (const [symbol, series] of bars) {
    // Inclusive of today's close, exclusive of everything after it. Slicing
    // one bar too far is look-ahead bias, and it is the single easiest way to
    // produce a backtest that cannot be reproduced live.
    out.set(symbol, series.slice(0, index + 1));
  }
  return out;
}

function closesAt(bars: Map<string, PriceBar[]>, index: number): Map<string, Minor> {
  const out = new Map<string, Minor>();
  for (const [symbol, series] of bars) {
    const bar = series[index];
    if (bar) out.set(symbol, bar.closeMinor);
  }
  return out;
}

function valueOf(positions: Map<string, Qty>, closes: Map<string, Minor>): Minor {
  let total = 0n;
  for (const [symbol, qty] of positions) {
    const price = closes.get(symbol);
    if (price !== undefined) total += notional(qty, price);
  }
  return total;
}
