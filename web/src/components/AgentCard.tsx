import type { AgentView } from '../lib/api';
import { formatGBP, formatPct, formatQtyShort, directionClass } from '../lib/format';
import { Donut } from './Donut';

const SLICES = ['var(--slice-1)', 'var(--slice-2)', 'var(--slice-3)'];

interface AgentCardProps {
  agent: AgentView;
  index: number;
  busy: boolean;
  onCapital: () => void;
  onUniverse: () => void;
  onHalt: () => void;
  onStart: () => void;
  onKill: () => void;
}

export function AgentCard({
  agent,
  index,
  busy,
  onCapital,
  onUniverse,
  onHalt,
  onStart,
  onKill,
}: AgentCardProps) {
  const allocated = Number(agent.allocatedMinor);
  const deployed = Number(agent.deployedMinor);
  const usedPct = allocated > 0 ? Math.min(100, Math.round((deployed / allocated) * 100)) : 0;

  const held = new Set(agent.holdings.map((h) => h.symbol));
  const colour = SLICES[index % SLICES.length] ?? SLICES[0]!;

  return (
    <article className="slot" data-status={agent.status}>
      <div className="slot-head">
        <div>
          <h3 className="slot-name">{agent.name}</h3>
          <span className="slot-id">{agent.id}</span>
        </div>
        <span className="pill" data-status={agent.status}>
          {agent.status}
        </span>
      </div>

      <div className="slot-body">
        <div className="money-row">
          <Donut
            segments={[
              { key: 'deployed', label: 'Deployed', value: agent.deployedMinor, color: colour },
            ]}
            size={58}
            stroke={7}
            centre={{ big: `${usedPct}%`, small: 'used' }}
            ariaLabel={`${usedPct}% of allocation deployed`}
          />
          <div>
            <div className="equity">{formatGBP(agent.equityMinor)}</div>
            <div className="label">of {formatGBP(agent.allocatedMinor)} allocated</div>
          </div>
          <div className="pnl-stack">
            <span className={`pnl ${directionClass(agent.pnlPctSinceStart)}`}>
              {formatPct(agent.pnlPctSinceStart)}
            </span>
            <span className="pnl-label">since start</span>
            <span className={`pnl ${directionClass(agent.pnlPctToday)}`}>
              {formatPct(agent.pnlPctToday)}
            </span>
            <span className="pnl-label">today</span>
          </div>
        </div>

        <div>
          <div className="section-line">
            <span className="label">May trade</span>
            <span className="label">
              {agent.universe.length} symbol{agent.universe.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="chips">
            {agent.universe.length === 0 ? (
              <span className="hint">No universe set — this agent cannot open anything.</span>
            ) : (
              agent.universe.map((symbol) => (
                <span key={symbol} className={`chip${held.has(symbol) ? ' held' : ''}`}>
                  {symbol}
                </span>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="section-line">
            <span className="label">Holding now</span>
            {agent.unpricedSymbols.length > 0 && (
              <span className="label" style={{ color: 'var(--halt)' }}>
                {agent.unpricedSymbols.length} unpriced
              </span>
            )}
          </div>
          <div className="holdings">
            {agent.holdings.length === 0 ? (
              <div className="no-holdings">No open positions</div>
            ) : (
              agent.holdings.map((h) => (
                <div className="holding" key={h.symbol}>
                  <span className="holding-sym">{h.symbol}</span>
                  <span className="holding-qty">{formatQtyShort(h.qty)}</span>
                  <span>{formatGBP(h.marketValueMinor ?? h.costBasisMinor)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="slot-actions">
        {agent.status === 'killed' ? (
          <span className="hint">
            Stood down. Restarting is a deliberate decision about whether its P/L history resumes
            or starts fresh.
          </span>
        ) : (
          <>
            <button className="btn-sm" onClick={onCapital} disabled={busy}>
              Capital
            </button>
            <button className="btn-sm" onClick={onUniverse} disabled={busy}>
              Universe
            </button>
            <span className="spacer" />
            {agent.status === 'running' ? (
              <button className="btn-sm" onClick={onHalt} disabled={busy}>
                Halt
              </button>
            ) : (
              <button className="btn-sm btn-primary" onClick={onStart} disabled={busy}>
                {agent.status === 'idle' ? 'Start' : 'Resume'}
              </button>
            )}
            <button className="btn-sm btn-danger" onClick={onKill} disabled={busy}>
              Kill
            </button>
          </>
        )}
      </div>
    </article>
  );
}
