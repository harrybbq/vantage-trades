/**
 * The weekly summary: what the owner would have learned by opening the panel,
 * sent to them instead, so that not opening it is a safe habit.
 *
 * It follows the panel's rules. A value that is not known is said to be not
 * known; an agent is compared with the same money in VWRP, never with a lump
 * sum; and nothing is called good or bad before 60 trading days.
 */

import type { Sql } from '../db.js';
import { formatGBP } from '../money.js';
import { controlPanelView } from '../api/view.js';
import { performanceView, type PerformancePoint } from '../api/performance.js';
import { readiness, MIN_TRADING_DAYS } from '../api/insights.js';
import { benchmarkPhrase } from '../ledger/snapshots.js';
import type { Alert } from './notify.js';

const signed = (minor: bigint) => `${minor > 0n ? '+' : minor < 0n ? '-' : ''}${formatGBP(minor < 0n ? -minor : minor)}`;
const pp = (n: number) => `${Math.abs(n).toFixed(1)} pp ${n >= 0 ? 'ahead of' : 'behind'} ${benchmarkPhrase()}`;

function weekChange(points: readonly PerformancePoint[], since: string): bigint | null {
  const recent = points.filter((p) => p.date > since && p.dayPnlMinor !== null);
  if (recent.length === 0) return null;
  return recent.reduce((sum, p) => sum + BigInt(p.dayPnlMinor!), 0n);
}

/** Null when there is nothing worth a message: no money in, nothing running. */
export async function weeklyDigest(tx: Sql, now = new Date()): Promise<Alert | null> {
  const view = await controlPanelView(tx, now);
  const perf = await performanceView(tx);
  const ready = await readiness(tx, now);

  const live = view.agents.filter((a) => a.status !== 'killed');
  const fundIn = BigInt(view.unallocatedMinor) + BigInt(view.allocatedMinor);
  if (fundIn <= 0n && live.every((a) => a.status === 'idle')) return null;

  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const lines: string[] = [];

  const fundWeek = weekChange(perf.fund.points, since);
  const lastFund = perf.fund.points[perf.fund.points.length - 1];
  lines.push(
    view.totalEquityMinor === null
      ? 'Fund: part of it has no price, so the total is not known.'
      : `Fund: ${formatGBP(BigInt(view.totalEquityMinor))}` +
          (fundWeek === null ? '.' : ` (${signed(fundWeek)} this week, money in or out left aside).`),
  );
  if (lastFund?.shadowMinor) {
    lines.push(`The same money in ${benchmarkPhrase()} would be about ${formatGBP(BigInt(lastFund.shadowMinor))}.`);
  }
  lines.push('');

  for (const agent of live) {
    const points = perf.agents.find((s) => s.id === agent.id)?.points ?? [];
    const last = points[points.length - 1];
    const week = weekChange(points, since);
    const value = agent.equityMinor === null ? 'value not known (a holding has no price)' : formatGBP(BigInt(agent.equityMinor));
    let line = `- ${agent.name} (${agent.status}): ${value}`;
    if (week !== null) line += `, ${signed(week)} this week`;
    if (agent.strategy === 'hold') {
      line += `. It holds ${benchmarkPhrase()}: it is the benchmark.`;
    } else if (last && last.benchPct !== null && points.length >= 2) {
      line += `, ${pp(last.twrPct - last.benchPct)} since it started.`;
      line += points.length < MIN_TRADING_DAYS ? ` Day ${points.length} of ${MIN_TRADING_DAYS}: too early to judge.` : '';
    } else {
      line += '. No record yet.';
    }
    lines.push(line);
  }
  lines.push('');

  const needs: string[] = [];
  const recon = view.reconciliation;
  if (!recon) needs.push('The ledger has never been checked against the broker.');
  else if (recon.status !== 'ok') needs.push(`The last check found a problem: ${recon.summary}`);
  else if (recon.stale) needs.push('The nightly check has stopped running.');
  for (const a of live) {
    if (a.status === 'halted') needs.push(`${a.name} is halted. Resume it or kill it when you have decided.`);
    if (a.status === 'killing') needs.push(`${a.name} is part-way through being killed. Press Kill again to finish.`);
    if (a.unpricedSymbols.length) needs.push(`${a.name} holds ${a.unpricedSymbols.join(', ')} with no price.`);
  }
  if (ready.cleanStreak > 0) lines.push(`Checks: clean for ${ready.cleanStreak} night${ready.cleanStreak === 1 ? '' : 's'} in a row.`);
  lines.push(needs.length ? `Needs you:\n${needs.map((n) => `- ${n}`).join('\n')}` : 'Nothing needs you.');
  lines.push('', 'Paper money. Nothing here is real yet.');

  return {
    title: needs.length ? 'Vantage Trades: weekly summary (needs you)' : 'Vantage Trades: weekly summary',
    body: lines.join('\n'),
    urgent: false,
  };
}
