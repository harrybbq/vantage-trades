import { describe, expect, it } from 'vitest';
import { capitalAdvice, integrityOf, leadSummary, limitsAdvice, nextStep, parsePence, verdictFor } from '../lib/guidance';
import type { PerformancePoint } from '../lib/api';
import { agent, view } from './fixtures';

const points = (n: number, lead: (i: number) => number): PerformancePoint[] =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    equityMinor: '100000',
    shadowMinor: '100000',
    putInMinor: '100000',
    dayPnlMinor: i ? '0' : null,
    twrPct: lead(i) + Math.sin(i) * 0.3,
    benchPct: Math.sin(i) * 0.3,
    trades: 0,
  }));

describe('the integrity banner', () => {
  it('treats a check that found a problem as loudly as a divergence', () => {
    const s = integrityOf(view({ reconciliation: { status: 'error', asOf: 'x', runAt: '2026-10-02T22:37:00Z', summary: 'a fill could not be recorded', stale: false } }));
    expect(s.level).toBe('diverged');
    expect(s.detail).toMatch(/could not be recorded/);
  });

  it('calls a missed nightly check unknown, not clean', () => {
    const s = integrityOf(view({ reconciliation: { status: 'ok', asOf: 'x', runAt: '2026-09-28T22:37:00Z', summary: '', stale: true } }));
    expect(s.level).toBe('unknown');
  });

  it('calls a missing price stale, and names the share', () => {
    const s = integrityOf(view({ agents: [agent({ unpricedSymbols: ['BARC'], equityMinor: null })] }));
    expect(s.level).toBe('stale');
    expect(s.title).toMatch(/BARC/);
  });
});

describe('verdicts', () => {
  it('refuses to judge before 60 days, however good it looks', () => {
    const v = verdictFor(agent(), points(29, (i) => i * 0.5));
    expect(v.title).toMatch(/Too early/);
  });

  it('calls a lead inside the band no sign of skill, even after 60 days', () => {
    const v = verdictFor(agent(), points(70, () => 0.1));
    expect(v.title).toMatch(/No sign of skill/);
  });

  it('spells out the options for a halted agent', () => {
    expect(verdictFor(agent({ status: 'halted' }), []).options?.length).toBe(2);
  });

  it('widens the luck band with time', () => {
    const early = leadSummary(points(10, () => 0))!;
    const late = leadSummary(points(60, () => 0))!;
    expect(late.bandPp).toBeGreaterThan(early.bandPp);
  });
});

describe('capital advice', () => {
  it('refuses more than the pool holds', () => {
    expect(capitalAdvice(agent({ allocatedMinor: '0' }), view(), '2000', true).level).toBe('stop');
  });

  it('warns above a quarter of the fund for an untested agent', () => {
    // Fund £5,100; agent already has £2,000.
    expect(capitalAdvice(agent(), view(), '300', true).level).toBe('warn');
  });

  it('is calm about a modest top-up', () => {
    expect(capitalAdvice(agent({ allocatedMinor: '60000' }), view(), '300', true).level).toBe('ok');
  });

  it('reads pounds exactly, without floats', () => {
    expect(parsePence('1,234.5')).toBe(123450n);
    expect(parsePence('£0.07')).toBe(7n);
    expect(parsePence('1.234')).toBeNull();
  });
});

describe('the next step', () => {
  it('puts a halted agent ahead of anything routine', () => {
    const v = view({ agents: [agent(), agent({ id: 'meanrev-1', name: 'Mean reversion', status: 'halted' })] });
    expect(nextStep(v, integrityOf(v)).title).toMatch(/Mean reversion/);
  });

  it('says so when nothing needs doing', () => {
    const v = view();
    expect(nextStep(v, integrityOf(v)).title).toBe('Nothing needs you today');
  });
});

describe('the first run', () => {
  it('asks for a bank transfer first, not a check of an empty ledger', () => {
    const v = view({ unallocatedMinor: '0', allocatedMinor: '0', agents: [], reconciliation: null });
    expect(nextStep(v, integrityOf(v)).title).toBe('Record your first bank transfer');
  });

  it('then an agent', () => {
    const v = view({ unallocatedMinor: '500000', allocatedMinor: '0', agents: [], reconciliation: null });
    expect(nextStep(v, integrityOf(v)).title).toBe('Add your first agent');
  });
});

describe('a hold agent', () => {
  const hold = agent({ id: 'hold-1', name: 'Hold VWRP', strategy: 'hold', dailyLossCapPct: null, maxOrderPct: 100, universe: ['VWRP'] });

  it('is never judged: it is the benchmark', () => {
    expect(verdictFor(hold, points(70, () => -0.2)).title).toMatch(/Nothing to judge/);
  });

  it('gets no size warning, because holding the index is the default', () => {
    expect(capitalAdvice(hold, view(), '1500', true).level).toBe('ok');
    expect(capitalAdvice(hold, view(), '1501', true).level).toBe('stop');
  });

  it('is not nagged about having no loss cap', () => {
    expect(limitsAdvice(hold, null, '100').level).toBe('ok');
  });
});

describe('limits advice', () => {
  it('says what a cap means in pounds for this agent', () => {
    // £2,000 allocated, 2.5% cap.
    expect(limitsAdvice(agent(), '2.5', '25').title).toMatch(/£50\.00/);
    expect(limitsAdvice(agent(), '2.5', '25').detail).toMatch(/£500\.00/);
  });

  it('warns when a trading agent has no cap, or a very loose one', () => {
    expect(limitsAdvice(agent(), null, '25').level).toBe('warn');
    expect(limitsAdvice(agent(), '15', '25').level).toBe('warn');
  });

  it('refuses values that are not percentages', () => {
    expect(limitsAdvice(agent(), '0', '25').level).toBe('stop');
    expect(limitsAdvice(agent(), '3', '101').level).toBe('stop');
    expect(limitsAdvice(agent(), 'lots', '25').level).toBe('stop');
  });
});

describe('alerts', () => {
  it('become the next step once something is running and nothing would tell the owner', () => {
    const v = view({ alerts: { channel: null } });
    expect(nextStep(v, integrityOf(v)).title).toMatch(/Set up alerts/);
  });

  it('are not pushed before anything is running', () => {
    const v = view({ alerts: { channel: null }, agents: [agent({ status: 'idle' })] });
    expect(nextStep(v, integrityOf(v)).title).toMatch(/Start Momentum/);
  });
});
