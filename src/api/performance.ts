/**
 * Is each agent beating the same money put into VWRP on the same days?
 *
 * The comparison this replaces anchored VWRP as one lump sum on the first day.
 * Every allocation after that then counted as the agent's return — give an
 * agent another £500 and it "beat the market" by £500 — which is exactly the
 * flattering, wrong answer this app exists not to give.
 *
 * Instead, per agent and for the whole fund:
 *
 *   - money put in      net capital given (agents) or deposited (the fund),
 *                       cumulative. Drawn as a step, so a top-up is visibly
 *                       money in rather than a gain.
 *   - time-weighted %   each day's change with that day's money in or out
 *                       taken out first, chained. How the agent's choices did,
 *                       independent of when it was given money. This is the
 *                       fair comparison with VWRP's own return.
 *   - same-money VWRP   a shadow that buys VWRP with every £ the agent is
 *                       given, on the same snapshot, and sells it when capital
 *                       is taken back. What doing nothing would have made of
 *                       the same money.
 *   - day's £ gain      the change in value not explained by money in or out.
 *
 * Two rules decide whether this is right, and both are easy to get wrong:
 *
 *   1. **Money is bucketed "since the previous snapshot", not by calendar day.**
 *      Snapshots exist only on days the reconciliation passed. Money moved on a
 *      day with no snapshot belongs to the next one; filed under its own date
 *      it would land nowhere, and reappear as return.
 *   2. **The shadow buys at the price stored with the snapshot the money enters
 *      on.** No benchmark price exists for days without a snapshot, so this is
 *      the honest rule, not an approximation of a better one.
 *
 * Money stays in integer pence; the shadow's holding is integer units at the
 * same 10^8 scale as share quantities, so rounding happens once per output
 * point rather than accumulating. Percentages are floats: they are derived and
 * display-only, as everywhere else.
 *
 * The comparison starts at the first snapshot with a VWRP price. Before that
 * there is nothing to compare against, and money given before it counts as
 * money put in at the start.
 */

import type { Sql } from '../db.js';
import { benchmarkSymbol } from '../ledger/snapshots.js';

const UNITS = 100_000_000n;

/** Integer division rounded to nearest, for a positive divisor. */
const divRound = (a: bigint, b: bigint): bigint => (a >= 0n ? (a + b / 2n) / b : -((-a + b / 2n) / b));

export interface PerformancePoint {
  /** The snapshot's day, YYYY-MM-DD. */
  date: string;
  equityMinor: string;
  /** The same money in VWRP. Null on a day with no VWRP price. */
  shadowMinor: string | null;
  /** Net money in, cumulative, through this point. */
  putInMinor: string;
  /** Change in value not explained by money in or out. Null on the first point. */
  dayPnlMinor: string | null;
  /** Time-weighted return since the first point, in percent. */
  twrPct: number;
  /** VWRP's own return since the first point, in percent. Null without a price. */
  benchPct: number | null;
  /** Fills since the previous point. */
  trades: number;
}

export interface PerformanceSeries {
  /** Null for the whole fund. */
  id: string | null;
  name: string;
  status: string | null;
  points: PerformancePoint[];
}

export interface PerformanceView {
  benchmarkSymbol: string;
  fund: PerformanceSeries;
  agents: PerformanceSeries[];
}

interface Snapshot {
  day: string;
  equity: bigint;
  bench: bigint | null;
}

interface Flow {
  at: Date;
  amount: bigint;
}

/** When each snapshot day's figures were taken: its latest clean check. */
async function snapshotTimes(tx: Sql): Promise<Map<string, Date>> {
  const r = await tx.query<{ day: string; at: Date }>(
    `select (as_of at time zone 'UTC')::date::text as day, max(as_of) as at
       from ledger.reconciliations where status = 'ok' group by 1`,
  );
  return new Map(r.rows.map((row) => [row.day, row.at]));
}

/**
 * The cutoff for a snapshot: money and fills up to this moment are in it.
 * A snapshot with no clean check on record (a test, a backfill) takes the end
 * of its day, which is what "as of that date" means.
 */
function cutoffFor(day: string, times: Map<string, Date>): Date {
  return times.get(day) ?? new Date(`${day}T23:59:59.999Z`);
}

