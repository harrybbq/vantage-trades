/**
 * Netlify adapter for the control-panel API.
 *
 * Holds no logic of its own — it translates a Netlify Request into an
 * ApiRequest and back. The broker credentials and the database URL live here,
 * server-side, and never reach the bundle the browser downloads.
 */

import { handle, serialise } from '../../src/server/handler.js';

export default async function control(request: Request): Promise<Response> {
  const url = new URL(request.url);

  let body: unknown = null;
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'body must be JSON' }, { status: 400 });
    }
  }

  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await handle({
    method: request.method,
    path: url.pathname,
    headers,
    body,
  });

  // serialise rather than Response.json: a stray bigint would make the
  // built-in serialiser throw, and this route can be the difference between
  // halting an agent and not.
  return new Response(serialise(result.body), {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      // Owner-only data. Never let a shared cache hold a copy of it.
      'cache-control': 'no-store',
    },
  });
}

export const config = { path: '/api/control' };
