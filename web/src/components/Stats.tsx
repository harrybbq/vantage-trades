import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { StatsView } from '../lib/api';
import { formatGBP, formatPct, directionClass } from '../lib/format';
import { EquityChart } from './EquityChart';

export function Stats() {
  const [view, setView] = useState<StatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchStats()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not load stats'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="banner-error">
        <span>
          <b>Could not load stats.</b> {error}
        </span>
      </div>
    );
  }

  if (!view) return <div className="loading">Loading the equity curve…</div>;

  const beating = view.excessPct !== null && view.excessPct > 0;

  return (
    <div className="stats-page">
      <section className="overview">
        <div className="stats">
          <div className="stat">
            <span className="label">Fund</span>
            <span className={`stat-value hero pnl ${directionClass(view.fundReturnPct)}`}>
              {formatPct(view.fundReturnPct)}
            </span>
            <span className="stat-sub">since the first reconciled day</span>
          </div>
          <div className="stat">
            <span className="label">{view.benchmarkSymbol} buy and hold</span>
            <span className="stat-value">{formatPct(view.benchmarkReturnPct)}</span>
            <span className="stat-sub">same dates, doing nothing</span>
          </div>
          <div className="stat">
            <span className="label">Difference</span>
            <span className={`stat-value pnl ${directionClass(view.excessPct)}`}>
              {formatPct(view.excessPct)}
            </span>
            <span className="stat-sub">
              {view.excessPct === null
                ? 'not comparable yet'
                : beating
                  ? 'ahead — one path, not evidence'
                  : 'behind doing nothing'}
            </span>
          </div>
          <div className="stat">
            <span className="label">Costs paid</span>
            <span className="stat-value">{formatGBP(view.totalFeesMinor)}</span>
            <span className="stat-sub">
              over {view.totalTrades} fill{view.totalTrades === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </section>

      {view.note ? (
        <div className="empty-note">{view.note}</div>
      ) : (
        <section className="panel-block">
          <h2 className="block-title">Equity against doing nothing</h2>
          <EquityChart points={view.fund} benchmarkSymbol={view.benchmarkSymbol} />
          <p className="hint block-note">
            The benchmark line is the same starting capital left in {view.benchmarkSymbol}. Both
            series are in pounds on one axis — a second scale would let any pair of lines tell any
            story. The fund figure includes unallocated cash sitting idle, which drags it against a
            fully-invested index.
          </p>
        </section>
      )}

      {view.agents.length > 0 && (
        <section className="panel-block">
          <h2 className="block-title">Per agent</h2>
          <div className="agent-curves">
            {view.agents.map((agent) => (
              <article className="mini-curve" key={agent.agentId}>
                <header>
                  <div>
                    <div className="mini-name">{agent.name}</div>
                    <span className="slot-id">{agent.agentId}</span>
                  </div>
                  <span className={`pnl ${directionClass(agent.returnPct)}`}>
                    {formatPct(agent.returnPct)}
                  </span>
                </header>
                {agent.points.length >= 2 ? (
                  <EquityChart
                    points={agent.points}
                    benchmarkSymbol={view.benchmarkSymbol}
                    height={150}
                    seriesLabel={agent.name}
                  />
                ) : (
                  <p className="hint">Not enough history yet.</p>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="panel-block">
        <h2 className="block-title">Reconciliation log</h2>
        {view.reconciliations.length === 0 ? (
          <p className="hint">Never reconciled. Run the daily job.</p>
        ) : (
          <div className="table-scroll">
            <table className="figures-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Cash drift</th>
                  <th scope="col">Equity drift</th>
                </tr>
              </thead>
              <tbody>
                {view.reconciliations.map((row) => (
                  <tr key={row.runAt}>
                    <td>{new Date(row.runAt).toLocaleString('en-GB')}</td>
                    <td>
                      <span className="pill" data-status={row.status === 'ok' ? 'running' : 'halted'}>
                        {row.status}
                      </span>
                    </td>
                    <td className="figure">{formatGBP(row.cashDiffMinor)}</td>
                    <td className="figure">{formatGBP(row.equityDiffMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint block-note">
          There is no tolerance band. A penny of drift is a bug, and a tolerance is how a slow leak
          goes unnoticed for a quarter.
        </p>
      </section>
    </div>
  );
}
