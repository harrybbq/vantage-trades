#!/usr/bin/env tsx
/**
 * Fill a LOCAL database with six weeks of invented history, for looking at
 * the panel. Refuses anything that is not localhost, like the test suite.
 *
 *   npx tsx scripts/local/seed-panel.ts
 */
import '../../tests/setup.ts';
import { getPool, inTransaction, closePool } from '../../src/db.js';
import { parseMoney, parseQty } from '../../src/money.js';
import { PaperBroker } from '../../src/broker/paper.js';
import { createAgent } from '../../src/ledger/agents.js';
import { addToUniverse } from '../../src/ledger/universe.js';
import { recordDeposit, allocate } from '../../src/ledger/allocation.js';
import { start, halt } from '../../src/ledger/control.js';
import { submitOrder } from '../../src/pipeline/submit.js';
import { syncFills } from '../../src/pipeline/sync.js';

const pool = getPool();
const broker = new PaperBroker(pool);

function weekdaysBack(n: number, end: Date): Date[] {
  const out: Date[] = [];
  const d = new Date(end);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const days = weekdaysBack(29, new Date('2026-10-02T12:00:00Z'));
const at = (i: number, h = 9) => new Date(Date.UTC(days[i]!.getUTCFullYear(), days[i]!.getUTCMonth(), days[i]!.getUTCDate(), h));
const day = (i: number) => days[i]!.toISOString().slice(0, 10);

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const walk = (n: number, vol: number, drift: number) => {
  let v = 0;
  return Array.from({ length: n }, (_, i) => (i === 0 ? 0 : (v += (rnd() + rnd() + rnd() - 1.5) * vol + drift)));
};

async function main() {
  await pool.query(`truncate ledger.postings, ledger.journal_entries, ledger.position_lots, ledger.fills, ledger.orders,
    ledger.accounts, ledger.agent_control_events, ledger.reconciliations, ledger.marks, ledger.agents restart identity cascade`);
  await pool.query(`truncate paper.fills, paper.orders, paper.positions, paper.market_prices, paper.feed_instruments restart identity cascade`);
  await pool.query(`update paper.account set cash_minor = 0`);
  await pool.query(`truncate ledger.equity_snapshots`);

  await broker.fundAccount(parseMoney('5100.00'));
  await inTransaction(async (tx) => {
    await recordDeposit(tx, parseMoney('4000.00'), at(0, 8), 'first transfer');
    await recordDeposit(tx, parseMoney('1100.00'), at(10, 8), 'second transfer');
    await createAgent(tx, { id: 'momentum-1', name: 'Momentum' });
    await createAgent(tx, { id: 'meanrev-1', name: 'Mean reversion' });
    await createAgent(tx, { id: 'div-1', name: 'Dividend' });
    for (const s of ['AZN', 'ULVR', 'ISF']) await addToUniverse(tx, 'momentum-1', s, 'seed');
    for (const s of ['GSK', 'ULVR', 'BARC']) await addToUniverse(tx, 'meanrev-1', s, 'seed');
    for (const s of ['LGEN', 'NG', 'SSE']) await addToUniverse(tx, 'div-1', s, 'seed');
    await allocate(tx, 'momentum-1', parseMoney('1500.00'), at(0));
    await allocate(tx, 'momentum-1', parseMoney('500.00'), at(12));
    await allocate(tx, 'meanrev-1', parseMoney('1000.00'), at(3));
    await allocate(tx, 'div-1', parseMoney('600.00'), at(25));
    await start(tx, 'momentum-1', 'seed');
    await start(tx, 'meanrev-1', 'seed');
  });

  // Holdings that really exist at the broker, so who-owns-what matches.
  const prices: Record<string, string> = { AZN: '117.10', ULVR: '47.24', ISF: '8.40', GSK: '14.71', BARC: '3.08', VWRP: '145.62' };
  for (const [s, p] of Object.entries(prices)) await broker.setPrice(s, parseMoney(p));
  let k = 0;
  const buy = (agentId: string, symbol: string, qty: string) =>
    submitOrder(broker, { agentId, symbol, side: 'buy', qty: parseQty(qty), idempotencyKey: `seed-${k++}` });
  await buy('momentum-1', 'AZN', '4');
  await buy('momentum-1', 'ULVR', '12');
  await buy('momentum-1', 'ISF', '72');
  await buy('meanrev-1', 'GSK', '20');
  await buy('meanrev-1', 'ULVR', '5');
  await buy('meanrev-1', 'BARC', '120');
  await syncFills(broker);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'AZN'`, [at(4, 11)]);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'ISF'`, [at(28, 15)]);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'GSK'`, [at(6, 11)]);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'BARC'`, [at(11, 11)]);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'ULVR' and agent_id = 'momentum-1'`, [at(15, 10)]);
  await pool.query(`update ledger.fills set filled_at = $1 where symbol = 'ULVR' and agent_id = 'meanrev-1'`, [at(21, 10)]);

  // Prices the ledger values with. BARC is left unpriced on purpose.
  for (const [s, p] of Object.entries(prices)) {
    if (s === 'BARC') continue;
    await pool.query(`insert into ledger.marks (symbol, as_of, price_minor, source) values ($1, now(), $2, 'seed')`, [s, parseMoney(p).toString()]);
  }

  // Six weeks of nightly snapshots and clean checks.
  const bench = walk(29, 0.4, 0.04).map((v) => Math.round(14200 * (1 + v / 100)));
  const mom = walk(29, 0.55, 0.07);
  const mr = walk(29, 0.75, -0.04);
  for (let i = 0; i < 29; i++) {
    if (i === 19) continue; // a night the check failed: no snapshot
    const momIn = i >= 12 ? 2000 : 1500;
    const momEq = Math.round(momIn * 100 * (1 + mom[i]! / 100));
    const mrEq = i >= 3 ? Math.round(1000 * 100 * (1 + mr[i]! / 100)) : null;
    const divEq = i >= 25 ? 60000 : null;
    const poolMinor = 510000 - (momIn * 100) - (i >= 3 ? 100000 : 0) - (i >= 25 ? 60000 : 0) - (i < 10 ? 110000 : 0);
    const fundEq = momEq + (mrEq ?? 0) + (divEq ?? 0) + poolMinor;
    const rows: [string | null, number][] = [['momentum-1', momEq], [null, fundEq]];
    if (mrEq !== null && i <= 26) rows.push(['meanrev-1', mrEq]);
    if (divEq !== null) rows.push(['div-1', divEq]);
    for (const [agent, eq] of rows) {
      await pool.query(
        `insert into ledger.equity_snapshots (agent_id, as_of, equity_minor, cash_minor, positions_minor, benchmark_symbol, benchmark_minor)
         values ($1, $2, $3, 0, 0, 'VWRP', $4)`,
        [agent, day(i), eq, bench[i]],
      );
    }
    await pool.query(
      `insert into ledger.reconciliations (run_at, as_of, broker_cash_minor, broker_equity_minor, computed_cash_minor,
         computed_equity_minor, cash_diff_minor, equity_diff_minor, status, detail)
       values ($1, $1, $2, $2, $2, $2, 0, 0, 'ok', $3)`,
      [new Date(at(i, 22).getTime() + 40 * 60_000), fundEq, JSON.stringify({ summary: 'Reconciled clean.' })],
    );
  }
  await pool.query(`update ledger.agents set daily_loss_cap_pct = 3`);
  await inTransaction((tx) => halt(tx, 'meanrev-1', 'owner', 'BARC feed looks wrong'));
  console.log('seeded six weeks of example history into the local database');
  await closePool();
}

void main();
