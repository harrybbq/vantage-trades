/**
 * Netlify adapter for the configuration self-check.
 *
 * Unauthenticated by design — see src/server/health.ts for why that is safe
 * and why it has to be. It reads configuration and answers; it touches neither
 * the ledger nor the broker, and there is no request it can be talked into
 * making that moves money.
 */

import { healthReport } from '../../src/server/health.js';

export default async function health(request: Request): Promise<Response> {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // ?feed=1 additionally asks the market data provider for one quote. Opt-in
  // because it spends a rate-limited API credit and this endpoint is public.
  const probeFeed = new URL(request.url).searchParams.get('feed') === '1';

  const report = await healthReport(headers, process.env, fetch, undefined, probeFeed);

  return Response.json(report, {
    // 503 when something is actually wrong, so a glance at the status code is
    // enough and an uptime check notices without reading the body.
    status: report.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}

export const config = { path: '/api/health' };
