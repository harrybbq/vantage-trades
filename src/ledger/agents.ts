import type { Sql } from '../db.js';
import { accountId } from './accounts.js';
import { benchmarkSymbol } from './snapshots.js';
import { addToUniverse } from './universe.js';

/** Which rule an agent runs. See `src/agents/`. */
export type StrategyKind = 'sma' | 'hold';

export interface CreateAgentInput {
  id: string;
  name: string;
  strategy?: StrategyKind;
}

/**
 * Create an agent and its four accounts.
 *
 * Agents start idle, never running. Creating something that immediately begins
 * placing orders is the wrong default for anything that can move money —
 * starting it is a separate, deliberate act.
 */
export async function createAgent(tx: Sql, input: CreateAgentInput): Promise<void> {
  const strategy = input.strategy ?? 'sma';

  if (strategy === 'hold') {
    // One order may be its whole allocation, because buying the benchmark in
    // one go is the entire job. No daily loss cap: it makes no decisions for
    // a cap to stop, and halting it on the day the market falls would raise
    // an alarm on the day least worth acting on.
    await tx.query(
      `insert into ledger.agents (id, name, status, strategy, max_order_pct, daily_loss_cap_pct)
       values ($1, $2, 'idle', 'hold', 100, null)`,
      [input.id, input.name],
    );
  } else {
    await tx.query(
      `insert into ledger.agents (id, name, status, strategy) values ($1, $2, 'idle', $3)`,
      [input.id, input.name, strategy],
    );
  }

  for (const kind of ['agent_cash', 'agent_positions', 'agent_realised', 'agent_fees'] as const) {
    await accountId(tx, kind, input.id);
  }

  if (strategy === 'hold') {
    // The one share it exists to buy. Still idle and still unfunded, so this
    // permits nothing until the owner gives it capital and starts it.
    await addToUniverse(tx, input.id, benchmarkSymbol(), 'system');
  }
}
