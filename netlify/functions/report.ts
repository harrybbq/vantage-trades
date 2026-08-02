/**
 * Netlify adapter for the read-only report endpoint.
 *
 * The only thing Vantage talks to. Read-only, token-authenticated, and
 * deliberately separate from /api/control so that a caller holding a report
 * token can never reach an action that moves money.
 */

import { handleReport } from '../../src/server/report-handler.js';
import { serialise } from '../../src/server/handler.js';

export default async function report(request: Request): Promise<Response> {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await handleReport({ method: request.method, headers });

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
