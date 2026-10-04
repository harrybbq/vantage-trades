import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './lib/api';
import type { ActivityItem, AgentView, ControlPanelView, PerformanceResponse } from './lib/api';
import {
  AddAgentDialog,
  CapitalDialog,
  FundsDialog,
  GlobalHaltDialog,
  KillDialog,
  UniverseDialog,
} from './components/dialogs';
import { SignIn } from './components/SignIn';
import { Performance } from './components/panel/Performance';
import { Activity, AgentPanel, agentColors, Banner, Coach, FundSummary, Glance, Ownership, PROBLEM_ORDER, ReadinessCard } from './components/panel/Sections';
import { integrityOf, leadSummary, nextStep } from './lib/guidance';
import { authConfigured, currentSession, onAuthChange, signOut } from './lib/auth';
import './panel.css';

type Dialog =
  | { kind: 'capital'; agent: AgentView }
  | { kind: 'universe'; agent: AgentView }
  | { kind: 'kill'; agent: AgentView }
  | { kind: 'globalHalt' }
  | { kind: 'addAgent' }
  | { kind: 'funds' }
  | null;

/**
 * Sign-in gate.
 *
 * Skipped entirely when Supabase is not configured in the build, which is the
 * local-development case — the dev API has its own explicit bypass and there
 * is nothing to sign in to. A deployed build always has it configured, so
 * there is no path where a deployed panel renders without a session.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(authConfigured ? 'checking' : 'in');

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

/** Explanations on by default; remembered per browser. Storage can be refused, so every access is guarded. */
function useGuide(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem('vt.guide') !== 'off';
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOn((v) => {
      try {
        localStorage.setItem('vt.guide', v ? 'off' : 'on');
      } catch {
        /* a private window: it simply is not remembered */
      }
      return !v;
    });
  return [on, toggle];
}

function describeLoadError(e: unknown): string {
  const status = e instanceof api.ApiError ? e.status : 0;
  // A deployed build with no VITE_SUPABASE_* set has no sign-in screen and
  // sends no token, so every call 401s and the panel looks broken for a
  // reason nothing on screen explains. Name it instead.
  if (status === 401 && !authConfigured) {
    return (
      'This build has no sign-in configured, so it cannot authenticate. Set ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and redeploy — they are read at ' +
      'build time, so changing them needs a rebuild.'
    );
  }
  if (status === 401) {
    return (
      'Signed in, but the server would not accept it. That is either the wrong ' +
      'account or a server-side Supabase setting — open /api/health, which says which.'
    );
  }
  // 503 means the server recognised its own fault and named it, so the
  // message stands on its own. 500 is the unrecognised case.
  if (status === 503) return e instanceof Error ? e.message : 'the ledger is unavailable';
  if (status >= 500) {
    return `${e instanceof Error ? e.message : 'the server failed'} — /api/health checks the configuration and names what is wrong.`;
  }
  return e instanceof Error ? e.message : 'could not load the control panel';
}

