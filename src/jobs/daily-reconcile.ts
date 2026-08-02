#!/usr/bin/env node
/**
 * The daily reconciliation job. Mandatory, not a nice-to-have.
 *
 * Run it on a schedule and read what it says. Its whole value is that a
 * divergence surfaces the day it happens rather than three months later, by
 * which point reconstructing what went wrong is close to impossible.
 *
 *   npm run job:reconcile
 *
 * Exit code is 1 on divergence, so a scheduler or CI step fails loudly rather
 * than logging into the void.
 */

import { closePool } from '../db.js';
import { inTransaction, getPool } from '../db.js';
import { PaperBroker } from '../broker/paper.js';
import type { BrokerAdapter } from '../broker/types.js';
import { reconcile } from '../ledger/reconcile.js';
import { syncFills, syncMarks } from '../pipeline/sync.js';
import { findOrphanedOrders } from '../pipeline/submit.js';

export async function runDailyReconcile(broker: BrokerAdapter): Promise<boolean> {
  // Order matters: pull fills before valuing anything, or the ledger is
  // reconciled against positions it has not heard about yet.
  const fills = await syncFills(broker);
  console.log(
    `fills: ${fills.recorded} recorded, ${fills.alreadyKnown} already known, ` +
      `${fills.unattributable.length} unattributable`,
  );

  for (const orphan of fills.unattributable) {
    console.error(
      `UNATTRIBUTABLE FILL ${orphan.brokerFillId} (${orphan.symbol}, broker order ` +
        `${orphan.brokerOrderId}) - no matching order in the ledger. Do not guess whose it is.`,
    );
  }

  const orphanedOrders = await findOrphanedOrders();
  for (const order of orphanedOrders) {
    console.error(
      `ORDER ${order.orderId} (${order.agentId}, ${order.symbol}) never got a broker id. ` +
        `Ask the broker about idempotency key ${order.idempotencyKey} before re-submitting.`,
    );
  }

  const quotes = await syncMarks(broker);
  console.log(`marks: ${quotes} symbol(s) priced`);

  const account = await broker.getAccount();
  const positions = await broker.getPositions();

  const result = await inTransaction((tx) =>
    reconcile(tx, {
      asOf: account.asOf,
      cashMinor: account.cashMinor,
      equityMinor: account.equityMinor,
      positions,
    }),
  );

  console.log(result.summary);

  const clean =
    result.status === 'ok' && fills.unattributable.length === 0 && orphanedOrders.length === 0;
  return clean;
}

// Only runs when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  const broker = new PaperBroker(getPool());
  runDailyReconcile(broker)
    .then(async (clean) => {
      await closePool();
      process.exit(clean ? 0 : 1);
    })
    .catch(async (error: unknown) => {
      console.error('reconciliation failed to run:', error);
      await closePool();
      process.exit(1);
    });
}
