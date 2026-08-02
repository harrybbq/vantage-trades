/**
 * Daily equity snapshots, and the benchmark they are measured against.
 *
 * The benchmark is not "the bot versus me trading by hand" — it is
 * buy-and-hold a global index fund. Picking the wrong benchmark is how people
 * lose money for years without noticing, and retrofitting an honest one later
 * never happens, because by then the flattering comparison is the one already
 * on screen.
 *
 * So the benchmark price is captured from the very first snapshot, before any
 * agent has run. What it enables:
 *
 *   - "P/L today" needs a prior close to measure from
 *   - the equity curve needs points
 *   - "would you have done better doing nothing" needs the index on the same
 *     axis, from the same start date
 */

import type { Sql } from '../db.js';
import type { Minor } from '../money.js';
import { allAgentEquities, unallocatedPool } from './equity.js';

export const DEFAULT_BENCHMARK = 'VWRP';

export function benchmarkSymbol(): string {
  return process.env['BENCHMARK_SYMBOL'] ?? DEFAULT_BENCHMARK;
}

export interface SnapshotResult {
  asOf: string;
  fundEquityMinor: Minor | null;
  agentsRecorded: number;
  benchmarkMinor: Minor | null;
  skipped: string[];
}

/**
 * Write today's snapshot for every agent and for the fund.
 *
 * Re-running on the same day overwrites rather than duplicating, so the job is
 * safe to run more than once. An agent whose equity cannot be computed is
 * skipped rather than recorded as zero — a fabricated point on an equity curve
 * is worse than a gap, because the gap is visible.
 */
export async function recordSnapshots(
  tx: Sql,
  benchmarkPriceMinor: Minor | null,
  asOf = new Date(),
): Promise<SnapshotResult> {
  const day = asOf.toISOString().slice(0, 10);
  const equities = await allAgentEquities(tx, asOf);
  const pool = await unallocatedPool(tx);
  const symbol = benchmarkSymbol();

  const skipped: string[] = [];
  let recorded = 0;

  for (const agent of equities) {
    if (agent.equityMinor === null) {
      skipped.push(agent.agentId);
      continue;
    }

    await tx.query(
      `insert into ledger.equity_snapshots
         (agent_id, as_of, equity_minor, cash_minor, positions_minor,
          benchmark_symbol, benchmark_minor)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (agent_id, as_of) where agent_id is not null
       do update set equity_minor = excluded.equity_minor,
                     cash_minor = excluded.cash_minor,
                     positions_minor = excluded.positions_minor,
                     benchmark_symbol = excluded.benchmark_symbol,
                     benchmark_minor = excluded.benchmark_minor`,
      [
        agent.agentId,
        day,
        agent.equityMinor.toString(),
        agent.cashMinor.toString(),
        (agent.positionsMarketMinor ?? 0n).toString(),
        symbol,
        benchmarkPriceMinor?.toString() ?? null,
      ],
    );
    recorded += 1;
  }

  // The fund row is only meaningful when every live agent could be valued.
  const live = equities.filter((e) => e.status !== 'killed');
  const anyUnknown = live.some((e) => e.equityMinor === null);
  const fundEquity = anyUnknown
    ? null
    : live.reduce((sum, e) => sum + (e.equityMinor ?? 0n), pool);

  if (fundEquity !== null) {
    const cash = live.reduce((sum, e) => sum + e.cashMinor, pool);
    await tx.query(
      `insert into ledger.equity_snapshots
         (agent_id, as_of, equity_minor, cash_minor, positions_minor,
          benchmark_symbol, benchmark_minor)
       values (null, $1, $2, $3, $4, $5, $6)
       on conflict (as_of) where agent_id is null
       do update set equity_minor = excluded.equity_minor,
                     cash_minor = excluded.cash_minor,
                     positions_minor = excluded.positions_minor,
                     benchmark_symbol = excluded.benchmark_symbol,
                     benchmark_minor = excluded.benchmark_minor`,
      [
        day,
        fundEquity.toString(),
        cash.toString(),
        (fundEquity - cash).toString(),
        symbol,
        benchmarkPriceMinor?.toString() ?? null,
      ],
    );
  }

  return {
    asOf: day,
    fundEquityMinor: fundEquity,
    agentsRecorded: recorded,
    benchmarkMinor: benchmarkPriceMinor,
    skipped,
  };
}

export interface BenchmarkComparison {
  from: string;
  to: string;
  fundReturnPct: number;
  benchmarkReturnPct: number;
  /** Positive means the agents beat buy-and-hold. Usually they will not. */
  excessPct: number;
  benchmarkSymbol: string;
}

/**
 * The fund against buy-and-hold, on the same dates.
 *
 * Uses the first snapshot that has a benchmark price as the start, so both
 * series are indexed from the same day. Comparing over different windows is
 * the easiest way to accidentally flatter a strategy.
 *
 * Returns null until there are two comparable points — an honest "not yet"
 * rather than a 0% that looks like parity.
 */
export async function benchmarkComparison(tx: Sql): Promise<BenchmarkComparison | null> {
  const rows = await tx.query<{
    as_of: string;
    equity_minor: bigint;
    benchmark_minor: bigint | null;
    benchmark_symbol: string | null;
  }>(
    `select as_of::text as as_of, equity_minor, benchmark_minor, benchmark_symbol
       from ledger.equity_snapshots
      where agent_id is null and benchmark_minor is not null
      order by as_of`,
  );

  const first = rows.rows[0];
  const last = rows.rows[rows.rows.length - 1];
  if (!first || !last || first.as_of === last.as_of) return null;

  const pct = (from: bigint, to: bigint): number => {
    if (from === 0n) return 0;
    return Number(((to - from) * 10000n) / from) / 100;
  };

  const fund = pct(first.equity_minor, last.equity_minor);
  const bench = pct(first.benchmark_minor ?? 1n, last.benchmark_minor ?? 1n);

  return {
    from: first.as_of,
    to: last.as_of,
    fundReturnPct: fund,
    benchmarkReturnPct: bench,
    excessPct: Number((fund - bench).toFixed(2)),
    benchmarkSymbol: first.benchmark_symbol ?? benchmarkSymbol(),
  };
}
