/**
 * The agent loop.
 *
 * A strategy proposes; this decides. Between an intent and an order there are
 * five gates, and an intent has to survive all of them:
 *
 *   1. the agent is running                (re-read immediately before each order)
 *   2. the tick is not too soon            (a crash-loop must not become a trading loop)
 *   3. the daily loss cap is not breached  (self-halt, not "try again")
 *   4. the order is within max_order_pct   (bounds a single mistake)
 *   5. the symbol is in the universe       (enforced again by the database)
 *
 * Gates 1 and 5 are also enforced by triggers on ledger.orders, so they hold
 * even if this file is wrong. Gates 3 and 4 are only enforced here, which is
 * exactly why the same limits must be set broker-side before live money: a
 * limit this codebase owns is a limit a bug in this codebase can lift.
 */

import type { Sql } from '../db.js';
import { inTransaction } from '../db.js';
import type { BrokerAdapter } from '../broker/types.js';
import { notional, type Minor, type Qty } from '../money.js';
import { agentEquity } from '../ledger/equity.js';
import { listUniverse } from '../ledger/universe.js';
import { halt } from '../ledger/control.js';
import { submitOrder } from '../pipeline/submit.js';
import { syncFills, syncMarks } from '../pipeline/sync.js';
import type { Intent, PriceBar, Strategy, StrategyInput } from './types.js';

const QTY_SCALE = 100000000n;

/**
 * Percent of available cash held back on a buy, to cover the gap between the
 * mark used for sizing and the price the order actually fills at, plus
 * commission. Generous on purpose: an order that bounces off the budget cap
 * costs a whole tick, and being slightly under-invested costs almost nothing.
 */
const BUY_HEADROOM_PCT = 3;

export interface TickOutcome {
  agentId: string;
  ran: boolean;
  /** Why the tick did nothing, when it did nothing. */
  skipped?: string;
  submitted: { symbol: string; side: 'buy' | 'sell'; why: string }[];
  refused: { symbol: string; reason: string }[];
  selfHalted?: string;
}

interface AgentRow {
  id: string;
  status: string;
  max_order_pct: string;
  daily_loss_cap_pct: string | null;
  min_tick_seconds: number;
  last_tick_at: Date | null;
}

/** Close history from the marks the sync job has been storing. */
async function history(tx: Sql, symbols: readonly string[], bars: number): Promise<Map<string, PriceBar[]>> {
  const out = new Map<string, PriceBar[]>();
  if (symbols.length === 0) return out;

  const result = await tx.query<{ symbol: string; as_of: Date; price_minor: bigint }>(
    `select symbol, as_of, price_minor from (
       select symbol, as_of, price_minor,
              row_number() over (partition by symbol order by as_of desc) as rn
         from ledger.marks
        where symbol = any($1)
     ) ranked
      where rn <= $2
      order by symbol, as_of`,
    [[...symbols], bars],
  );

  for (const row of result.rows) {
    const list = out.get(row.symbol) ?? [];
    list.push({ asOf: row.as_of, closeMinor: row.price_minor });
    out.set(row.symbol, list);
  }
  return out;
}

/**
 * Run one decision tick for one agent.
 *
 * Deliberately one tick, not a loop. Scheduling belongs outside — a process
 * that decides its own cadence is a process that can decide to go faster.
 */
