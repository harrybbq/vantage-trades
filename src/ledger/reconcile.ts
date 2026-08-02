/**
 * Daily reconciliation. Mandatory, not a nice-to-have.
 *
 * The assertion is:
 *
 *     sum(agent equities) + unallocated == broker account equity
 *
 * plus a per-symbol quantity check, because equity can match by coincidence
 * while the attribution underneath it is wrong.
 *
 * When these diverge there is a bug, and the point of running this daily is to
 * hear about it that day rather than three months later. There is deliberately
 * no tolerance: 'ok' means exactly zero drift. A tolerance band is how a slow
 * leak goes unnoticed for a quarter.
 */

import type { Sql } from '../db.js';
import { formatGBP, formatQty, notional, parseQty, type Minor, type Qty } from '../money.js';
import { allAgentEquities, latestMarks, unallocatedPool } from './equity.js';

/** What the broker says. Supplied by a broker adapter. */
export interface BrokerSnapshot {
  asOf: Date;
  cashMinor: Minor;
  equityMinor: Minor;
  positions: { symbol: string; qty: Qty }[];
}

export interface SymbolDiff {
  symbol: string;
  brokerQty: string;
  computedQty: string;
}

export interface ReconciliationResult {
  id: string;
  status: 'ok' | 'diverged';
  cashDiffMinor: Minor;
  /** Null when equity could not be computed, because a holding had no mark. */
  equityDiffMinor: Minor | null;
  symbolDiffs: SymbolDiff[];
  unpricedSymbols: string[];
  /** Human-readable, suitable for an alert. */
  summary: string;
}

export async function reconcile(
  tx: Sql,
  snapshot: BrokerSnapshot,
): Promise<ReconciliationResult> {
  const equities = await allAgentEquities(tx, snapshot.asOf);
  const pool = await unallocatedPool(tx);

  const computedCash = equities.reduce((acc, e) => acc + e.cashMinor, 0n) + pool;

  // Value the aggregate position per symbol, then sum — deliberately not the
  // sum of per-agent equities.
  //
  // A broker values one position of 9 shares. We attribute 4 to one agent and
  // 5 to another, and with fractional shares rounding each agent's slice
  // separately can land a penny away from rounding the whole. Reconciling on
  // the per-agent sum would then report a divergence every single day, and a
  // check that cries wolf is a check nobody reads. So this mirrors the
  // broker's own arithmetic.
  //
  // The consequence, which is real and worth knowing: per-agent equities need
  // not sum exactly to total equity when fractional shares are held. That
  // residual is a display artefact of attribution, not a ledger error.
  const positions = await tx.query<{ symbol: string; qty: string }>(
    `select symbol, qty::text as qty from ledger.expected_broker_positions order by symbol`,
  );

  const marks = await latestMarks(
    tx,
    positions.rows.map((r) => r.symbol),
    snapshot.asOf,
  );

  const unpricedSymbols = positions.rows
    .filter((r) => !marks.has(r.symbol))
    .map((r) => r.symbol)
    .sort();

  // With a symbol unpriced, equity is unknown. Reporting it as zero drift
  // would be a green tick that means nothing, so this is recorded as a
  // divergence needing attention.
  const computedEquity = unpricedSymbols.length
    ? null
    : positions.rows.reduce(
        (acc, r) => acc + notional(parseQty(r.qty), marks.get(r.symbol) ?? 0n),
        computedCash,
      );

  const cashDiff = snapshot.cashMinor - computedCash;
  const equityDiff = computedEquity === null ? null : snapshot.equityMinor - computedEquity;

  const symbolDiffs = await comparePositions(tx, snapshot.positions);

  const clean =
    cashDiff === 0n &&
    equityDiff === 0n &&
    symbolDiffs.length === 0 &&
    unpricedSymbols.length === 0;
  const status: 'ok' | 'diverged' = clean ? 'ok' : 'diverged';

  const summary = clean
    ? `Reconciled clean at ${snapshot.asOf.toISOString()}: ` +
      `cash ${formatGBP(computedCash)}, equity ${formatGBP(computedEquity ?? 0n)}.`
    : describeDivergence(cashDiff, equityDiff, symbolDiffs, unpricedSymbols);

  const stored = await tx.query<{ id: string }>(
    `insert into ledger.reconciliations
       (as_of, broker_cash_minor, broker_equity_minor,
        computed_cash_minor, computed_equity_minor,
        cash_diff_minor, equity_diff_minor, status, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      snapshot.asOf,
      snapshot.cashMinor.toString(),
      snapshot.equityMinor.toString(),
      computedCash.toString(),
      computedEquity?.toString() ?? null,
      cashDiff.toString(),
      equityDiff?.toString() ?? null,
      status,
      JSON.stringify({ symbolDiffs, unpricedSymbols, summary }),
    ],
  );

  const id = stored.rows[0]?.id;
  if (!id) throw new Error('failed to store reconciliation');

  return { id, status, cashDiffMinor: cashDiff, equityDiffMinor: equityDiff, symbolDiffs, unpricedSymbols, summary };
}

async function comparePositions(
  tx: Sql,
  brokerPositions: readonly { symbol: string; qty: Qty }[],
): Promise<SymbolDiff[]> {
  const computed = await tx.query<{ symbol: string; qty: string }>(
    `select symbol, qty::text as qty from ledger.expected_broker_positions`,
  );

  const ours = new Map<string, Qty>(computed.rows.map((r) => [r.symbol, parseQty(r.qty)]));
  const theirs = new Map<string, Qty>(brokerPositions.map((p) => [p.symbol, p.qty]));

  const diffs: SymbolDiff[] = [];
  for (const symbol of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    const a = theirs.get(symbol) ?? 0n;
    const b = ours.get(symbol) ?? 0n;
    if (a !== b) {
      diffs.push({ symbol, brokerQty: formatQty(a), computedQty: formatQty(b) });
    }
  }
  return diffs;
}

function describeDivergence(
  cashDiff: Minor,
  equityDiff: Minor | null,
  symbolDiffs: readonly SymbolDiff[],
  unpricedSymbols: readonly string[],
): string {
  const lines = ['LEDGER DIVERGENCE - investigate today.'];

  if (cashDiff !== 0n) {
    lines.push(`  cash: broker is ${formatGBP(cashDiff)} away from the ledger`);
  }
  if (equityDiff !== null && equityDiff !== 0n) {
    lines.push(`  equity: broker is ${formatGBP(equityDiff)} away from the ledger`);
  }
  for (const d of symbolDiffs) {
    lines.push(`  ${d.symbol}: broker holds ${d.brokerQty}, ledger attributes ${d.computedQty}`);
  }
  if (unpricedSymbols.length) {
    lines.push(
      `  no mark for ${unpricedSymbols.join(', ')} - equity could not be computed, so this run proves nothing`,
    );
  }

  return lines.join('\n');
}