function ControlPanel() {
  const [view, setView] = useState<ControlPanelView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Something the server wants read about the action just taken — a kill
  // that could not finish, say. Not an error: the action did something.
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [perf, setPerf] = useState<PerformanceResponse | null>(null);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [who, setWho] = useState<string>('');
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [guide, toggleGuide] = useGuide();

  const load = useCallback(async () => {
    try {
      setView(await api.fetchPanel());
      setLoadError(null);
    } catch (e) {
      setLoadError(describeLoadError(e));
    }
  }, []);

  // The record moves once a day; it is fetched on load and after each action,
  // not on the poll.
  const loadRecord = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.fetchPerformance(), api.fetchActivity()]);
      setPerf(p);
      setItems(a.items);
    } catch (e) {
      setError(e instanceof Error ? `Could not load the record: ${e.message}` : 'Could not load the record');
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRecord();
    // Poll rather than push. A panel showing a stale position is worse than
    // one a few seconds behind.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, loadRecord]);

  /** Apply what the server committed. No optimistic updates: for money, that is a guess shown as fact. */
  const applyView = useCallback(
    (next: ControlPanelView) => {
      setView(next);
      setNotice(next.notice ?? null);
      setError(null);
      void loadRecord();
    },
    [loadRecord],
  );

  const run = async (action: () => Promise<ControlPanelView>) => {
    setBusy(true);
    try {
      applyView(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that did not work');
      void load();
    }
    setBusy(false);
  };

  const colors = useMemo(() => (view ? agentColors(view) : new Map<string, string>()), [view]);
  const seriesById = useMemo(() => new Map((perf?.performance.agents ?? []).map((s) => [s.id!, s])), [perf]);

  if (!view) {
    return (
      <div className="vt">
        <div className="wrap">
          {loadError ? (
            <div className="notice err" style={{ marginTop: 24 }}>
              <span>
                <b>Cannot reach the control API.</b> {loadError}
              </span>
              <button className="btn v-sm" onClick={() => void load()}>
                Retry
              </button>
            </div>
          ) : (
            <div className="loading">Loading the ledger…</div>
          )}
        </div>
      </div>
    );
  }

  // Problems first, everywhere agents are listed.
  const live = view.agents.filter((a) => a.status !== 'killed').sort((a, b) => PROBLEM_ORDER[a.status] - PROBLEM_ORDER[b.status]);
  const killed = view.agents.filter((a) => a.status === 'killed');
  const integrity = integrityOf(view);
  const next = nextStep(view, integrity);
  const running = live.filter((a) => a.status === 'running').length;

  const chartable = [...live.filter((a) => (seriesById.get(a.id)?.points.length ?? 0) > 0 || a.status !== 'idle')];
  const drawable = chartable.find((a) => a.status === 'running' && (seriesById.get(a.id)?.points.length ?? 0) >= 8);
  const selected = who || drawable?.id || 'fund';
  const chosenSeries = selected === 'fund' ? perf?.performance.fund : seriesById.get(selected);
  const chosenColor = selected === 'fund' ? 'var(--text)' : (colors.get(selected) ?? 'var(--a1)');
  const chosenEvents = (items ?? []).filter((i) => i.kind !== 'check' && (selected === 'fund' ? i.kind === 'money' && i.agentId === null : i.agentId === selected));
  const leads = live.map((a) => leadSummary(seriesById.get(a.id)?.points ?? []));

  const findOnChart = (item: ActivityItem) => {
    if (!item.agentId) return;
    setWho(item.agentId);
    setFocusDay(item.at.slice(0, 10));
    document.getElementById('performance')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={`vt${guide ? ' guide' : ''}`}>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <div className="v-mark" aria-hidden="true">
              V
            </div>
            <h1>Vantage: Trades</h1>
            <span className="paper" title="No real money can move. Orders go to the paper broker.">
              PAPER
            </span>
          </div>
          <span className="spacer" />
          <button className="btn v-sm guide-toggle" aria-pressed={guide} onClick={toggleGuide} title="Plain-English explanations under each figure">
            {guide ? 'Guide on' : 'Guide off'}
          </button>
          {authConfigured && (
            <button className="btn v-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
          {/* Never disabled. Every other control waits while something is in
              flight, but this is the one that must work when something is stuck. */}
          <button className="btn v-halt-all" onClick={() => setDialog({ kind: 'globalHalt' })}>
            <span className="icon">❚❚</span>Halt all
          </button>
        </div>
      </header>

      <main className="wrap">
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button className="btn v-sm" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {error && (
          <div className="notice err">
            <span>
              <b>Refused.</b> {error}
            </span>
            <button className="btn v-sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {loadError && (
          <div className="notice err">
            <span>
              <b>Lost contact with the server.</b> {loadError} The figures below are from the last successful load.
            </span>
          </div>
        )}

        <Banner
          state={integrity}
          busy={busy}
          onCheck={() => void run(() => api.reconcileNow())}
          onHistory={() => document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' })}
        />

        <Coach view={view} readiness={perf?.readiness ?? null} next={next} />

        <FundSummary view={view} colors={colors} onFunds={() => setDialog({ kind: 'funds' })} />

        <div className="section-h" id="performance">
          <h2>Is it beating doing nothing?</h2>
          <span className="sub">Each agent against the same money put into VWRP on the same days</span>
        </div>
        <section className="card">
          <div className="perf-controls">
            <span className="seg" aria-label="Whose performance">
              {chartable.map((a) => (
                <button key={a.id} aria-pressed={selected === a.id} onClick={() => { setWho(a.id); setFocusDay(null); }}>
                  {a.name}
                </button>
              ))}
              <button aria-pressed={selected === 'fund'} onClick={() => { setWho('fund'); setFocusDay(null); }}>
                Whole fund
              </button>
            </span>
          </div>
          {perf === null ? (
            <div className="loading">Loading the record…</div>
          ) : chosenSeries ? (
            <Performance key={selected} series={chosenSeries} color={chosenColor} events={chosenEvents} focusDay={focusDay} />
          ) : (
            <div className="empty">
              <b>Not enough data yet</b>This agent has no record to compare with VWRP yet.
            </div>
          )}
          <div className="explain">
            <b>How to read this.</b> The top chart is the return since the start, with <b>VWRP</b> dashed. VWRP is one fund holding about 3,700 companies worldwide; buying it and doing nothing is the bar to beat. Switch to <b>£</b> to see real money, with a stepped line for the money put in. The middle chart is the gap between the two in <b>percentage points (pp)</b>: 5% against VWRP's 4% is 1 pp ahead. The bottom chart shows how far it has fallen below its <b>best-ever value</b>.
          </div>
          <div className="explain">
            <b>The grey bands.</b> If the agent had no skill at all, its lead would stay inside the darkest band about half the time, inside the middle band 4 days in 5, and inside the whole grey area 19 days in 20. A lead inside the grey is what luck alone looks like. It widens over time because luck has longer to wander.
          </div>
          <div className="explain">
            <b>% and £.</b> The % view ignores when money was added, so it shows how the agent's <b>choices</b> did, and is the fair comparison with VWRP. The £ view shows what the <b>money</b> actually did. The two can disagree, even about whether it made or lost money. There are no "per year" figures: under a year of record they mislead.
          </div>
        </section>

        <div className="section-h">
          <h2>Agents</h2>
          <span className="sub">
            Problems first · {live.length} active{killed.length ? ` · ${killed.length} stood down` : ''}
          </span>
        </div>
        <Glance agents={view.agents} series={seriesById} colors={colors} />

        <section className="agents">
          {live.map((agent, i) => (
            <AgentPanel
              key={agent.id}
              agent={agent}
              color={colors.get(agent.id)!}
              series={seriesById.get(agent.id)}
              busy={busy}
              first={i === 0}
              onCapital={() => setDialog({ kind: 'capital', agent })}
              onUniverse={() => setDialog({ kind: 'universe', agent })}
              onHalt={() => void run(() => api.halt(agent.id, 'halted from the control panel'))}
              onStart={() => void run(() => api.start(agent.id))}
              onKill={() => setDialog({ kind: 'kill', agent })}
            />
          ))}
        </section>

        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          {killed.map((a) => (
            <div className="card" key={a.id}>
              <b>{a.name}</b> <span className="mono why">{a.id}</span>
              <div className="why">Stood down. Restarting is a deliberate decision about whether its record resumes or starts fresh, so it is not a button yet.</div>
            </div>
          ))}
          <div className="card add-card" style={{ padding: 14 }}>
            <div>
              <button className="btn v-primary v-sm" onClick={() => setDialog({ kind: 'addAgent' })} disabled={busy}>
                + Add an agent
              </button>
            </div>
            <div className="why">Starts idle, with no capital and no share list. It places nothing until you set both.</div>
          </div>
        </div>

        <div className="section-h">
          <h2>Who owns what</h2>
          <span className="sub">The broker sees one account; the ledger splits it between agents</span>
        </div>
        <section className="card">
          <Ownership view={view} colors={colors} />
          <div className="explain">
            The broker does not know your agents exist. If two agents both own a share, it shows <b>one</b> holding. This checks that the agents' shares add up to exactly what the broker holds. A mismatch means the ledger has lost track of something, and the next check will say so at the top of the page.
          </div>
        </section>

        <div className="section-h">
          <h2>Ready for real money?</h2>
          <span className="sub">Real money stays locked until every line is ticked</span>
        </div>
        {perf ? <ReadinessCard readiness={perf.readiness} leads={leads} /> : <div className="loading">Loading…</div>}

        <Activity items={items} colors={colors} onFind={findOnChart} />
      </main>

      {dialog?.kind === 'capital' && (
        <CapitalDialog agent={dialog.agent} poolMinor={view.unallocatedMinor} view={view} onClose={() => setDialog(null)} onDone={applyView} onError={setError} />
      )}
      {dialog?.kind === 'universe' && (
        <UniverseDialog
          // Re-read from the current view so the chips update as they change.
          agent={view.agents.find((a) => a.id === dialog.agent.id) ?? dialog.agent}
          onClose={() => setDialog(null)}
          onDone={applyView}
          onError={setError}
        />
      )}
      {dialog?.kind === 'kill' && (
        <KillDialog
          agent={dialog.agent}
          onClose={() => setDialog(null)}
          onDone={applyView}
          onError={setError}
          {...(dialog.agent.status === 'running'
            ? { onHaltInstead: () => void run(() => api.halt(dialog.agent.id, 'halted instead of killed')) }
            : {})}
        />
      )}
      {dialog?.kind === 'globalHalt' && <GlobalHaltDialog running={running} onClose={() => setDialog(null)} onDone={applyView} onError={setError} />}
      {dialog?.kind === 'addAgent' && <AddAgentDialog onClose={() => setDialog(null)} onDone={applyView} onError={setError} />}
      {dialog?.kind === 'funds' && <FundsDialog poolMinor={view.unallocatedMinor} onClose={() => setDialog(null)} onDone={applyView} onError={setError} />}
    </div>
  );
}