export async function tick(
  broker: BrokerAdapter,
  strategy: Strategy,
  agentId: string,
  barsNeeded = 60,
): Promise<TickOutcome> {
  const outcome: TickOutcome = { agentId, ran: false, submitted: [], refused: [] };

  // Pull fills and prices first, so the decision is made on current state
  // rather than on whatever was true at the end of the last tick.
  await syncFills(broker);
  await syncMarks(broker);

  const setup = await inTransaction(async (tx) => {
    const rows = await tx.query<AgentRow>(
      `select id, status, max_order_pct::text as max_order_pct,
              daily_loss_cap_pct::text as daily_loss_cap_pct,
              min_tick_seconds, last_tick_at
         from ledger.agents where id = $1`,
      [agentId],
    );
    const agent = rows.rows[0];
    if (!agent) throw new Error(`no such agent: ${agentId}`);

    const equity = await agentEquity(tx, agentId);
    const universe = await listUniverse(tx, agentId);
    const prior = await tx.query<{ equity_minor: bigint }>(
      `select equity_minor from ledger.equity_snapshots
        where agent_id = $1 and as_of < current_date
        order by as_of desc limit 1`,
      [agentId],
    );

    return { agent, equity, universe, priorClose: prior.rows[0]?.equity_minor ?? null };
  });

  const { agent, equity, universe, priorClose } = setup;

  if (agent.status !== 'running') {
    outcome.skipped = `agent is ${agent.status}`;
    return outcome;
  }

  if (agent.last_tick_at) {
    const elapsed = (Date.now() - agent.last_tick_at.getTime()) / 1000;
    if (elapsed < agent.min_tick_seconds) {
      outcome.skipped = `last tick was ${Math.round(elapsed)}s ago, minimum is ${agent.min_tick_seconds}s`;
      return outcome;
    }
  }

  // Daily loss cap. Checked before deciding anything: an agent having a bad
  // day should stop, not get one more chance to fix it.
  if (agent.daily_loss_cap_pct && priorClose !== null && priorClose > 0n && equity.equityMinor !== null) {
    const dropBps = ((priorClose - equity.equityMinor) * 10000n) / priorClose;
    const capBps = BigInt(Math.round(Number(agent.daily_loss_cap_pct) * 100));

    if (dropBps >= capBps) {
      const reason = `daily loss cap: down ${Number(dropBps) / 100}% today, cap is ${agent.daily_loss_cap_pct}%`;
      await inTransaction((tx) => halt(tx, agentId, `runner:${strategy.name}`, reason));
      outcome.selfHalted = reason;
      return outcome;
    }
  }

  if (universe.length === 0) {
    outcome.skipped = 'empty trading universe';
    return outcome;
  }

  if (equity.equityMinor === null) {
    // Trading on an equity figure we could not compute means sizing off a
    // number that does not exist.
    outcome.skipped = `no mark for ${equity.unpricedSymbols.join(', ')}`;
    return outcome;
  }

  const bars = await inTransaction((tx) => history(tx, universe, barsNeeded));

  const input: StrategyInput = {
    asOf: new Date(),
    universe,
    history: bars,
    positions: new Map(equity.holdings.map((h) => [h.symbol, h.qty])),
    cashMinor: equity.cashMinor,
    allocatedMinor: equity.cashMinor + (equity.positionsMarketMinor ?? 0n),
  };

  const intents = strategy.decide(input);
  outcome.ran = true;

  const maxOrder = (input.allocatedMinor * BigInt(Math.round(Number(agent.max_order_pct) * 100))) / 10000n;

  for (const intent of intents) {
    const refusal = await place(
      broker,
      strategy,
      agentId,
      intent,
      bars,
      maxOrder,
      equity.cashMinor,
      outcome,
    );
    if (refusal === 'stop') break;
  }

  await inTransaction((tx) =>
    tx.query(`update ledger.agents set last_tick_at = now() where id = $1`, [agentId]),
  );

  // Pick up anything that filled during this tick, so the next one sees it.
  await syncFills(broker);

  return outcome;
}

async function place(
  broker: BrokerAdapter,
  strategy: Strategy,
  agentId: string,
  intent: Intent,
  bars: Map<string, PriceBar[]>,
  maxOrderMinor: Minor,
  cashMinor: Minor,
  outcome: TickOutcome,
): Promise<'ok' | 'stop'> {
  const series = bars.get(intent.symbol) ?? [];
  const last = series[series.length - 1];
  if (!last) {
    outcome.refused.push({ symbol: intent.symbol, reason: 'no price' });
    return 'ok';
  }

  let qty: Qty;

  if (intent.action === 'buy') {
    if (intent.notionalMinor > maxOrderMinor) {
      // Clamped rather than skipped: the strategy wanting too much is a
      // sizing disagreement, not a reason to do nothing.
      intent = { ...intent, notionalMinor: maxOrderMinor };
    }

    // Leave headroom for what the mark price does not include.
    //
    // Sizing is done off the last mark, but the fill lands above it — spread
    // and slippage move the price against you, and commission is charged on
    // top. An order sized to the last penny of available cash therefore costs
    // more than the cash on hand and is refused by the budget cap. Which is
    // the cap working correctly, and the runner asking for something it
    // should have known better than to ask for.
    const affordable = (cashMinor * BigInt(100 - BUY_HEADROOM_PCT)) / 100n;
    if (intent.notionalMinor > affordable) {
      intent = { ...intent, notionalMinor: affordable };
    }

    qty = (intent.notionalMinor * QTY_SCALE) / last.closeMinor;
    if (qty <= 0n) {
      outcome.refused.push({ symbol: intent.symbol, reason: 'order rounds to zero shares' });
      return 'ok';
    }
  } else {
    // Exits are deliberately NOT capped by max_order_pct.
    //
    // The cap exists to bound how much can be put at risk in one go. Applying
    // it to a sell does the opposite: a position that grew past the cap could
    // never be closed, and the rail meant to limit exposure would be the thing
    // preserving it. Anything that reduces exposure goes through.
    //
    // The same asymmetry as the trading universe, for the same reason.
    qty = intent.qty;
  }

  // The idempotency key identifies the DECISION, not the moment.
  //
  // It is derived from the bar the decision was made on, so a runner that
  // crashed between placing and recording re-derives the same key and the
  // duplicate is refused rather than opening a second position — while a
  // genuinely new decision, made on a newer bar, gets a new key.
  //
  // An earlier version used the wall-clock minute, which meant any two
  // decisions inside the same minute collided and the second was silently
  // refused. That is a runner that stops trading and does not say so.
  const bar = last.asOf.toISOString();
  const key = `${agentId}:${strategy.name}:${intent.action}:${intent.symbol}:${bar}`;

  try {
    await submitOrder(broker, {
      agentId,
      symbol: intent.symbol,
      side: intent.action,
      qty,
      idempotencyKey: key,
    });
    outcome.submitted.push({ symbol: intent.symbol, side: intent.action, why: intent.why });
    return 'ok';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome.refused.push({ symbol: intent.symbol, reason: message });

    // Halted mid-tick — by the owner, the global switch, or the loss cap.
    // Stop the whole tick rather than trying the next symbol.
    if (/not running/.test(message)) return 'stop';
    return 'ok';
  }
}
