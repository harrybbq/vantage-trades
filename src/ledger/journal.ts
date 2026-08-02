import type { Sql } from '../db.js';
import type { Minor } from '../money.js';

export type EntryKind =
  | 'deposit'
  | 'withdrawal'
  | 'allocation'
  | 'deallocation'
  | 'buy'
  | 'sell'
  | 'fee'
  | 'adjustment';

export interface Posting {
  accountId: string;
  /** Signed minor units. Positive increases the account. */
  amountMinor: Minor;
}

export interface EntryInput {
  kind: EntryKind;
  occurredAt: Date;
  postings: readonly Posting[];
  memo?: string;
  /**
   * Identifier from whatever caused this entry outside the system — a broker
   * fill id, a bank reference. Unique in the schema, so replaying a webhook or
   * re-polling a broker endpoint cannot post the same movement twice.
   */
  externalRef?: string;
}

/**
 * Post one balanced journal entry.
 *
 * The balance check is asserted here for a clear error message, and again by a
 * deferred constraint trigger at commit. The database check is the one that
 * counts — this one is a courtesy, since it can be bypassed by any code path
 * that writes postings directly.
 */
export async function postEntry(tx: Sql, entry: EntryInput): Promise<string> {
  if (entry.postings.length < 2) {
    throw new Error(`double-entry needs at least 2 postings, got ${entry.postings.length}`);
  }

  const sum = entry.postings.reduce((acc, p) => acc + p.amountMinor, 0n);
  if (sum !== 0n) {
    throw new Error(`entry does not balance: postings sum to ${sum} minor units`);
  }

  if (entry.postings.some((p) => p.amountMinor === 0n)) {
    throw new Error('a zero-amount posting carries no information; omit it');
  }

  const created = await tx.query<{ id: string }>(
    `insert into ledger.journal_entries (kind, occurred_at, memo, external_ref)
     values ($1, $2, $3, $4)
     returning id`,
    [entry.kind, entry.occurredAt, entry.memo ?? null, entry.externalRef ?? null],
  );
  const row = created.rows[0];
  if (!row) throw new Error('failed to create journal entry');

  for (const posting of entry.postings) {
    await tx.query(
      `insert into ledger.postings (entry_id, account_id, amount_minor) values ($1, $2, $3)`,
      [row.id, posting.accountId, posting.amountMinor.toString()],
    );
  }

  return row.id;
}
