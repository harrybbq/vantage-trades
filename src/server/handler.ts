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
import { describeInfrastructureFailure } from './config.js';
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
  // Trimmed for the same reason as the client: an env var pasted with a
  // trailing newline fails in a way nothing on screen explains.
  const supabaseUrl = process.env['SUPABASE_URL']?.trim().replace(/\/+$/, '');
  const ownerId = process.env['OWNER_USER_ID']?.trim();

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

  // SUPABASE_URL is the project's API origin — https://<ref>.supabase.co — and
  // is NOT the database host. Mixing them up is easy when you have just been
  // handling a connection string, and it fails as a bare "fetch failed" that
  // explains nothing: db.<ref>.supabase.co resolves fine but serves no HTTPS.
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(supabaseUrl)) {
    throw new Error(
      `SUPABASE_URL does not look like a project API URL (got "${supabaseUrl}"). ` +
        'It should be https://<project-ref>.supabase.co — the Project URL from ' +
        'Settings, not the database host and not the pooler host.',
    );
  }

  const header = headers['authorization'] ?? headers['Authorization'];
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);

  const anonKey = process.env['SUPABASE_ANON_KEY']?.trim();
  if (!anonKey) return null;

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    // Node reports every connection-level failure as "fetch failed", which
    // tells the owner nothing. Name what was being reached instead.
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not reach ${supabaseUrl} to verify your session (${why}). ` +
        'Check SUPABASE_URL is the project API URL and that the project is not paused.',
    );
  }

  if (!response.ok) {
    // The caller still gets a bland 401 — telling them which half failed is
    // free reconnaissance. But the reason belongs in the function log, or a
    // misconfigured key is indistinguishable from a wrong user and the owner
    // has nothing to debug with.
    const detail = await response.text().catch(() => '');
    console.error(
      `Supabase rejected the token check: ${response.status} ${detail.slice(0, 200)}`,
    );
    return null;
  }

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
      case 'recordDeposit':
        return json(200, await actions.doRecordDeposit(body as never, actor));
      case 'recordWithdrawal':
        return json(200, await actions.doRecordWithdrawal(body as never, actor));
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
      /not running|overdraw|pool would go negative|not permitted to trade|empty trading universe|still holds|was killed|must be unwound|does not hold enough|duplicate key/.test(
        message,
      );

    if (isDomainRefusal) return json(409, { error: message });

    console.error('control panel request failed:', error);

    // Infrastructure faults are the owner's own deployment facts — an
    // unreachable host, a missing schema, a refused password. They carry no
    // ledger data, and withholding them turns a five-minute fix into an
    // afternoon of reading function logs: "something went wrong" reads
    // identically whether the database is down or the SQL is broken.
    //
    // Everything else stays opaque. An unexpected error is exactly the kind
    // that might be quoting a row back at you.
    const infrastructure = describeInfrastructureFailure(error);
    if (infrastructure) {
      return json(503, { error: `${infrastructure} See /api/health.` });
    }

    return json(500, { error: 'something went wrong' });
  }
}
