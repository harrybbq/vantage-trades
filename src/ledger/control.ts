/**
 * Agent control: halt, kill, start.
 *
 * Three distinct controls, easy to conflate and dangerous to get wrong, so the
 * words are used precisely here and everywhere else:
 *
 *   halt  - freeze. Opens nothing, closes nothing. Positions left exactly as
 *           they are, capital stays allocated. The "something looks wrong,
 *           stop touching it" button.
 *   kill  - confirm, then liquidate everything and stand down. Capital returns
 *           to the pool. Destructive and irreversible: it realises losses.
 *           In between it is `killing`: it may sell what it holds and
 *           nothing else, and it stays there until every position is gone.
 *   start - resume from halted, or begin fresh.
 *
 * Halt being authoritative rather than advisory is enforced in the schema: a
 * trigger on ledger.orders rejects an order from any agent that is not
 * running. That check sits at the point of writing the order, so an agent
 * whose loop is wedged mid-iteration still cannot slip one through.
 */

import type { Sql } from '../db.js';
import { accountId, balance } from './accounts.js';
import { postEntry } from './journal.js';
import { formatGBP, formatQty, parseQty, type Minor, type Qty } from '../money.js';

export type AgentStatus = 'idle' | 'running' | 'halted' | 'killing' | 'killed';

/**
 * Read an agent's status and hold its row until the transaction ends.
 *
 * Without the lock, two controls arriving together — Kill and Start, say —
 * each read the same status, each decide they are allowed, and the last one
 * to write wins whatever the first one did.
 */
async function currentStatus(tx: Sql, agentId: string): Promise<AgentStatus> {
  const result = await tx.query<{ status: AgentStatus }>(
    `select status from ledger.agents where id = $1 for update`,
    [agentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no such agent: ${agentId}`);
  return row.status;
}

async function transition(
  tx: Sql,
  agentId: string,
  to: AgentStatus,
  action: 'start' | 'halt' | 'kill',
  actor: string,
  reason?: string,
): Promise<void> {
  const from = await currentStatus(tx, agentId);

  await tx.query(
    `update ledger.agents
        set status = $2::ledger.agent_status,
            started_at = case
              when $2::text = 'running' and started_at is null then now()
              else started_at
            end,
            updated_at = now()
      where id = $1`,
    [agentId, to],
  );

  await tx.query(
    `insert into ledger.agent_control_events (agent_id, action, from_status, to_status, actor, reason)
     values ($1, $2, $3, $4, $5, $6)`,
    [agentId, action, from, to, actor, reason ?? null],
  );
}

/**
 * Freeze an agent. Positions are left alone and capital stays allocated.
 *
 * Halting an already-halted agent is not an error. This is the button reached
 * for when something looks wrong, and it should never fail on a technicality.
 */
export async function halt(
  tx: Sql,
  agentId: string,
  actor: string,
  reason?: string,
): Promise<void> {
  const from = await currentStatus(tx, agentId);
  if (from === 'killed') {
    throw new Error(`agent ${agentId} is killed; there is nothing to halt`);
  }
  await transition(tx, agentId, 'halted', 'halt', actor, reason);
}

export async function start(
  tx: Sql,
  agentId: string,
  actor: string,
  reason?: string,
): Promise<void> {
  const from = await currentStatus(tx, agentId);
  if (from === 'killed') {
    throw new Error(
      `agent ${agentId} was killed. Restarting it is a deliberate decision about whether ` +
        'its P/L history resumes or starts fresh, so it is not a plain start.',
    );
  }
  if (from === 'killing') {
    throw new Error(
      `agent ${agentId} is part-way through being killed. Finish the kill, or halt it to ` +
        'stop selling; it cannot go back to trading from here.',
    );
  }
  await transition(tx, agentId, 'running', 'start', actor, reason);
}

/**
 * Halt every agent at once.
 *
 * Independent of any individual agent's state, and it works by writing status
 * directly rather than by asking each agent's loop to stop, so a wedged loop
 * is still caught by the order-level check.
 */
export async function globalHalt(tx: Sql, actor: string, reason?: string): Promise<string[]> {
  const affected = await tx.query<{ id: string }>(
    `update ledger.agents
        set status = 'halted', updated_at = now()
      where status in ('running', 'idle', 'killing')
      returning id`,
  );

  await tx.query(
    `insert into ledger.agent_control_events (agent_id, action, actor, reason)
     values (null, 'global_halt', $1, $2)`,
    [actor, reason ?? null],
  );

  return affected.rows.map((r) => r.id);
}

export interface KillPreview {
  agentId: string;
  positions: {
    symbol: string;
    qty: Qty;
    costBasisMinor: Minor;
    /** The latest stored price, or null when there is none to sell at. */
    lastPriceMinor: Minor | null;
    /** Other agents holding the same share, whose shares this kill leaves alone. */
    others: { agentId: string; qty: Qty }[];
  }[];
  uninvestedCashMinor: Minor;
  /** Ready to drop into a confirmation prompt. */
  summary: string;
}

/**
 * What killing this agent would actually do.
 *
 * Kill is destructive and irreversible, so its confirmation has to name what
 * will be sold rather than just asking "are you sure" — the point of the
 * prompt is that the owner can notice it is about to liquidate the wrong
 * agent.
 */
/**
 * Move an agent into `killing`, or confirm it is already there.
 *
 * Refuses while the agent has an order still open. Selling on top of a sale
 * that has not finished would sell the same shares twice — and the broker,
 * which has no idea which agent owns what, would happily take the second lot
 * out of another agent's holding.
 */
export async function beginKill(tx: Sql, agentId: string, actor: string): Promise<void> {
  const from = await currentStatus(tx, agentId);
  if (from === 'killed') throw new Error(`agent ${agentId} is already killed`);

  const open = await tx.query<{ symbol: string; side: string; status: string; acked: boolean }>(
    // Open means not yet fully filled, whatever the status column says: the
    // status can lag the fills, and a filled order is no risk of a double sale.
    `select o.symbol, o.side, o.status, o.broker_order_id is not null as acked from ledger.orders o
      where o.agent_id = $1 and o.status in ('pending', 'submitted', 'partially_filled')
        and coalesce((select sum(f.qty) from ledger.fills f where f.order_id = o.id), 0) < o.qty
      order by o.created_at`,
    [agentId],
  );
  if (open.rows.length > 0) {
    const list = open.rows.map((o) => `${o.side} ${o.symbol} (${o.status})`).join(', ');
    // An order the broker never acknowledged will not settle by waiting: it
    // is an orphan, and only asking the broker says whether it exists.
    const orphans = open.rows.filter((o) => !o.acked).length;
    throw new Error(
      `agent ${agentId} has ${open.rows.length} order(s) still open: ${list}. Selling now could ` +
        'sell the same shares twice. ' +
        (orphans > 0
          ? `${orphans} of them never got the broker's acknowledgement, so waiting will not settle ` +
            'them — check the broker for them by hand first. '
          : 'Wait for them to settle, then press Kill again. ') +
        'Halt still works in the meantime.',
    );
  }

  if (from !== 'killing') await transition(tx, agentId, 'killing', 'kill', actor, 'kill started');
}

