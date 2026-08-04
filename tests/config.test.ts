/**
 * Configuration checks.
 *
 * These are pure — no database, no network — because they are the thing that
 * has to work when nothing else does. Every failure they describe has already
 * happened at least once on this project, each time presenting as the same
 * unhelpful "Invalid API key" in a browser.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  inspectKey,
  describeInfrastructureFailure,
  probeSupabase,
  projectRefFromUrl,
  redact,
  serverConfigReport,
  webConfigReport,
  type Env,
} from '../src/server/config.js';
import { healthReport } from '../src/server/health.js';
import { sslFor, poolConfig } from '../src/db.js';
import pg from 'pg';

/** A Supabase-shaped JWT. The signature is never checked here — only claims. */
const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'not-a-real-signature',
  ].join('.');

const anonFor = (ref: string) => jwt({ iss: 'supabase', ref, role: 'anon' });
const serviceFor = (ref: string) => jwt({ iss: 'supabase', ref, role: 'service_role' });

/**
 * Fictional, and it has to stay that way.
 *
 * The first version of this file used the real owner's user id, and Netlify's
 * secrets scanner failed the build over it — correctly. A user id is not a
 * credential, but it is the value `OWNER_USER_ID` holds, and a real one in a
 * repository is a real one in every clone of it.
 */
const OWNER = '11111111-2222-4333-8444-555555555555';
const SOMEBODY_ELSE = '99999999-8888-4777-8666-555555555555';

const failed = (report: { checks: { name: string; ok: boolean }[] }) =>
  report.checks.filter((c) => !c.ok).map((c) => c.name);

describe('project URLs', () => {
  it('accepts a project API URL', () => {
    expect(projectRefFromUrl('https://abcdefgh.supabase.co')).toBe('abcdefgh');
  });

  it('tolerates the trailing slash and whitespace people paste', () => {
    expect(projectRefFromUrl('  https://abcdefgh.supabase.co/  ')).toBe('abcdefgh');
  });

  it('rejects the database host, which is the easy mistake', () => {
    // Resolves fine, serves no HTTPS API, and fails as a bare "fetch failed".
    expect(projectRefFromUrl('https://db.abcdefgh.supabase.co')).toBeNull();
  });

  it('rejects the pooler host', () => {
    expect(projectRefFromUrl('https://aws-0-eu-central-2.pooler.supabase.com')).toBeNull();
  });

  it('rejects a postgres connection string', () => {
    expect(projectRefFromUrl('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')).toBeNull();
  });

  it('rejects plain http', () => {
    expect(projectRefFromUrl('http://abcdefgh.supabase.co')).toBeNull();
  });
});

describe('keys', () => {
  it('reads the project out of a legacy anon key', () => {
    expect(inspectKey(anonFor('abcdefgh'))).toMatchObject({
      kind: 'legacy-anon',
      ref: 'abcdefgh',
      fatal: null,
    });
  });

  it('refuses a service_role key', () => {
    const facts = inspectKey(serviceFor('abcdefgh'));
    expect(facts.kind).toBe('legacy-service-role');
    expect(facts.fatal).toMatch(/row-level security/);
  });

  it('refuses an sb_secret_ key', () => {
    expect(inspectKey('sb_secret_abc123').fatal).toMatch(/secret key/);
  });

  it('accepts a publishable key, which carries no project ref', () => {
    expect(inspectKey('sb_publishable_TbZBi2UF7atd')).toMatchObject({
      kind: 'publishable',
      ref: null,
      fatal: null,
    });
  });

  it('refuses something that is not a key at all', () => {
    expect(inspectKey('hunter2').fatal).toMatch(/not a Supabase API key/);
  });

  it('never echoes the key it was given', () => {
    const key = serviceFor('abcdefgh');
    expect(JSON.stringify(inspectKey(key))).not.toContain(key);
  });
});