export function buildSeries(
  snapshots: readonly Snapshot[],
  flows: readonly Flow[],
  fills: readonly Date[],
  times: Map<string, Date>,
): PerformancePoint[] {
  const start = snapshots.findIndex((s) => s.bench !== null && s.bench > 0n);
  if (start < 0) return [];

  const out: PerformancePoint[] = [];
  let fi = 0;
  let ti = 0;
  let putIn = 0n;
  let units = 0n;
  let pendingBuy = 0n;
  let prev: bigint | null = null;
  let index = 1;
  let p0: bigint | null = null;

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i]!;
    const cutoff = cutoffFor(s.day, times);

    let flow = 0n;
    while (fi < flows.length && flows[fi]!.at <= cutoff) flow += flows[fi++]!.amount;
    let trades = 0;
    while (ti < fills.length && fills[ti]! <= cutoff) {
      trades += 1;
      ti += 1;
    }
    putIn += flow;

    if (i < start) continue;

    if (i === start) {
      // What it had at the start is what the shadow starts with. Money given
      // before this point is all inside that figure.
      p0 = s.bench!;
      units = divRound(s.equity * UNITS, p0);
      out.push({
        date: s.day,
        equityMinor: s.equity.toString(),
        shadowMinor: s.equity.toString(),
        putInMinor: putIn.toString(),
        dayPnlMinor: null,
        twrPct: 0,
        benchPct: 0,
        trades,
      });
      prev = s.equity;
      continue;
    }

    // A day's return is its change with its own money in or out removed. An
    // agent that had nothing yesterday has no return to speak of today.
    if (prev !== null && prev > 0n) index *= Number(s.equity - flow) / Number(prev);

    if (s.bench !== null && s.bench > 0n) {
      units += divRound((pendingBuy + flow) * UNITS, s.bench);
      pendingBuy = 0n;
    } else {
      // No price to buy at today. The money waits for the next snapshot that
      // has one, rather than being bought at a price that was never quoted.
      pendingBuy += flow;
    }

    out.push({
      date: s.day,
      equityMinor: s.equity.toString(),
      shadowMinor: s.bench !== null && s.bench > 0n ? divRound(units * s.bench, UNITS).toString() : null,
      putInMinor: putIn.toString(),
      dayPnlMinor: prev === null ? null : (s.equity - prev - flow).toString(),
      twrPct: Number(((index - 1) * 100).toFixed(4)),
      benchPct: s.bench !== null && s.bench > 0n ? Number(((Number(s.bench) / Number(p0) - 1) * 100).toFixed(4)) : null,
      trades,
    });
    prev = s.equity;
  }

  return out;
}

export async function performanceView(tx: Sql): Promise<PerformanceView> {
  const times = await snapshotTimes(tx);

  const snaps = await tx.query<{ agent_id: string | null; day: string; equity_minor: bigint; benchmark_minor: bigint | null }>(
    `select agent_id, as_of::text as day, equity_minor, benchmark_minor
       from ledger.equity_snapshots order by agent_id nulls first, as_of`,
  );

  const agentFlows = await tx.query<{ agent_id: string; at: Date; amount: bigint }>(
    `select a.agent_id, e.occurred_at as at, p.amount_minor as amount
       from ledger.postings p
       join ledger.accounts a on a.id = p.account_id
       join ledger.journal_entries e on e.id = p.entry_id
      where a.kind = 'agent_cash' and e.kind in ('allocation', 'deallocation')
      order by e.occurred_at`,
  );
  const fundFlows = await tx.query<{ at: Date; amount: bigint }>(
    `select e.occurred_at as at, p.amount_minor as amount
       from ledger.postings p
       join ledger.accounts a on a.id = p.account_id
       join ledger.journal_entries e on e.id = p.entry_id
      where a.kind = 'pool' and e.kind in ('deposit', 'withdrawal')
      order by e.occurred_at`,
  );
  const fills = await tx.query<{ agent_id: string; at: Date }>(
    `select agent_id, filled_at as at from ledger.fills order by filled_at`,
  );
  const agents = await tx.query<{ id: string; name: string; status: string }>(
    `select id, name, status::text as status from ledger.agents order by created_at, id`,
  );

  const snapshotsOf = (id: string | null): Snapshot[] =>
    snaps.rows
      .filter((r) => r.agent_id === id)
      .map((r) => ({ day: r.day, equity: r.equity_minor, bench: r.benchmark_minor }));

  const fund: PerformanceSeries = {
    id: null,
    name: 'Whole fund',
    status: null,
    points: buildSeries(
      snapshotsOf(null),
      fundFlows.rows.map((f) => ({ at: f.at, amount: f.amount })),
      fills.rows.map((f) => f.at),
      times,
    ),
  };

  return {
    benchmarkSymbol: benchmarkSymbol(),
    fund,
    agents: agents.rows
      .filter((a) => a.status !== 'killed')
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        points: buildSeries(
          snapshotsOf(a.id),
          agentFlows.rows.filter((f) => f.agent_id === a.id).map((f) => ({ at: f.at, amount: f.amount })),
          fills.rows.filter((f) => f.agent_id === a.id).map((f) => f.at),
          times,
        ),
      })),
  };
}
