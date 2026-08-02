/**
 * The control panel's read model.
 *
 * One shape, assembled server-side, so the browser never does arithmetic on
 * money. Everything crosses the wire as an integer string of minor units —
 * JSON numbers are IEEE 754 doubles, and a ledger that survived being kept in
 * integers all the way through Postgres should not lose that on the last hop.
 *
 * Anything that cannot be computed honestly comes back null rather than as a
 * plausible-looking substitute. A P/L figure with no prior close, or an equity
 * with no mark, is unknown — and unknown has to look different from zero.
 */

import type { Sql } from '../db.js';
import { allAgentEquities, unallocatedPool } from '../ledger/equity.js';
import { universesFor } from '../ledger/universe.js';
import { formatQty } from '../money.js';

export interface HoldingView {
  symbol: string;
  qty: string;
  costBasisMinor: string;
  marketValueMinor: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'halted' | 'killed';
  allocatedMinor: string;
  cashMinor: string;
  deployedMinor: string;
  equityMinor: string | null;
  realisedMinor: string;
  feesMinor: string;
  /** Percent, or null when there is no baseline to measure from. */
  pnlPctSinceStart: number | null;
  pnlPctToday: number | null;
  universe: string[];
  holdings: HoldingView[];
  unpricedSymbols: string[];
}

export interface ReconciliationView {
  status: 'ok' | 'diverged' | 'error';
  asOf: string;
  summary: string;
}

export interface ControlPanelView {
  asOf: string;
  totalEquityMinor: string | null;
  unallocatedMinor: string;
  allocatedMinor: string;
  todayMinor: string | null;
  reconciliation: ReconciliationView | null;
  agents: AgentView[];
}

/**
 * Net capital the owner has put behind an agent: allocations less
 * deallocations. This is the denominator for "P/L since start" — measuring
 * against current equity would make every agent look flat.
 */
async function netAllocated(tx: Sql): Promise<Map<string, bigint>> {
  const result = await tx.query<{ agent_id: string; net: bigint }>(
    `select a.agent_id, coalesce(sum(p.amount_minor), 0)::bigint as net
       from ledger.postings p
       join ledger.accounts a on a.id = p.account_id
       join ledger.journal_entries e on e.id = p.entry_id
      where a.kind = 'agent_cash'
        and e.kind in ('allocation', 'deallocation')
      group by a.agent_id`,
  );
  return new Map(result.rows.map((r) => [r.agent_id, r.net]));
}

/** Most recent snapshot strictly before today, per agent. */
async function priorClose(tx: Sql): Promise<Map<string, bigint>> {
  const result = await tx.query<{ agent_id: string | null; equity_minor: bigint }>(
    `select distinct on (agent_id) agent_id, equity_minor
       from ledger.equity_snapshots
      where as_of < current_date
      order by agent_id, as_of desc`,
  );
  return new Map(result.rows.map((r) => [r.agent_id ?? '__fund__', r.equity_minor]));
}

function pctChange(from: bigint, to: bigint): number | null {
  if (from === 0n) return null;
  // Two decimal places, computed in integers then scaled down, so the
  // percentage never inherits a float rounding artefact from the money.
  const basisPoints = ((to - from) * 10000n) / (from < 0n ? -from : from);
  return Number(basisPoints) / 100;
}

export async function controlPanelView(tx: Sql, asOf = new Date()): Promise<ControlPanelView> {
  const equities = await allAgentEquities(tx, asOf);
  const pool = await unallocatedPool(tx);
  const universes = await universesFor(tx);
  const allocatedNet = await netAllocated(tx);
  const closes = await priorClose(tx);

  const names = await tx.query<{ id: string; name: string }>(
    `select id, name from ledger.agents`,
  );
  const nameById = new Map(names.rows.map((r) => [r.id, r.name]));

  const agents: AgentView[] = equities.map((e) => {
    const deployed = e.positionsMarketMinor ?? e.positionsBookMinor;
    const basis = allocatedNet.get(e.agentId) ?? 0n;
    const close = closes.get(e.agentId);

    return {
      id: e.agentId,
      name: nameById.get(e.agentId) ?? e.agentId,
      status: e.status as AgentView['status'],
      allocatedMinor: basis.toString(),
      cashMinor: e.cashMinor.toString(),
      deployedMinor: deployed.toString(),
      equityMinor: e.equityMinor?.toString() ?? null,
      realisedMinor: e.realisedMinor.toString(),
      feesMinor: e.feesMinor.toString(),
      pnlPctSinceStart: e.equityMinor === null ? null : pctChange(basis, e.equityMinor),
      pnlPctToday:
        e.equityMinor === null || close === undefined ? null : pctChange(close, e.equityMinor),
      universe: universes.get(e.agentId) ?? [],
      holdings: e.holdings.map((h) => ({
        symbol: h.symbol,
        qty: formatQty(h.qty),
        costBasisMinor: h.costBasisMinor.toString(),
        marketValueMinor: h.marketValueMinor?.toString() ?? null,
      })),
      unpricedSymbols: e.unpricedSymbols,
    };
  });

  const liveAgents = agents.filter((a) => a.status !== 'killed');
  const anyUnknown = liveAgents.some((a) => a.equityMinor === null);

  const totalEquity = anyUnknown
    ? null
    : liveAgents.reduce((sum, a) => sum + BigInt(a.equityMinor ?? '0'), pool);

  const allocated = liveAgents.reduce((sum, a) => sum + BigInt(a.allocatedMinor), 0n);

  const fundClose = closes.get('__fund__');
  const todayMinor =
    totalEquity === null || fundClose === undefined ? null : totalEquity - fundClose;

  const recon = await tx.query<{ status: string; as_of: Date; detail: { summary?: string } }>(
    `select status, as_of, detail from ledger.reconciliations order by run_at desc limit 1`,
  );
  const last = recon.rows[0];

  return {
    asOf: asOf.toISOString(),
    totalEquityMinor: totalEquity?.toString() ?? null,
    unallocatedMinor: pool.toString(),
    allocatedMinor: allocated.toString(),
    todayMinor: todayMinor?.toString() ?? null,
    reconciliation: last
      ? {
          status: last.status as ReconciliationView['status'],
          asOf: last.as_of.toISOString(),
          summary: last.detail?.summary ?? '',
        }
      : null,
    agents,
  };
}