describe('the server report', () => {
  const good: Env = {
    SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_ANON_KEY: anonFor('abcdefgh'),
    OWNER_USER_ID: OWNER,
    DATABASE_URL: 'postgresql://u:p@host:6543/postgres?sslmode=require',
    MARKET_DATA_API_KEY: 'a-key',
  };

  it('passes a correct configuration', () => {
    const report = serverConfigReport(good);
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('catches a key issued for a different project', () => {
    // The exact failure this project hit: both values individually valid, and
    // the pair meaningless. Supabase answers "Invalid API key" and says no more.
    const report = serverConfigReport({ ...good, SUPABASE_ANON_KEY: anonFor('zyxwvuts') });
    expect(failed(report)).toContain('SUPABASE_ANON_KEY matches SUPABASE_URL');
    expect(report.checks.find((c) => !c.ok)?.detail).toMatch(/Invalid API key/);
  });

  it('catches the database host in SUPABASE_URL', () => {
    const report = serverConfigReport({ ...good, SUPABASE_URL: 'https://db.abcdefgh.supabase.co' });
    expect(failed(report)).toContain('SUPABASE_URL');
  });

  it('catches an email in OWNER_USER_ID', () => {
    const report = serverConfigReport({ ...good, OWNER_USER_ID: 'harry@example.com' });
    expect(failed(report)).toContain('OWNER_USER_ID');
  });

  it('catches a connection string without sslmode=require', () => {
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: 'postgresql://u:p@host:6543/postgres',
    });
    expect(failed(report)).toContain('DATABASE_URL');
  });

  it('accepts the database Netlify provides', () => {
    const { DATABASE_URL: _unused, ...rest } = good;
    const report = serverConfigReport({
      ...rest,
      NETLIFY_DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require',
    });
    expect(failed(report)).toEqual([]);
  });

  it('catches the direct database host, which serverless cannot reach', () => {
    // Supabase's direct host is IPv6-only. From a Netlify function it fails to
    // route, and the driver error reads like the database being down.
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres?sslmode=require',
    });
    expect(failed(report)).toContain('DATABASE_URL');
    expect(report.checks.find((c) => c.name === 'DATABASE_URL')?.detail).toMatch(/IPv6-only/);
  });

  it('catches the pooler being given the plain postgres username', () => {
    const report = serverConfigReport({
      ...good,
      DATABASE_URL:
        'postgresql://postgres:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require',
    });
    expect(report.checks.find((c) => c.name === 'DATABASE_URL')?.detail).toMatch(
      /Tenant or user not found/,
    );
  });

  it('accepts a correct pooler URI', () => {
    const report = serverConfigReport({
      ...good,
      DATABASE_URL:
        'postgresql://postgres.abcdefgh:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require',
    });
    expect(failed(report)).toEqual([]);
  });

  it('shows the wrong string with the password removed', () => {
    // "The value in the dashboard" and "the value the function reads" turned
    // out to be different things, with no way to see the second.
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: 'postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres?sslmode=require',
    });
    const shown = report.checks.find((c) => c.name === 'DATABASE_URL (password removed)')?.detail;
    expect(shown).toContain('postgres:***@db.abcdefgh.supabase.co:5432');
    expect(shown).toContain('characters in total');
  });

  it('does not publish a password hiding in the path', () => {
    // A second connection string pasted after the first — into a field that
    // was not cleared, which a masked input makes invisible. The password ends
    // up in the path, so removing it from the userinfo is not enough.
    const doubled =
      'postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres' +
      'postgresql://postgres.abcdefgh:hunter2@aws-0.pooler.supabase.com:6543/postgres?sslmode=require';
    const report = serverConfigReport({ ...good, DATABASE_URL: doubled });

    expect(JSON.stringify(report)).not.toContain('hunter2');
    // But it still says the length, which is what reveals the doubling.
    expect(
      report.checks.find((c) => c.name === 'DATABASE_URL (password removed)')?.detail,
    ).toContain(`${doubled.length} characters`);
  });

  it('never echoes the password, whatever it decides', () => {
    for (const url of [
      'postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres?sslmode=require',
      'postgresql://postgres:hunter2@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require',
      'postgresql://postgres:hunter2@host:6543/postgres',
    ]) {
      expect(JSON.stringify(serverConfigReport({ ...good, DATABASE_URL: url }))).not.toContain(
        'hunter2',
      );
    }
  });

  it('strips credentials out of driver errors', () => {
    expect(redact('connect ECONNREFUSED postgresql://postgres:hunter2@host:6543/db')).not.toContain(
      'hunter2',
    );
  });

  it('names the character that broke the connection string', () => {
    // A generated Supabase password containing "#" truncates the URI at the
    // fragment and makes new URL() throw. Nothing warns you it needs encoding,
    // and "not a valid URL" sends you looking at the host instead.
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: 'postgresql://postgres.abc:pa#ss@aws-0.pooler.supabase.com:6543/postgres',
    });
    const detail = report.checks.find((c) => c.name === 'DATABASE_URL')?.detail ?? '';
    expect(detail).toMatch(/percent-encoded/);
    expect(detail).toMatch(/%23/);
    expect(detail).not.toContain('pa#ss');
  });

  it('spots the whole psql command being pasted', () => {
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: 'psql postgresql://postgres:pw@host:6543/postgres',
    });
    expect(report.checks.find((c) => c.name === 'DATABASE_URL')?.detail).toMatch(/starts with "psql"/);
  });

  it('spots surrounding quotes', () => {
    const report = serverConfigReport({
      ...good,
      DATABASE_URL: '"postgresql://postgres:pw@host:6543/postgres"',
    });
    expect(report.checks.find((c) => c.name === 'DATABASE_URL')?.detail).toMatch(/wrapped in quotes/);
  });

  it('flags a deployment that can never price anything', () => {
    // The panel still works without it, but nothing can be valued: equity
    // stays unknown and the benchmark cannot be drawn. Degraded, not working.
    const { MARKET_DATA_API_KEY: _none, ...rest } = good;
    const report = serverConfigReport(rest);
    expect(failed(report)).toContain('MARKET_DATA_API_KEY');
  });

  it('flags AUTH_MODE being set at all', () => {
    const report = serverConfigReport({ ...good, AUTH_MODE: 'insecure-local' });
    expect(failed(report)).toContain('AUTH_MODE');
  });

  it('reports nothing secret', () => {
    const serialised = JSON.stringify(serverConfigReport(good));
    expect(serialised).not.toContain(good.SUPABASE_ANON_KEY);
    expect(serialised).not.toContain(OWNER);
    expect(serialised).not.toContain('postgresql://');
  });
});