export async function previewKill(tx: Sql, agentId: string): Promise<KillPreview> {
  const positions = await tx.query<{ symbol: string; qty: string; cost_basis_minor: bigint }>(
    `select symbol, qty::text as qty, cost_basis_minor
       from ledger.agent_positions where agent_id = $1 order by symbol`,
    [agentId],
  );

  const cash = await balance(tx, await accountId(tx, 'agent_cash', agentId));

  const marks = await tx.query<{ symbol: string; price_minor: bigint }>(
    `select distinct on (symbol) symbol, price_minor from ledger.marks
      where symbol = any($1) order by symbol, as_of desc`,
    [positions.rows.map((r) => r.symbol)],
  );
  const others = await tx.query<{ symbol: string; agent_id: string; qty: string }>(
    `select symbol, agent_id, qty::text as qty from ledger.agent_positions
      where symbol = any($1) and agent_id <> $2 order by agent_id`,
    [positions.rows.map((r) => r.symbol), agentId],
  );

  const parsed = positions.rows.map((r) => ({
    symbol: r.symbol,
    qty: parseQty(r.qty),
    costBasisMinor: r.cost_basis_minor,
    lastPriceMinor: marks.rows.find((m) => m.symbol === r.symbol)?.price_minor ?? null,
    others: others.rows
      .filter((o) => o.symbol === r.symbol)
      .map((o) => ({ agentId: o.agent_id, qty: parseQty(o.qty) })),
  }));

  const totalBasis = parsed.reduce((a, p) => a + p.costBasisMinor, 0n);
  const lines = parsed.map((p) => `  ${p.symbol}: ${formatQty(p.qty)}`);

  const summary = parsed.length
    ? `Kill ${agentId}? This sells all ${parsed.length} position(s) at market:\n${lines.join('\n')}\n` +
      `and returns about ${formatGBP(totalBasis + cash)} to the unallocated pool. ` +
      'This realises any losses and cannot be undone.'
    : `Kill ${agentId}? It holds no positions; ${formatGBP(cash)} returns to the unallocated pool.`;

  return { agentId, positions: parsed, uninvestedCashMinor: cash, summary };
}

/**
 * Complete a kill once every position has actually been liquidated.
 *
 * Separate from `previewKill` and from placing the sell orders, because the
 * capital cannot come back to the pool until the sells have really filled.
 * Standing an agent down while it still holds something would leave a position
 * attributed to a dead agent — reconciliation would catch it, but only after
 * the fact.
 */
export async function standDown(
  tx: Sql,
  agentId: string,
  actor: string,
  reason?: string,
): Promise<Minor> {
  const open = await tx.query<{ n: string }>(
    `select count(*)::text as n from ledger.agent_positions where agent_id = $1`,
    [agentId],
  );
  const remaining = Number(open.rows[0]?.n ?? '0');
  if (remaining > 0) {
    throw new Error(
      `agent ${agentId} still holds ${remaining} position(s); liquidate them before standing it down`,
    );
  }

  const cash = await accountId(tx, 'agent_cash', agentId);
  const returned = await balance(tx, cash);

  if (returned > 0n) {
    await postEntry(tx, {
      kind: 'deallocation',
      occurredAt: new Date(),
      memo: `kill ${agentId}: return remaining capital to the pool`,
      postings: [
        { accountId: cash, amountMinor: -returned },
        { accountId: await accountId(tx, 'pool'), amountMinor: returned },
      ],
    });
  }

  await transition(tx, agentId, 'killed', 'kill', actor, reason);
  return returned;
}
