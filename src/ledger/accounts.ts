import type { Sql } from '../db.js';

export type AccountKind =
  | 'pool'
  | 'agent_cash'
  | 'agent_positions'
  | 'agent_realised'
  | 'agent_fees'
  | 'external';

const AGENT_KINDS = new Set<AccountKind>([
  'agent_cash',
  'agent_positions',
  'agent_realised',
  'agent_fees',
]);

export function baseCurrency(): string {
  return process.env['LEDGER_BASE_CURRENCY'] ?? 'GBP';
}

/**
 * Resolve an account id, creating the account if it does not exist yet.
 *
 * Accounts are created on demand rather than up front so that adding an agent
 * is one insert. The unique indexes in the schema mean a race just resolves to
 * the same row instead of producing a second pool account.
 */
export async function accountId(
  tx: Sql,
  kind: AccountKind,
  agentId: string | null = null,
  currency = baseCurrency(),
): Promise<string> {
  const needsAgent = AGENT_KINDS.has(kind);
  if (needsAgent && agentId === null) {
    throw new Error(`account kind ${kind} requires an agent id`);
  }
  if (!needsAgent && agentId !== null) {
    throw new Error(`account kind ${kind} must not name an agent`);
  }

  const existing = await tx.query<{ id: string }>(
    `select id from ledger.accounts
      where kind = $1 and currency = $2 and agent_id is not distinct from $3`,
    [kind, currency, agentId],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const inserted = await tx.query<{ id: string }>(
    `insert into ledger.accounts (kind, agent_id, currency)
     values ($1, $2, $3)
     on conflict do nothing
     returning id`,
    [kind, agentId, currency],
  );
  const created = inserted.rows[0];
  if (created) return created.id;

  // Lost an insert race: the row now exists, so read it back.
  const reread = await tx.query<{ id: string }>(
    `select id from ledger.accounts
      where kind = $1 and currency = $2 and agent_id is not distinct from $3`,
    [kind, currency, agentId],
  );
  const row = reread.rows[0];
  if (!row) throw new Error(`could not resolve account ${kind}/${agentId ?? 'global'}`);
  return row.id;
}

export async function balance(tx: Sql, id: string): Promise<bigint> {
  const result = await tx.query<{ balance_minor: bigint }>(
    `select coalesce(sum(amount_minor), 0)::bigint as balance_minor
       from ledger.postings where account_id = $1`,
    [id],
  );
  return result.rows[0]?.balance_minor ?? 0n;
}