describe('the build-time web check', () => {
  it('refuses to compile a service_role key into public JavaScript', () => {
    const report = webConfigReport({
      VITE_SUPABASE_URL: 'https://abcdefgh.supabase.co',
      VITE_SUPABASE_ANON_KEY: serviceFor('abcdefgh'),
    });
    expect(report.ok).toBe(false);
    expect(failed(report)).toContain('VITE_SUPABASE_ANON_KEY');
  });

  it('refuses a URL and key from different projects', () => {
    const report = webConfigReport({
      VITE_SUPABASE_URL: 'https://abcdefgh.supabase.co',
      VITE_SUPABASE_ANON_KEY: anonFor('zyxwvuts'),
    });
    expect(report.ok).toBe(false);
  });

  it('passes a matched pair', () => {
    const report = webConfigReport({
      VITE_SUPABASE_URL: 'https://abcdefgh.supabase.co',
      VITE_SUPABASE_ANON_KEY: anonFor('abcdefgh'),
    });
    expect(report.ok).toBe(true);
  });
});

describe('naming an infrastructure failure', () => {
  const pgError = (code: string, message = 'boom') =>
    Object.assign(new Error(message), { code });

  it('names an unreachable host and points at the pooler', () => {
    const named = describeInfrastructureFailure(pgError('ECONNREFUSED'));
    expect(named).toMatch(/could not be reached/);
    expect(named).toMatch(/IPv6-only/);
  });

  it('names the driver failing to load, which is a bundling fault', () => {
    // node-postgres is CommonJS; bundled to ESM its require() throws before
    // any of our code runs. Distinct from every configuration problem.
    const named = describeInfrastructureFailure(
      new Error('Dynamic require of "events" is not supported'),
    );
    expect(named).toMatch(/bundling fault/);
  });

  it('names a refused password without quoting it', () => {
    const named = describeInfrastructureFailure(pgError('28P01', 'password authentication failed'));
    expect(named).toMatch(/refused the password/);
  });

  it('names the pooler username mistake', () => {
    expect(describeInfrastructureFailure(new Error('Tenant or user not found'))).toMatch(
      /postgres\.<project-ref>/,
    );
  });

  it('names a missing ledger schema', () => {
    expect(describeInfrastructureFailure(pgError('42P01'))).toMatch(/install\.sql/);
  });

  it('says nothing about an error it does not recognise', () => {
    // The fallback has to stay opaque: an unexpected error is the kind that
    // might be quoting a ledger row back at you.
    expect(describeInfrastructureFailure(new Error('cannot read property x of undefined'))).toBeNull();
  });

  it('never forwards the driver text verbatim', () => {
    const named = describeInfrastructureFailure(
      pgError('ECONNREFUSED', 'connect ECONNREFUSED postgresql://postgres:hunter2@host:6543/db'),
    );
    expect(named).not.toContain('hunter2');
  });
});

