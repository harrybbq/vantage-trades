import { useCallback, useEffect, useState } from 'react';
import * as api from './lib/api';
import type { AgentView, ControlPanelView } from './lib/api';
import { Overview } from './components/Overview';
import { Stats } from './components/Stats';
import { AgentCard } from './components/AgentCard';
import {
  AddAgentDialog,
  CapitalDialog,
  FundsDialog,
  GlobalHaltDialog,
  KillDialog,
  UniverseDialog,
} from './components/dialogs';
import { SignIn } from './components/SignIn';
import { Mark } from './components/Mark';
import { authConfigured, currentSession, onAuthChange, signOut } from './lib/auth';

type Dialog =
  | { kind: 'capital'; agent: AgentView }
  | { kind: 'universe'; agent: AgentView }
  | { kind: 'kill'; agent: AgentView }
  | { kind: 'globalHalt' }
  | { kind: 'addAgent' }
  | { kind: 'funds' }
  | null;

function Reconciliation({
  view,
  busy,
  onCheck,
}: {
  view: ControlPanelView;
  busy: boolean;
  onCheck: () => void;
}) {
  const recon = view.reconciliation;

  // Checking talks to the feed and the broker before it answers, so it takes
  // seconds. Saying so beats a button that looks stuck.
  const check = (
    <button className="btn-sm" onClick={onCheck} disabled={busy} title="Reconcile now">
      {busy ? 'Checking…' : 'Check now'}
    </button>
  );

  if (!recon) {
    return (
      <div className="recon none">
        <span className="dot" />
        <span className="txt">Never reconciled</span>
        {check}
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
        {check}
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
      {check}
    </div>
  );
}

type Tab = 'control' | 'stats';

/**
 * Sign-in gate.
 *
 * Skipped entirely when Supabase is not configured in the build, which is the
 * local-development case — the dev API has its own explicit bypass and there
 * is nothing to sign in to. A deployed build always has it configured, so
 * there is no path where a deployed panel renders without a session.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(
    authConfigured ? 'checking' : 'in',
  );

  useEffect(() => {
    if (!authConfigured) return;

    void currentSession().then((session) => setState(session ? 'in' : 'out'));
    return onAuthChange((session) => setState(session ? 'in' : 'out'));
  }, []);

  if (state === 'checking') return <div className="loading">Checking your session…</div>;
  if (state === 'out') return <SignIn />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthGate>
      <ControlPanel />
    </AuthGate>
  );
}

function ControlPanel() {
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
      const status = e instanceof api.ApiError ? e.status : 0;

      // A deployed build with no VITE_SUPABASE_* set has no sign-in screen and
      // sends no token, so every call 401s and the panel looks broken for a
      // reason nothing on screen explains. Name it instead.
      if (status === 401 && !authConfigured) {
        setError(
          'This build has no sign-in configured, so it cannot authenticate. Set ' +
            'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and redeploy — they are read at ' +
            'build time, so changing them needs a rebuild.',
        );
        return;
      }
      if (status === 401) {
        setError(
          'Signed in, but the server would not accept it. That is either the wrong ' +
            'account or a server-side Supabase setting — open /api/health, which says which.',
        );
        return;
      }
      // 503 means the server recognised its own fault and named it, so the
      // message stands on its own. 500 is the unrecognised case and says
      // nothing useful by design.
      if (status === 503) {
        setError(e instanceof Error ? e.message : 'the ledger is unavailable');
        return;
      }
      if (status >= 500) {
        setError(
          `${e instanceof Error ? e.message : 'the server failed'} — /api/health checks the ` +
            'configuration and names what is wrong.',
        );
        return;
      }

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
        <div className="brand-block">
          <Mark size={56} />
          <div>
          <span className="label">Digital factory</span>
          <h1>Vantage: Trades</h1>
          <p className="owner-tag">
            Owner only · identity verified server-side on every request that can move money
          </p>
          </div>
        </div>
        <div className="topbar-right">
          <Reconciliation
            view={view}
            busy={busy}
            onCheck={() => void run(() => api.reconcileNow())}
          />
          {authConfigured && (
            <button className="btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
        </div>
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

      <div className="funds-bar">
        <div className="global-copy">
          <b>Unallocated pool.</b> Capital sitting in the brokerage account that no agent may
          deploy yet. Money enters and leaves by bank transfer; this only records that it did.
        </div>
        <button className="btn-sm" onClick={() => setDialog({ kind: 'funds' })} disabled={busy}>
          Record cash in or out
        </button>
      </div>

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
      {dialog?.kind === 'funds' && (
        <FundsDialog
          poolMinor={view.unallocatedMinor}
          onClose={closeDialog}
          onDone={applyView}
          onError={setError}
        />
      )}
    </div>
  );
}
