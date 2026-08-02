/**
 * The HTTP layer.
 *
 * Every route here can move money, so the two things that matter are that
 * unauthenticated requests get nothing, and that a response can actually be
 * serialised — a handler that throws while encoding is a control that does not
 * work, and "halt" not working is the whole risk this system is built around.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { inTransaction, closePool, getPool } from '../src/db.js';
import { handle, serialise, type ApiResponse } from '../src/server/handler.js';
import { parseMoney } from '../src/money.js';
import { recordDeposit, allocate } from '../src/ledger/allocation.js';
import { start } from '../src/ledger/control.js';
import { resetData, newAgent, trade, setMark } from './helpers.js';

const AUTHED = { authorization: 'Bearer irrelevant-in-local-mode' };

beforeAll(() => {
  process.env['AUTH_MODE'] = 'insecure-local';
});
beforeEach(resetData);
afterAll(closePool);

const get = () => handle({ method: 'GET', path: '/', headers: AUTHED, body: null });

const post = (body: Record<string, unknown>): Promise<ApiResponse> =>
  handle({ method: 'POST', path: '/', headers: AUTHED, body });

async function seed(): Promise<void> {
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('5000.00'), new Date(), 'api-test-deposit');
    await newAgent(tx, 'momentum-1', 'Momentum');
    await allocate(tx, 'momentum-1', parseMoney('2000.00'));
    await start(tx, 'momentum-1', 'owner');
    await trade(tx, 'momentum-1', 'buy', 'AAPL', '4', '100.00');
    // Without a mark the holding is unpriced and equity is legitimately
    // unknown, which is its own test further down.
    await setMark(tx, 'AAPL', '110.00');
  });
}

describe('authentication', () => {
  it('refuses everything when no auth mode is configured', async () => {
    delete process.env['AUTH_MODE'];
    const before = process.env['SUPABASE_URL'];
    delete process.env['SUPABASE_URL'];

    const result = await handle({ method: 'GET', path: '/', headers: {}, body: null });
    expect(result.status).toBe(401);

    process.env['AUTH_MODE'] = 'insecure-local';
    if (before) process.env['SUPABASE_URL'] = before;
  });

  it('does not say why it refused', async () => {
    delete process.env['AUTH_MODE'];
    const result = await handle({ method: 'GET', path: '/', headers: {}, body: null });
    // Distinguishing "no token" from "not the owner" tells an attacker which
    // half of the problem to work on.
    expect(result.body).toEqual({ error: 'not authorised' });
    process.env['AUTH_MODE'] = 'insecure-local';
  });

  it('refuses to run the local bypass in production', async () => {
    process.env['NODE_ENV'] = 'production';
    const result = await handle({ method: 'GET', path: '/', headers: AUTHED, body: null });
    expect(result.status).toBe(500);
    delete process.env['NODE_ENV'];
  });

  it('refuses the local bypass on a hosted platform, whatever NODE_ENV says', async () => {
    // The natural reaction to a deployed panel returning 401 is to try
    // AUTH_MODE=insecure-local. Netlify does not reliably set NODE_ENV at
    // function runtime, so that alone would have put halt, kill and allocate
    // on the public internet.
    for (const marker of ['NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME', 'LAMBDA_TASK_ROOT', 'VERCEL']) {
      process.env[marker] = 'true';

      const result = await handle({ method: 'GET', path: '/', headers: AUTHED, body: null });
      expect(result.status).toBe(500);
      expect((result.body as { error: string }).error).toMatch(/must never be set on a deployed site/);

      delete process.env[marker];
    }

    // And with no marker present it still works locally.
    const local = await handle({ method: 'GET', path: '/', headers: AUTHED, body: null });
    expect(local.status).toBe(200);
  });
});

describe('every response can be serialised', () => {
  it('serialises the panel view', async () => {
    await seed();
    const result = await get();
    expect(result.status).toBe(200);
    expect(() => serialise(result.body)).not.toThrow();
  });

  it('serialises a kill preview', async () => {
    await seed();
    const result = await post({ action: 'previewKill', agentId: 'momentum-1' });

    expect(result.status).toBe(200);
    // This one carried bigints and used to throw while encoding, which took
    // the whole API process down rather than failing one request.
    expect(() => serialise(result.body)).not.toThrow();

    const preview = JSON.parse(serialise(result.body)) as {
      positions: { symbol: string; qty: string }[];
    };
    expect(preview.positions).toEqual([
      { symbol: 'AAPL', qty: '4.00000000', costBasisMinor: '40000' },
    ]);
  });

  it('sends money as strings, never as JSON numbers', async () => {
    await seed();
    const encoded = serialise((await get()).body);
    const parsed = JSON.parse(encoded) as { unallocatedMinor: unknown; agents: unknown[] };

    // A JSON number is an IEEE 754 double. Money that survived being integers
    // through Postgres should not lose that on the last hop.
    expect(typeof parsed.unallocatedMinor).toBe('string');
    expect(typeof (parsed.agents[0] as { equityMinor: unknown }).equityMinor).toBe('string');
  });
});

describe('control actions', () => {
  it('halts and resumes an agent', async () => {
    await seed();

    const halted = await post({ action: 'halt', agentId: 'momentum-1', reason: 'test' });
    expect(halted.status).toBe(200);
    expect((halted.body as { agents: { status: string }[] }).agents[0]?.status).toBe('halted');

    const resumed = await post({ action: 'start', agentId: 'momentum-1' });
    expect((resumed.body as { agents: { status: string }[] }).agents[0]?.status).toBe('running');
  });

  it('refuses a kill that is not confirmed with the agent id', async () => {
    await seed();
    const result = await post({ action: 'kill', agentId: 'momentum-1', confirm: 'yes' });

    // The browser gates this too, but a UI check is decoration.
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/repeating the agent id/);
  });

  it('refuses a kill while the agent still holds something', async () => {
    await seed();
    const result = await post({
      action: 'kill',
      agentId: 'momentum-1',
      confirm: 'momentum-1',
    });

    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/still holds 1 position/);
  });

  it('passes a domain refusal through as 409 with its own message', async () => {
    await seed();
    const result = await post({
      action: 'allocate',
      agentId: 'momentum-1',
      amount: '99999.00',
    });

    // The message is written to be read by the owner, so it survives the trip.
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/pool would go negative/);
  });

  it('rejects an amount that is not an exact decimal string', async () => {
    await seed();

    for (const amount of [500, '500.005', 'lots', '-5.00', null]) {
      const result = await post({ action: 'allocate', agentId: 'momentum-1', amount });
      expect(result.status).toBe(400);
    }
  });

  it('rejects a malformed agent id rather than passing it to the database', async () => {
    for (const agentId of ['', 'Robert; DROP TABLE ledger.agents', 'UPPER', 'x']) {
      const result = await post({ action: 'halt', agentId });
      expect(result.status).toBe(400);
    }
  });

  it('adds and removes universe symbols, reporting when one is still held', async () => {
    await seed();

    const added = await post({ action: 'addSymbol', agentId: 'momentum-1', symbol: 'vwrp' });
    expect((added.body as { agents: { universe: string[] }[] }).agents[0]?.universe).toContain(
      'VWRP',
    );

    const removed = await post({ action: 'removeSymbol', agentId: 'momentum-1', symbol: 'AAPL' });
    expect((removed.body as { stillHeld: boolean }).stillHeld).toBe(true);
  });

  it('records a bank transfer in, so the pool has something to allocate', async () => {
    const result = await post({
      action: 'recordDeposit',
      amount: '2500.00',
      reference: '2026-08-02 faster payment',
    });

    expect(result.status).toBe(200);
    expect((result.body as { unallocatedMinor: string }).unallocatedMinor).toBe('250000');
  });

  it('refuses the same transfer twice rather than doubling the pool', async () => {
    const deposit = {
      action: 'recordDeposit',
      amount: '2500.00',
      reference: 'same-transfer',
    };

    expect((await post(deposit)).status).toBe(200);
    const second = await post(deposit);

    // Recording a transfer is bookkeeping. Doing it twice silently would
    // inflate the pool and every allocation made from it.
    expect(second.status).toBe(409);

    const view = (await get()).body as { unallocatedMinor: string };
    expect(view.unallocatedMinor).toBe('250000');
  });

  it('requires a reference, so an entry can be matched to the real transfer', async () => {
    const result = await post({ action: 'recordDeposit', amount: '100.00', reference: '' });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/reference is required/);
  });

  it('records money out', async () => {
    await post({ action: 'recordDeposit', amount: '2500.00', reference: 'in-1' });
    const result = await post({
      action: 'recordWithdrawal',
      amount: '500.00',
      reference: 'out-1',
    });

    expect((result.body as { unallocatedMinor: string }).unallocatedMinor).toBe('200000');
  });

  it('refuses to withdraw more than the pool holds', async () => {
    await post({ action: 'recordDeposit', amount: '100.00', reference: 'small' });
    const result = await post({
      action: 'recordWithdrawal',
      amount: '500.00',
      reference: 'too-much',
    });

    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/pool would go negative/);
  });

  it('halts everything at once', async () => {
    await seed();
    const result = await post({ action: 'globalHalt', reason: 'kill switch' });
    const agents = (result.body as { agents: { status: string }[] }).agents;
    expect(agents.every((a) => a.status === 'halted')).toBe(true);
  });

  it('rejects an unknown action', async () => {
    const result = await post({ action: 'liquidateEverything' });
    expect(result.status).toBe(400);
  });

  it('rejects a method that is not GET or POST', async () => {
    const result = await handle({ method: 'DELETE', path: '/', headers: AUTHED, body: null });
    expect(result.status).toBe(405);
  });
});

describe('the view', () => {
  it('reports unknown rather than a plausible number when a holding has no mark', async () => {
    await seed();
    await getPool().query(`delete from ledger.marks`);

    const view = (await get()).body as {
      totalEquityMinor: string | null;
      agents: { equityMinor: string | null; unpricedSymbols: string[] }[];
    };

    expect(view.totalEquityMinor).toBeNull();
    expect(view.agents[0]?.equityMinor).toBeNull();
    expect(view.agents[0]?.unpricedSymbols).toEqual(['AAPL']);
  });

  it('reports P/L today as unknown until there is a prior close', async () => {
    await seed();
    const view = (await get()).body as { todayMinor: string | null };
    expect(view.todayMinor).toBeNull();
  });
});
