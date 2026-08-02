import { useState } from 'react';
import type { ControlPanelView } from '../lib/api';
import { formatGBP, formatGBPRound, signOf } from '../lib/format';
import { Donut, type Segment } from './Donut';

const SLICES = ['var(--slice-1)', 'var(--slice-2)', 'var(--slice-3)'];

export function Overview({ view }: { view: ControlPanelView }) {
  const [highlight, setHighlight] = useState<string | null>(null);

  const live = view.agents.filter((a) => a.status !== 'killed');

  const segments: Segment[] = live.map((agent, i) => ({
    key: agent.id,
    label: agent.name,
    value: agent.allocatedMinor,
    color: SLICES[i % SLICES.length] ?? SLICES[0]!,
  }));
  segments.push({
    key: 'pool',
    label: 'Unallocated',
    value: view.unallocatedMinor,
    color: 'var(--slice-rest)',
  });

  const capital = (Number(view.allocatedMinor) + Number(view.unallocatedMinor)).toString();
  const todayDirection = signOf(view.todayMinor);

  return (
    <section className="overview">
      <div className="donut-wrap">
        <Donut
          segments={segments}
          size={132}
          stroke={16}
          centre={{ big: formatGBPRound(capital), small: 'capital' }}
          highlight={highlight}
          ariaLabel="Capital allocation across agents and the unallocated pool"
        />
        {/* The legend carries name and value, so identity never depends on
            colour — which is also what makes the lighter slices legitimate. */}
        <div className="legend">
          {segments
            .filter((s) => Number(s.value) > 0)
            .map((s) => (
              <div
                className="legend-row"
                key={s.key}
                onMouseEnter={() => setHighlight(s.key)}
                onMouseLeave={() => setHighlight(null)}
              >
                <span className="legend-key" style={{ background: s.color }} />
                <span className="legend-name">{s.label}</span>
                <span className="legend-val">{formatGBP(s.value)}</span>
              </div>
            ))}
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="label">Total fund</span>
          <span className="stat-value hero">
            {view.totalEquityMinor === null ? (
              <span className="unknown">unknown</span>
            ) : (
              formatGBP(view.totalEquityMinor)
            )}
          </span>
          <span className="stat-sub">
            {view.totalEquityMinor === null
              ? 'a holding has no price'
              : `${live.length} agent${live.length === 1 ? '' : 's'} + pool`}
          </span>
        </div>

        <div className="stat">
          <span className="label">Today</span>
          <span className={`stat-value pnl ${todayDirection === 'na' ? 'na' : todayDirection}`}>
            {view.todayMinor === null ? <span className="unknown">—</span> : formatGBP(view.todayMinor)}
          </span>
          <span className="stat-sub">
            {view.todayMinor === null ? 'no prior close yet' : 'since yesterday'}
          </span>
        </div>

        <div className="stat">
          <span className="label">Unallocated</span>
          <span className="stat-value">{formatGBP(view.unallocatedMinor)}</span>
          <span className="stat-sub">available to allocate</span>
        </div>
      </div>
    </section>
  );
}