describe('probing the project', () => {
  const url = 'https://abcdefgh.supabase.co';

  it('reads a gateway rejection as a bad key', async () => {
    const fake = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }),
    );
    const probe = await probeSupabase(url, 'wrong', fake as unknown as typeof fetch);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/rejected the key outright/);
  });

  it('reads a missing-session 401 as the key being fine', async () => {
    // The key got past the gateway; only the absent user token was objected
    // to. Same status code, opposite diagnosis.
    const fake = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 401, msg: 'invalid claim: missing sub claim' }), {
        status: 401,
      }),
    );
    const probe = await probeSupabase(url, 'right', fake as unknown as typeof fetch);
    expect(probe.ok).toBe(true);
  });

  it('names the host it could not reach', async () => {
    const fake = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const probe = await probeSupabase(url, 'right', fake as unknown as typeof fetch);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain(url);
  });
});

describe('the health report', () => {
  const env = {
    SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_ANON_KEY: anonFor('abcdefgh'),
    OWNER_USER_ID: OWNER,
    DATABASE_URL: 'postgresql://u:p@host:6543/postgres?sslmode=require',
    MARKET_DATA_API_KEY: 'a-key',
  } as NodeJS.ProcessEnv;

  const accepts = () =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401 }), { status: 401 }));

  // The real probe opens a connection using process.env, which these tests
  // deliberately do not control. What it reports is covered by its own tests.
  const dbOk = async () => [
    { name: 'database', ok: true, detail: 'connected' },
    { name: 'ledger schema', ok: true, detail: 'installed' },
  ];

  it('does not probe the network when the URL is malformed', async () => {
    const fake = vi.fn();
    const report = await healthReport(
      {},
      { ...env, SUPABASE_URL: 'db.abcdefgh.supabase.co' },
      fake as unknown as typeof fetch,
      dbOk,
    );
    expect(fake).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
  });

  it('passes a sound configuration, and says the bundle is next to suspect', async () => {
    const report = await healthReport({}, env, accepts() as unknown as typeof fetch, dbOk);
    expect(report.ok).toBe(true);
    expect(report.advice.join(' ')).toMatch(/build time/);
  });

  it('names both anon-key variables when the server one is wrong', async () => {
    // Fixing VITE_SUPABASE_ANON_KEY and not SUPABASE_ANON_KEY produces a
    // report identical to fixing neither, and this endpoint can only see the
    // second. Saying so is the difference between one round trip and three.
    const report = await healthReport(
      {},
      { ...env, SUPABASE_ANON_KEY: 'sb_secret_nope' },
      accepts() as unknown as typeof fetch,
      dbOk,
    );
    expect(report.advice.join(' ')).toMatch(/VITE_SUPABASE_ANON_KEY/);
  });

  it('says nothing about a caller who presented no token', async () => {
    const report = await healthReport({}, env, accepts() as unknown as typeof fetch, dbOk);
    expect(report.checks.map((c) => c.name)).not.toContain('your session');
  });

  it('tells the owner they are the owner', async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401 }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: OWNER }), { status: 200 }));
    const report = await healthReport(
      { authorization: 'Bearer token' },
      env,
      fake as unknown as typeof fetch,
      dbOk,
    );
    expect(report.checks.find((c) => c.name === 'your session')).toMatchObject({ ok: true });
  });

  it('separates a valid session from the wrong account', async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401 }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: SOMEBODY_ELSE }), {
          status: 200,
        }),
      );
    const report = await healthReport(
      { authorization: 'Bearer token' },
      env,
      fake as unknown as typeof fetch,
      dbOk,
    );
    const session = report.checks.find((c) => c.name === 'your session');
    expect(session?.ok).toBe(false);
    expect(session?.detail).toMatch(/not the owner/);
    // The other user's id is not this caller's business.
    expect(JSON.stringify(report)).not.toContain(SOMEBODY_ELSE);
  });
});

