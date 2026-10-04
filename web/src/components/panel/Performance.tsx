import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItem, PerformancePoint, PerformanceSeries } from '../../lib/api';
import { formatDay, formatDayShort, formatGBP, formatPp, dirOf } from '../../lib/format';
import { band, leadVolatility, MIN_CHART_DAYS } from '../../lib/guidance';

/**
 * Is it beating doing nothing? Three panels on one timeline:
 *
 *   1. return since the start (or £), with the same money in VWRP dashed and
 *      the gap between them shaded ahead/behind
 *   2. the lead in pp, inside graded bands showing where luck alone would put it
 *   3. how far below its best-ever value it is
 *
 * The timeline is every weekday from the first point, so a day with no check
 * is a gap in the lines rather than being silently squeezed out. Money values
 * are turned into numbers here only to place pixels; every figure printed
 * comes from the server's integers.
 */

type Unit = 'pct' | 'gbp';
type Range = 'all' | '10' | '21';

interface Props {
  series: PerformanceSeries;
  color: string;
  events: ActivityItem[];
  focusDay: string | null;
}

const pence = (s: string | null) => (s === null ? null : Number(s) / 100);
const sgn = (v: number, unit = '%', dp = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}${unit}`;

function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function ticks(lo: number, hi: number, target: number): number[] {
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}

function eventGlyph(items: ActivityItem[]): { glyph: string; color: string; text: string } | null {
  if (items.length === 0) return null;
  const fills = items.filter((i) => i.kind === 'fill');
  const halt = items.find((i) => i.kind === 'control' && /Halt/.test(i.title));
  if (halt) return { glyph: '❚❚', color: 'var(--halt)', text: items.map((i) => i.title).join(' · ') };
  if (items.some((i) => i.kind === 'money' || (i.kind === 'control' && i.title === 'Started'))) {
    return { glyph: '◆', color: 'var(--em)', text: items.map((i) => i.title).join(' · ') };
  }
  if (fills.length) {
    const buys = fills.some((f) => f.title.startsWith('Bought'));
    const sells = fills.some((f) => f.title.startsWith('Sold'));
    return { glyph: buys && sells ? '▲▼' : buys ? '▲' : '▼', color: 'var(--mid)', text: fills.map((f) => f.title).join(' · ') };
  }
  return null;
}

export function Performance({ series, color, events, focusDay }: Props) {
  const [unit, setUnit] = useState<Unit>('pct');
  const [range, setRange] = useState<Range>('all');
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(900);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pts = series.points;
  const enough = pts.length >= MIN_CHART_DAYS;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(300, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(300, el.clientWidth));
    return () => ro.disconnect();
    // Re-attached when the chart replaces the empty state, which has no box.
  }, [enough]);

  const model = useMemo(() => {
    if (pts.length === 0) return null;
    const first = pts[0]!.date;
    const last = pts[pts.length - 1]!.date;
    const today = new Date().toISOString().slice(0, 10);
    const days = weekdays(first, today > last ? today : last);
    const byDay = new Map(pts.map((p) => [p.date, p]));
    const at: (PerformancePoint | null)[] = days.map((d) => byDay.get(d) ?? null);
    const lk = at.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).pop() ?? 0;

    // Drawdown over the whole record, from the time-weighted index.
    let peak = -Infinity;
    let peakB = -Infinity;
    const dd = at.map((p) => {
      if (!p) return null;
      const v = 1 + p.twrPct / 100;
      peak = Math.max(peak, v);
      return (v / peak - 1) * 100;
    });
    const ddB = at.map((p) => {
      if (!p || p.benchPct === null) return null;
      const v = 1 + p.benchPct / 100;
      peakB = Math.max(peakB, v);
      return (v / peakB - 1) * 100;
    });
    let put: number | null = null;
    const putIn = at.map((p) => {
      if (p) put = pence(p.putInMinor);
      return put;
    });
    return { days, at, lk, dd, ddB, putIn, sd: leadVolatility(pts) };
  }, [pts]);

  if (!model || !enough) {
    return (
      <div className="empty">
        <b>Not enough data yet</b>
        {pts.length === 0
          ? `${series.name} has no record to compare with VWRP yet. The first point appears after a nightly check with a VWRP price.`
          : `${pts.length} of ${MIN_CHART_DAYS} trading days so far. The chart appears at ${MIN_CHART_DAYS}; before that a line would invite reading a trend into a few days of noise.`}
      </div>
    );
  }

  const { days, at, lk, dd, ddB, putIn, sd } = model;
  const n = days.length;
  const x0 = range === 'all' ? 0 : Math.max(0, lk - Number(range) + 1);
  const x1 = n - 1;
  const base = at.slice(x0).find((p) => p !== null) ?? at[lk]!;
  const rebase = (v: number | null, b: number | null) => (v === null || b === null ? null : ((1 + v / 100) / (1 + b / 100) - 1) * 100);

  const ser = at.map((p, i) => (i < x0 || !p ? null : rebase(p.twrPct, base.twrPct)));
  const ben = at.map((p, i) => (i < x0 || !p ? null : rebase(p.benchPct, base.benchPct)));
  const gap = ser.map((v, i) => (v === null || ben[i] === null ? null : v - ben[i]!));
  const eq = at.map((p, i) => (i < x0 || !p ? null : pence(p.equityMinor)));
  const sh = at.map((p, i) => (i < x0 || !p ? null : pence(p.shadowMinor)));
  const put = putIn.map((v, i) => (i < x0 ? null : v));
  const A = unit === 'pct' ? ser : eq;
  const B = unit === 'pct' ? ben : sh;

  const small = width < 560;
  const W = width;
  const L = unit === 'gbp' ? 54 : 40;
  const R = small ? 78 : 112;
  const P1 = { y: 16, h: small ? 170 : 200 };
  const P2 = { y: P1.y + P1.h + 46, h: small ? 100 : 118 };
  const P3 = { y: P2.y + P2.h + 34, h: 64 };
  const H = P3.y + P3.h + 30;
  const X = (i: number) => L + ((i - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const scale = (P: { y: number; h: number }, lo: number, hi: number) => (v: number) => P.y + P.h - ((v - lo) / (hi - lo || 1)) * P.h;
  const vals = (...arrs: (number | null)[][]) => arrs.flat().filter((v): v is number => v !== null && Number.isFinite(v));

  let lo1: number;
  let hi1: number;
  if (unit === 'pct') {
    const v = vals(A, B);
    lo1 = Math.min(0, ...v) - 0.4;
    hi1 = Math.max(0, ...v) + 0.4;
  } else {
    const v = vals(A, B, put);
    const span = Math.max(1, Math.max(...v) - Math.min(...v));
    lo1 = Math.min(...v) - span * 0.12;
    hi1 = Math.max(...v) + span * 0.12;
  }
  const Y1 = scale(P1, lo1, hi1);
  const bandAt = (i: number, z: number) => band(sd, i - x0, z);
  const bandMax = bandAt(x1, 1.96);
  const v2 = vals(gap);
  const lo2 = Math.min(-bandMax, ...v2) - 0.5;
  const hi2 = Math.max(bandMax, ...v2) + 0.5;
  const Y2 = scale(P2, lo2, hi2);
  const ddW = dd.map((v, i) => (i < x0 ? null : v));
  const ddBW = ddB.map((v, i) => (i < x0 ? null : v));
  const lo3 = Math.min(-0.5, ...vals(ddW, ddBW)) - 0.3;
  const Y3 = scale(P3, lo3, 0);

  const segments = (arr: (number | null)[], Y: (v: number) => number): [number, number][][] => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (let i = x0; i <= x1; i++) {
      const v = arr[i];
      if (v === null || v === undefined) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push([X(i), Y(v)]);
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const path = (arr: (number | null)[], Y: (v: number) => number) =>
    segments(arr, Y)
      .map((s) => (s.length === 1 ? `M${s[0]![0] - 1.5},${s[0]![1]}h3` : `M${s.map((p) => p.join(',')).join('L')}`))
      .join('');

  const fills: JSX.Element[] = [];
  for (let i = x0; i < x1; i++) {
    const a1 = A[i];
    const a2 = A[i + 1];
    const b1 = B[i];
    const b2 = B[i + 1];
    if (a1 == null || a2 == null || b1 == null || b2 == null) continue;
    const d1 = a1 - b1;
    const d2 = a2 - b2;
    const quad = (xa: number, ya1: number, yb1: number, xb: number, ya2: number, yb2: number, pos: boolean, k: string) => (
      <polygon key={k} points={`${xa},${ya1} ${xb},${ya2} ${xb},${yb2} ${xa},${yb1}`} fill={pos ? 'var(--gain-fill)' : 'var(--loss-fill)'} />
    );
    if (d1 * d2 >= 0) fills.push(quad(X(i), Y1(a1), Y1(b1), X(i + 1), Y1(a2), Y1(b2), d1 + d2 >= 0, `f${i}`));
    else {
      const t = d1 / (d1 - d2);
      const xm = X(i) + t * (X(i + 1) - X(i));
      const ym = Y1(a1 + t * (a2 - a1));
      fills.push(quad(X(i), Y1(a1), Y1(b1), xm, ym, ym, d1 > 0, `f${i}a`), quad(xm, ym, ym, X(i + 1), Y1(a2), Y1(b2), d2 > 0, `f${i}b`));
    }
  }

  const eventsByDay = new Map<string, ActivityItem[]>();
  for (const e of events) {
    const d = e.at.slice(0, 10);
    eventsByDay.set(d, [...(eventsByDay.get(d) ?? []), e]);
  }

  const shortName = small ? series.name.split(' ')[0] : series.name;
  const fmt1 = (v: number) => (unit === 'pct' ? sgn(v) : `£${Math.round(v).toLocaleString('en-GB')}`);
  type Label = { y: number; t: string; c: string; cls?: string };
  const spread = (labels: Label[], gapPx: number) => {
    labels.sort((a, b) => a.y - b.y);
    for (let k = 0; k < 4; k++)
      for (let i = 1; i < labels.length; i++) {
        const d = labels[i]!.y - labels[i - 1]!.y;
        if (d < gapPx) {
          labels[i]!.y += (gapPx - d) / 2;
          labels[i - 1]!.y -= (gapPx - d) / 2;
        }
      }
    return labels;
  };
  const ends: Label[] =
    small && unit === 'gbp'
      ? [{ y: Y1(A[lk]!), t: fmt1(A[lk]!), c: 'var(--text)' }]
      : [
          { y: Y1(A[lk]!), t: small ? fmt1(A[lk]!) : `${shortName} ${fmt1(A[lk]!)}`, c: 'var(--text)' },
          ...(B[lk] != null ? [{ y: Y1(B[lk]!), t: `VWRP ${fmt1(B[lk]!)}`, c: 'var(--muted)' }] : []),
          ...(unit === 'gbp' && put[lk] != null ? [{ y: Y1(put[lk]!), t: `Put in £${Math.round(put[lk]!).toLocaleString('en-GB')}`, c: 'var(--mid)' }] : []),
        ];
  const gl = gap[lk] ?? 0;
  const glC = gl >= 0 ? 'var(--gain)' : 'var(--loss)';
  const ends2 = spread(
    [
      { y: Y2(gl), t: `${gl >= 0 ? '+' : '−'}${Math.abs(gl).toFixed(1)} pp`, c: glC, cls: 'end-label' },
      { y: Y2(bandMax), t: small ? `±${bandMax.toFixed(1)}` : `19 in 20: ±${bandMax.toFixed(1)}`, c: 'var(--muted)', cls: 'tick' },
    ],
    13,
  );

  const near = (clientX: number) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    return Math.max(x0, Math.min(x1, Math.round(x0 + ((px - L) / (W - L - R)) * (x1 - x0))));
  };
  const focusIdx = focusDay ? days.indexOf(focusDay) : -1;
  const shown = hover ?? (focusIdx >= x0 ? focusIdx : null);
  const di = shown ?? lk;
  const p = at[di];
  const ev = eventGlyph(eventsByDay.get(days[di]!) ?? []);

  const step = (arr: (number | null)[]) => {
    let d = '';
    let prev: number | null = null;
    for (let i = x0; i <= x1; i++) {
      const v = arr[i];
      if (v == null) continue;
      d += prev === null ? `M${X(i)},${Y1(v)}` : `L${X(i)},${Y1(prev)}L${X(i)},${Y1(v)}`;
      prev = v;
    }
    return d;
  };

  return (
    <div>
      <div className="perf-controls" style={{ marginTop: 4 }}>
        <span className="seg" aria-label="Show as">
          {(['pct', 'gbp'] as const).map((u) => (
            <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
              {u === 'pct' ? '%' : '£'}
            </button>
          ))}
        </span>
        <span className="seg" aria-label="Time range">
          {(
            [
              ['10', '2W'],
              ['21', '1M'],
              ['all', 'All'],
            ] as const
          )
            .filter(([r]) => r === 'all' || Number(r) < n)
            .map(([r, label]) => (
              <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
                {label}
              </button>
            ))}
        </span>
        {range !== 'all' && <span className="why">The verdict and lead always use the full record, not the window.</span>}
      </div>

      <div className="readout" aria-live="polite">
        <span className="d">
          {formatDay(days[di]!)}
          {shown === null && <small> latest</small>}
        </span>
        <span className="i">
          <span className="k" style={{ borderColor: color }} />
          {shortName}{' '}
          <b>{p ? `${sgn(ser[di] ?? 0, '%', 2)} · ${formatGBP(p.equityMinor)}` : '— no check that day'}</b>
        </span>
        <span className="i">
          <span className="k" style={{ borderColor: 'var(--bench)', borderTopStyle: 'dashed' }} />
          VWRP <b>{p && ben[di] != null ? `${sgn(ben[di]!, '%', 2)} · ${formatGBP(p.shadowMinor)}` : '—'}</b>
        </span>
        <span className="i">
          Lead <b className={dirOf(gap[di] ?? null)}>{gap[di] == null ? '—' : formatPp(gap[di]!)}</b>
        </span>
        <span className="i">
          Luck 19 in 20 <b>±{bandAt(di, 1.96).toFixed(1)} pp</b>
        </span>
        <span className="i">
          Below best <b>{dd[di] == null ? '—' : dd[di]! < -0.005 ? `−${Math.abs(dd[di]!).toFixed(1)}%` : '0'}</b>
        </span>
        {ev && <span className="i ev">{ev.glyph} {ev.text}</span>}
      </div>

      <div className="chart-wrap" ref={box}>
        <svg
          ref={svg}
          className="perf"
          viewBox={`0 0 ${W} ${H}`}
          style={{ height: H }}
          tabIndex={0}
          role="img"
          aria-label={`${series.name}: return, lead over VWRP and drawdown by trading day. Arrow keys step through days.`}
          onPointerMove={(e) => setHover(near(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            setHover((h) => Math.max(x0, Math.min(x1, (h ?? x1) + (e.key === 'ArrowRight' ? 1 : -1))));
          }}
        >
          {/* Panel 1 */}
          <text className="panel-label" x={L} y={P1.y - 4}>
            {unit === 'pct' ? `Return since ${range === 'all' ? 'start' : formatDayShort(days[x0]!)}` : 'Value in £'}
          </text>
          {ticks(lo1, hi1, 4).map((t) => (
            <g key={`t1${t}`}>
              <line x1={L} x2={W - R + 6} y1={Y1(t)} y2={Y1(t)} stroke={unit === 'pct' && t === 0 ? 'var(--border)' : 'var(--border-lt)'} strokeWidth={unit === 'pct' && t === 0 ? 1.5 : 1} />
              <text className="tick" x={L - 6} y={Y1(t) + 3.5} textAnchor="end">
                {unit === 'pct' ? sgn(t, '%', t % 1 ? 1 : 0) : `£${Math.round(t).toLocaleString('en-GB')}`}
              </text>
            </g>
          ))}
          {fills}
          {unit === 'gbp' && <path d={step(put)} fill="none" stroke="var(--mid)" strokeWidth={1.5} />}
          <path d={path(B, Y1)} fill="none" stroke="var(--bench)" strokeWidth={1.75} strokeDasharray="5 4" strokeLinejoin="round" />
          <path d={path(A, Y1)} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
          {spread(ends, 14).map((l) => (
            <text key={l.t} className="end-label" x={X(lk) + 8} y={l.y + 4} fill={l.c}>
              {l.t}
            </text>
          ))}
          {lk < x1 && <rect x={X(lk)} y={P1.y} width={X(x1) - X(lk)} height={P3.y + P3.h - P1.y} fill="color-mix(in srgb, var(--halt) 8%, transparent)" />}
          {days.map((d, i) => {
            if (i < x0) return null;
            const g = eventGlyph(eventsByDay.get(d) ?? []);
            if (!g) return null;
            return (
              <text key={`e${d}`} x={X(i)} y={P1.y + P1.h + 16} textAnchor="middle" fontSize={g.glyph.length > 1 ? 9 : 10.5} fill={g.color} fontWeight={focusDay === d ? 700 : 400}>
                <title>{`${formatDay(d)}: ${g.text}`}</title>
                {g.glyph}
              </text>
            );
          })}

          {/* Panel 2 */}
          <text className="panel-label" x={L} y={P2.y - 8}>
            {small ? 'Lead over VWRP · grey = luck' : 'Lead over VWRP, pp · grey = where luck alone would put it'}
          </text>
          {(
            [
              [1.96, 'var(--band-95)'],
              [1.28, 'var(--band-80)'],
              [0.67, 'var(--band-50)'],
            ] as const
          ).map(([z, fill]) => {
            const top: string[] = [];
            const bot: string[] = [];
            for (let i = x0; i <= x1; i++) {
              top.push(`${X(i)},${Y2(bandAt(i, z))}`);
              bot.unshift(`${X(i)},${Y2(-bandAt(i, z))}`);
            }
            return <polygon key={z} points={[...top, ...bot].join(' ')} fill={fill} />;
          })}
          {ticks(lo2, hi2, 4).map((t) => (
            <g key={`t2${t}`}>
              <line x1={L} x2={W - R + 6} y1={Y2(t)} y2={Y2(t)} stroke={t === 0 ? 'var(--border)' : 'var(--border-lt)'} strokeWidth={t === 0 ? 1.5 : 1} />
              <text className="tick" x={L - 6} y={Y2(t) + 3.5} textAnchor="end">
                {sgn(t, '', t % 1 ? 1 : 0)}
              </text>
            </g>
          ))}
          <path d={path(gap, Y2)} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" />
          <circle cx={X(lk)} cy={Y2(gl)} r={4} fill={glC} stroke="var(--raised)" strokeWidth={2} />
          {ends2.map((l) => (
            <text key={l.t} className={l.cls} x={X(lk) + 8} y={l.y + 4} fill={l.c}>
              {l.t}
            </text>
          ))}

          {/* Panel 3 */}
          <text className="panel-label" x={L} y={P3.y - 8}>
            Below its best-ever value
          </text>
          {ticks(lo3, 0, 2).map((t) => (
            <g key={`t3${t}`}>
              <line x1={L} x2={W - R + 6} y1={Y3(t)} y2={Y3(t)} stroke="var(--border-lt)" />
              <text className="tick" x={L - 6} y={Y3(t) + 3.5} textAnchor="end">
                {t === 0 ? '0' : `−${Math.abs(t)}%`}
              </text>
            </g>
          ))}
          {segments(ddW, Y3)
            .filter((s) => s.length > 1)
            .map((s, k) => (
              <path key={`dd${k}`} d={`M${s[0]![0]},${Y3(0)}L${s.map((q) => q.join(',')).join('L')}L${s[s.length - 1]![0]},${Y3(0)}Z`} fill="var(--loss-fill)" />
            ))}
          <path d={path(ddBW, Y3)} fill="none" stroke="var(--bench)" strokeWidth={1.25} strokeDasharray="4 4" />
          <path d={path(ddW, Y3)} fill="none" stroke="var(--loss)" strokeWidth={1.5} />
          <text className="end-label" x={X(lk) + 8} y={Y3(dd[lk] ?? 0) + 4} fill="var(--loss)">
            {(dd[lk] ?? 0) < -0.05 ? `−${Math.abs(dd[lk]!).toFixed(1)}%` : small ? 'best' : 'at its best'}
          </text>

          {/* Axis and cursor */}
          {(small ? [x0, x1] : [x0, Math.round((x0 + x1) / 2), x1]).map((i, k, all) => (
            <text key={`x${i}`} className="tick" x={X(i)} y={H - 8} textAnchor={k === 0 ? 'start' : k === all.length - 1 ? 'end' : 'middle'} style={k === all.length - 1 && lk < x1 ? { fill: 'var(--halt)' } : undefined}>
              {formatDayShort(days[i]!)}
              {k === all.length - 1 && lk < x1 ? ` · no check ${x1 - lk}d` : ''}
            </text>
          ))}
          {focusIdx >= x0 && <line x1={X(focusIdx)} x2={X(focusIdx)} y1={P1.y} y2={P3.y + P3.h} stroke="var(--em)" strokeWidth={2} opacity={0.55} />}
          {shown !== null && (
            <g>
              <line x1={X(shown)} x2={X(shown)} y1={P1.y} y2={P3.y + P3.h} stroke="var(--muted)" />
              {A[shown] != null && <circle cx={X(shown)} cy={Y1(A[shown]!)} r={4} fill={color} stroke="var(--raised)" strokeWidth={2} />}
              {B[shown] != null && <circle cx={X(shown)} cy={Y1(B[shown]!)} r={4} fill="var(--bench)" stroke="var(--raised)" strokeWidth={2} />}
              {gap[shown] != null && <circle cx={X(shown)} cy={Y2(gap[shown]!)} r={3.5} fill="var(--text)" stroke="var(--raised)" strokeWidth={2} />}
              <rect x={Math.min(Math.max(X(shown) - 32, L), W - R - 20)} y={H - 22} width={64} height={18} rx={9} fill="var(--text)" />
              <text x={Math.min(Math.max(X(shown), L + 32), W - R + 12)} y={H - 9} textAnchor="middle" fontSize={11} fontFamily="DM Mono, monospace" fill="var(--bg)">
                {formatDayShort(days[shown]!)}
              </text>
            </g>
          )}
        </svg>
      </div>

      <div className="chart-foot">
        <span className="v-key">
          <i style={{ borderColor: color }} />
          {series.name}
        </span>
        <span className="v-key">
          <i className="dash" style={{ borderColor: 'var(--bench)' }} />
          VWRP, same money same days
        </span>
        {unit === 'gbp' && (
          <span className="v-key">
            <i style={{ borderColor: 'var(--mid)', borderTopWidth: 1.5 }} />
            money put in
          </span>
        )}
        <span className="v-key">
          <s style={{ background: 'var(--gain-fill)' }} />
          ahead
        </span>
        <span className="v-key">
          <s style={{ background: 'var(--loss-fill)' }} />
          behind
        </span>
        <span className="v-key">
          <s style={{ background: 'var(--band-50)' }} />
          <s style={{ background: 'var(--band-80)' }} />
          <s style={{ background: 'var(--band-95)' }} />
          luck: half · 4 in 5 · 19 in 20
        </span>
        <span className="v-key">◆ money · ▲▼ trades · ❚❚ halt</span>
      </div>

      <details className="tbl" style={{ marginTop: 10 }}>
        <summary>Daily figures as a table</summary>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>{series.name}</th>
                <th>£</th>
                <th>VWRP</th>
                <th>VWRP £</th>
                <th>Lead</th>
                <th>Below best</th>
              </tr>
            </thead>
            <tbody>
              {days
                .map((d, i) => ({ d, i }))
                .filter(({ i }) => i >= x0)
                .reverse()
                .map(({ d, i }) => (
                  <tr key={d}>
                    <td>{formatDay(d)}</td>
                    <td>{ser[i] == null ? '— no check' : sgn(ser[i]!, '%', 2)}</td>
                    <td>{at[i] ? formatGBP(at[i]!.equityMinor) : '—'}</td>
                    <td>{ben[i] == null ? '—' : sgn(ben[i]!, '%', 2)}</td>
                    <td>{at[i] ? formatGBP(at[i]!.shadowMinor) : '—'}</td>
                    <td>{gap[i] == null ? '—' : sgn(gap[i]!, ' pp', 2)}</td>
                    <td>{dd[i] == null ? '—' : dd[i]! < -0.005 ? `−${Math.abs(dd[i]!).toFixed(2)}%` : '0'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
