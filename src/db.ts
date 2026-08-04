/**
 * Database access for the ledger.
 *
 * Everything that writes money goes through `inTransaction`. Posting an entry
 * without its balancing postings in the same transaction would leave the
 * ledger unbalanced, and the deferred constraint triggers only fire at commit,
 * so the transaction boundary is part of the safety model rather than a
 * performance detail.
 */

import pg from 'pg';
import { SUPABASE_ROOT_CA } from './supabase-ca.js';

// node-postgres hands back int8 as a string by default to avoid precision loss.
// We want bigint, and we want it everywhere, so it is set once here rather than
// left to each caller to remember.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => BigInt(value));

export type Sql = pg.PoolClient | pg.Pool;

let pool: pg.Pool | undefined;

const isLocal = (url: string): boolean => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

/** Serverless runtimes give each invocation its own process. */
const isServerless = (): boolean =>
  Boolean(
    process.env['NETLIFY'] ??
      process.env['AWS_LAMBDA_FUNCTION_NAME'] ??
      process.env['LAMBDA_TASK_ROOT'],
  );

/**
 * The ledger's connection string.
 *
 * `DATABASE_URL` wins when set. `NETLIFY_DATABASE_URL` is the fallback:
 * Netlify DB injects it automatically, and requiring it to be copied into a
 * second variable by hand is a step that will eventually be done wrong — or
 * left stale after the database is re-provisioned and the injected value
 * changes underneath it.
 */
export function resolveConnectionString(): string {
  const explicit = process.env['DATABASE_URL'];
  if (explicit) return explicit;

  const netlify = process.env['NETLIFY_DATABASE_URL'];
  if (netlify) return netlify;

  throw new Error(
    'no database configured: set DATABASE_URL, or add Netlify DB which provides ' +
      'NETLIFY_DATABASE_URL automatically',
  );
}

/** Supabase's own hosts — the database, the pooler, and nothing else. */
const SUPABASE_HOST = /(^|\.)supabase\.(co|com)$/i;

/**
 * TLS settings for a Supabase connection, or undefined to leave it to pg.
 *
 * Postgres at Supabase presents a certificate signed by Supabase's own root
 * CA, which Node does not trust, so `sslmode=require` alone fails with
 * "self-signed certificate in certificate chain". The usual fix found in
 * examples is `rejectUnauthorized: false`, which keeps the encryption and
 * throws away the identity check — the connection is then private from
 * eavesdroppers but not proof against something answering in the database's
 * place. For a link carrying a brokerage ledger, that is the wrong trade when
 * the alternative is shipping one public certificate.
 *
 * So the CA is supplied and verification stays on, including the hostname
 * check. Only for Supabase hosts: anything else keeps pg's own handling, so a
 * different provider is unaffected by a certificate that has nothing to do
 * with it.
 */
export function sslFor(url: string): { ca: string; rejectUnauthorized: true } | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!SUPABASE_HOST.test(host)) return undefined;

  return { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const url = resolveConnectionString();

    // A ledger connection must not cross the internet in plaintext. Anything
    // that is not loopback has to declare SSL, and rather than quietly adding
    // it, this refuses — silently "fixing" a connection string is how you end
    // up unsure whether a given deploy was encrypted.
    if (!isLocal(url) && !/sslmode=(require|verify-ca|verify-full)/.test(url)) {
      throw new Error(
        'a remote database URL must specify sslmode=require (or stronger). ' +
          'Netlify DB and Neon include it already; for Supabase, use the connection ' +
          'pooler URI and append ?sslmode=require',
      );
    }

    pool = new pg.Pool({
      connectionString: url,
      // Supplied explicitly, and only for Supabase hosts. See sslFor().
      ...(sslFor(url) ? { ssl: sslFor(url) } : {}),
      // One connection per invocation in serverless: each cold start gets its
      // own process, so a large pool multiplies by the number of concurrent
      // invocations and exhausts the database's connection limit.
      max: isServerless() ? 1 : 8,
      idleTimeoutMillis: isServerless() ? 1_000 : 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Run `fn` inside a transaction, rolling back on any error.
 *
 * The rollback matters more than usual here: a half-applied fill leaves a
 * position the ledger does not know about, which is the failure mode that is
 * hardest to notice and hardest to reconstruct afterwards.
 */
export async function inTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {
      /* the original error is the one worth surfacing */
    });
    throw error;
  } finally {
    client.release();
  }
}
