#!/usr/bin/env node
/**
 * Tick every running agent once.
 *
 *   npm run job:agents
 *
 * One pass, then exit. Scheduling is deliberately somebody else's job — cron,
 * a Netlify scheduled function, whatever. A long-lived process that decides
 * its own cadence is a process that can decide to go faster, and the thing
 * that most reliably loses money on a small account is trading more often.
 *
 * Each agent's own `min_tick_seconds` is checked against `last_tick_at` in the
 * database, so running this too frequently is a no-op rather than a problem.
 */

import { closePool, getPool, inTransaction } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import type { BrokerAdapter } from '../broker/types.js';
import { SmaCrossover } from '../agents/sma.js';
import { HoldBenchmark } from '../agents/hold.js';
import { tick } from '../agents/runner.js';
import type { Strategy } from '../agents/types.js';

export interface RunningAgent {
  id: string;
  /** `ledger.agents.strategy`. */
  strategy: string;
}

/**
 * The rule each agent runs, from its row.
 *
 * An unknown name runs nothing at all rather than falling back to some
 * default: a rule the owner did not choose must not trade their money.
 */
export function strategyFor(agent: RunningAgent): Strategy {
  switch (agent.strategy) {
    case 'hold':
      return new HoldBenchmark();
    case 'sma':
      return new SmaCrossover();
    default:
      throw new Error(`agent ${agent.id} has an unknown strategy "${agent.strategy}"; it was not run`);
  }
}

/** Something from a run that the owner should be told about. */
export interface AgentEvent {
  agentId: string;
  kind: 'halted-itself' | 'failed';
  detail: string;
}

export async function runAllAgents(
  broker: BrokerAdapter,
  pick: (agent: RunningAgent) => Strategy = strategyFor,
  onEvent: (event: AgentEvent) => void = () => undefined,
): Promise<number> {
  const agents = await inTransaction(async (tx) => {
    const result = await tx.query<RunningAgent>(
      `select id, strategy from ledger.agents where status = 'running' order by id`,
    );
    return result.rows;
  });

  if (agents.length === 0) {
    console.log('no running agents');
    return 0;
  }

  let acted = 0;
  const failures: string[] = [];

  for (const agent of agents) {
    const agentId = agent.id;
    // One agent throwing used to end the run for every agent after it.
    let outcome: Awaited<ReturnType<typeof tick>>;
    try {
      outcome = await tick(broker, pick(agent), agentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${agentId}: TICK FAILED - ${message}`);
      failures.push(`${agentId}: ${message}`);
      onEvent({ agentId, kind: 'failed', detail: message });
      continue;
    }

    if (outcome.selfHalted) {
      console.warn(`${agentId}: HALTED ITSELF - ${outcome.selfHalted}`);
      onEvent({ agentId, kind: 'halted-itself', detail: outcome.selfHalted });
      continue;
    }
    if (!outcome.ran) {
      console.log(`${agentId}: ${outcome.skipped ?? 'did not run'}`);
      continue;
    }

    for (const s of outcome.submitted) {
      console.log(`${agentId}: ${s.side} ${s.symbol} - ${s.why}`);
      acted += 1;
    }
    for (const r of outcome.refused) {
      console.warn(`${agentId}: refused ${r.symbol} - ${r.reason}`);
    }
    if (outcome.submitted.length === 0 && outcome.refused.length === 0) {
      console.log(`${agentId}: no signal`);
    }
  }

  // Thrown after every agent has had its turn, so the run still shows as
  // failed rather than as a success that logged an error nobody reads.
  if (failures.length > 0) {
    throw new Error(`${failures.length} agent tick(s) failed: ${failures.join('; ')}`);
  }

  return acted;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0');

if (invokedDirectly) {
  const broker = new PaperBroker(getPool());
  runAllAgents(broker)
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error('agent run failed:', error);
      await closePool();
      process.exit(1);
    });
}
