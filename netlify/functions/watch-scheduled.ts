/**
 * The watchdog, and the weekly summary.
 *
 * Every other job reports its own failures. None of them can report that it
 * did not run at all — a schedule that silently stops looks exactly like a
 * quiet night. This runs in the morning and asks one question of the night
 * before: did the check happen? It is a separate function so that whatever
 * stopped the nightly job has to stop this one too before nobody is told.
 *
 * On Saturday morning it also sends the week's summary.
 *
 * Reads only. It places nothing and changes nothing.
 */

import { closePool, inTransaction } from '../../src/db.js';
import { expectedReconcileBy } from '../../src/api/view.js';
import { weeklyDigest } from '../../src/alerts/digest.js';
import { notify } from '../../src/alerts/notify.js';

export default async function watchScheduled(): Promise<Response> {
  const now = new Date();
  const done: string[] = [];

  try {
    const last = await inTransaction(async (tx) => {
      const r = await tx.query<{ run_at: Date }>(
        `select run_at from ledger.reconciliations order by run_at desc limit 1`,
      );
      return r.rows[0]?.run_at ?? null;
    });

    if (last === null || last < expectedReconcileBy(now)) {
      await notify({
        title: 'Vantage Trades: the nightly check did not run',
        body:
          (last === null
            ? 'The ledger has never been checked against the broker.'
            : `The last check was ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC, and one was due since.`) +
          ' Nothing has confirmed the numbers since then. Open the panel and press Check now; ' +
          'if that fails, /api/health says what is wrong.',
        urgent: true,
      });
      done.push('missed check reported');
    }

    if (now.getUTCDay() === 6) {
      const digest = await inTransaction((tx) => weeklyDigest(tx, now));
      if (digest) {
        await notify(digest);
        done.push('weekly summary sent');
      }
    }

    return new Response(done.join(', ') || 'nothing to report', { status: 200 });
  } catch (error) {
    console.error('the watchdog failed:', error);
    await notify({
      title: 'Vantage Trades: the watchdog could not read the ledger',
      body: 'The morning check on the system itself failed, which usually means the database could not be reached. See /api/health.',
      urgent: true,
    });
    return new Response('the watchdog failed', { status: 500 });
  } finally {
    await closePool().catch(() => undefined);
  }
}

/**
 * 07:10 UTC, Tuesday to Saturday: the morning after each weekday night's
 * check, with the Saturday run doubling as the end of the week.
 */
export const config = { schedule: '10 7 * * 2-6' };
