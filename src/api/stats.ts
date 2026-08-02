/**
 * The stats read model: the equity curve, and the thing it must be shown
 * against.
 *
 * The benchmark is rebased into money rather than left as an index level.
 * "Your £5,000 would be £5,412 in VWRP" is a comparison anyone can act on;
 * two lines on different scales is a chart people nod at. Both series are
 * therefore in pence, on one axis, from the same start date.
 *
 * Rebasing happens here, in integers, for the same reason everything else
 * does: the browser is not allowed to do arithmetic on money.
 */

import type { Sql } from '../db.js';
import { benchmarkSymbol } from '../ledger/snapshots.js';

export interface CurvePoint {
  date: string;
  equityMinor: string;
  /** What the same starting capital would be worth in the index. */
  benchmarkMinor: string | null;
}

export interface AgentCurve {
  agentId: string;
  name: string;
  status: string;
  points: CurvePoint[];
  returnPct: number | null;
}

export interface ReconciliationRow {
  runAt: string;
  asOf: string;
  status: string;
  cashDiffMinor: string;
  equityDiffMinor: string | null;
  summary: string;
}

export interface StatsView {
  benchmarkSymbol: string;
  fund: CurvePoint[];
  fundReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessPct: number | null;
  agents: AgentCurve[];
  reconciliations: ReconciliationRow[];
  totalFeesMinor: string;
  totalTrades: number;
  /** Set when there is not enough history to draw anything honest. */
  note: string | null;
}

interface SnapshotRow {
  as_of: string;
  equity_minor: bigint;
  benchmark_minor: bigint | null;
}

/**
 * Rebase a snapshot series into a curve.
 *
 * The benchmark column is only meaningful relative to its own first value, so
 * the first point that HAS a benchmark price anchors both series. Anchoring on
 * the first snapshot regardless would silently compare windows of different
 * lengths.
 */
function toCurve(rows: readonly SnapshotRow[]): CurvePoint[] {
  const anchor = rows.find((r) => r.benchmark_minor !== null && r.benchmark_minor > 0n);
  const anchorEquity = anchor?.equity_minor ?? null;
  const anchorBenchmark = anchor?.benchmark_minor ?? null;

  return rows.map((row) => ({
    date: row.as_of,
    equityMinor: row.equity_minor.toString(),
    benchmarkMinor:
      anchorEquity === null || anchorBenchmark === null || row.benchmark_minor === null
        ? null
        : ((anchorEquity * row.benchmark_minor) / anchorBenchmark).toString(),
  }));
}

function pctOf(points: readonly CurvePoint[], pick: (p: CurvePoint) => string | null): number | null {
  const values = points.map(pick).filter((v): v is string => v !== null);
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined || first === last) {
    return values.length >= 2 ? 0 : null;
  }
  const from = BigInt(first);
  if (from === 0n) return null;
  return Number(((BigInt(last) - from) * 10000n) / from) / 100;
}

export async function statsView(tx: Sql): Promise<StatsView> {
  const fundRows = await tx.query<SnapshotRow>(
    `select as_of::text as as_of, equity_minor, benchmark_minor
       from ledger.equity_snapshots
      where agent_id is null
      order by as_of`,
  );

  const fund = toCurve(fundRows.rows);

  const agentRows = await tx.query<SnapshotRow & { agent_id: string; name: string; status: string }>(
    `select s.agent_id, a.name, a.status::text as status,
            s.as_of::text as as_of, s.equity_minor, s.benchmark_minor
       from ledger.equity_snapshots s
       join ledger.agents a on a.id = s.agent_id
      where s.agent_id is not null
      order by s.agent_id, s.as_of`,
  );

  const grouped = new Map<string, { name: string; status: string; rows: SnapshotRow[] }>();
  for (const row of agentRows.rows) {
    const entry = grouped.get(row.agent_id) ?? { name: row.name, status: row.status, rows: [] };
    entry.rows.push(row);
    grouped.set(row.agent_id, entry);
  }

  const agents: AgentCurve[] = [...grouped.entries()].map(([agentId, entry]) => {
    const points = toCurve(entry.rows);
    return {
      agentId,
      name: entry.name,
      status: entry.status,
      points,
      returnPct: pctOf(points, (p) => p.equityMinor),
    };
  });

  const recon = await tx.query<{
    run_at: Date;
    as_of: Date;
    status: string;
    cash_diff_minor: bigint;
    equity_diff_minor: bigint | null;
    detail: { summary?: string };
  }>(
    `select run_at, as_of, status, cash_diff_minor, equity_diff_minor, detail
       from ledger.reconciliations
      -- as_of breaks the tie when two runs share a timestamp, so the order
      -- is stable rather than whatever the planner returns.
      order by run_at desc, as_of desc limit 30`,
  );

  const totals = await tx.query<{ fees: bigint; trades: string }>(
    `select coalesce((select sum(balance_minor) from ledger.account_balances
                       where kind = 'agent_fees'), 0)::bigint as fees,
            (select count(*)::text from ledger.fills) as trades`,
  );

  const fundReturnPct = pctOf(fund, (p) => p.equityMinor);
  const benchmarkReturnPct = pctOf(fund, (p) => p.benchmarkMinor);

  // Two points is the minimum for a line, and a single point drawn as a
  // "curve" invites reading a trend into one day.
  const note =
    fund.length < 2
      ? 'Not enough history yet. The equity curve needs at least two reconciled days.'
      : benchmarkReturnPct === null
        ? `No ${benchmarkSymbol()} price recorded, so there is nothing to compare against.`
        : null;

  return {
    benchmarkSymbol: benchmarkSymbol(),
    fund,
    fundReturnPct,
    benchmarkReturnPct,
    excessPct:
      fundReturnPct === null || benchmarkReturnPct === null
        ? null
        : Number((fundReturnPct - benchmarkReturnPct).toFixed(2)),
    agents,
    reconciliations: recon.rows.map((r) => ({
      runAt: r.run_at.toISOString(),
      asOf: r.as_of.toISOString(),
      status: r.status,
      cashDiffMinor: r.cash_diff_minor.toString(),
      equityDiffMinor: r.equity_diff_minor?.toString() ?? null,
      summary: r.detail?.summary ?? '',
    })),
    totalFeesMinor: (totals.rows[0]?.fees ?? 0n).toString(),
    totalTrades: Number(totals.rows[0]?.trades ?? '0'),
    note,
  };
}
