/**
 * Recording cash must leave the ledger and the broker agreeing.
 *
 * This is the first thing anybody does with the app, and it used to be the
 * thing that broke reconciliation. The ledger recorded the deposit; nothing
 * told the paper broker; the daily job then reported a divergence exactly
 * equal to every deposit ever made.
 *
 * That is worse than a missing feature. The divergence alarm is the one signal
 * in this system that says "every number downstream is now fiction", and an
 * alarm that fires on day one over the app's own wiring is an alarm that gets
 * ignored by the time it means something.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closePool, getPool } from '../src/db.js';
import { doRecordDeposit, doRecordWithdrawal, ValidationError } from '../src/api/actions.js';
import { runDailyReconcile } from '../src/jobs/daily-reconcile.js';
import { PaperBroker } from '../src/broker/paper.js';
import { usingPaperBroker, brokerKind } from '../src/broker/config.js';
import { resetData } from './helpers.js';

beforeEach(async () => {
  await resetData();
  await getPool().query(`update paper.account set cash_minor = 0`);
});
afterAll(closePool);

const reconcile = () => runDailyReconcile(new PaperBroker(getPool()));

const paperCash = async (): Promise<bigint> => {
  const result = await getPool().query<{ cash_minor: bigint }>(
    `select cash_minor from paper.account`,
  );
  return result.rows[0]?.cash_minor ?? 0n;
};

describe('recording a bank transfer', () => {
  it('reconciles clean immediately afterwards', async () => {
    await doRecordDeposit({ amount: '5000.00', reference: 'first-transfer' }, 'owner');

    // The whole point: no agents, no trades, just money in — and the ledger
    // and the broker still agree.
    expect(await reconcile()).toBe(true);
  });

  it('tells the simulator the cash arrived', async () => {
    await doRecordDeposit({ amount: '5000.00', reference: 'first-transfer' }, 'owner');
    expect(await paperCash()).toBe(500_000n);
  });

  it('still reconciles after money goes back out', async () => {
    await doRecordDeposit({ amount: '5000.00', reference: 'cash-in' }, 'owner');
    await doRecordWithdrawal({ amount: '2000.00', reference: 'cash-out' }, 'owner');

    expect(await paperCash()).toBe(300_000n);
    expect(await reconcile()).toBe(true);
  });

  it('refuses a withdrawal the brokerage account cannot cover', async () => {
    await doRecordDeposit({ amount: '1000.00', reference: 'cash-in' }, 'owner');

    await expect(
      doRecordWithdrawal({ amount: '5000.00', reference: 'too-much' }, 'owner'),
    ).rejects.toThrow();

    // And the refusal left nothing half-applied.
    expect(await paperCash()).toBe(100_000n);
    expect(await reconcile()).toBe(true);
  });

  it('refuses the same transfer twice rather than doubling the pool', async () => {
    await doRecordDeposit({ amount: '5000.00', reference: 'same-ref' }, 'owner');
    await expect(
      doRecordDeposit({ amount: '5000.00', reference: 'same-ref' }, 'owner'),
    ).rejects.toThrow();

    // The rejected attempt must not have credited the simulator either — the
    // two writes share a transaction precisely so this cannot drift apart.
    expect(await paperCash()).toBe(500_000n);
    expect(await reconcile()).toBe(true);
  });
});

describe('which broker this deployment thinks it is talking to', () => {
  it('is paper unless something explicitly says live', () => {
    // A default that has to be remembered is not a default. Live money is the
    // last step in the build order, so it is the one that has to be asked for.
    expect(brokerKind()).toBe('paper');
    expect(usingPaperBroker()).toBe(true);
  });

  it('never touches the simulator once a real broker is configured', async () => {
    const was = process.env['BROKER'];
    process.env['BROKER'] = 'live';

    try {
      await doRecordDeposit({ amount: '5000.00', reference: 'real-money' }, 'owner');
      // Against a real broker the cash moved at the bank and the broker
      // already knows. Crediting a simulator would be inventing money.
      expect(await paperCash()).toBe(0n);
    } finally {
      if (was === undefined) delete process.env['BROKER'];
      else process.env['BROKER'] = was;
    }
  });
});

describe('validation still applies', () => {
  it('requires a bank reference', async () => {
    await expect(doRecordDeposit({ amount: '100.00', reference: 'x' }, 'owner')).rejects.toThrow(
      ValidationError,
    );
  });
});
