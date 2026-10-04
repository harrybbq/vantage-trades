/**
 * The panel's guidance: verdicts, the next step, the luck band, capital advice.
 *
 * Process and risk only. Nothing here suggests what to buy or predicts a
 * price — see "The owner is new to trading" in CLAUDE.md.
 *
 * Money arithmetic here is integer (BigInt) and advisory: it decides which
 * sentence to show, never a figure the ledger records. The server re-checks
 * every action that moves money.
 */

import type { AgentView, ControlPanelView, PerformancePoint, Readiness } from './api';

export const JUDGE_AFTER_DAYS = 60;
export const MIN_CHART_DAYS = 8;
/** Soft ceiling on one untested agent's share of the fund. */
export const SOFT_SHARE_PCT = 25;

/* ---------- Luck band ---------- */

/**
 * How far the lead over VWRP can wander by luck alone, after `n` days.
 *
 * The daily change in the lead has some spread; with no skill at all, its sum
 * after n days spreads with the square root of n. The floor stops a quiet
 * first fortnight producing a band so narrow that noise looks like skill.
 */
export function leadVolatility(points: readonly PerformancePoint[]): number {
  const gaps = points.map((p) => (p.benchPct === null ? null : p.twrPct - p.benchPct));
  const diffs: number[] = [];
  for (let i = 1; i < gaps.length; i++) {
    const a = gaps[i - 1];
    const b = gaps[i];
    if (a != null && b != null) diffs.push(b - a);
  }
  if (diffs.length < 2) return 0.5;
  const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((x, y) => x + (y - mean) ** 2, 0) / (diffs.length - 1));
  return Math.max(0.25, sd);
}

/** Half-width of the band, in pp, `days` after the start. z: 0.67 half, 1.28 four in five, 1.96 nineteen in twenty. */
export const band = (sd: number, days: number, z = 1.96) => z * sd * Math.sqrt(Math.max(0, days));

export interface LeadSummary {
  leadPp: number;
  bandPp: number;
  days: number;
  inside: boolean;
}

export function leadSummary(points: readonly PerformancePoint[]): LeadSummary | null {
  const known = points.filter((p) => p.benchPct !== null);
  const last = known[known.length - 1];
  if (!last || points.length < 2) return null;
  const sd = leadVolatility(points);
  const leadPp = last.twrPct - (last.benchPct ?? 0);
  const bandPp = band(sd, points.length - 1);
  return { leadPp, bandPp, days: points.length, inside: Math.abs(leadPp) < bandPp };
}

/* ---------- Verdicts ---------- */

export type VerdictTone = 'wait' | 'decide' | 'ready' | 'good' | 'bad';

export interface Verdict {
  tone: VerdictTone;
  title: string;
  body: string;
  options?: string[];
}

export function verdictFor(agent: AgentView, points: readonly PerformancePoint[]): Verdict {
  if (agent.status === 'killing') {
    return {
      tone: 'decide',
      title: 'Kill not finished',
      body: 'It is part-way through being killed: it can only sell. Press Kill again to sell what is left; anything without a price waits until it has one.',
    };
  }
  if (agent.status === 'halted') {
    return {
      tone: 'decide',
      title: 'Your decision',
      body: 'It is frozen: it opens nothing and closes nothing, but what it holds still moves with the market.',
      options: [
        'If you halted it over something now fixed, Resume.',
        'If you have lost confidence in the strategy itself, Kill. That sells what it holds.',
      ],
    };
  }
  if (agent.status === 'idle') {
    if (BigInt(agent.allocatedMinor) <= 0n) {
      return { tone: 'ready', title: 'Needs capital', body: 'Give it some capital from the pool. It cannot buy anything until it has a budget.' };
    }
    if (agent.universe.length === 0) {
      return { tone: 'ready', title: 'Needs a share list', body: 'Choose which shares it may trade. With an empty list it cannot open anything.' };
    }
    return {
      tone: 'ready',
      title: 'Ready to start',
      body: `It has capital and ${agent.universe.length} share${agent.universe.length === 1 ? '' : 's'} it may trade. Starting begins its paper record. Nothing real is at risk.`,
    };
  }

  const lead = leadSummary(points);
  if (!lead) {
    return { tone: 'wait', title: 'Too early to judge: leave it running', body: 'It has no record yet to compare with VWRP. The first point appears after the nightly check.' };
  }
  const gap = `${Math.abs(lead.leadPp).toFixed(1)} pp ${lead.leadPp >= 0 ? 'ahead of' : 'behind'} VWRP`;
  if (lead.days < JUDGE_AFTER_DAYS) {
    return {
      tone: 'wait',
      title: 'Too early to judge: leave it running',
      body: `Day ${lead.days} of ${JUDGE_AFTER_DAYS}. It is ${gap}, ${lead.inside ? `well inside the ±${lead.bandPp.toFixed(1)} pp luck alone produces` : 'outside the range luck usually produces, but with this little record one agent in several will do that by chance'}. Judge it at ${JUDGE_AFTER_DAYS} days.`,
    };
  }
  if (lead.inside) {
    return {
      tone: 'wait',
      title: 'No sign of skill yet',
      body: `After ${lead.days} trading days it is ${gap}, inside the ±${lead.bandPp.toFixed(1)} pp luck alone produces. Holding VWRP would have done about as well, for less risk and no effort.`,
    };
  }
  return lead.leadPp > 0
    ? {
        tone: 'good',
        title: 'Ahead by more than luck usually explains',
        body: `After ${lead.days} trading days it is ${gap}, outside the ±${lead.bandPp.toFixed(1)} pp band. Encouraging, not proof: with several agents, one will do this by chance.`,
      }
    : {
        tone: 'bad',
        title: 'Behind by more than luck usually explains',
        body: `After ${lead.days} trading days it is ${gap}, outside the ±${lead.bandPp.toFixed(1)} pp band. Worth considering whether to stop it; VWRP would have done better with the same money.`,
      };
}