describe('TLS to the database', () => {
  it('pins Supabase\'s CA for Supabase hosts, and only those', () => {
    // Supabase presents a certificate signed by its own root CA. Supplying
    // that CA keeps verification on; the alternative found in most examples,
    // rejectUnauthorized: false, keeps the encryption and drops the identity
    // check — private from eavesdroppers, but not proof against something
    // answering in the database's place.
    expect(
      sslFor('postgresql://postgres.ref:pw@aws-0-eu-central-2.pooler.supabase.com:6543/postgres'),
    ).toMatchObject({ rejectUnauthorized: true });
    expect(sslFor('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')).toMatchObject({
      rejectUnauthorized: true,
    });

    // Another provider keeps pg's own handling: a certificate that has nothing
    // to do with them must not become the only one their host can present.
    expect(sslFor('postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db')).toBeUndefined();
    expect(sslFor('postgres://postgres@localhost:5432/vantage_trades')).toBeUndefined();
  });

  it('is not fooled by a hostname that merely contains supabase.co', () => {
    // The match is anchored to the end of the host. Without that,
    // evil-supabase.co.attacker.net would be handed the pinned CA and, worse,
    // be treated as a host this app expects to be talking to.
    expect(sslFor('postgresql://u:p@evil-supabase.co.attacker.net/db')).toBeUndefined();
    expect(sslFor('postgresql://u:p@supabase.co.example.com/db')).toBeUndefined();
  });

  it('never verifies against an expired certificate without noticing', () => {
    // A root that has quietly expired fails every connection at once, with a
    // message that sounds like a network fault. Asserting the window here
    // means the suite says so first.
    const expiry = new Date('2031-04-26T10:56:53Z');
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the TLS settings that reach the driver', () => {
  const POOLER =
    'postgresql://postgres.abcdefgh:pw@aws-0-eu-central-2.pooler.supabase.com:6543/postgres?sslmode=require';

  /** What pg will really use, after it has merged the connection string. */
  interface Internals {
    ssl: { ca?: string; rejectUnauthorized?: boolean } | boolean;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  }

  // connectionParameters is not in pg's public types, but it is what the
  // driver connects with, and asserting anything less would not have caught
  // the bug this replaces.
  const asClientSees = (url: string): Internals =>
    (new pg.Client(poolConfig(url)) as unknown as { connectionParameters: Internals })
      .connectionParameters;

  it('actually hands the CA to pg', () => {
    // The bug this replaces: pg merges the parsed connection string over the
    // explicit config, so sslmode=require replaced { ca } with {}. TLS still
    // happened and the CA was silently dropped, which fails identically to
    // pinning the wrong CA. Asserting the driver's own view is the only
    // version of this test that would have caught it.
    const ssl = asClientSees(POOLER).ssl;
    expect(typeof ssl).toBe('object');
    expect((ssl as { ca?: string }).ca).toContain('BEGIN CERTIFICATE');
    expect((ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true);
  });

  it('keeps every other part of the connection string intact', () => {
    const params = asClientSees(POOLER);
    expect(params.host).toBe('aws-0-eu-central-2.pooler.supabase.com');
    expect(params.port).toBe(6543);
    expect(params.user).toBe('postgres.abcdefgh');
    expect(params.password).toBe('pw');
    expect(params.database).toBe('postgres');
  });

  it('leaves a non-Supabase provider to pg', () => {
    const neon = 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require';
    expect(poolConfig(neon).ssl).toBeUndefined();
    // And its sslmode is left in the string, since nothing is replacing it.
    expect(poolConfig(neon).connectionString).toContain('sslmode=require');
  });
});
