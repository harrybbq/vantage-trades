import { useMemo, useState } from 'react';
import type { ActivityItem, AgentView, ControlPanelView, PerformanceSeries, Readiness } from '../../lib/api';
import { dirOf, formatDay, formatGBP, formatPctArrow, formatPp, formatQtyShort, formatSigned, signOf } from '../../lib/format';
import {
  JUDGE_AFTER_DAYS,
  leadSummary,
  readinessChecks,
  verdictFor,
  type IntegrityState,
  type LeadSummary,
  type NextStep,
} from '../../lib/guidance';

/* ---------- Shared ---------- */

/**
 * Colour follows the agent: its place in the order agents were created,
 * counting killed ones, so neither a new agent nor a kill repaints the rest.
 */
export function agentColors(view: ControlPanelView): Map<string, string> {
  const byAge = [...view.agents].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  return new Map(byAge.map((a, i) => [a.id, `var(--a${(i % 4) + 1})`]));
}

const STATUS_LABEL: Record<AgentView['status'], string> = {
  running: 'Running',
  halted: 'Halted',
  idle: 'Idle',
  killing: 'Being killed',
  killed: 'Stood down',
};

function Pill({ status }: { status: AgentView['status'] }) {
  return (
    <span className="v-pill" data-s={status}>
      {status === 'running' && <span className="dot" />}
      {(status === 'halted' || status === 'killing') && <span className="icon">❚❚</span>}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Today's loss against the cap: a bullet graph, not a progress bar, because filling up is bad. */
function LossBullet({ lossPence, capPence }: { lossPence: bigint | null; capPence: bigint | null }) {
  if (capPence === null || capPence <= 0n) {
    return <div className="sub">No daily loss cap set.</div>;
  }
  const cap = Number(capPence);
  const max = cap * 1.15;
  const x = (v: number) => (Math.max(0, Math.min(v, max)) / max) * 100;
  const loss = lossPence === null ? 0 : Number(lossPence > 0n ? lossPence : 0n);
  return (
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="3" width={x(cap * 0.5)} height="12" fill="var(--overlay)" />
      <rect x={x(cap * 0.5)} y="3" width={x(cap * 0.3)} height="12" fill="color-mix(in srgb, var(--muted) 18%, var(--overlay))" />
      <rect x={x(cap * 0.8)} y="3" width={x(cap * 0.2)} height="12" fill="color-mix(in srgb, var(--muted) 32%, var(--overlay))" />
      <rect x="0" y="7" width={x(loss)} height="4" fill="var(--loss)" />
      <rect x={x(cap) - 0.75} y="1" width="1.5" height="16" fill="var(--text)" />
    </svg>
  );
}

function UsedBar({ used, of }: { used: bigint; of: bigint }) {
  const pct = of > 0n ? Number((used * 1000n) / of) / 10 : 0;
  return (
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="5" width="100" height="8" rx="2" fill="var(--overlay)" />
      <rect x="0" y="5" width={Math.min(100, pct)} height="8" rx="2" fill="var(--em)" opacity="0.75" />
    </svg>
  );
}

function Spark({ series, color, lo, hi }: { series: PerformanceSeries | undefined; color: string; lo: number; hi: number }) {
  const pts = series?.points ?? [];
  if (pts.length < 2) return <span className="why">{pts.length === 0 ? 'no record yet' : 'one day so far'}</span>;
  const W = 120;
  const H = 30;
  const X = (i: number) => (i / (pts.length - 1)) * W;
  const Y = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  const line = (pick: (i: number) => number | null) =>
    pts
      .map((_, i) => pick(i))
      .map((v, i) => (v === null ? '' : `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`))
      .join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="var(--border)" />
      <path d={line((i) => pts[i]!.benchPct)} fill="none" stroke="var(--bench)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={line((i) => pts[i]!.twrPct)} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------- Banner ---------- */

const GLYPH = { clean: '✓', stale: '!', unknown: '?', diverged: '✕' } as const;

export function Banner({ state, busy, onCheck, onHistory }: { state: IntegrityState; busy: boolean; onCheck: () => void; onHistory: () => void }) {
  return (
    <section className="banner" data-s={state.level} role="status" aria-live="polite">
      <div className="glyph">{GLYPH[state.level]}</div>
      <div className="t">{state.title}</div>
      <div className="d">{state.detail}</div>
      <div className="act">
        <button className="btn v-sm" onClick={onCheck} disabled={busy}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
        <button className="btn v-sm" onClick={onHistory}>
          History
        </button>
      </div>
    </section>
  );
}

/* ---------- Where you are, and the next step ---------- */

export function Coach({ view, readiness, next }: { view: ControlPanelView; readiness: Readiness | null; next: NextStep }) {
  const live = view.agents.filter((a) => a.status !== 'killed');
  const funded = BigInt(view.unallocatedMinor) + BigInt(view.allocatedMinor) > 0n;
  const setUp = live.some((a) => BigInt(a.allocatedMinor) > 0n && a.universe.length > 0);
  const days = readiness?.tradingDays ?? 0;
  const target = readiness?.minTradingDays ?? JUDGE_AFTER_DAYS;
  const stage = !funded ? 0 : !setUp ? 1 : days < target ? 2 : 3;
  const steps = [
    ['Put money in the pot', funded ? `${formatGBP((BigInt(view.unallocatedMinor) + BigInt(view.allocatedMinor)).toString())} recorded` : 'Record a bank transfer'],
    ['Set up agents', setUp ? `${live.length} agent${live.length === 1 ? '' : 's'}` : 'Each needs capital and a list of shares'],
    ['Paper-trade and watch', `Trading day ${days} of at least ${target}`],
    ['Judge each agent against VWRP', `Unlocks at ${target} trading days`],
    ['Decide about real money', 'Only if the checklist below is all ticks'],
  ];
  return (
    <section className="card coach" aria-label="Where you are and what to do next">
      <div>
        <div className="eyebrow">Where you are</div>
        <ol className="steps">
          {steps.map(([t, s], i) => (
            <li key={t} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
              <span className="n">{i < stage ? '✓' : i + 1}</span>
              <span>
                {t}
                <span className="s">{s}</span>
                {i === 2 && i === stage && (
                  <span className="prog">
                    <i style={{ width: `${Math.min(100, (days / target) * 100)}%` }} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="next">
        <div className="eyebrow">Your next step</div>
        <h3>{next.title}</h3>
        <p>{next.why}</p>
        {next.steps && (
          <ol>
            {next.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        <div className="calm">Checking once a day is plenty. Agents only act a few times a day.</div>
      </div>
    </section>
  );
}

/* ---------- The fund ---------- */

export function FundSummary({ view, colors, onFunds }: { view: ControlPanelView; colors: Map<string, string>; onFunds: () => void }) {
  const live = view.agents.filter((a) => a.status !== 'killed');
  const unpriced = [...new Set(live.flatMap((a) => a.unpricedSymbols))];
  // What is known: each agent's cash plus every holding that has a price.
  const pricedTotal = live.reduce(
    (sum, a) => sum + BigInt(a.cashMinor) + a.holdings.reduce((s, h) => s + (h.marketValueMinor === null ? 0n : BigInt(h.marketValueMinor)), 0n),
    BigInt(view.unallocatedMinor),
  );
  const realised = live.reduce((sum, a) => sum + BigInt(a.realisedMinor), 0n);
  const fund = BigInt(view.unallocatedMinor) + BigInt(view.allocatedMinor);
  const slices = live
    .filter((a) => BigInt(a.allocatedMinor) > 0n)
    .sort((a, b) => (BigInt(b.allocatedMinor) > BigInt(a.allocatedMinor) ? 1 : -1));
  const pct = (minor: bigint) => (fund > 0n ? Number((minor * 100n) / fund) : 0);

  return (
    <section className="fund">
      <div className="card">
        <div className="eyebrow">Account equity</div>
        {view.totalEquityMinor !== null ? (
          <div className="big num">{formatGBP(view.totalEquityMinor)}</div>
        ) : (
          <>
            <div className="big num">
              {formatGBP(pricedTotal.toString())}
              <small> + {unpriced.join(', ')}</small>
            </div>
            <div className="partial">◐ Partial. {unpriced.join(', ')} {unpriced.length === 1 ? 'has' : 'have'} no price, so {unpriced.length === 1 ? 'it counts' : 'they count'} as unknown: not as zero, and not at cost.</div>
          </>
        )}
        <div className="deltas">
          <div className="delta">
            <div className="k">Today</div>
            <div className={`v ${view.todayMinor === null ? 'unk' : signOf(view.todayMinor)}`}>
              {view.todayMinor === null ? <>— <span className="why">{unpriced.length ? 'needs every price' : 'no close yet to compare with'}</span></> : formatSigned(view.todayMinor)}
            </div>
          </div>
          <div className="delta">
            <div className="k">Locked in by selling</div>
            <div className={`v ${signOf(realised.toString())}`}>{formatSigned(realised.toString())}</div>
          </div>
        </div>
        <div className="explain">
          <b>Equity</b> is everything in the account: cash, plus what the shares would sell for at the latest price. It is pretend money while the app is in paper mode. <b>Locked in</b> is profit or loss from shares already sold; the rest moves with prices until it is sold. "Today" leaves out money you added or took back, so a top-up never looks like a good day.
        </div>
      </div>
      <div className="card">
        <div className="eyebrow">Where the capital is</div>
        <div className="stack" role="img" aria-label={slices.map((a) => `${a.name} ${pct(BigInt(a.allocatedMinor))}%`).join(', ') + `, unallocated ${pct(BigInt(view.unallocatedMinor))}%`}>
          {slices.map((a) => (
            <span key={a.id} style={{ flex: Number(BigInt(a.allocatedMinor) / 100n) || 1, background: colors.get(a.id) }}>
              {pct(BigInt(a.allocatedMinor)) >= 8 ? `${pct(BigInt(a.allocatedMinor))}%` : ''}
            </span>
          ))}
          {BigInt(view.unallocatedMinor) > 0n && (
            <span className="pool" style={{ flex: Number(BigInt(view.unallocatedMinor) / 100n) || 1 }}>
              {pct(BigInt(view.unallocatedMinor)) >= 8 ? `${pct(BigInt(view.unallocatedMinor))}%` : ''}
            </span>
          )}
        </div>
        <div className="v-legend">
          {slices.map((a) => (
            <FragmentRow key={a.id} color={colors.get(a.id)!} name={a.name} minor={a.allocatedMinor} pct={pct(BigInt(a.allocatedMinor))} />
          ))}
          <FragmentRow color="var(--overlay)" name="Unallocated pool" minor={view.unallocatedMinor} pct={pct(BigInt(view.unallocatedMinor))} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn v-sm" onClick={onFunds}>
            Record bank transfer
          </button>
          <span className="why">Records a transfer you made. Moves no money.</span>
        </div>
        <div className="explain">
          Each agent can only spend what you <b>give</b> it. The striped <b>pool</b> is money no agent may touch. Giving capital or taking it back moves no real money; it only changes the agent's spending limit.
        </div>
      </div>
    </section>
  );
}

function FragmentRow({ color, name, minor, pct }: { color: string; name: string; minor: string; pct: number }) {
  return (
    <>
      <span className="sw" style={{ background: color, outline: color === 'var(--overlay)' ? '1px solid var(--border)' : undefined }} />
      <span>{name}</span>
      <span className="num">{formatGBP(minor)}</span>
      <span className="pct">{pct}%</span>
    </>
  );
}

/* ---------- Agents at a glance ---------- */

export const PROBLEM_ORDER: Record<AgentView['status'], number> = { killing: 0, halted: 1, idle: 2, running: 3, killed: 4 };

export function Glance({ agents, series, colors }: { agents: AgentView[]; series: Map<string, PerformanceSeries>; colors: Map<string, string> }) {
  const live = agents.filter((a) => a.status !== 'killed').sort((a, b) => PROBLEM_ORDER[a.status] - PROBLEM_ORDER[b.status]);
  const all = live.flatMap((a) => series.get(a.id)?.points.flatMap((p) => [p.twrPct, p.benchPct ?? 0]) ?? []);
  const lo = Math.min(0, ...all) - 0.3;
  const hi = Math.max(0, ...all) + 0.3;
  if (live.length === 0) return null;
  return (
    <section className="card glance" style={{ padding: 0 }}>
      <div className="g-row g-head">
        <span>Agent</span>
        <span>Verdict</span>
        <span className="g-r">Equity</span>
        <span className="g-r">Today</span>
        <span className="g-r">vs VWRP</span>
        <span>Record · shared scale</span>
        <span>Today's loss vs cap</span>
      </div>
      {live.map((a) => {
        const s = series.get(a.id);
        const v = verdictFor(a, s?.points ?? []);
        const lead = leadSummary(s?.points ?? []);
        const cap = a.dailyLossCapPct === null ? null : (BigInt(a.allocatedMinor) * BigInt(Math.round(a.dailyLossCapPct * 100))) / 10000n;
        const loss = a.todayMinor === null ? null : -BigInt(a.todayMinor);
        return (
          <div className="g-row" key={a.id}>
            <div className="g-name">
              <span className="sw" style={{ background: colors.get(a.id), width: 12, height: 12 }} />
              <div>
                <b>{a.name}</b>
                <span className="id">
                  {a.id} · {STATUS_LABEL[a.status].toLowerCase()}
                </span>
              </div>
            </div>
            <div className="g-verdict">
              <span className={`g-vt vt-${v.tone}`}>{v.title}</span>
              {a.status === 'running' && lead ? `Day ${lead.days} of ${JUDGE_AFTER_DAYS}` : ''}
            </div>
            <div className="g-r">
              {a.equityMinor === null ? '—' : formatGBP(a.equityMinor)}
              <small>of {formatGBP(a.allocatedMinor)}</small>
            </div>
            <div className="g-r">
              <span className={a.todayMinor === null ? 'unk' : signOf(a.todayMinor)}>{formatSigned(a.todayMinor)}</span>
              <small>{formatPctArrow(a.pnlPctToday)}</small>
            </div>
            <div className="g-r">
              {lead ? <span className={dirOf(lead.leadPp)}>{formatPp(lead.leadPp)}</span> : '—'}
              <small>{lead ? (lead.inside ? 'inside luck band' : 'outside luck band') : 'no record yet'}</small>
            </div>
            <div>
              <Spark series={s} color={colors.get(a.id)!} lo={lo} hi={hi} />
            </div>
            <div className="limit">
              <div className="row">
                <span className="num">
                  {loss === null ? '—' : formatGBP((loss > 0n ? loss : 0n).toString())} / {cap === null ? 'no cap' : formatGBP(cap.toString())}
                </span>
              </div>
              <LossBullet lossPence={loss} capPence={cap} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ---------- One agent ---------- */

function Calendar({ series }: { series: PerformanceSeries }) {
  const pts = series.points;
  if (pts.length < 2) return null;
  const byDay = new Map(pts.map((p) => [p.date, p]));
  const first = new Date(`${pts[0]!.date}T12:00:00Z`);
  const today = new Date();
  const cells: JSX.Element[] = [];
  const lead = (first.getUTCDay() + 6) % 7;
  for (let k = 0; k < lead && k < 5; k++) cells.push(<span key={`b${k}`} className="c blank" />);
  const d = new Date(first);
  let up = 0;
  let down = 0;
  while (d <= today) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const key = d.toISOString().slice(0, 10);
      const p = byDay.get(key);
      const dn = d.getUTCDate();
      if (!p) {
        cells.push(
          <span key={key} className="c np" title={`${formatDay(key)}: no check`}>
            <span>{dn}</span>
            <b style={{ color: 'var(--halt)' }}>—</b>
          </span>,
        );
      } else if (p.dayPnlMinor === null) {
        cells.push(
          <span key={key} className="c blank" title={formatDay(key)}>
            <span>{dn}</span>
            <b style={{ color: 'var(--em)' }}>start</b>
          </span>,
        );
      } else {
        const s = signOf(p.dayPnlMinor);
        if (s === 'up') up += 1;
        if (s === 'down') down += 1;
        cells.push(
          <span key={key} className={`c ${s === 'up' ? 'up' : s === 'down' ? 'down' : ''}`} title={`${formatDay(key)}: ${formatSigned(p.dayPnlMinor)}${p.trades ? `, ${p.trades} trade${p.trades > 1 ? 's' : ''}` : ''}`}>
            <span>{dn}</span>
            <b>{formatSigned(p.dayPnlMinor)}</b>
            <span className="t">{'•'.repeat(Math.min(p.trades, 5))}</span>
          </span>,
        );
      }
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return (
    <details className="cal">
      <summary>
        Day by day: <b>{up} up</b>, <b>{down} down</b>
      </summary>
      <div className="calgrid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((h) => (
          <span key={h} className="h">
            {h}
          </span>
        ))}
        {cells}
      </div>
      <div className="why" style={{ marginTop: 6 }}>
        Each square is one trading day's gain or loss in £, with money added or taken back left out; dots are trades. Striped means no check that day. One good week can look like skill; this shows whether it was many small days or one lucky one.
      </div>
    </details>
  );
}

interface AgentActions {
  onCapital: () => void;
  onUniverse: () => void;
  onHalt: () => void;
  onStart: () => void;
  onKill: () => void;
}

export function AgentPanel({ agent, color, series, busy, first, ...act }: { agent: AgentView; color: string; series: PerformanceSeries | undefined; busy: boolean; first: boolean } & AgentActions) {
  const v = verdictFor(agent, series?.points ?? []);
  const alloc = BigInt(agent.allocatedMinor);
  const cap = agent.dailyLossCapPct === null ? null : (alloc * BigInt(Math.round(agent.dailyLossCapPct * 100))) / 10000n;
  const loss = agent.todayMinor === null ? null : -BigInt(agent.todayMinor);
  const maxOrder = (alloc * BigInt(Math.round(agent.maxOrderPct * 100))) / 10000n;
  const unrealised = agent.holdings.every((h) => h.marketValueMinor !== null)
    ? agent.holdings.reduce((s, h) => s + BigInt(h.marketValueMinor!) - BigInt(h.costBasisMinor), 0n)
    : null;
  const sinceStart = agent.equityMinor === null ? null : BigInt(agent.equityMinor) - alloc;
  const atCost = agent.holdings.reduce((s, h) => s + BigInt(h.costBasisMinor), 0n);

  return (
    <article className="card agent" data-status={agent.status} style={{ ['--agent' as string]: color }}>
      <div className="a-head">
        <div>
          <h3>{agent.name}</h3>
          <div className="id">{agent.id}</div>
        </div>
        <Pill status={agent.status} />
      </div>

      <div>
        <div className="a-eq">
          {agent.equityMinor === null ? '—' : formatGBP(agent.equityMinor)} <span className="of">of {formatGBP(agent.allocatedMinor)}</span>
        </div>
        {agent.equityMinor === null && (
          <div className="why">
            {formatGBP((BigInt(agent.cashMinor) + agent.holdings.reduce((s, h) => s + (h.marketValueMinor === null ? 0n : BigInt(h.marketValueMinor)), 0n)).toString())} priced, plus {agent.unpricedSymbols.join(', ')} with no price
          </div>
        )}
      </div>

      {agent.status !== 'idle' && (
        <div className="a-split">
          <div>
            <div className="k">Since start</div>
            <div className={`v ${sinceStart === null ? 'unk' : signOf(sinceStart.toString())}`}>{sinceStart === null ? '—' : formatSigned(sinceStart.toString())}</div>
          </div>
          <div>
            <div className="k">Locked in</div>
            <div className={`v ${signOf(agent.realisedMinor)}`}>{formatSigned(agent.realisedMinor)}</div>
          </div>
          <div>
            <div className="k">Still moving</div>
            <div className={`v ${unrealised === null ? 'unk' : signOf(unrealised.toString())}`}>{unrealised === null ? '—' : formatSigned(unrealised.toString())}</div>
          </div>
        </div>
      )}

      <div className="verdict" data-v={v.tone}>
        <span className={`vt-title vt-${v.tone === 'decide' ? 'decide' : v.tone}`}>{v.title}</span>
        {v.body}
        {v.options && (
          <ul>
            {v.options.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="limits">
        <div className="limit">
          <div className="row">
            <span>Today's loss vs daily cap (about)</span>
            <span className="num">
              {loss === null ? '—' : formatGBP((loss > 0n ? loss : 0n).toString())} / {cap === null ? 'none' : formatGBP(cap.toString())}
            </span>
          </div>
          <LossBullet lossPence={loss} capPence={cap} />
          <div className="sub">
            {agent.status === 'halted'
              ? 'Halted, so it cannot trade today. What it holds still moves with the market.'
              : `The black tick is the cap: ${agent.dailyLossCapPct ?? '—'}% of the day's opening value, shown here against its allocation.`}
          </div>
        </div>
        <div className="limit">
          <div className="row">
            <span>Invested (at cost) vs allocation</span>
            <span className="num">
              {formatGBP(atCost.toString())} / {formatGBP(agent.allocatedMinor)}
            </span>
          </div>
          <UsedBar used={atCost} of={alloc} />
        </div>
        <div className="limit">
          <div className="row">
            <span>Largest single order allowed</span>
            <span className="num">{formatGBP(maxOrder.toString())}</span>
          </div>
        </div>
        {first && (
          <div className="explain" style={{ marginTop: 0 }}>
            These are its <b>limits</b>. If it loses its daily cap in a day it stops <b>trading</b> until tomorrow, but what it already holds can still fall further: the cap limits what it does, not what the market does. No single purchase can be bigger than the largest order.
          </div>
        )}
      </div>

      {series && <Calendar series={series} />}

      {agent.holdings.length > 0 ? (
        <table className="holds">
          <thead>
            <tr>
              <th>Holding</th>
              <th>Qty</th>
              <th>Cost</th>
              <th>Value</th>
              <th>Gain</th>
            </tr>
          </thead>
          <tbody>
            {agent.holdings.map((h) => {
              const gain = h.marketValueMinor === null ? null : (BigInt(h.marketValueMinor) - BigInt(h.costBasisMinor)).toString();
              return (
                <tr key={h.symbol}>
                  <td className="sym">
                    {h.symbol}
                    {h.marketValueMinor === null && <small className="old">◐ no price</small>}
                  </td>
                  <td>{formatQtyShort(h.qty)}</td>
                  <td>{formatGBP(h.costBasisMinor)}</td>
                  <td>{h.marketValueMinor === null ? <span className="unk">—</span> : formatGBP(h.marketValueMinor)}</td>
                  <td className={gain === null ? 'unk' : signOf(gain)}>{formatSigned(gain)}</td>
                </tr>
              );
            })}
            <tr className="cash">
              <td>Cash</td>
              <td />
              <td />
              <td>{formatGBP(agent.cashMinor)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="why">Nothing held. All {formatGBP(agent.cashMinor)} is cash.</div>
      )}
      {first && agent.holdings.length > 0 && (
        <div className="explain" style={{ marginTop: 0 }}>
          <b>Value</b> is what the shares would sell for at the latest price. <b>Locked in</b> is profit from shares it has sold; <b>still moving</b> is the rest, which changes with prices until it sells.
        </div>
      )}

      <div className="chip-row">
        {agent.universe.length === 0 ? <span className="why">No share list: it cannot open anything.</span> : agent.universe.map((s) => <span key={s} className="mini-chip">{s}</span>)}
      </div>

      <div className="a-actions">
        <button className="btn v-sm" onClick={act.onCapital} disabled={busy || agent.status === 'killing'}>
          Capital
        </button>
        <button className="btn v-sm" onClick={act.onUniverse} disabled={busy}>
          Universe
        </button>
        <span className="spacer" />
        {agent.status === 'running' ? (
          // Never disabled: halting can only reduce what an agent does, so it
          // must not wait behind a slow request.
          <button className="btn v-sm" onClick={act.onHalt}>
            <span className="icon">❚❚</span>Halt
          </button>
        ) : agent.status === 'killing' ? null : (
          <button className="btn v-sm v-primary" onClick={act.onStart} disabled={busy}>
            ▶ {agent.status === 'idle' ? 'Start' : 'Resume'}
          </button>
        )}
        <button className="btn v-sm v-danger" onClick={act.onKill} disabled={busy}>
          {agent.status === 'killing' ? 'Finish kill…' : 'Kill…'}
        </button>
      </div>
    </article>
  );
}

/* ---------- Who owns what ---------- */

export function Ownership({ view, colors }: { view: ControlPanelView; colors: Map<string, string> }) {
  const o = view.ownership;
  if (o.symbols.length === 0) return <div className="why">Nothing held yet.</div>;
  return (
    <table className="owners">
      <thead>
        <tr>
          <th>Share</th>
          <th>Owned by</th>
          <th>Ledger total</th>
          <th>Broker holds</th>
          <th>Match</th>
        </tr>
      </thead>
      <tbody>
        {o.symbols.map((s) => {
          const match = s.brokerQty === null ? null : s.brokerQty === s.ledgerQty;
          return (
            <tr key={s.symbol}>
              <td>{s.symbol}</td>
              <td>
                <span className="own-split">
                  {s.owners.map((w, i) => (
                    <span key={w.agentId}>
                      {i > 0 && <span className="why">+</span>}
                      <span className="sw" style={{ background: colors.get(w.agentId) }} title={w.agentId} />
                      {formatQtyShort(w.qty)}
                    </span>
                  ))}
                </span>
              </td>
              <td>{formatQtyShort(s.ledgerQty)}</td>
              <td>{s.brokerQty === null ? '—' : formatQtyShort(s.brokerQty)}</td>
              <td className={match === false ? 'down' : 'ok'}>{match === null ? '—' : match ? '✓' : '✗ mismatch'}</td>
            </tr>
          );
        })}
        <tr>
          <td>Cash</td>
          <td className="why" style={{ textAlign: 'right' }}>
            agents + pool
          </td>
          <td>{formatGBP(o.ledgerCashMinor)}</td>
          <td>{formatGBP(o.brokerCashMinor)}</td>
          <td className={o.brokerCashMinor !== null && o.brokerCashMinor !== o.ledgerCashMinor ? 'down' : 'ok'}>
            {o.brokerCashMinor === null ? '—' : o.brokerCashMinor === o.ledgerCashMinor ? '✓' : '✗ mismatch'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/* ---------- Ready for real money? ---------- */

export function ReadinessCard({ readiness, leads }: { readiness: Readiness; leads: (LeadSummary | null)[] }) {
  const checks = readinessChecks(readiness, leads);
  return (
    <section className="card">
      <ul className="ready-list">
        {checks.map((c) => (
          <li key={c.label}>
            <span className={c.ok ? 'ok' : 'no'}>{c.ok ? '✓' : '✗'}</span>
            <span>
              {c.label}
              <span className="s">{c.hint}</span>
            </span>
            <span className="num">{c.progress}</span>
          </li>
        ))}
      </ul>
      <div className="explain">
        Even with every tick, a few months ahead of VWRP is weak evidence: proving real skill usually takes years of record. Most strategies that win on paper don't win with real money, because real trades pay the spread and get worse prices. If you go live, start with an amount you would be fine losing entirely.
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn v-sm" disabled title="There is no live broker connected, and the checklist is not complete.">
          🔒 Switch to real money
        </button>
      </div>
    </section>
  );
}

/* ---------- Activity ---------- */

type Filter = 'all' | ActivityItem['kind'];

function csv(items: ActivityItem[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = items.map((i) => [i.at, i.kind, i.agentId ?? '', i.title, i.tags.join('; '), i.amountMinor === null ? '' : formatGBP(i.amountMinor)].map(cell).join(','));
  return ['at,kind,agent,what,detail,amount', ...rows].join('\n');
}

export function Activity({ items, colors, onFind }: { items: ActivityItem[] | null; colors: Map<string, string>; onFind: (item: ActivityItem) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = useMemo(() => (items ?? []).filter((i) => filter === 'all' || i.kind === filter), [items, filter]);

  const download = () => {
    const blob = new Blob([csv(items ?? [])], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vantage-trades-activity.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="section-h" id="activity">
        <h2>Activity</h2>
        <span className="sub">Trades, your actions and checks. Click a trade to find it on the chart.</span>
        <div className="feed-tools">
          {(
            [
              ['all', 'All'],
              ['fill', 'Trades'],
              ['control', 'Controls'],
              ['money', 'Money'],
              ['check', 'Checks'],
            ] as const
          ).map(([f, label]) => (
            <button key={f} className="chipf" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
          <button className="chipf" onClick={download} disabled={!items?.length}>
            ⤓ CSV
          </button>
        </div>
      </div>
      <div className="explain" style={{ margin: '0 0 10px' }}>
        The <b>spread</b> is the gap between the price you can buy at and the price you can sell at. Every trade pays it, and it usually costs more than any fee. It is why trading often loses to doing nothing.
      </div>
      <section className="card" style={{ padding: 0 }}>
        {items === null ? (
          <div className="loading">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="empty">Nothing here yet.</div>
        ) : (
          shown.map((i) => {
            const Tag = i.kind === 'fill' && i.agentId ? 'button' : 'div';
            const glyph = i.kind === 'fill' ? (i.title.startsWith('Bought') ? '▲' : '▼') : i.kind === 'control' ? '❚❚' : i.kind === 'money' ? '£' : '✓';
            return (
              <Tag key={`${i.at}${i.title}${i.agentId}`} className="ev" data-k={i.kind === 'check' ? 'recon' : i.kind} onClick={Tag === 'button' ? () => onFind(i) : undefined}>
                <span className="when">{new Date(i.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="ic">{glyph}</span>
                <span>
                  {i.title}
                  <span className="who">
                    {i.agentId && (
                      <span className="badge">
                        <span className="sw" style={{ background: colors.get(i.agentId) ?? 'var(--muted)' }} />
                        {i.agentId}
                      </span>
                    )}
                    {i.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </span>
                </span>
                <span className={`amt ${i.amountMinor && !i.amountMinor.startsWith('-') && i.kind === 'fill' ? 'up' : ''}`}>{i.amountMinor === null ? '' : formatSigned(i.amountMinor)}</span>
              </Tag>
            );
          })
        )}
      </section>
    </>
  );
}
