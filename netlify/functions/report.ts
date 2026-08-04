/**
 * Netlify adapter for the read-only report endpoint.
 *
 * The only thing Vantage talks to. Read-only, token-authenticated, and
 * deliberately separate from /api/control so that a caller holding a report
 * token can never reach an action that moves money.
 */

import { handleReport, unavailable } from '../../src/server/report-handler.js';
import { serialise } from '../../src/server/handler.js';

export default async function report(request: Request): Promise<Response> {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // An uncaught throw here does not reach the caller as a 500 — the platform
  // returns 502 "error decoding lambda response", which names neither the
  // endpoint nor the cause. Vantage's widget would show that as an outage of
  // itself rather than of this app.
  //
  // The reason is deliberately withheld. This endpoint is reachable by anyone
  // and its token check needs the database, so a failure before authentication
  // means there is no way to know who is asking. /api/health is the place that
  // explains itself, and it does so by choice.
  let result;
  try {
    result = await handleReport({ method: request.method, headers });
  } catch (error) {
    // handleReport answers its own failures; reaching here means one escaped
    // it. The reply still has to carry a reconciliation block, so it is built
    // by the same function rather than written out again — the version written
    // out again is the one that was missing it.
    console.error('report request failed before the handler could answer:', error);
    result = unavailable(503, 'unavailable');
  }

  return new Response(serialise(result.body), {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      // Owner-only figures. No shared cache may keep a copy.
      'cache-control': 'no-store',
      // Vantage calls this from its own server side, not the browser, so no
      // CORS allowance is granted. A widget fetching this directly from the
      // page would put the token in client-side JavaScript.
      'x-content-type-options': 'nosniff',
    },
  });
}

export const config = { path: '/api/report' };
