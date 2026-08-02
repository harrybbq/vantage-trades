import type { Sql } from '../db.js';
import { accountId } from './accounts.js';

export interface CreateAgentInput {
  id: string;
  name: string;
}

/**
 * Create an agent and its four accounts.
 *
 * Agents start idle, never running. Creating something that immediately begins
 * placing orders is the wrong default for anything that can move money —
 * starting it is a separate, deliberate act.
 */
export async function createAgent(tx: Sql, input: CreateAgentInput): Promise<void> {
  await tx.query(
    `insert into ledger.agents (id, name, status) values ($1, $2, 'idle')`,
    [input.id, input.name],
  );

  for (const kind of ['agent_cash', 'agent_positions', 'agent_realised', 'agent_fees'] as const) {
    await accountId(tx, kind, input.id);
  }
}
