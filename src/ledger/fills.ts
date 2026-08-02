/**
 * Recording fills, and the per-agent cost basis that makes attribution work.
 *
 * This is the file the whole system exists for. The broker knows one AAPL
 * position; if two agents both bought AAPL, only these lots know whose it is
 * and what each paid. Get this wrong and every number in the UI is confident
 * fiction that is very hard to notice.
 *
 * Lots close FIFO within an agent. The agent is always the outermost key —
 * one agent's sell can never touch another agent's lots, which is the property
 * that keeps the two AAPL holdings from bleeding into each other.
 */

import type { Sql } from '../db.js';
import { notional, parseQty, type Minor, type Qty } from '../money.js';
import { accountId } from './accounts.js';
import { postEntry } from './journal.js';

export interface FillInput {
  orderId: string;
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: Qty;
  pricePerUnitMinor: Minor;
  feeMinor?: Minor;
  /** The broker's own id. Unique, so a replayed webhook cannot book it twice. */
  brokerFillId: string;
  filledAt: Date;
}

export interface FillResult {
  fillId: string;
  entryId: string;
  /** Cost for a buy, proceeds for a sell, both before fees. */
  grossMinor: Minor;
  /** Only meaningful for a sell. */
  realisedMinor: Minor;
}

interface LotRow {
  id: string;
  qty_remaining: string;
  basis_remaining_minor: bigint;
}

/**
 * Record a fill: write the fill, post the journal entry, and update the lots.
 *
 * Must be called inside a transaction. All three effects belong together — a
 * fill without its lot leaves a position nothing can attribute, and a lot
 * without its entry leaves the books unbalanced.
 */
