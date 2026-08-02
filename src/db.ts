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

// node-postgres hands back int8 as a string by default to avoid precision loss.
// We want bigint, and we want it everywhere, so it is set once here rather than
// left to each caller to remember.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => BigInt(value));

export type Sql = pg.PoolClient | pg.Pool;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({ connectionString, max: 8 });
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
