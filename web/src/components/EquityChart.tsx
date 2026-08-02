/**
 * The fund's equity curve against buy-and-hold.
 *
 * One axis, two series, both in pounds. The benchmark is rebased server-side
 * into "what the same starting capital would be worth in the index", so the
 * comparison is money against money rather than money against an index level.
 * A second y-axis would make any pair of lines look however you wanted.
 *
 * Colours were validated for colour-blind separation against both surfaces —
 * the obvious choice of a muted grey benchmark line failed badly for
 * deuteranopia against the green. Dash and weight carry the hierarchy
 * instead, and both series are direct-labelled at their endpoints so identity
 * never rests on colour alone.
 */

import { useId, useMemo, useState } from 'react';
import type { CurvePoint } from '../lib/api';
import { formatGBP } from '../lib/format';

interface EquityChartProps {
  points: CurvePoint[];
  benchmarkSymbol: string;
  height?: number;
  /** What the solid line is. "Fund" on the whole-portfolio chart, the agent's
      name on a per-agent one — labelling an agent's curve "Fund" is just wrong. */
  seriesLabel?: string;
}

interface Plotted {
  x: number;
  y: number;
  point: CurvePoint;
}

const PAD = { top: 16, right: 76, bottom: 28, left: 8 };

export function EquityChart({
  points,
  benchmarkSymbol,
  height = 260,
  seriesLabel = 'Fund',
}: EquityChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const gradientId = useId();

  const width = 800;

  const model = useMemo(() => {
    const fundValues = points.map((p) => Number(p.equityMinor));
    const benchValues = points.map((p) => (p.benchmarkMinor === null ? null : Number(p.benchmarkMinor)));

    const all = [...fundValues, ...benchValues.filter((v): v is number => v !== null)];
    if (all.length === 0) return null;

    let min = Math.min(...all);
    let max = Math.max(...all);
    // A flat series would collapse to a zero-height band; give it room so the
    // line sits in the middle rather than on an edge.
    if (min === max) {
      min -= Math.abs(min) * 0.01 + 100;
      max += Math.abs(max) * 0.01 + 100;
    }
    // Headroom so the line never touches the frame.
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    const xOf = (i: number) =>
      PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const yOf = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

    const fund: Plotted[] = points.map((point, i) => ({
      x: xOf(i),
      y: yOf(Number(point.equityMinor)),
      point,
    }));

    const bench: Plotted[] = points
      .map((point, i) =>
        point.benchmarkMinor === null
          ? null
          : { x: xOf(i), y: yOf(Number(point.benchmarkMinor)), point },
      )
      .filter((p): p is Plotted => p !== null);

    return { fund, bench, min, max, plotH };
  }, [points, height]);

  if (!model || points.length < 2) return null;

  const path = (series: Plotted[]) =>
    series.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const lastFund = model.fund[model.fund.length - 1];
  const lastBench = model.bench[model.bench.length - 1];

  // Nudge the endpoint labels apart when the two series finish close together,
  // otherwise they overlap into an unreadable smear at exactly the moment the
  // comparison is most interesting.
  const MIN_GAP = 13;
  let fundLabelY = lastFund?.y ?? 0;
  let benchLabelY = lastBench?.y ?? 0;
  if (lastFund && lastBench && Math.abs(fundLabelY - benchLabelY) < MIN_GAP) {
    const mid = (fundLabelY + benchLabelY) / 2;
    const fundAbove = fundLabelY <= benchLabelY;
    fundLabelY = mid + (fundAbove ? -MIN_GAP / 2 : MIN_GAP / 2);
    benchLabelY = mid + (fundAbove ? MIN_GAP / 2 : -MIN_GAP / 2);
  }
  const hovered = hover === null ? null : model.fund[hover];
  const hoveredBench = hover === null ? null : model.bench[hover];

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <div className="legend-inline">
          <span className="key">
            <svg width="18" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="18" y2="4" stroke="var(--series-fund)" strokeWidth="2" />
            </svg>
            {seriesLabel}
          </span>
          <span className="key">
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke="var(--series-bench)"
                strokeWidth="2"
                strokeDasharray="4 3"
              />
            </svg>
            {benchmarkSymbol} buy and hold
          </span>
        </div>
        <button className="btn-sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide figures' : 'Show figures'}
        </button>
      </figcaption>

      <div className="chart-body">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Fund equity against ${benchmarkSymbol} buy and hold`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * width;
            const plotW = width - PAD.left - PAD.right;
            const ratio = (x - PAD.left) / plotW;
            const index = Math.round(ratio * (points.length - 1));
            setHover(index >= 0 && index < points.length ? index : null);
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-fund)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--series-fund)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Recessive baseline only. A full grid competes with two lines. */}
          <line
            x1={PAD.left}
            y1={height - PAD.bottom}
            x2={width - PAD.right}
            y2={height - PAD.bottom}
            stroke="var(--border)"
            strokeWidth="1"
          />

          <path
            d={`${path(model.fund)} L${lastFund?.x ?? 0} ${height - PAD.bottom} L${model.fund[0]?.x ?? 0} ${height - PAD.bottom} Z`}
            fill={`url(#${gradientId})`}
          />

          {model.bench.length > 1 && (
            <path
              d={path(model.bench)}
              fill="none"
              stroke="var(--series-bench)"
              strokeWidth="2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
          )}

          <path
            d={path(model.fund)}
            fill="none"
            stroke="var(--series-fund)"
            strokeWidth="2"
            strokeLinejoin="round"
          />

          {hovered && (
            <>
              <line
                x1={hovered.x}
                y1={PAD.top}
                x2={hovered.x}
                y2={height - PAD.bottom}
                stroke="var(--text-muted)"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
              {hoveredBench && (
                <circle
                  cx={hoveredBench.x}
                  cy={hoveredBench.y}
                  r="4"
                  fill="var(--series-bench)"
                  stroke="var(--bg-raised)"
                  strokeWidth="2"
                />
              )}
              <circle
                cx={hovered.x}
                cy={hovered.y}
                r="4.5"
                fill="var(--series-fund)"
                stroke="var(--bg-raised)"
                strokeWidth="2"
              />
            </>
          )}

          {/* Direct labels at the endpoints. These are what make the lighter
              series legitimate despite its sub-3:1 contrast. */}
          {lastFund && (
            <text
              x={width - PAD.right + 8}
              y={fundLabelY + 4}
              className="endpoint"
              fill="var(--series-fund)"
            >
              {formatGBP(lastFund.point.equityMinor)}
            </text>
          )}
          {lastBench && (
            <text
              x={width - PAD.right + 8}
              y={benchLabelY + 4}
              className="endpoint"
              fill="var(--series-bench)"
            >
              {formatGBP(lastBench.point.benchmarkMinor)}
            </text>
          )}

          <text x={PAD.left} y={height - 8} className="axis">
            {points[0]?.date}
          </text>
          <text x={width - PAD.right} y={height - 8} className="axis" textAnchor="end">
            {points[points.length - 1]?.date}
          </text>
        </svg>

        {hovered && (
          <div className="chart-tip" style={{ left: `${(hovered.x / width) * 100}%` }}>
            <div className="tip-date">{hovered.point.date}</div>
            <div className="tip-row">
              <span className="tip-key" style={{ background: 'var(--series-fund)' }} />
              Fund <b>{formatGBP(hovered.point.equityMinor)}</b>
            </div>
            {hovered.point.benchmarkMinor && (
              <div className="tip-row">
                <span className="tip-key" style={{ background: 'var(--series-bench)' }} />
                {benchmarkSymbol} <b>{formatGBP(hovered.point.benchmarkMinor)}</b>
              </div>
            )}
          </div>
        )}
      </div>

      {showTable && (
        <div className="table-scroll">
          <table className="figures-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">{seriesLabel}</th>
                <th scope="col">{benchmarkSymbol}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date}>
                  <td>{p.date}</td>
                  <td className="figure">{formatGBP(p.equityMinor)}</td>
                  <td className="figure">{formatGBP(p.benchmarkMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
