/**
 * The read-only feed Vantage pulls.
 *
 * One direction, no exceptions. Vantage pulls; this app never pushes, and
 * nothing reachable through this file can place an order, move capital, or
 * change an agent's state. Fully compromised, this token reveals numbers and
 * nothing more.
 *
 * Money crosses as integer strings of minor units, the same as every other
 * boundary here. `CLAUDE.md` sketched this endpoint with JSON numbers
 * (`"equity": 2143.02`); that is a deliberate deviation. A JSON number is an
 * IEEE 754 double and 2143.02 is not exactly representable in one — the whole
 * point of holding the ledger in integers is lost if the last hop is a float.
 * The widget formats pence for display and never does arithmetic on them.
 */

import type { Sql } from '../db.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { allAgentEquities, unallocatedPool } from '../ledger/equity.js';
import { formatQty } from '../money.js';

export interface ReportHolding {
  symbol: string;
  qty: string;
}

export interface ReportAgent {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'halted' | 'killed';
  allocatedMinor: string;
  /** Null when a holding has no price. Unknown must not look like zero. */
  equityMinor: string | null;
  pnlPctSinceStart: number | null;
  pnlPctToday: number | null;
  holdings: ReportHolding[];
}

export interface ReportView {
  asOf: string;
  currency: 'GBP';
  totalEquityMinor: string | null;
  unallocatedMinor: string;
  agents: ReportAgent[];
  /** Set when the ledger last disagreed with the broker. */
  reconciliation: { status: string; asOf: string } | null;
}

export const TOKEN_HEADER = 'x-vantage-token';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Check a presented token against the active ones.
 *
 * Compares hashes with `timingSafeEqual`, so how long the check takes does not
 * leak how much of the token was right. Revoked tokens are excluded by the
 * query rather than filtered afterwards.
 */
export async function verifyReportToken(tx: Sql, presented: string | undefined): Promise<boolean> {
  if (!presented || presented.length < 32) return false;

  const presentedHash = Buffer.from(sha256(presented), 'hex');

  const active = await tx.query<{ id: string; token_hash: string }>(
    `select id, token_hash from ledger.report_tokens where revoked_at is null`,
  );

  for (const row of active.rows) {
    const stored = Buffer.from(row.token_hash, 'hex');
    if (stored.length === presentedHash.length && timingSafeEqual(stored, presentedHash)) {
      await tx.query(`update ledger.report_tokens set last_used_at = now() where id = $1`, [row.id]);
      return true;
    }
  }

  return false;
}

export interface MintedToken {
  id: string;
  /** Shown once. Nothing can retrieve it afterwards. */
  token: string;
}

/**
 * Mint a token.
 *
 * 32 bytes from the CSPRNG — 256 bits, comfortably past the 192-bit floor.
 * Never `Math.random()`: it is not a CSPRNG and its internal state is
 * recoverable from a handful of outputs.
 */
export async function mintReportToken(
  tx: Sql,
  label: string,
  createdBy: string,
): Promise<MintedToken> {
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');

  const result = await tx.query<{ id: string }>(
    `insert into ledger.report_tokens (token_hash, label, created_by)
     values ($1, $2, $3) returning id`,
    [sha256(token), label, createdBy],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to mint token');
  return { id, token };
}

export async function revokeReportToken(
  tx: Sql,
  id: string,
  revokedBy: string,
): Promise<boolean> {
  const result = await tx.query(
    `update ledger.report_tokens
        set revoked_at = now(), revoked_by = $2
      where id = $1 and revoked_at is null`,
    [id, revokedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function reportView(tx: Sql, asOf = new Date()): Promise<ReportView> {
  const equities = await allAgentEquities(tx, asOf);
  const pool = await unallocatedPool(tx);

  const names = await tx.query<{ id: string; name: string }>(`select id, name from ledger.agents`);
  const nameById = new Map(names.rows.map((r) => [r.id, r.name]));

  const allocated = await tx.query<{ agent_id: string; net: bigint }>(
    `select a.agent_id, coalesce(sum(p.amount_minor), 0)::bigint as net
       from ledger.postings p
       join ledger.accounts a on a.id = p.account_id
       join ledger.journal_entries e on e.id = p.entry_id
      where a.kind = 'agent_cash' and e.kind in ('allocation', 'deallocation')
      group by a.agent_id`,
  );
  const allocatedBy = new Map(allocated.rows.map((r) => [r.agent_id, r.net]));

  const closes = await tx.query<{ agent_id: string | null; equity_minor: bigint }>(
    `select distinct on (agent_id) agent_id, equity_minor
       from ledger.equity_snapshots
      where as_of < current_date
      order by agent_id, as_of desc`,
  );
  const closeBy = new Map(closes.rows.map((r) => [r.agent_id ?? '__fund__', r.equity_minor]));

  const pct = (from: bigint, to: bigint): number | null => {
    if (from === 0n) return null;
    return Number(((to - from) * 10000n) / (from < 0n ? -from : from)) / 100;
  };

  const agents: ReportAgent[] = equities
    .filter((e) => e.status !== 'killed')
    .map((e) => {
      const basis = allocatedBy.get(e.agentId) ?? 0n;
      const close = closeBy.get(e.agentId);

      return {
        id: e.agentId,
        name: nameById.get(e.agentId) ?? e.agentId,
        status: e.status as ReportAgent['status'],
        allocatedMinor: basis.toString(),
        equityMinor: e.equityMinor?.toString() ?? null,
        pnlPctSinceStart: e.equityMinor === null ? null : pct(basis, e.equityMinor),
        pnlPctToday:
          e.equityMinor === null || close === undefined ? null : pct(close, e.equityMinor),
        holdings: e.holdings.map((h) => ({ symbol: h.symbol, qty: formatQty(h.qty) })),
      };
    });

  const anyUnknown = agents.some((a) => a.equityMinor === null);
  const total = anyUnknown
    ? null
    : agents.reduce((sum, a) => sum + BigInt(a.equityMinor ?? '0'), pool);

  const recon = await tx.query<{ status: string; as_of: Date }>(
    `select status, as_of from ledger.reconciliations order by run_at desc limit 1`,
  );
  const last = recon.rows[0];

  return {
    asOf: asOf.toISOString(),
    currency: 'GBP',
    totalEquityMinor: total?.toString() ?? null,
    unallocatedMinor: pool.toString(),
    agents,
    reconciliation: last ? { status: last.status, asOf: last.as_of.toISOString() } : null,
  };
}
