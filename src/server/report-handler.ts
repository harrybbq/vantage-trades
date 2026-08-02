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

export async function handleReport(request: ReportRequest): Promise<ReportResponse> {
  if (request.method !== 'GET') {
    return { status: 405, body: { error: 'this endpoint is read-only' } };
  }

  // Header, never a query string. Query strings end up in server logs, browser
  // history and Referer headers, which is how a token outlives its usefulness.
  const presented = request.headers[TOKEN_HEADER] ?? request.headers[TOKEN_HEADER.toLowerCase()];

  const ok = await inTransaction((tx) => verifyReportToken(tx, presented));
  if (!ok) {
    return { status: 401, body: { error: 'not authorised' } };
  }

  return { status: 200, body: await inTransaction((tx) => reportView(tx)) };
}
