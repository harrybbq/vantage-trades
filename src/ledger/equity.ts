/**
 * Valuation: turning the ledger into the numbers the control panel shows.
 *
 * Equity needs a price, and the price used is stored rather than fetched at
 * read time (see ledger.marks). That way a figure shown in the UI can be
 * reproduced later, and reconciliation compares like with like instead of
 * against whatever the market happened to be doing when the job ran.
 */

import type { Sql } from '../db.js';
import { notional, parseQty, type Minor, type Qty } from '../money.js';

export interface Holding {
  symbol: string;
  qty: Qty;
  costBasisMinor: Minor;
  markMinor: Minor | null;
  marketValueMinor: Minor | null;
}

export interface AgentEquity {
  agentId: string;
  status: string;
  cashMinor: Minor;
  positionsBookMinor: Minor;
  positionsMarketMinor: Minor | null;
  /** cash + market value of positions. Null if any holding has no mark. */
  equityMinor: Minor | null;
  realisedMinor: Minor;
  feesMinor: Minor;
  holdings: Holding[];
  /** Symbols with no usable mark. Non-empty means equity is not computable. */
  unpricedSymbols: string[];
}

/** Latest stored mark per symbol, at or before `asOf`. */
export async function latestMarks(
  tx: Sql,
  symbols: readonly string[],
  asOf: Date,
): Promise<Map<string, Minor>> {
  if (symbols.length === 0) return new Map();

  const result = await tx.query<{ symbol: string; price_minor: bigint }>(
    `select distinct on (symbol) symbol, price_minor
       from ledger.marks
      where symbol = any($1) and as_of <= $2
      order by symbol, as_of desc`,
    [[...symbols], asOf],
  );

  return new Map(result.rows.map((r) => [r.symbol, r.price_minor]));
}

export async function agentEquity(
  tx: Sql,
  agentId: string,
  asOf = new Date(),
): Promise<AgentEquity> {
  const agent = await tx.query<{ status: string }>(
    `select status from ledger.agents where id = $1`,
    [agentId],
  );
  const status = agent.rows[0]?.status;
  if (!status) throw new Error(`no such agent: ${agentId}`);

  const balances = await tx.query<{ kind: string; balance_minor: bigint }>(
    `select kind, balance_minor from ledger.account_balances where agent_id = $1`,
    [agentId],
  );
  const byKind = new Map(balances.rows.map((r) => [r.kind, r.balance_minor]));

  const positions = await tx.query<{ symbol: string; qty: string; cost_basis_minor: bigint }>(
    `select symbol, qty::text as qty, cost_basis_minor
       from ledger.agent_positions where agent_id = $1 order by symbol`,
    [agentId],
  );

  const marks = await latestMarks(
    tx,
    positions.rows.map((r) => r.symbol),
    asOf,
  );

  const unpricedSymbols: string[] = [];
  const holdings: Holding[] = positions.rows.map((row) => {
    const qty = parseQty(row.qty);
    const mark = marks.get(row.symbol) ?? null;
    if (mark === null) unpricedSymbols.push(row.symbol);
    return {
      symbol: row.symbol,
      qty,
      costBasisMinor: row.cost_basis_minor,
      markMinor: mark,
      marketValueMinor: mark === null ? null : notional(qty, mark),
    };
  });

  const cash = byKind.get('agent_cash') ?? 0n;
  const positionsBook = byKind.get('agent_positions') ?? 0n;

  // A missing mark makes equity unknown, and unknown is reported as null
  // rather than filled in with cost basis. Silently substituting book value
  // would show a flat P/L for a position that had in fact moved, which is
  // worse than showing nothing.
  const positionsMarket = unpricedSymbols.length
    ? null
    : holdings.reduce((acc, h) => acc + (h.marketValueMinor ?? 0n), 0n);

  return {
    agentId,
    status,
    cashMinor: cash,
    positionsBookMinor: positionsBook,
    positionsMarketMinor: positionsMarket,
    equityMinor: positionsMarket === null ? null : cash + positionsMarket,
    // Assets are positive, so a realised gain sits as a negative balance.
    // Flip it here so callers get the intuitive sign.
    realisedMinor: -(byKind.get('agent_realised') ?? 0n),
    feesMinor: byKind.get('agent_fees') ?? 0n,
    holdings,
    unpricedSymbols,
  };
}

export async function unallocatedPool(tx: Sql): Promise<Minor> {
  const result = await tx.query<{ balance_minor: bigint }>(
    `select balance_minor from ledger.account_balances where kind = 'pool'`,
  );
  return result.rows[0]?.balance_minor ?? 0n;
}

export async function allAgentEquities(tx: Sql, asOf = new Date()): Promise<AgentEquity[]> {
  const agents = await tx.query<{ id: string }>(
    `select id from ledger.agents order by id`,
  );
  const out: AgentEquity[] = [];
  for (const { id } of agents.rows) {
    out.push(await agentEquity(tx, id, asOf));
  }
  return out;
}
