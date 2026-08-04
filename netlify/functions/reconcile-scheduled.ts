/**
 * The daily reconciliation, on a schedule.
 *
 * `CLAUDE.md` calls this mandatory and it is the one job that is: it asserts
 * `sum(agent equities) + unallocated == broker account equity`. Per-agent P/L
 * exists only because this app computes it, so nothing else in the system can
 * tell you that the computation has drifted. Unrun, every number in the UI is
 * confident fiction and stays that way until somebody notices by hand.
 *
 * Until this runs, `/api/report` reports `reconciliation: {"status":"never"}`
 * and Vantage shows the alarm — correctly. Nothing has been checked.
 *
 * It places no orders. It reads the broker, writes a reconciliation row, and
 * records the day's equity snapshot only when the ledger agreed. A point
 * recorded from a diverged ledger quietly misleads every chart drawn from it
 * afterwards.
 */

import { runDailyReconcile } from '../../src/jobs/daily-reconcile.js';
import { PaperBroker } from '../../src/broker/paper.js';
import { closePool, getPool } from '../../src/db.js';

export default async function reconcileScheduled(): Promise<Response> {
  try {
    const clean = await runDailyReconcile(new PaperBroker(getPool()));

    // Non-2xx on divergence, so the platform records a failed run rather than
    // a successful one that happened to log a disaster. A scheduled job whose
    // failures look like successes is a job nobody reads.
    return new Response(clean ? 'reconciled clean' : 'DIVERGED — see the control panel', {
      status: clean ? 200 : 500,
    });
  } catch (error) {
    console.error('reconciliation failed to run:', error);
    return new Response('reconciliation failed to run', { status: 500 });
  } finally {
    // Each invocation gets its own process and its own single connection.
    // Leaving it open holds a slot in a pooler shared with Vantage.
    await closePool().catch(() => undefined);
  }
}

/**
 * Weekdays, after the US close in either daylight or standard time.
 *
 * 16:00 New York is 20:00 UTC in summer and 21:00 in winter; 22:37 clears both
 * with room for late prints. The odd minute is deliberate — every scheduler on
 * the platform fires on the hour, and there is nothing to gain by joining them.
 */
export const config = { schedule: '37 22 * * 1-5' };
