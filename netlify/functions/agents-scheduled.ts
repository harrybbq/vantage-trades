/**
 * Tick every running agent, on a schedule.
 *
 * This is the only thing in the codebase that can place an order without a
 * human present, which makes it the one function where "off unless explicitly
 * switched on" is worth the inconvenience. `AGENTS_ENABLED=true` is required,
 * and its absence is the default in every environment including this one.
 *
 * Deploying it switched off is the point. The schedule, the wiring and the
 * failure modes get exercised while the worst outcome is a log line, and
 * enabling it later is one variable rather than a code change made in a hurry.
 *
 * Four things stand between this and an order nobody asked for, and none of
 * them live in this file:
 *
 *   - an agent is `idle` until started, and only `running` agents are ticked;
 *   - a database trigger refuses any order from an agent that is not running,
 *     checked at submission rather than once per loop, so halting mid-tick
 *     stops the next order rather than the next pass;
 *   - a buy must name a symbol in that agent's universe, which is empty until
 *     the owner fills it;
 *   - `min_tick_seconds` is measured against `last_tick_at` in the database,
 *     so a scheduler firing too often is a no-op rather than a faster trader.
 *
 * The fourth matters most. The most reliable way to lose money on a small
 * account is to trade more often, and a schedule is exactly the kind of thing
 * that gets tightened without anyone deciding to trade more.
 */

import { runAllAgents, strategyFor, type AgentEvent } from '../../src/jobs/run-agents.js';
import { notify } from '../../src/alerts/notify.js';
import { tradingBroker } from '../../src/broker/select.js';
import { closePool } from '../../src/db.js';

export default async function agentsScheduled(): Promise<Response> {
  if (process.env['AGENTS_ENABLED'] !== 'true') {
    // Not an error. This is the expected state until the owner decides
    // otherwise, and it should read that way in the logs.
    return new Response('agents are not enabled (set AGENTS_ENABLED=true)', { status: 200 });
  }

  const events: AgentEvent[] = [];
  // Whatever happens to the run, the owner hears about anything that stopped.
  const tell = async () => {
    if (events.length === 0) return;
    await notify({
      title: events.some((e) => e.kind === 'halted-itself')
        ? 'Vantage Trades: an agent halted itself'
        : 'Vantage Trades: an agent could not run',
      body:
        events
          .map((e) => `${e.agentId} ${e.kind === 'halted-itself' ? 'halted itself' : 'failed'}: ${e.detail}`)
          .join('\n') +
        '\n\nA halted agent opens nothing and closes nothing until you press Resume. What it holds still moves with the market.',
      urgent: true,
    });
  };

  try {
    const acted = await runAllAgents(tradingBroker(), strategyFor, (event) => events.push(event));
    await tell();
    return new Response(`ticked, ${acted} agent(s) acted`, { status: 200 });
  } catch (error) {
    console.error('the agent run failed:', error);
    if (events.length === 0) {
      events.push({ agentId: 'the run', kind: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
    await tell();
    return new Response('the agent run failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * Twice a day inside London hours, weekdays.
 *
 * The ledger is sterling and the shares are London-listed, so orders belong
 * inside the London session (08:00–16:30). The prices are end-of-day: there
 * is one new bar a day, and a decision is keyed to its bar, so a second tick
 * on the same bar places nothing. 09:11 is the decision; 13:11 is a second
 * chance if the first run failed. Both are after the 07:42 price run.
 *
 * This used to run hourly through the US session, which for London shares
 * meant placing orders after the market had closed.
 */
export const config = { schedule: '11 9,13 * * 1-5' };