export async function recordFill(tx: Sql, input: FillInput): Promise<FillResult> {
  const fee = input.feeMinor ?? 0n;
  if (input.qty <= 0n) throw new Error('a fill must have positive quantity');
  if (input.pricePerUnitMinor <= 0n) throw new Error('a fill must have a positive price');
  if (fee < 0n) throw new Error('a fee cannot be negative');

  const gross = notional(input.qty, input.pricePerUnitMinor);
  if (gross <= 0n) {
    throw new Error('fill rounds to a zero value; refusing to record a position worth nothing');
  }

  const cashAcct = await accountId(tx, 'agent_cash', input.agentId);
  const posAcct = await accountId(tx, 'agent_positions', input.agentId);
  const feeAcct = await accountId(tx, 'agent_fees', input.agentId);
  const realisedAcct = await accountId(tx, 'agent_realised', input.agentId);

  const entryId =
    input.side === 'buy'
      ? await postBuy(tx, input, gross, fee, cashAcct, posAcct, feeAcct)
      : await postSell(tx, input, gross, fee, cashAcct, posAcct, feeAcct, realisedAcct);

  const fill = await tx.query<{ id: string }>(
    `insert into ledger.fills
       (order_id, agent_id, symbol, side, qty, price_minor, fee_minor, broker_fill_id, entry_id, filled_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      input.orderId,
      input.agentId,
      input.symbol,
      input.side,
      formatQtyForPg(input.qty),
      input.pricePerUnitMinor.toString(),
      fee.toString(),
      input.brokerFillId,
      entryId.entryId,
      input.filledAt,
    ],
  );
  const fillId = fill.rows[0]?.id;
  if (!fillId) throw new Error('failed to record fill');

  if (input.side === 'buy') {
    await tx.query(
      `insert into ledger.position_lots
         (agent_id, symbol, opening_fill_id, qty_opened, qty_remaining,
          cost_total_minor, basis_remaining_minor, opened_at)
       values ($1, $2, $3, $4, $4, $5, $5, $6)`,
      [
        input.agentId,
        input.symbol,
        fillId,
        formatQtyForPg(input.qty),
        gross.toString(),
        input.filledAt,
      ],
    );
  }

  return {
    fillId,
    entryId: entryId.entryId,
    grossMinor: gross,
    realisedMinor: entryId.realisedMinor,
  };
}

async function postBuy(
  tx: Sql,
  input: FillInput,
  cost: Minor,
  fee: Minor,
  cashAcct: string,
  posAcct: string,
  feeAcct: string,
): Promise<{ entryId: string; realisedMinor: Minor }> {
  const postings = [
    { accountId: cashAcct, amountMinor: -(cost + fee) },
    { accountId: posAcct, amountMinor: cost },
  ];
  if (fee > 0n) postings.push({ accountId: feeAcct, amountMinor: fee });

  const entryId = await postEntry(tx, {
    kind: 'buy',
    occurredAt: input.filledAt,
    externalRef: `fill:${input.brokerFillId}`,
    memo: `${input.agentId} buy ${input.symbol}`,
    postings,
  });

  return { entryId, realisedMinor: 0n };
}

async function postSell(
  tx: Sql,
  input: FillInput,
  proceeds: Minor,
  fee: Minor,
  cashAcct: string,
  posAcct: string,
  feeAcct: string,
  realisedAcct: string,
): Promise<{ entryId: string; realisedMinor: Minor }> {
  const basisClosed = await closeLotsFifo(tx, input.agentId, input.symbol, input.qty);
  const realised = proceeds - basisClosed;

  // Signs: assets positive, so a gain shows as a negative balance on the
  // realised account. Reported P/L is therefore -balance(agent_realised);
  // see docs/LEDGER.md, which is the only place that convention is explained.
  const postings = [
    { accountId: posAcct, amountMinor: -basisClosed },
    { accountId: cashAcct, amountMinor: proceeds - fee },
  ];
  if (realised !== 0n) postings.push({ accountId: realisedAcct, amountMinor: -realised });
  if (fee > 0n) postings.push({ accountId: feeAcct, amountMinor: fee });

  const entryId = await postEntry(tx, {
    kind: 'sell',
    occurredAt: input.filledAt,
    externalRef: `fill:${input.brokerFillId}`,
    memo: `${input.agentId} sell ${input.symbol}`,
    postings,
  });

  return { entryId, realisedMinor: realised };
}

/**
 * Close `qty` units of `symbol` for `agent`, oldest lot first, returning the
 * cost basis released.
 *
 * `for update` locks the lots being consumed: two concurrent sells of the same
 * symbol reading the same open lots would each think there was enough to sell
 * and between them close more than the agent holds.
 */
async function closeLotsFifo(
  tx: Sql,
  agentId: string,
  symbol: string,
  qty: Qty,
): Promise<Minor> {
  const lots = await tx.query<LotRow>(
    `select id, qty_remaining::text as qty_remaining, basis_remaining_minor
       from ledger.position_lots
      where agent_id = $1 and symbol = $2 and qty_remaining > 0
      order by opened_at, id
      for update`,
    [agentId, symbol],
  );

  let toClose = qty;
  let basisClosed = 0n;

  for (const lot of lots.rows) {
    if (toClose === 0n) break;

    const lotQty = parseQty(lot.qty_remaining);
    const take = lotQty < toClose ? lotQty : toClose;

    // Release basis in proportion to the units taken, and take all of what is
    // left when the lot is fully closed. Deriving the last slice by
    // subtraction rather than multiplication is what stops a rounding
    // remainder being stranded on an empty lot.
    const releasing =
      take === lotQty
        ? lot.basis_remaining_minor
        : (lot.basis_remaining_minor * take) / lotQty;

    const remainingQty = lotQty - take;
    const remainingBasis = lot.basis_remaining_minor - releasing;

    await tx.query(
      `update ledger.position_lots
          set qty_remaining = $2,
              basis_remaining_minor = $3,
              closed_at = case when $2::numeric = 0 then $4::timestamptz else null end
        where id = $1`,
      [lot.id, formatQtyForPg(remainingQty), remainingBasis.toString(), new Date()],
    );

    basisClosed += releasing;
    toClose -= take;
  }

  if (toClose > 0n) {
    throw new Error(
      `agent ${agentId} does not hold enough ${symbol} to sell: short by ${toClose} (scale 8). ` +
        'Refusing to record a sell that would create a position the ledger cannot attribute.',
    );
  }

  return basisClosed;
}

function formatQtyForPg(qty: Qty): string {
  const negative = qty < 0n;
  const abs = negative ? -qty : qty;
  const whole = abs / 100000000n;
  const frac = (abs % 100000000n).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
