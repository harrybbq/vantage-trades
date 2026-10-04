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
import { formatQty, parseQty } from '../money.js';
import { PaperBroker } from '../broker/paper.js';
import { usingPaperBroker } from '../broker/config.js';

export interface HoldingView {
  symbol: string;
  qty: string;
  costBasisMinor: string;
  marketValueMinor: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'halted' | 'killing' | 'killed';
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
  /** Largest single order, as a percent of allocation. */
  maxOrderPct: number;
  /** The day's loss, as a percent, at which it halts itself. Null: no cap. */
  dailyLossCapPct: number | null;
  startedAt: string | null;
  /** When it was created. The panel's colour for an agent follows this. */
  createdAt: string;
  /**
   * Today's gain or loss in pence, with money given or taken back since the
   * last close removed first. Without that, a £500 top-up read as a £500 day.
   */
  todayMinor: string | null;
}

/**
 * The broker sees one account. This splits each holding between the agents
 * the ledger says own it, beside what the broker actually holds, so a
 * mismatch is visible as a row rather than inferred from a total.
 */
export interface OwnershipView {
  symbols: {
    symbol: string;
    owners: { agentId: string; qty: string }[];
    ledgerQty: string;
    /** Null when the broker cannot be asked from here. */
    brokerQty: string | null;
  }[];
  ledgerCashMinor: string;
  brokerCashMinor: string | null;
}

export interface ReconciliationView {
  status: 'ok' | 'diverged' | 'error';
  asOf: string;
  summary: string;
  /** When the check ran, which is not always when its figures are from. */
  runAt: string;
  /**
   * The nightly check should have run since this one and has not. A clean
   * result from three days ago says nothing about today, and showing it as
   * "clean" is how a stopped job goes unnoticed.
   */
  stale: boolean;
}

/**
 * The most recent scheduled reconciliation that should have finished by now.
 *
 * Weekdays at 22:37 UTC, as `reconcile-scheduled` runs, with two hours' grace
 * so a check still running, or retried, is not reported as missing.
 */
export function expectedReconcileBy(now: Date): Date {
  const d = new Date(now.getTime() - 2 * 3_600_000);
  const run = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22, 37));
  if (run > d) run.setUTCDate(run.getUTCDate() - 1);
  while (run.getUTCDay() === 0 || run.getUTCDay() === 6) run.setUTCDate(run.getUTCDate() - 1);
  return run;
}

export interface ControlPanelView {
  asOf: string;
  totalEquityMinor: string | null;
  unallocatedMinor: string;
  allocatedMinor: string;
  todayMinor: string | null;
  reconciliation: ReconciliationView | null;
  agents: AgentView[];
  ownership: OwnershipView;
  /**
   * Something the owner needs to read about the action that produced this
   * view — a kill that could not finish, say. Present only on the response
   * to that action.
   */
  notice?: string;
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

/**
 * Most recent snapshot strictly before today, per agent, with the money moved
 * in or out since it was taken — so "today" is what the day did, not what the
 * owner did to it.
 */
async function priorClose(tx: Sql): Promise<Map<string, bigint>> {
  const result = await tx.query<{ agent_id: string | null; equity_minor: bigint; flows: bigint }>(
    `with last as (
       select distinct on (agent_id) agent_id, as_of, equity_minor
         from ledger.equity_snapshots
        where as_of < current_date
        order by agent_id, as_of desc
     ), cut as (
       select l.*, coalesce(
                (select max(r.as_of) from ledger.reconciliations r
                  where r.status = 'ok' and (r.as_of at time zone 'UTC')::date = l.as_of),
                (l.as_of + 1)::timestamp at time zone 'UTC') as cutoff
         from last l
     )
     select c.agent_id, c.equity_minor,
            coalesce((select sum(p.amount_minor)
                        from ledger.postings p
                        join ledger.accounts a on a.id = p.account_id
                        join ledger.journal_entries e on e.id = p.entry_id
                       where e.occurred_at > c.cutoff
                         and ((c.agent_id is not null and a.kind = 'agent_cash' and a.agent_id = c.agent_id
                               and e.kind in ('allocation', 'deallocation'))
                           or (c.agent_id is null and a.kind = 'pool' and e.kind in ('deposit', 'withdrawal')))
                     ), 0)::bigint as flows
       from cut c`,
  );
  // The close plus what was added since: the baseline today is measured from.
  return new Map(result.rows.map((r) => [r.agent_id ?? '__fund__', r.equity_minor + r.flows]));
}

async function ownership(tx: Sql): Promise<OwnershipView> {
  const owned = await tx.query<{ symbol: string; agent_id: string; qty: string }>(
    `select symbol, agent_id, qty::text as qty from ledger.agent_positions order by symbol, agent_id`,
  );
  const cash = await tx.query<{ total: bigint }>(
    `select coalesce(sum(balance_minor), 0)::bigint as total
       from ledger.account_balances where kind in ('pool', 'agent_cash')`,
  );

  let broker: Map<string, bigint> | null = null;
  let brokerCash: bigint | null = null;
  if (usingPaperBroker()) {
    const paper = new PaperBroker(tx);
    broker = new Map((await paper.getPositions()).map((p) => [p.symbol, p.qty]));
    brokerCash = await paper.getCash();
  }

  const symbols = [...new Set([...owned.rows.map((r) => r.symbol), ...(broker?.keys() ?? [])])].sort();
  return {
    symbols: symbols.map((symbol) => {
      const owners = owned.rows.filter((r) => r.symbol === symbol);
      const total = owners.reduce((sum, o) => sum + parseQty(o.qty), 0n);
      return {
        symbol,
        owners: owners.map((o) => ({ agentId: o.agent_id, qty: o.qty })),
        ledgerQty: formatQty(total),
        brokerQty: broker ? formatQty(broker.get(symbol) ?? 0n) : null,
      };
    }),
    ledgerCashMinor: (cash.rows[0]?.total ?? 0n).toString(),
    brokerCashMinor: brokerCash?.toString() ?? null,
  };
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

  const names = await tx.query<{
    id: string; name: string; max_order_pct: string; daily_loss_cap_pct: string | null; started_at: Date | null; created_at: Date;
  }>(
    `select id, name, max_order_pct::text as max_order_pct,
            daily_loss_cap_pct::text as daily_loss_cap_pct, started_at, created_at
       from ledger.agents`,
  );
  const nameById = new Map(names.rows.map((r) => [r.id, r.name]));
  const railsById = new Map(names.rows.map((r) => [r.id, r]));

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
      maxOrderPct: Number(railsById.get(e.agentId)?.max_order_pct ?? 25),
      dailyLossCapPct:
        railsById.get(e.agentId)?.daily_loss_cap_pct == null ? null : Number(railsById.get(e.agentId)!.daily_loss_cap_pct),
      startedAt: railsById.get(e.agentId)?.started_at?.toISOString() ?? null,
      createdAt: railsById.get(e.agentId)?.created_at.toISOString() ?? '',
      todayMinor: e.equityMinor === null || close === undefined ? null : (e.equityMinor - close).toString(),
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

  const recon = await tx.query<{ status: string; as_of: Date; run_at: Date; detail: { summary?: string } }>(
    `select status, as_of, run_at, detail from ledger.reconciliations order by run_at desc limit 1`,
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
          runAt: last.run_at.toISOString(),
          stale: last.run_at < expectedReconcileBy(new Date()),
        }
      : null,
    agents,
    ownership: await ownership(tx),
  };
}
