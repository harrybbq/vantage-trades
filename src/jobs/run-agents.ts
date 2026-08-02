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
import { tick } from '../agents/runner.js';
import type { Strategy } from '../agents/types.js';

/**
 * Which strategy each agent runs.
 *
 * A map rather than a column on the agent, for now: wiring a strategy name
 * from the database to a constructor is an indirection that only earns its
 * keep once there is more than one strategy worth running.
 */
function strategyFor(_agentId: string): Strategy {
  return new SmaCrossover();
}

export async function runAllAgents(broker: BrokerAdapter): Promise<number> {
  const agents = await inTransaction(async (tx) => {
    const result = await tx.query<{ id: string }>(
      `select id from ledger.agents where status = 'running' order by id`,
    );
    return result.rows.map((r) => r.id);
  });

  if (agents.length === 0) {
    console.log('no running agents');
    return 0;
  }

  let acted = 0;

  for (const agentId of agents) {
    const strategy = strategyFor(agentId);
    const outcome = await tick(broker, strategy, agentId);

    if (outcome.selfHalted) {
      console.warn(`${agentId}: HALTED ITSELF - ${outcome.selfHalted}`);
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
