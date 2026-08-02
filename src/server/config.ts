/**
 * What the Supabase configuration says about itself.
 *
 * Every value this module reads is public by construction — a project URL, a
 * project ref, the *shape* of a key — so it is safe to report on. It never
 * returns a key, a password or a connection string, and the one place it looks
 * inside a key it reads only the `ref` and `role` claims, both of which are
 * readable by anyone holding the key already.
 *
 * This exists because a misconfigured deployment fails as "Invalid API key" in
 * a browser console, which is indistinguishable from a wrong password, a stale
 * build, a paused project and a key from the wrong project. Four causes, one
 * message, no way to tell them apart — so each one gets named here instead.
 */

/** The API origin for a project, trimmed of the trailing slash people paste. */
const PROJECT_URL = /^https:\/\/([a-z0-9-]+)\.supabase\.(?:co|in)$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Env = Record<string, string | undefined>;

export function cleanUrl(raw: string | undefined): string | undefined {
  return raw?.trim().replace(/\/+$/, '') || undefined;
}

/** The project ref a URL points at, or null when it is not a project URL. */
export function projectRefFromUrl(raw: string | undefined): string | null {
  const match = PROJECT_URL.exec(cleanUrl(raw) ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

export type KeyKind =
  | 'legacy-anon'
  | 'legacy-service-role'
  | 'legacy-other-role'
  | 'publishable'
  | 'secret'
  | 'unrecognised';

export interface KeyFacts {
  kind: KeyKind;
  /** The project the key was issued for, when the key carries one. */
  ref: string | null;
  /** Set when this key must never be used as the public client key. */
  fatal: string | null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Classify a Supabase API key without revealing it.
 *
 * The `fatal` cases are the ones that matter most: a `service_role` or
 * `sb_secret_` key bypasses row-level security entirely, and the natural
 * mistake — grabbing the wrong key off the same settings page — puts it in a
 * `VITE_` variable, which bundles it into JavaScript anyone can download.
 */
export function inspectKey(raw: string | undefined): KeyFacts {
  const key = raw?.trim();
  if (!key) return { kind: 'unrecognised', ref: null, fatal: null };

  if (key.startsWith('sb_secret_')) {
    return {
      kind: 'secret',
      ref: null,
      fatal: 'this is a secret key (sb_secret_…). It grants full access and must never be used as the public key.',
    };
  }

  if (key.startsWith('sb_publishable_')) {
    // Publishable keys carry no project ref, so there is nothing to
    // cross-check: one from the wrong project is indistinguishable from the
    // right one until a request comes back rejected.
    return { kind: 'publishable', ref: null, fatal: null };
  }

  const claims = decodeJwtClaims(key);
  if (!claims) {
    return {
      kind: 'unrecognised',
      ref: null,
      fatal: 'not a Supabase API key — expected a JWT (eyJ…) or an sb_publishable_… key.',
    };
  }

  const ref = typeof claims['ref'] === 'string' ? claims['ref'].toLowerCase() : null;
  const role = typeof claims['role'] === 'string' ? claims['role'] : null;

  if (role === 'service_role') {
    return {
      kind: 'legacy-service-role',
      ref,
      fatal: 'this is the service_role key. It bypasses every row-level security policy and must never be used as the public key.',
    };
  }
  if (role === 'anon') return { kind: 'legacy-anon', ref, fatal: null };

  return {
    kind: 'legacy-other-role',
    ref,
    fatal: `unrecognised key role "${role ?? '(none)'}" — expected anon.`,
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConfigReport {
  ok: boolean;
  checks: Check[];
}

const report = (checks: Check[]): ConfigReport => ({
  ok: checks.every((c) => c.ok),
  checks,
});

/**
 * Check the pair of variables that decide whether a sign-in can work.
 *
 * Shared by the server report and the build-time check so the two cannot drift
 * apart and start disagreeing about what a valid configuration looks like.
 */
function checkPair(env: Env, urlVar: string, keyVar: string): Check[] {
  const checks: Check[] = [];

  const rawUrl = env[urlVar];
  const ref = projectRefFromUrl(rawUrl);
  checks.push({
    name: urlVar,
    ok: ref !== null,
    detail: !rawUrl?.trim()
      ? 'not set'
      : ref
        ? `project ${ref}`
        : `"${cleanUrl(rawUrl) ?? ''}" is not a project API URL. It should be ` +
          'https://<project-ref>.supabase.co — the Project URL from Settings → API, ' +
          'not the database host and not the pooler host.',
  });

  const key = inspectKey(env[keyVar]);
  const keySet = Boolean(env[keyVar]?.trim());
  checks.push({
    name: keyVar,
    ok: keySet && key.fatal === null,
    detail: !keySet
      ? 'not set'
      : (key.fatal ??
        (key.ref
          ? `${key.kind} key for project ${key.ref}`
          : `${key.kind} key — it names no project, so it cannot be checked ` +
            `against ${urlVar} here. Only the project itself can tell you.`)),
  });

  // Only meaningful for legacy JWT keys; publishable keys carry no ref.
  if (ref && key.ref) {
    checks.push({
      name: `${keyVar} matches ${urlVar}`,
      ok: key.ref === ref,
      detail:
        key.ref === ref
          ? `both project ${ref}`
          : `the key is for project ${key.ref} but the URL points at ${ref}. ` +
            'That is exactly what "Invalid API key" means.',
    });
  }

  return checks;
}

/**
 * The server's own configuration, as a list of named checks.
 *
 * Reports refs and shapes only. No key, no password, no connection string, and
 * not the owner's user id — only whether one is set and well-formed.
 */
export function serverConfigReport(env: Env = process.env): ConfigReport {
  const checks = checkPair(env, 'SUPABASE_URL', 'SUPABASE_ANON_KEY');

  const owner = env['OWNER_USER_ID']?.trim();
  checks.push({
    name: 'OWNER_USER_ID',
    ok: Boolean(owner && UUID.test(owner)),
    detail: !owner ? 'not set' : UUID.test(owner) ? 'set' : 'set, but not a UUID',
  });

  const database = env['DATABASE_URL']?.trim() ?? env['NETLIFY_DATABASE_URL']?.trim();
  const requiresSsl = database ? /sslmode=require/i.test(database) : false;
  checks.push({
    name: 'DATABASE_URL',
    ok: Boolean(database) && requiresSsl,
    detail: !database
      ? 'not set'
      : requiresSsl
        ? 'set, sslmode=require'
        : 'set, but missing ?sslmode=require',
  });

  // Never legitimately set on a deployed site. The handler already refuses to
  // honour it there, but a deployment that has it set at all is a deployment
  // somebody tried to unlock, and that is worth saying out loud.
  const authMode = env['AUTH_MODE']?.trim();
  if (authMode) {
    checks.push({
      name: 'AUTH_MODE',
      ok: false,
      detail: `set to "${authMode}". This is a local development bypass and must not be set here.`,
    });
  }

  return report(checks);
}

/**
 * The two variables baked into the browser bundle, checked at build time.
 *
 * These are read by Vite when the bundle is compiled, not when it runs, so a
 * wrong value cannot be corrected by editing it in the hosting dashboard — it
 * needs another build. Catching it here turns a silent bad deploy into a
 * failed one.
 */
export function webConfigReport(env: Env = process.env): ConfigReport {
  return report(checkPair(env, 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'));
}

export interface Probe {
  ok: boolean;
  detail: string;
}

/**
 * Ask the project whether it accepts this key, without a user token.
 *
 * A valid key with no bearer token gets past the gateway and is turned away by
 * the auth service for having no session; an invalid key never gets that far
 * and is refused by the gateway. Two different 401s, and the difference is the
 * whole diagnosis — it separates "the key is wrong" from "the key is fine and
 * something else is".
 */
export async function probeSupabase(
  url: string,
  anonKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: `could not reach ${url} (${why}). Check the URL, and that the project is not paused.`,
    };
  }

  const text = await response.text().catch(() => '');

  if (/invalid api key/i.test(text)) {
    return {
      ok: false,
      detail:
        `${url} rejected the key outright ("Invalid API key"). The key is wrong, ` +
        'stale, disabled, or issued for a different project.',
    };
  }

  // 401 with anything else means the key was accepted and only the missing
  // user token was objected to, which is the expected answer here.
  return {
    ok: true,
    detail: `${url} accepted the key (replied ${response.status} to a session-less request, as it should).`,
  };
}
