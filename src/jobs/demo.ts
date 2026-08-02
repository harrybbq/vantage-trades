#!/usr/bin/env node
/**
 * A scripted end-to-end run against the simulated broker.
 *
 *   npm run demo
 *
 * Wipes the ledger and the paper account, then walks through the thing the
 * whole system exists to do: two agents buy the same symbol, the broker shows
 * one position, and the ledger still knows whose is whose. Ends with a
 * reconciliation.
 *
 * Safe to run repeatedly. It refuses to touch a non-local database.
 */

import { getPool, closePool, inTransaction } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import { formatGBP, formatQty, parseMoney, parseQty } from '../money.js';
import { createAgent } from '../ledger/agents.js';
import { recordDeposit, allocate } from '../ledger/allocation.js';
import { start, halt, previewKill } from '../ledger/control.js';
import { agentEquity, unallocatedPool } from '../ledger/equity.js';
import { submitOrder } from '../pipeline/submit.js';
import { syncFills, syncMarks } from '../pipeline/sync.js';
import { runDailyReconcile } from './daily-reconcile.js';

function assertLocal(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`demo wipes data and refuses to run against ${url || '(unset DATABASE_URL)'}`);
  }
}

async function wipe(): Promise<void> {
  await getPool().query(`
    truncate ledger.postings, ledger.journal_entries, ledger.position_lots, ledger.fills,
             ledger.orders, ledger.accounts, ledger.agent_control_events,
             ledger.reconciliations, ledger.marks, ledger.agents
    restart identity cascade
  `);
  await getPool().query(
    `truncate paper.fills, paper.orders, paper.positions, paper.market_prices restart identity cascade`,
  );
  await getPool().query(`update paper.account set cash_minor = 0`);
}

function heading(text: string): void {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`);
}

async function showPanel(broker: PaperBroker): Promise<void> {
  const account = await broker.getAccount();
  const positions = await broker.getPositions();

  heading('WHAT THE BROKER SEES');
  console.log(`cash    ${formatGBP(account.cashMinor)}`);
  console.log(`equity  ${formatGBP(account.equityMinor)}`);
  for (const p of positions) {
    console.log(`        ${p.symbol} ${formatQty(p.qty)}   <- one position, no idea whose`);
  }

  heading('WHAT THE CONTROL PANEL SEES');
  await inTransaction(async (tx) => {
    console.log(`unallocated pool  ${formatGBP(await unallocatedPool(tx))}\n`);
    for (const id of ['momentum-1', 'value-1']) {
      const e = await agentEquity(tx, id);
      console.log(`${id}  [${e.status}]`);
      console.log(`  cash       ${formatGBP(e.cashMinor)}`);
      console.log(`  equity     ${e.equityMinor === null ? 'unknown (no mark)' : formatGBP(e.equityMinor)}`);
      console.log(`  realised   ${formatGBP(e.realisedMinor)}`);
      console.log(`  fees       ${formatGBP(e.feesMinor)}`);
      for (const h of e.holdings) {
        console.log(
          `  holds      ${h.symbol} ${formatQty(h.qty)} @ cost ${formatGBP(h.costBasisMinor)}` +
            `  now worth ${h.marketValueMinor === null ? '?' : formatGBP(h.marketValueMinor)}`,
        );
      }
      console.log();
    }
  });
}

async function main(): Promise<void> {
  assertLocal();
  await wipe();

  const broker = new PaperBroker(getPool());

  heading('1. FUND THE ACCOUNT');
  // Two separate acts: cash physically arriving, and the ledger being told.
  // A real broker API cannot do the first — that is a manual bank transfer.
  await broker.fundAccount(parseMoney('5000.00'));
  await inTransaction((tx) => recordDeposit(tx, parseMoney('5000.00'), new Date(), 'demo-transfer'));
  console.log('£5000.00 transferred in, and recorded in the ledger');

  heading('2. CREATE TWO AGENTS AND ALLOCATE CAPITAL');
  await inTransaction(async (tx) => {
    for (const [id, name, amount] of [
      ['momentum-1', 'Momentum', '2000.00'],
      ['value-1', 'Value', '1500.00'],
    ] as const) {
      await createAgent(tx, { id, name });
      await allocate(tx, id, parseMoney(amount));
      await start(tx, id, 'owner');
      console.log(`${id}: allocated ${formatGBP(parseMoney(amount))}, started`);
    }
  });
  console.log('allocation moved no real money - it is a budget cap, not a transfer');

  heading('3. BOTH AGENTS BUY THE SAME SYMBOL, AT DIFFERENT PRICES');
  await broker.setPrice('AAPL', parseMoney('100.00'));
  await submitOrder(broker, {
    agentId: 'momentum-1',
    symbol: 'AAPL',
    side: 'buy',
    qty: parseQty('4'),
    idempotencyKey: `demo-m-${Date.now()}`,
  });
  console.log('momentum-1 bought 4 AAPL around £100.00');

  await broker.setPrice('AAPL', parseMoney('80.00'));
  await submitOrder(broker, {
    agentId: 'value-1',
    symbol: 'AAPL',
    side: 'buy',
    qty: parseQty('5'),
    idempotencyKey: `demo-v-${Date.now()}`,
  });
  console.log('value-1 bought 5 AAPL around £80.00');

  const synced = await syncFills(broker);
  console.log(`\nsynced ${synced.recorded} fill(s) from the broker, each attributed to its agent`);

  await broker.setPrice('AAPL', parseMoney('110.00'));
  await syncMarks(broker);
  console.log('AAPL now marked at £110.00');

  await showPanel(broker);
  console.log('Same symbol, same price, different P/L. That difference is the point.');

  heading('4. HALT ONE AGENT');
  await inTransaction((tx) => halt(tx, 'momentum-1', 'owner', 'demo'));
  console.log('momentum-1 halted - it keeps its AAPL and keeps its capital');
  try {
    await submitOrder(broker, {
      agentId: 'momentum-1',
      symbol: 'AAPL',
      side: 'buy',
      qty: parseQty('1'),
      idempotencyKey: `demo-blocked-${Date.now()}`,
    });
    console.log('!! an order got through, which should be impossible');
  } catch (error) {
    console.log(`order refused: ${(error as Error).message.split('\n')[0]}`);
  }

  heading('5. WHAT KILLING AN AGENT WOULD DO');
  const preview = await inTransaction((tx) => previewKill(tx, 'value-1'));
  console.log(preview.summary);

  heading('6. RECONCILE');
  const clean = await runDailyReconcile(broker);
  console.log(`\n${clean ? 'CLEAN - the ledger agrees with the broker.' : 'DIVERGED - see above.'}`);
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
