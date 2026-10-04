/**
 * Two read models the panel guides from: the real-money checklist, and the
 * activity feed. Neither can move money or change anything.
 */

import type { Sql } from '../db.js';
import { formatQty, parseQty } from '../money.js';

/** The days the checklist asks for. Mirrored in CLAUDE.md. */
export const MIN_TRADING_DAYS = 60;
export const MIN_CLEAN_NIGHTS = 20;

export interface Readiness {
  /** Days with a fund snapshot: days the ledger agreed with the broker. */
  tradingDays: number;
  /** Consecutive weekdays, back from the latest, whose last check was clean. */
  cleanStreak: number;
  /** A kill has sold shares on paper at least once. */
  killTested: boolean;
  agentsWithLimits: number;
  agentsActive: number;
  minTradingDays: number;
  minCleanNights: number;
}

export async function readiness(tx: Sql, now = new Date()): Promise<Readiness> {
  const days = await tx.query<{ n: string }>(
    `select count(distinct as_of)::text as n from ledger.equity_snapshots where agent_id is null`,
  );

  // The latest check of each day decides that day. A clean run followed by an
  // error that evening is an error night, which is why the error rows written
  // since the audit matter here.
  const nights = await tx.query<{ day: string; status: string }>(
    `select distinct on (day) day, status from (
       select (run_at at time zone 'UTC')::date::text as day, status, run_at
         from ledger.reconciliations
        where run_at > now() - interval '120 days'
     ) r
     order by day desc, run_at desc`,
  );
  const byDay = new Map(nights.rows.map((r) => [r.day, r.status]));

  // Walk back over weekdays. A weekday with no check at all breaks the streak:
  // a night nothing looked is not a clean night.
  let streak = 0;
  const d = new Date(now);
  if (!byDay.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < 200; i++) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      if (byDay.get(d.toISOString().slice(0, 10)) !== 'ok') break;
      streak += 1;
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  const kill = await tx.query<{ tested: boolean }>(
    `select exists (
       select 1 from ledger.orders o
        where o.side = 'sell' and o.idempotency_key like 'kill:%'
          and exists (select 1 from ledger.fills f where f.order_id = o.id)
     ) as tested`,
  );

  const limits = await tx.query<{ active: string; limited: string }>(
    `select count(*)::text as active,
            count(*) filter (where daily_loss_cap_pct is not null)::text as limited
       from ledger.agents where status <> 'killed'`,
  );

  return {
    tradingDays: Number(days.rows[0]?.n ?? 0),
    cleanStreak: streak,
    killTested: kill.rows[0]?.tested ?? false,
    agentsWithLimits: Number(limits.rows[0]?.limited ?? 0),
    agentsActive: Number(limits.rows[0]?.active ?? 0),
    minTradingDays: MIN_TRADING_DAYS,
    minCleanNights: MIN_CLEAN_NIGHTS,
  };
}

export type ActivityKind = 'fill' | 'control' | 'check' | 'money';

export interface ActivityItem {
  at: string;
  kind: ActivityKind;
  agentId: string | null;
  /** One line, written to be read by the owner. */
  title: string;
  /** Short labels: the reason given, who did it, the order's purpose. */
  tags: string[];
  /** Money in or out of the agent's cash, signed. Null when nothing moved. */
  amountMinor: string | null;
}

