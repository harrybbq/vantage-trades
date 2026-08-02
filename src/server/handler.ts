/**
 * The control-panel API, as one framework-agnostic handler.
 *
 * Netlify wraps it, and the local dev server wraps it. There is deliberately
 * one implementation: an auth check duplicated across five entry points is an
 * auth check that will eventually differ in one of them, and every route here
 * can move money.
 *
 * Identity is verified server-side on every request, without exception. A UI
 * check for "is this the owner" is decoration — the browser is not a trusted
 * place to decide who you are.
 */

import { ValidationError } from '../api/actions.js';
import * as actions from '../api/actions.js';
import { inTransaction } from '../db.js';
import { controlPanelView } from '../api/view.js';
import { statsView } from '../api/stats.js';

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });

/**
 * Serialise a response body.
 *
 * bigints become strings rather than throwing. Every figure is supposed to be
 * converted at the API boundary already, but `JSON.stringify` throws on a
 * bigint, and one that slipped through should not take the whole process down
 * — a string of minor units is the wire convention anyway.
 */
export function serialise(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * Resolve the caller, or null.
 *
 * Verifies the bearer token against Supabase and then checks the resulting
 * user is the owner. Both halves matter: a valid token proves who someone is,
 * not that they are allowed here.
 */
export async function authenticate(
  headers: Record<string, string | undefined>,
): Promise<string | null> {
  const supabaseUrl = process.env['SUPABASE_URL'];
  const ownerId = process.env['OWNER_USER_ID'];

  // Local development only, and it has to be asked for explicitly.
  //
  // The guard used to be NODE_ENV !== 'production', which is not good enough:
  // Netlify does not reliably set NODE_ENV at function runtime, so the bypass
  // could have fired on a deployed site. Since the natural reaction to a
  // deployed panel returning 401 is to try AUTH_MODE=insecure-local, that was
  // a live path to putting halt, kill and allocate on the public internet.
  //
  // So this now refuses whenever it can detect a hosted environment at all,
  // and fails closed rather than open.
  if (process.env['AUTH_MODE'] === 'insecure-local') {
    const hostedMarkers = [
      'NETLIFY',
      'AWS_LAMBDA_FUNCTION_NAME',
      'LAMBDA_TASK_ROOT',
      'AWS_EXECUTION_ENV',
      'VERCEL',
      'FLY_APP_NAME',
      'K_SERVICE',
    ];
    const hosted = hostedMarkers.find((key) => process.env[key]);

    if (hosted || process.env['NODE_ENV'] === 'production') {
      throw new Error(
        `AUTH_MODE=insecure-local is a local development bypass and must never be set ` +
          `on a deployed site (detected ${hosted ?? 'NODE_ENV=production'}). ` +
          `Set SUPABASE_URL, SUPABASE_ANON_KEY and OWNER_USER_ID instead.`,
      );
    }
    return 'local-owner';
  }

  if (!supabaseUrl || !ownerId) return null;

  const header = headers['authorization'] ?? headers['Authorization'];
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);

  const anonKey = process.env['SUPABASE_ANON_KEY'];
  if (!anonKey) return null;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!response.ok) return null;

  const user = (await response.json()) as { id?: string };
  if (!user.id || user.id !== ownerId) return null;

  return user.id;
}

type Body = Record<string, unknown>;

export async function handle(request: ApiRequest): Promise<ApiResponse> {
  let actor: string | null;
  try {
    actor = await authenticate(request.headers);
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'auth failed' });
  }

  if (!actor) {
    // Deliberately uninformative. Distinguishing "no token", "bad token" and
    // "not the owner" tells an attacker which half to work on.
    return json(401, { error: 'not authorised' });
  }

  const body = (request.body ?? {}) as Body;

  try {
    if (request.method === 'GET') {
      return json(200, await inTransaction((tx) => controlPanelView(tx)));
    }

    if (request.method !== 'POST') {
      return json(405, { error: `${request.method} not allowed` });
    }

    const action = body['action'];
    switch (action) {
      // Read-only, but a POST like everything else so there is one shape of
      // request to authenticate and one place to add an action.
      case 'stats':
        return json(200, await inTransaction((tx) => statsView(tx)));
      case 'createAgent':
        return json(200, await actions.doCreateAgent(body as never, actor));
      case 'allocate':
        return json(200, await actions.doAllocate(body as never, actor));
      case 'returnCapital':
        return json(200, await actions.doReturnCapital(body as never, actor));
      case 'halt':
        return json(200, await actions.doHalt(body as never, actor));
      case 'start':
        return json(200, await actions.doStart(body as never, actor));
      case 'globalHalt':
        return json(200, await actions.doGlobalHalt(body as never, actor));
      case 'previewKill':
        return json(200, await actions.doPreviewKill(body as never));
      case 'kill':
        return json(200, await actions.doKill(body as never, actor));
      case 'addSymbol':
        return json(200, await actions.doAddSymbol(body as never, actor));
      case 'removeSymbol':
        return json(200, await actions.doRemoveSymbol(body as never, actor));
      default:
        return json(400, { error: `unknown action: ${String(action)}` });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return json(400, { error: error.message });
    }

    // Domain refusals — halt, budget cap, universe, kill guards — are the
    // expected way for a request to fail, and the message is written to be
    // read by the owner, so it is passed through rather than swallowed.
    const message = error instanceof Error ? error.message : 'request failed';
    const isDomainRefusal =
      /not running|overdraw|pool would go negative|not permitted to trade|empty trading universe|still holds|was killed|must be unwound|does not hold enough/.test(
        message,
      );

    if (isDomainRefusal) return json(409, { error: message });

    console.error('control panel request failed:', error);
    return json(500, { error: 'something went wrong' });
  }
}