/* ---------- Integrity ---------- */

export type Integrity = 'clean' | 'stale' | 'unknown' | 'diverged';

export interface IntegrityState {
  level: Integrity;
  title: string;
  detail: string;
}

/** Worst wins. A check that found a problem is never quieter than one that diverged. */
export function integrityOf(view: ControlPanelView): IntegrityState {
  const r = view.reconciliation;
  const when = r ? new Date(r.runAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  if (r && (r.status === 'diverged' || r.status === 'error')) {
    return {
      level: 'diverged',
      title: r.status === 'diverged' ? 'Ledger and broker disagree: investigate today' : 'The last check found a problem',
      detail: `${r.summary || 'No detail recorded.'} Every figure on this page is suspect until this is explained. Consider halting all agents. (${when})`,
    };
  }
  if (!r) {
    return { level: 'unknown', title: 'Never checked', detail: 'The ledger has not yet been compared with the broker. Press Check now.' };
  }
  if (r.stale) {
    return {
      level: 'unknown',
      title: 'No recent check',
      detail: `The nightly check has not run since ${when}. The numbers below may be right, but nothing has confirmed them since.`,
    };
  }
  const unpriced = [...new Set(view.agents.filter((a) => a.status !== 'killed').flatMap((a) => a.unpricedSymbols))];
  if (unpriced.length > 0) {
    return {
      level: 'stale',
      title: `Prices are missing for ${unpriced.join(', ')}`,
      detail: `The last check (${when}) found shares and cash matching the broker, but ${unpriced.length === 1 ? 'that holding’s' : 'those holdings’'} value is unknown, so totals below are partial.`,
    };
  }
  return { level: 'clean', title: 'Reconciled clean', detail: `Shares, cash and value all matched the broker at the last check (${when}).` };
}

/* ---------- Next step ---------- */

export interface NextStep {
  title: string;
  why: string;
  steps?: string[];
}

export function nextStep(view: ControlPanelView, integrity: IntegrityState): NextStep {
  const live = view.agents.filter((a) => a.status !== 'killed');
  const fund = BigInt(view.unallocatedMinor) + BigInt(view.allocatedMinor);

  if (integrity.level === 'diverged') {
    return { title: 'Find out why the ledger and broker disagree', why: integrity.detail, steps: ['Halt all agents while you look.', 'Read the check’s detail in Activity.', 'Press Check now once you think it is fixed.'] };
  }
  if (integrity.level === 'unknown') {
    return { title: 'Get a fresh check', why: integrity.detail, steps: ['Press Check now.', 'If it keeps failing, the nightly job may have stopped: see /api/health.'] };
  }
  if (fund <= 0n) {
    return { title: 'Record your first bank transfer', why: 'Nothing can happen until the pot has money in it. In paper mode this is pretend money: record any amount you would one day be willing to trade with.' };
  }
  if (live.length === 0) {
    return { title: 'Add your first agent', why: 'An agent starts idle, with no capital and no share list, and places nothing until you give it both.' };
  }
  const killing = live.find((a) => a.status === 'killing');
  if (killing) return { title: `Finish killing ${killing.name}`, why: 'It is part-way through being killed and can only sell. Press Kill on it again to sell what is left.' };
  const halted = live.find((a) => a.status === 'halted');
  if (halted) {
    return {
      title: `Decide what to do with ${halted.name}`,
      why: 'It is halted: frozen, but what it holds still moves with the market. Halted is safe to leave while you decide.',
      steps: ['If you halted it over something now fixed, Resume.', 'If you have lost confidence in the strategy, Kill it.'],
    };
  }
  const broke = live.find((a) => a.status === 'idle' && BigInt(a.allocatedMinor) <= 0n);
  if (broke) return { title: `Give ${broke.name} some capital`, why: 'It cannot buy anything without a budget. Use Capital on its card; the dialog suggests a sensible size.' };
  const listless = live.find((a) => a.universe.length === 0);
  if (listless) return { title: `Choose what ${listless.name} may trade`, why: 'With an empty share list it cannot open anything. Use Universe on its card.' };
  const ready = live.find((a) => a.status === 'idle');
  if (ready) return { title: `Start ${ready.name}`, why: 'It has capital and a share list. Starting begins its paper record, and nothing real is at risk.' };
  if (integrity.level === 'stale') return { title: 'Wait for tonight’s prices', why: integrity.detail };
  return { title: 'Nothing needs you today', why: 'Checking once a day is plenty. Agents only act a few times a day, and more watching tends to mean more meddling.' };
}

/* ---------- Capital advice ---------- */

/** Parse an exact decimal pounds string to pence, or null. No floats. */
export function parsePence(text: string): bigint | null {
  const m = /^\s*£?\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(text.replace(/,/g, ''));
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export interface CapitalAdvice {
  level: 'ok' | 'warn' | 'stop';
  title: string;
  detail: string;
}

export function capitalAdvice(agent: AgentView, view: ControlPanelView, addText: string, giving: boolean): CapitalAdvice {
  const add = parsePence(addText);
  if (add === null || add <= 0n) return { level: 'stop', title: 'Enter an amount above zero, like 250 or 250.00.', detail: '' };

  const pool = BigInt(view.unallocatedMinor);
  const fund = pool + BigInt(view.allocatedMinor);
  const current = BigInt(agent.allocatedMinor);

  if (!giving) {
    const cash = BigInt(agent.cashMinor);
    if (add > cash) {
      return { level: 'stop', title: `It only has £${(cash / 100n).toLocaleString('en-GB')} in cash to give back.`, detail: 'Anything invested in shares has to be sold first.' };
    }
    return { level: 'ok', title: 'Returns uninvested cash to the pool.', detail: 'It keeps what it holds; only its spending limit goes down.' };
  }

  if (add > pool) {
    return { level: 'stop', title: `The pool only has £${(pool / 100n).toLocaleString('en-GB')}.`, detail: 'To give more, record a bank transfer in first, or take capital back from another agent.' };
  }
  const after = current + add;
  const sharePct = fund > 0n ? Number((after * 100n) / fund) : 100;
  const soft = (fund * BigInt(SOFT_SHARE_PCT)) / 100n;
  const cap = agent.dailyLossCapPct;
  const capLine =
    cap === null
      ? 'It has no daily loss cap set, so nothing stops it after a bad day.'
      : `Its daily loss cap would be about £${((after * BigInt(Math.round(cap * 100))) / 1000000n).toLocaleString('en-GB')} (${cap}%). That stops it trading after a bad day, but what it holds can still fall further.`;

  if (after > soft) {
    return {
      level: 'warn',
      title: `That puts ${sharePct}% of everything into one agent with no track record.`,
      detail: `New traders usually keep each agent at or below ${SOFT_SHARE_PCT}% (£${(soft / 100n).toLocaleString('en-GB')}) until it has ${JUDGE_AFTER_DAYS} days of record. You can still go ahead; treat paper money as practice for real money. ${capLine}`,
    };
  }
  return { level: 'ok', title: `Sensible: ${agent.name} would have £${(after / 100n).toLocaleString('en-GB')}, ${sharePct}% of the fund.`, detail: capLine };
}

/* ---------- Readiness ---------- */

export interface Check {
  ok: boolean;
  label: string;
  hint: string;
  progress: string;
}

export function readinessChecks(r: Readiness, leads: (LeadSummary | null)[]): Check[] {
  const outside = leads.filter((l) => l && l.days >= JUDGE_AFTER_DAYS && !l.inside && l.leadPp > 0).length;
  return [
    { ok: r.tradingDays >= r.minTradingDays, label: `At least ${r.minTradingDays} trading days of paper record`, hint: 'About three months. The minimum before judging, not proof of skill.', progress: `${Math.min(r.tradingDays, r.minTradingDays)} / ${r.minTradingDays}` },
    { ok: r.cleanStreak >= r.minCleanNights, label: `The ledger matched the broker every night for ${r.minCleanNights} nights in a row`, hint: 'Proves the money tracking is right before trusting any number.', progress: `${Math.min(r.cleanStreak, r.minCleanNights)} / ${r.minCleanNights}` },
    { ok: outside > 0, label: 'An agent’s lead over VWRP has left the luck band, after all costs', hint: outside > 0 ? 'At least one has. Encouraging, not proof.' : 'None has yet.', progress: `${outside} / ${leads.length}` },
    { ok: r.killTested, label: 'Kill tried on paper, with an agent holding shares', hint: 'So the first real Kill is not the first Kill.', progress: r.killTested ? 'done' : 'not yet' },
    { ok: r.agentsActive > 0 && r.agentsWithLimits === r.agentsActive, label: 'A daily loss cap set on every agent', hint: 'So a bad day ends with the agent stopping itself.', progress: `${r.agentsWithLimits} / ${r.agentsActive}` },
  ];
}
