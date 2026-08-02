/**
 * Capital allocation.
 *
 * Funding is not programmatic: retail broker APIs do not let software deposit
 * or withdraw cash, which is a deliberate fraud boundary. Real money enters and
 * leaves the brokerage account by manual bank transfer, and `recordDeposit`
 * exists to tell the ledger that happened.
 *
 * So "give agent 3 GBP 500" is not banking. It is a budget cap: the cash sits
 * in one brokerage account, and this ledger records how much each agent may
 * deploy. Allocation is instant, reversible, and moves no real money.
 */

import type { Sql } from '../db.js';
import type { Minor } from '../money.js';
import { accountId, balance } from './accounts.js';
import { postEntry } from './journal.js';

/** Tell the ledger that real cash arrived in the brokerage account. */
export async function recordDeposit(
  tx: Sql,
  amountMinor: Minor,
  occurredAt: Date,
  reference: string,
): Promise<string> {
  if (amountMinor <= 0n) throw new Error('a deposit must be positive');

  return postEntry(tx, {
    kind: 'deposit',
    occurredAt,
    externalRef: reference,
    memo: 'manual bank transfer into the brokerage account',
    postings: [
      { accountId: await accountId(tx, 'external'), amountMinor: -amountMinor },
      { accountId: await accountId(tx, 'pool'), amountMinor },
    ],
  });
}

/** Tell the ledger that real cash left the brokerage account. */
export async function recordWithdrawal(
  tx: Sql,
  amountMinor: Minor,
  occurredAt: Date,
  reference: string,
): Promise<string> {
  if (amountMinor <= 0n) throw new Error('a withdrawal must be positive');

  return postEntry(tx, {
    kind: 'withdrawal',
    occurredAt,
    externalRef: reference,
    memo: 'manual bank transfer out of the brokerage account',
    postings: [
      { accountId: await accountId(tx, 'pool'), amountMinor: -amountMinor },
      { accountId: await accountId(tx, 'external'), amountMinor },
    ],
  });
}

/** Raise an agent's budget cap. Pool -> agent cash. Moves no real money. */
export async function allocate(
  tx: Sql,
  agentId: string,
  amountMinor: Minor,
  occurredAt = new Date(),
): Promise<string> {
  if (amountMinor <= 0n) throw new Error('an allocation must be positive');

  return postEntry(tx, {
    kind: 'allocation',
    occurredAt,
    memo: `allocate to ${agentId}`,
    postings: [
      { accountId: await accountId(tx, 'pool'), amountMinor: -amountMinor },
      { accountId: await accountId(tx, 'agent_cash', agentId), amountMinor },
    ],
  });
}

/**
 * Lower an agent's budget cap, returning capital to the pool.
 *
 * Only uninvested cash can be returned this way. Capital that is currently in
 * positions has to be unwound first — the agent sells down to the new cap and
 * the proceeds land in its cash account, which can then be deallocated. This
 * function deliberately does not sell anything: liquidation is `kill`, which
 * is destructive, irreversible, and asks first.
 */
export async function deallocate(
  tx: Sql,
  agentId: string,
  amountMinor: Minor,
  occurredAt = new Date(),
): Promise<string> {
  if (amountMinor <= 0n) throw new Error('a deallocation must be positive');

  const cash = await accountId(tx, 'agent_cash', agentId);
  const available = await balance(tx, cash);
  if (amountMinor > available) {
    throw new Error(
      `agent ${agentId} has ${available} minor units in uninvested cash, cannot return ${amountMinor}. ` +
        'Capital held in positions must be unwound before it can be returned to the pool.',
    );
  }

  return postEntry(tx, {
    kind: 'deallocation',
    occurredAt,
    memo: `return capital from ${agentId} to the pool`,
    postings: [
      { accountId: cash, amountMinor: -amountMinor },
      { accountId: await accountId(tx, 'pool'), amountMinor },
    ],
  });
}
