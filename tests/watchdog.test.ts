/**
 * The things that say "stop trusting this": a check that has not run, a
 * deployment pointed at a broker that does not exist, a check that crashed.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { closePool, getPool } from '../src/db.js';
import { expectedReconcileBy } from '../src/api/view.js';
import { tradingBroker, NoLiveBrokerError } from '../src/broker/select.js';
import { runDailyReconcile } from '../src/jobs/daily-reconcile.js';
import type { BrokerAdapter } from '../src/broker/types.js';
import { resetData } from './helpers.js';

afterEach(() => {
  delete process.env['BROKER'];
});
afterAll(closePool);

describe('knowing when the nightly check is overdue', () => {
  it("expects Thursday night's run by Friday morning", () => {
    expect(expectedReconcileBy(new Date('2026-10-02T09:00:00Z')).toISOString()).toBe('2026-10-01T22:37:00.000Z');
  });

  it('gives a running check two hours before calling it missing', () => {
    expect(expectedReconcileBy(new Date('2026-10-01T23:00:00Z')).toISOString()).toBe('2026-09-30T22:37:00.000Z');
    expect(expectedReconcileBy(new Date('2026-10-02T01:00:00Z')).toISOString()).toBe('2026-10-01T22:37:00.000Z');
  });

  it('carries Friday night through the weekend', () => {
    expect(expectedReconcileBy(new Date('2026-10-04T12:00:00Z')).toISOString()).toBe('2026-10-02T22:37:00.000Z');
    expect(expectedReconcileBy(new Date('2026-10-05T20:00:00Z')).toISOString()).toBe('2026-10-02T22:37:00.000Z');
  });
});

describe('BROKER=live with no live adapter', () => {
  it('refuses outright rather than quietly trading the simulator', () => {
    process.env['BROKER'] = 'live';
    expect(() => tradingBroker()).toThrow(NoLiveBrokerError);
  });

  it('uses the simulator otherwise', () => {
    expect(tradingBroker().name).toBe('paper');
  });
});

describe('a reconciliation that crashes', () => {
  it('leaves an error as the newest result, so the panel stops saying "clean"', async () => {
    await resetData();
    const exploding = {
      name: 'paper',
      getFills: async () => {
        throw new Error('broker unreachable');
      },
    } as unknown as BrokerAdapter;

    await expect(runDailyReconcile(exploding)).rejects.toThrow(/broker unreachable/);
    const last = await getPool().query<{ status: string; detail: { summary: string } }>(
      `select status, detail from ledger.reconciliations order by run_at desc limit 1`,
    );
    expect(last.rows[0]?.status).toBe('error');
    expect(last.rows[0]?.detail.summary).toMatch(/could not run: broker unreachable/);
  });
});
