/**
 * A configuration self-check, readable without signing in.
 *
 * Deliberately unauthenticated, because the thing it diagnoses is usually the
 * reason you cannot sign in. Requiring a session to find out why sessions do
 * not work is a locked room with the key inside.
 *
 * It is safe to leave open. Everything it reports is either already public —
 * the project ref is compiled into the JavaScript this site serves — or a
 * boolean about whether a variable is set. No key, no password, no connection
 * string, and no user id. The one thing it will say about a caller is whether
 * that caller is the owner, and only to a caller who presented their own valid
 * token, which tells them nothing they did not already know.
 */

import { projectRefFromUrl, probeSupabase, redact, serverConfigReport } from './config.js';
import type { Check } from './config.js';
import { getPool } from '../db.js';

export interface HealthReport {
  ok: boolean;
  asOf: string;
  checks: Check[];
  /** What to do about it, when there is something to do. */
  advice: string[];
}

/**
 * Verify a caller's token far enough to say whether they are the owner.
 *
 * Separate from `authenticate` on purpose: that one is a gate and answers
 * yes/no, and turning it into something that explains itself would be turning
 * the gate into an oracle. This one explains and grants nothing.
 */
async function describeCaller(
  headers: Record<string, string | undefined>,
  url: string,
  anonKey: string,
  ownerId: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Check | null> {
  const header = headers['authorization'] ?? headers['Authorization'];
  if (!header?.startsWith('Bearer ')) return null;

  let response: Response;
  try {
    response = await fetchImpl(`${url}/auth/v1/user`, {
      headers: { Authorization: header, apikey: anonKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    return {
      name: 'your session',
      ok: false,
      detail: `could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      name: 'your session',
      ok: false,
      detail: `the project refused the token (${response.status}). Sign out and back in, or check the key above.`,
    };
  }

  const user = (await response.json().catch(() => ({}))) as { id?: string };
  if (!user.id) {
    return { name: 'your session', ok: false, detail: 'the project returned no user' };
  }

  return {
    name: 'your session',
    ok: user.id === ownerId,
    detail:
      user.id === ownerId
        ? 'valid, and you are the owner'
        : 'valid, but this account is not the owner. OWNER_USER_ID names a different user.',
  };
}

/**
 * Connect, and check the schema is actually there.
 *
 * A reachable database with no `ledger` schema is its own distinct failure —
 * the installer was never run, or was run against a different project — and it
 * produces a 500 that looks exactly like a connection problem.
 *
 * Read-only, and touches no table that holds money.
 */
async function checkDatabase(): Promise<Check[]> {
  let client;
  try {
    client = await getPool().connect();
  } catch (error) {
    return [
      {
        name: 'database',
        ok: false,
        detail: redact(error instanceof Error ? error.message : String(error)),
      },
    ];
  }

  try {
    const { rows } = await client.query<{ installed: string | null }>(
      "select to_regclass('ledger.agents')::text as installed",
    );
    const installed = rows[0]?.installed ?? null;

    return [
      { name: 'database', ok: true, detail: 'connected' },
      {
        name: 'ledger schema',
        ok: installed !== null,
        detail: installed
          ? 'installed'
          : 'connected, but the ledger schema is not there. Run supabase/install.sql ' +
            'against this database — or check DATABASE_URL points at the one you installed into.',
      },
    ];
  } catch (error) {
    return [
      {
        name: 'ledger schema',
        ok: false,
        detail: redact(error instanceof Error ? error.message : String(error)),
      },
    ];
  } finally {
    client.release();
  }
}

export async function healthReport(
  headers: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  probeDatabase: () => Promise<Check[]> = checkDatabase,
): Promise<HealthReport> {
  const config = serverConfigReport(env);
  const checks = [...config.checks];

  const url = env['SUPABASE_URL']?.trim().replace(/\/+$/, '');
  const anonKey = env['SUPABASE_ANON_KEY']?.trim();

  // Only worth asking the project anything once the two values are at least
  // the right shape — otherwise the answer is a network error that says less
  // than the checks above already did.
  if (url && anonKey && projectRefFromUrl(url)) {
    const probe = await probeSupabase(url, anonKey, fetchImpl);
    checks.push({ name: 'project reachable', ok: probe.ok, detail: probe.detail });

    const caller = await describeCaller(
      headers,
      url,
      anonKey,
      env['OWNER_USER_ID']?.trim(),
      fetchImpl,
    );
    if (caller) checks.push(caller);
  }

  // Only worth connecting once the string is the right shape; otherwise the
  // driver error says less than the check above already did.
  if (checks.find((check) => check.name === 'DATABASE_URL')?.ok) {
    checks.push(...(await probeDatabase()));
  }

  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  const advice: string[] = [];

  if (failed.some((name) => name.startsWith('SUPABASE'))) {
    advice.push(
      'Fix the variable named above, then redeploy. Changing it in the dashboard ' +
        'alone does not update a running function.',
    );
  }
  if (failed.includes('SUPABASE_ANON_KEY')) {
    // There are two variables one letter apart in meaning and six in name, and
    // fixing the wrong one looks identical to fixing nothing. Only the server's
    // is visible from here — the browser's is compiled into the bundle — so
    // this check cannot tell you which one you edited. Name both.
    advice.push(
      'SUPABASE_ANON_KEY and VITE_SUPABASE_ANON_KEY are different variables and ' +
        'both need the same publishable key. This check can only see the first: ' +
        'the VITE_ one is compiled into the browser bundle at build time. ' +
        'Correcting one and not the other looks exactly like correcting neither.',
    );
  }
  if (failed.includes('OWNER_USER_ID')) {
    advice.push(
      'OWNER_USER_ID is the owner\'s user id from Authentication → Users in Supabase, ' +
        'not their email.',
    );
  }
  if (failed.includes('your session')) {
    advice.push('Sign out and sign in again to rule out a stale token.');
  }
  if (failed.includes('database') || failed.includes('DATABASE_URL')) {
    advice.push(
      'The panel cannot load without the ledger, so this alone produces a 500 on ' +
        'every request. Supabase → Settings → Database → Connection pooling, ' +
        'transaction mode, and append ?sslmode=require.',
    );
  }
  if (failed.includes('MARKET_DATA_API_KEY')) {
    advice.push(
      'Without a market data key nothing is priced, so agents cannot act and the ' +
        'equity curve has no benchmark drawn on it. See docs/DEPLOY.md.',
    );
  }
  if (failed.includes('ledger schema')) {
    advice.push('Run supabase/install.sql against the database DATABASE_URL points at.');
  }
  if (!failed.length) {
    advice.push(
      'Server configuration is sound. If the panel still fails, the browser bundle ' +
        'is the remaining suspect: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are ' +
        'compiled in at build time, so a stale build keeps serving the old values ' +
        'until it is rebuilt.',
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    asOf: new Date().toISOString(),
    checks,
    advice,
  };
}
