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
  probeSupabase,
  projectRefFromUrl,
  serverConfigReport,
  webConfigReport,
  type Env,
} from '../src/server/config.js';
import { healthReport } from '../src/server/health.js';

/** A Supabase-shaped JWT. The signature is never checked here — only claims. */
const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'not-a-real-signature',
  ].join('.');

const anonFor = (ref: string) => jwt({ iss: 'supabase', ref, role: 'anon' });
const serviceFor = (ref: string) => jwt({ iss: 'supabase', ref, role: 'service_role' });

const OWNER = 'fa3bc586-6533-4248-a107-b6f53521cf73';

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
  } as NodeJS.ProcessEnv;

  const accepts = () =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401 }), { status: 401 }));

  it('does not probe the network when the URL is malformed', async () => {
    const fake = vi.fn();
    const report = await healthReport(
      {},
      { ...env, SUPABASE_URL: 'db.abcdefgh.supabase.co' },
      fake as unknown as typeof fetch,
    );
    expect(fake).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
  });

  it('passes a sound configuration, and says the bundle is next to suspect', async () => {
    const report = await healthReport({}, env, accepts() as unknown as typeof fetch);
    expect(report.ok).toBe(true);
    expect(report.advice.join(' ')).toMatch(/build time/);
  });

  it('says nothing about a caller who presented no token', async () => {
    const report = await healthReport({}, env, accepts() as unknown as typeof fetch);
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
    );
    expect(report.checks.find((c) => c.name === 'your session')).toMatchObject({ ok: true });
  });

  it('separates a valid session from the wrong account', async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401 }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }), {
          status: 200,
        }),
      );
    const report = await healthReport(
      { authorization: 'Bearer token' },
      env,
      fake as unknown as typeof fetch,
    );
    const session = report.checks.find((c) => c.name === 'your session');
    expect(session?.ok).toBe(false);
    expect(session?.detail).toMatch(/not the owner/);
    // The other user's id is not this caller's business.
    expect(JSON.stringify(report)).not.toContain('00000000-0000-4000-8000-000000000000');
  });
});
