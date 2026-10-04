/**
 * The broker every job and control talks to.
 *
 * One place, so `BROKER=live` cannot half-apply. Before this, the panel's
 * deposits honoured the setting while the agent loop, the reconciliation and
 * Kill quietly went on using the simulator — a deployment that believed it
 * was live while trading against a pretend account, and reconciling a real
 * one against it.
 *
 * There is no live adapter yet, so asking for one refuses outright. Nothing
 * trades and nothing reconciles until there is one: a stopped job is visible,
 * a job pointed at the wrong account is not.
 */

import { getPool } from '../db.js';
import type { BrokerAdapter } from './types.js';
import { PaperBroker } from './paper.js';
import { brokerKind } from './config.js';

export class NoLiveBrokerError extends Error {
  constructor() {
    super(
      'BROKER=live is set, but there is no live broker adapter yet. Nothing will trade, ' +
        'reconcile or be killed until there is one. Remove BROKER to go back to paper.',
    );
  }
}

export function tradingBroker(): BrokerAdapter {
  if (brokerKind() === 'live') throw new NoLiveBrokerError();
  return new PaperBroker(getPool());
}