const pounds = (minor: bigint) => {
  const sign = minor < 0n ? '−' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}£${(abs / 100n).toLocaleString('en-GB')}.${(abs % 100n).toString().padStart(2, '0')}`;
};
const shares = (qty: string) => formatQty(parseQty(qty)).replace(/\.?0+$/, '');

/** Fills, controls, checks and money movements, newest first. */
export async function activity(tx: Sql, limit = 100): Promise<ActivityItem[]> {
  const fills = await tx.query<{
    at: Date; agent_id: string; symbol: string; side: string; qty: string; price_minor: bigint; fee_minor: bigint; key: string;
  }>(
    `select f.filled_at as at, f.agent_id, f.symbol, f.side::text as side, f.qty::text as qty,
            f.price_minor, f.fee_minor, o.idempotency_key as key
       from ledger.fills f join ledger.orders o on o.id = f.order_id
      order by f.filled_at desc limit $1`,
    [limit],
  );
  const controls = await tx.query<{
    at: Date; agent_id: string | null; action: string; to_status: string | null; actor: string; reason: string | null;
  }>(
    `select created_at as at, agent_id, action, to_status::text as to_status, actor, reason
       from ledger.agent_control_events order by created_at desc limit $1`,
    [limit],
  );
  const checks = await tx.query<{ at: Date; status: string; summary: string | null }>(
    `select run_at as at, status, detail->>'summary' as summary
       from ledger.reconciliations order by run_at desc limit $1`,
    [limit],
  );
  const money = await tx.query<{ at: Date; kind: string; agent_id: string | null; amount: bigint; memo: string | null }>(
    `select e.occurred_at as at, e.kind::text as kind, a.agent_id, p.amount_minor as amount, e.memo
       from ledger.journal_entries e
       join ledger.postings p on p.entry_id = e.id
       join ledger.accounts a on a.id = p.account_id
      where (e.kind in ('allocation', 'deallocation') and a.kind = 'agent_cash')
         or (e.kind in ('deposit', 'withdrawal') and a.kind = 'pool')
      order by e.occurred_at desc limit $1`,
    [limit],
  );

  const items: ActivityItem[] = [
    ...fills.rows.map((f) => {
      const gross = (parseQty(f.qty) * f.price_minor) / 100_000_000n;
      const tags = [f.key.startsWith('kill:') ? 'sold by Kill' : 'placed by the agent'];
      if (f.fee_minor > 0n) tags.push(`fee ${pounds(f.fee_minor)}`);
      return {
        at: f.at.toISOString(),
        kind: 'fill' as const,
        agentId: f.agent_id,
        title: `${f.side === 'buy' ? 'Bought' : 'Sold'} ${shares(f.qty)} ${f.symbol} at ${pounds(f.price_minor)}`,
        tags,
        amountMinor: (f.side === 'buy' ? -gross - f.fee_minor : gross - f.fee_minor).toString(),
      };
    }),
    ...controls.rows.map((c) => {
      const what =
        c.action === 'global_halt' ? 'Halted every agent'
        : c.action === 'kill' && c.to_status === 'killing' ? 'Started killing'
        : c.action === 'kill' ? 'Stood down'
        : c.action === 'halt' ? 'Halted'
        : 'Started';
      const tags = [c.actor.startsWith('runner:') ? 'the agent itself' : c.actor];
      if (c.reason) tags.push(`“${c.reason}”`);
      return { at: c.at.toISOString(), kind: 'control' as const, agentId: c.agent_id, title: what, tags, amountMinor: null };
    }),
    ...checks.rows.map((c) => ({
      at: c.at.toISOString(),
      kind: 'check' as const,
      agentId: null,
      title:
        c.status === 'ok' ? 'Ledger matched the broker'
        : c.status === 'diverged' ? 'Ledger and broker disagreed'
        : 'The check found a problem',
      tags: c.summary ? [c.summary] : [],
      amountMinor: null,
    })),
    ...money.rows.map((m) => ({
      at: m.at.toISOString(),
      kind: 'money' as const,
      agentId: m.agent_id,
      title:
        m.kind === 'deposit' ? `Recorded a bank transfer in of ${pounds(m.amount)}`
        : m.kind === 'withdrawal' ? `Recorded a bank transfer out of ${pounds(-m.amount)}`
        : m.kind === 'allocation' ? `Gave it ${pounds(m.amount)} from the pool`
        : `Took ${pounds(-m.amount)} back to the pool`,
      tags: m.memo ? [m.memo] : [],
      amountMinor: m.amount.toString(),
    })),
  ];

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
