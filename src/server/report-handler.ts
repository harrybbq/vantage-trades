/**
 * The report endpoint's handler. Separate from the control handler on purpose.
 *
 * Different callers, different credentials, different powers. Routing both
 * through one switch would put a token-authenticated caller one mistyped case
 * label away from an action that moves money. This file can reach exactly one
 * function, and that function only reads.
 *
 * GET only. Not because a POST would be wrong, but because a read endpoint
 * that accepts POST bodies is one refactor away from accepting instructions.
 */

import { inTransaction } from '../db.js';
import { reportView, verifyReportToken, TOKEN_HEADER } from '../api/report.js';

export interface ReportRequest {
  method: string;
  headers: Record<string, string | undefined>;
}

export interface ReportResponse {
  status: number;
  body: unknown;
}

/**
 * Answer before the caller gives up, or do not answer at all.
 *
 * Vantage aborts at 8 seconds and reports a timeout. The connection pool's own
 * timeout is 10, so a database that is merely slow to hand out a connection
 * would blow the caller's budget every time and be reported as this app being
 * down — with nothing on either side saying which of the two ran out of
 * patience first. Six seconds leaves room for the network on both hops and
 * guarantees the timeout is ours to explain.
 */
export const BUDGET_MS = 6_000;

/** What Vantage waits before aborting and reporting a timeout of its own. */
export const CALLER_ABORTS_AT_MS = 8_000;

class DeadlineExceeded extends Error {}

async function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const work = fn();
  // The race may reject first, and an unobserved rejection afterwards would
  // take the whole function down rather than this one request.
  work.catch(() => undefined);

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every failure carries a reconciliation block.
 *
 * Vantage treats a missing block as untrustworthy and shows the alarm, which
 * is the right default — a partial payload must not read as healthy. Sending
 * one that says "unavailable" turns the same alarm from an inference into a
 * statement, and costs nothing: it names no agent, no figure and no caller.
 */
export const unavailable = (status: number, error: string): ReportResponse => ({
  status,
  body: { error, reconciliation: { status: 'unavailable', asOf: null } },
});

export async function handleReport(request: ReportRequest): Promise<ReportResponse> {
  if (request.method !== 'GET') {
    return unavailable(405, 'this endpoint is read-only');
  }

  // Header, never a query string. Query strings end up in server logs, browser
  // history and Referer headers, which is how a token outlives its usefulness.
  const presented = request.headers[TOKEN_HEADER] ?? request.headers[TOKEN_HEADER.toLowerCase()];

  try {
    // One transaction, not two. The check and the read used to take a
    // connection each, which doubled the chance of waiting on the pool inside
    // a budget measured in seconds.
    return await withDeadline(BUDGET_MS, () =>
      inTransaction(async (tx) => {
        if (!(await verifyReportToken(tx, presented))) {
          return unavailable(401, 'not authorised');
        }
        return { status: 200, body: await reportView(tx) };
      }),
    );
  } catch (error) {
    if (error instanceof DeadlineExceeded) {
      return unavailable(503, 'the ledger did not answer within the budget');
    }

    // Everything else is answered here rather than rethrown. Letting it escape
    // put the contract in the hands of whichever adapter happened to catch it
    // — and the adapter's own reply carried no reconciliation block, so the
    // single most likely failure in production, the ledger being unreachable,
    // was the one response that broke the rule this file exists to keep.
    //
    // No detail. This endpoint is publicly reachable and its token check needs
    // the database, so a failure before authentication means there is no way
    // to know who is asking. /api/health is the surface that explains itself.
    console.error('report request failed:', error);
    return unavailable(503, 'unavailable');
  }
}
