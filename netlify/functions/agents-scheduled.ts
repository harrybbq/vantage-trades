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

import { runAllAgents } from '../../src/jobs/run-agents.js';
import { PaperBroker } from '../../src/broker/paper.js';
import { closePool, getPool } from '../../src/db.js';

export default async function agentsScheduled(): Promise<Response> {
  if (process.env['AGENTS_ENABLED'] !== 'true') {
    // Not an error. This is the expected state until the owner decides
    // otherwise, and it should read that way in the logs.
    return new Response('agents are not enabled (set AGENTS_ENABLED=true)', { status: 200 });
  }

  try {
    const acted = await runAllAgents(new PaperBroker(getPool()));
    return new Response(`ticked, ${acted} agent(s) acted`, { status: 200 });
  } catch (error) {
    console.error('the agent run failed:', error);
    return new Response('the agent run failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * Hourly through the US session, weekdays.
 *
 * 14:00–20:00 UTC covers 09:30–16:00 New York across both daylight and
 * standard time. Hourly is a ceiling, not a cadence: each agent's own
 * `min_tick_seconds` decides how often it actually acts, so raising this
 * frequency does not make any agent trade more.
 */
export const config = { schedule: '11 14-20 * * 1-5' };
