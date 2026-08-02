/**
 * The trading universe: which symbols an agent may open a position in.
 *
 * The owner sets this; the agent picks within it. Enforced by a trigger on
 * ledger.orders, so a strategy cannot reach outside it however it is written.
 *
 * Buys are constrained, sells are not — removing a symbol must never trap an
 * agent in a position it can no longer exit.
 */

import type { Sql } from '../db.js';

export async function listUniverse(tx: Sql, agentId: string): Promise<string[]> {
  const result = await tx.query<{ symbol: string }>(
    `select symbol from ledger.agent_universe where agent_id = $1 order by symbol`,
    [agentId],
  );
  return result.rows.map((r) => r.symbol);
}

export async function addToUniverse(
  tx: Sql,
  agentId: string,
  symbol: string,
  actor: string,
): Promise<void> {
  const normalised = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(normalised)) {
    throw new Error(`not a usable symbol: ${JSON.stringify(symbol)}`);
  }

  await tx.query(
    `insert into ledger.agent_universe (agent_id, symbol, added_by)
     values ($1, $2, $3)
     on conflict (agent_id, symbol) do nothing`,
    [agentId, normalised, actor],
  );
}

/**
 * Remove a symbol. The agent can no longer open a position in it, but any
 * position it already holds stays sellable.
 */
export async function removeFromUniverse(
  tx: Sql,
  agentId: string,
  symbol: string,
): Promise<{ removed: boolean; stillHeld: boolean }> {
  const normalised = symbol.trim().toUpperCase();

  const deleted = await tx.query(
    `delete from ledger.agent_universe where agent_id = $1 and symbol = $2`,
    [agentId, normalised],
  );

  const held = await tx.query(
    `select 1 from ledger.agent_positions where agent_id = $1 and symbol = $2`,
    [agentId, normalised],
  );

  return { removed: (deleted.rowCount ?? 0) > 0, stillHeld: (held.rowCount ?? 0) > 0 };
}

export async function universesFor(tx: Sql): Promise<Map<string, string[]>> {
  const result = await tx.query<{ agent_id: string; symbol: string }>(
    `select agent_id, symbol from ledger.agent_universe order by agent_id, symbol`,
  );
  const out = new Map<string, string[]>();
  for (const row of result.rows) {
    const list = out.get(row.agent_id) ?? [];
    list.push(row.symbol);
    out.set(row.agent_id, list);
  }
  return out;
}
