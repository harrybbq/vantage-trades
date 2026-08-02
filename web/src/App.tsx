import { useCallback, useEffect, useState } from 'react';
import * as api from './lib/api';
import type { AgentView, ControlPanelView } from './lib/api';
import { Overview } from './components/Overview';
import { Stats } from './components/Stats';
import { AgentCard } from './components/AgentCard';
import {
  AddAgentDialog,
  CapitalDialog,
  GlobalHaltDialog,
  KillDialog,
  UniverseDialog,
} from './components/dialogs';

type Dialog =
  | { kind: 'capital'; agent: AgentView }
  | { kind: 'universe'; agent: AgentView }
  | { kind: 'kill'; agent: AgentView }
  | { kind: 'globalHalt' }
  | { kind: 'addAgent' }
  | null;

function Reconciliation({ view }: { view: ControlPanelView }) {
  const recon = view.reconciliation;

  if (!recon) {
    return (
      <div className="recon none">
        <span className="dot" />
        <span className="txt">Never reconciled</span>
        <span className="meta">run the daily job</span>
      </div>
    );
  }

  const when = new Date(recon.asOf).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (recon.status === 'ok') {
    return (
      <div className="recon ok">
        <span className="dot" />
        <span className="txt">Reconciled clean</span>
        <span className="meta">{when}</span>
      </div>
    );
  }

  // Never buried. If the ledger has stopped agreeing with the broker, every
  // number on this screen is suspect, and that has to be the loudest thing on it.
  return (
    <div className="recon bad" title={recon.summary}>
      <span className="dot" />
      <span className="txt">Ledger diverged — investigate today</span>
      <span className="meta">{when}</span>
    </div>
  );
}

type Tab = 'control' | 'stats';

export default function App() {
  const [tab, setTab] = useState<Tab>('control');
  const [view, setView] = useState<ControlPanelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.fetchPanel());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load the control panel');
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll rather than push. The numbers move when fills arrive, and a panel
    // showing a stale position is worse than one that is a few seconds behind.
    // Only while the control tab is showing: the equity curve moves once a
    // day, and polling it would be noise.
    if (tab !== 'control') return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, tab]);

  /** Run a control action, replacing the view with whatever the server committed. */
  const run = async (action: () => Promise<ControlPanelView>) => {
    setBusy(true);
    try {
      setView(await action());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that did not work');
    }
    setBusy(false);
  };

  const closeDialog = () => setDialog(null);
  const applyView = (next: ControlPanelView) => {
    setView(next);
    setError(null);
  };

  if (!view) {
    return (
      <div className="app">
        {error ? (
          <div className="banner-error">
            <span>
              <b>Cannot reach the control API.</b> {error}
            </span>
            <button className="btn-sm" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="loading">Loading the ledger…</div>
        )}
      </div>
    );
  }

  const running = view.agents.filter((a) => a.status === 'running').length;

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <span className="label">Digital factory</span>
          <h1>Agent control</h1>
          <p className="owner-tag">
            Owner only · identity verified server-side on every request that can move money
          </p>
        </div>
        <Reconciliation view={view} />
      </div>

      <nav className="tabs" aria-label="Sections">
        <button
          className={`tab${tab === 'control' ? ' is-active' : ''}`}
          onClick={() => setTab('control')}
          aria-current={tab === 'control' ? 'page' : undefined}
        >
          Control
        </button>
        <button
          className={`tab${tab === 'stats' ? ' is-active' : ''}`}
          onClick={() => setTab('stats')}
          aria-current={tab === 'stats' ? 'page' : undefined}
        >
          Performance
        </button>
      </nav>

      {error && (
        <div className="banner-error">
          <span>
            <b>Refused.</b> {error}
          </span>
          <button className="btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {tab === 'stats' ? (
        <Stats />
      ) : (
        <>
      <Overview view={view} />

      <div className="global-bar">
        <div className="global-copy">
          <b>Global halt.</b> Freezes every agent at once, whatever state each is in. Nothing is
          sold — positions stay exactly as they are. Works even if an agent's own loop is wedged.
        </div>
        <button
          className="btn-danger-solid"
          onClick={() => setDialog({ kind: 'globalHalt' })}
          disabled={busy}
        >
          Halt everything
        </button>
      </div>

      <div className="slots">
        {view.agents.map((agent, i) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            index={i}
            busy={busy}
            onCapital={() => setDialog({ kind: 'capital', agent })}
            onUniverse={() => setDialog({ kind: 'universe', agent })}
            onHalt={() => void run(() => api.halt(agent.id, 'halted from the control panel'))}
            onStart={() => void run(() => api.start(agent.id))}
            onKill={() => setDialog({ kind: 'kill', agent })}
          />
        ))}

        <article className="slot slot-empty">
          <button className="btn-primary" onClick={() => setDialog({ kind: 'addAgent' })}>
            Add an agent
          </button>
          <p>
            Creates the agent and its ledger accounts. It starts idle — no capital, no universe,
            placing nothing — until you set both.
          </p>
        </article>
      </div>
        </>
      )}

      {dialog?.kind === 'capital' && (
        <CapitalDialog
          agent={dialog.agent}
          poolMinor={view.unallocatedMinor}
          onClose={closeDialog}
          onDone={applyView}
          onError={setError}
        />
      )}
      {dialog?.kind === 'universe' && (
        <UniverseDialog
          // Re-read from the current view so the chips update as they change.
          agent={view.agents.find((a) => a.id === dialog.agent.id) ?? dialog.agent}
          onClose={closeDialog}
          onDone={applyView}
          onError={setError}
        />
      )}
      {dialog?.kind === 'kill' && (
        <KillDialog
          agent={dialog.agent}
          onClose={closeDialog}
          onDone={applyView}
          onError={setError}
        />
      )}
      {dialog?.kind === 'globalHalt' && (
        <GlobalHaltDialog
          running={running}
          onClose={closeDialog}
          onDone={applyView}
          onError={setError}
        />
      )}
      {dialog?.kind === 'addAgent' && (
        <AddAgentDialog onClose={closeDialog} onDone={applyView} onError={setError} />
      )}
    </div>
  );
}
