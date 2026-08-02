/**
 * The read-only feed Vantage pulls.
 *
 * The properties that matter: a report token cannot do anything but read,
 * revocation actually revokes, and the token itself is never recoverable from
 * the database.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { parseMoney } from '../src/money.js';
import {
  mintReportToken,
  revokeReportToken,
  verifyReportToken,
  reportView,
  TOKEN_HEADER,
} from '../src/api/report.js';
import { handleReport } from '../src/server/report-handler.js';
import { handle } from '../src/server/handler.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { resetData, newAgent, trade, setMark } from './helpers.js';

beforeEach(async () => {
  await resetData();
  // TRUNCATE, not DELETE: the table refuses DELETE by design.
  await getPool().query(`truncate ledger.report_tokens`);
});
afterAll(closePool);

async function seed(): Promise<void> {
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'report-dep');
    await newAgent(tx, 'momentum-1', 'Momentum');
    await allocate(tx, 'momentum-1', parseMoney('2000.00'));
    await start(tx, 'momentum-1', 'owner');
    await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
    await setMark(tx, 'AAPL', '110.00');
  });
}

describe('tokens', () => {
  it('is at least 192 bits from a CSPRNG', async () => {
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    // 32 random bytes, base64url. Comfortably past the floor, and from
    // randomBytes rather than Math.random, whose state is recoverable.
    expect(Buffer.from(token, 'base64url').length).toBe(32);
  });

  it('stores only the hash, so the token cannot be read back out', async () => {
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    const rows = await getPool().query<{ token_hash: string }>(
      `select token_hash from ledger.report_tokens`,
    );
    expect(rows.rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));

    // And the plaintext appears nowhere in the row.
    const dump = await getPool().query(`select * from ledger.report_tokens`);
    expect(JSON.stringify(dump.rows)).not.toContain(token);
  });

  it('accepts a valid token and rejects everything else', async () => {
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    expect(await inTransaction((tx) => verifyReportToken(tx, token))).toBe(true);
    expect(await inTransaction((tx) => verifyReportToken(tx, `${token}x`))).toBe(false);
    expect(await inTransaction((tx) => verifyReportToken(tx, undefined))).toBe(false);
    expect(await inTransaction((tx) => verifyReportToken(tx, ''))).toBe(false);
  });

  it('stops working the moment it is revoked', async () => {
    const { id, token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    expect(await inTransaction((tx) => verifyReportToken(tx, token))).toBe(true);

    await inTransaction((tx) => revokeReportToken(tx, id, 'owner'));
    expect(await inTransaction((tx) => verifyReportToken(tx, token))).toBe(false);
  });

  it('cannot be reinstated once revoked', async () => {
    const { id } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    await inTransaction((tx) => revokeReportToken(tx, id, 'owner'));

    // A token that has been revoked may already be somewhere it should not be.
    await expect(
      getPool().query(`update ledger.report_tokens set revoked_at = null where id = $1`, [id]),
    ).rejects.toThrow(/cannot be reinstated/);
  });

  it('keeps a rotated-out token in the record rather than deleting it', async () => {
    const { id } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    await inTransaction((tx) => revokeReportToken(tx, id, 'owner'));

    await expect(getPool().query(`delete from ledger.report_tokens`)).rejects.toThrow(
      /rather than deleting/,
    );
  });

  it('records when a token was last used', async () => {
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    await inTransaction((tx) => verifyReportToken(tx, token));

    const rows = await getPool().query<{ last_used_at: Date | null }>(
      `select last_used_at from ledger.report_tokens`,
    );
    expect(rows.rows[0]?.last_used_at).not.toBeNull();
  });

  it('lets a new token work while the old one is being swapped out', async () => {
    // Rotation without downtime: mint, deploy, then revoke.
    const first = await inTransaction((tx) => mintReportToken(tx, 'old', 'owner'));
    const second = await inTransaction((tx) => mintReportToken(tx, 'new', 'owner'));

    expect(await inTransaction((tx) => verifyReportToken(tx, first.token))).toBe(true);
    expect(await inTransaction((tx) => verifyReportToken(tx, second.token))).toBe(true);

    await inTransaction((tx) => revokeReportToken(tx, first.id, 'owner'));
    expect(await inTransaction((tx) => verifyReportToken(tx, first.token))).toBe(false);
    expect(await inTransaction((tx) => verifyReportToken(tx, second.token))).toBe(true);
  });
});

describe('the endpoint', () => {
  it('refuses without a token', async () => {
    await seed();
    const result = await handleReport({ method: 'GET', headers: {} });
    expect(result.status).toBe(401);
  });

  it('refuses anything that is not a GET', async () => {
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = await handleReport({ method, headers: { [TOKEN_HEADER]: token } });
      // A read endpoint that accepts bodies is one refactor from accepting
      // instructions.
      expect(result.status).toBe(405);
    }
  });

  it('returns the fund and its agents', async () => {
    await seed();
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    const result = await handleReport({ method: 'GET', headers: { [TOKEN_HEADER]: token } });
    expect(result.status).toBe(200);

    const body = result.body as Awaited<ReturnType<typeof reportView>>;
    expect(body.currency).toBe('GBP');
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.name).toBe('Momentum');
    expect(body.agents[0]?.holdings).toEqual([{ symbol: 'AAPL', qty: '4.00000000' }]);
    expect(body.unallocatedMinor).toBe('300000');
  });

  it('sends money as strings, never as JSON numbers', async () => {
    await seed();
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    const result = await handleReport({ method: 'GET', headers: { [TOKEN_HEADER]: token } });

    const parsed = JSON.parse(JSON.stringify(result.body)) as {
      totalEquityMinor: unknown;
      agents: { equityMinor: unknown }[];
    };
    expect(typeof parsed.totalEquityMinor).toBe('string');
    expect(typeof parsed.agents[0]?.equityMinor).toBe('string');
  });

  it('reports unknown equity as null rather than as zero', async () => {
    await seed();
    await getPool().query(`delete from ledger.marks`);
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    const body = (await handleReport({ method: 'GET', headers: { [TOKEN_HEADER]: token } }))
      .body as Awaited<ReturnType<typeof reportView>>;

    expect(body.agents[0]?.equityMinor).toBeNull();
    expect(body.totalEquityMinor).toBeNull();
  });

  it('omits killed agents', async () => {
    await seed();
    await getPool().query(`update ledger.agents set status = 'killed' where id = 'momentum-1'`);
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));

    const body = (await handleReport({ method: 'GET', headers: { [TOKEN_HEADER]: token } }))
      .body as Awaited<ReturnType<typeof reportView>>;
    expect(body.agents).toEqual([]);
  });
});

describe('the report token has no power beyond reading', () => {
  it('cannot reach the control API', async () => {
    delete process.env['AUTH_MODE'];
    const { token } = await inTransaction((tx) => mintReportToken(tx, 'widget', 'owner'));
    await seed();

    // The two handlers are separate on purpose: a caller holding a report
    // token must not be one mistyped case label away from halting an agent.
    for (const body of [
      { action: 'halt', agentId: 'momentum-1' },
      { action: 'globalHalt' },
      { action: 'allocate', agentId: 'momentum-1', amount: '100.00' },
    ]) {
      const result = await handle({
        method: 'POST',
        path: '/',
        headers: { authorization: `Bearer ${token}`, [TOKEN_HEADER]: token },
        body,
      });
      expect(result.status).toBe(401);
    }

    const status = await getPool().query<{ status: string }>(
      `select status from ledger.agents where id = 'momentum-1'`,
    );
    expect(status.rows[0]?.status).toBe('running');

    process.env['AUTH_MODE'] = 'insecure-local';
  });
});
