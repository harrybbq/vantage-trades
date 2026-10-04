import { useEffect, useState } from 'react';
import type { AgentView, KillPreview } from '../lib/api';
import * as api from '../lib/api';
import { formatGBP, formatQtyShort } from '../lib/format';
import { capitalAdvice } from '../lib/guidance';
import { Modal } from './Modal';

interface Common {
  onClose: () => void;
  onDone: (view: api.ControlPanelView) => void;
  onError: (message: string) => void;
}

/* -------------------------------------------------------------------------
   Kill

   The destructive one. It names every position it is about to sell and makes
   you retype the agent id, because the point of the confirmation is that you
   can notice it is about to liquidate the wrong agent. The server re-checks
   the same confirmation — a UI check is decoration.
   ------------------------------------------------------------------------- */

export function KillDialog({
  agent,
  onClose,
  onDone,
  onError,
  onHaltInstead,
}: Common & { agent: AgentView; onHaltInstead?: () => void }) {
  const [preview, setPreview] = useState<KillPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .previewKill(agent.id)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : 'preview failed'));
    return () => {
      cancelled = true;
    };
  }, [agent.id, onError]);

  const confirm = async () => {
    setBusy(true);
    try {
      onDone(await api.kill(agent.id, typed.trim()));
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'kill failed');
      setBusy(false);
    }
  };

  const positions = preview?.positions ?? [];

  return (
    <Modal
      kicker="Destructive · irreversible"
      title={`Kill ${agent.name}?`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-danger-solid"
            onClick={() => void confirm()}
            disabled={busy || preview === null || typed.trim() !== agent.id}
          >
            {busy
              ? 'Selling…'
              : positions.length === 0
                ? 'Stand down'
                : `Sell ${positions.length} and stand down`}
          </button>
        </>
      }
    >
      {onHaltInstead && (
        <div className="halt-instead-box">
          <span>
            <b>Not sure?</b> Halt stops it without selling anything, and you can Resume later.
          </span>
          <button
            onClick={() => {
              onHaltInstead();
              onClose();
            }}
            disabled={busy}
          >
            ❚❚ Halt instead
          </button>
        </div>
      )}
      {preview === null ? (
        <p className="hint">Working out what would be sold…</p>
      ) : (
        <>
          <p className="warn">
            This sells every position at market now, then stands the agent down. It cannot be
            undone, and any loss becomes real.
          </p>
          <table className="kill-table">
            <thead>
              <tr>
                <th>Sell</th>
                <th>Qty</th>
                <th>Last price</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={4}>Nothing held</td>
                </tr>
              ) : (
                positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>
                      {p.symbol}
                      {p.others.length > 0 && (
                        <small>
                          Only its own {formatQtyShort(p.qty)}.{' '}
                          {p.others.map((o) => `${o.agentId} keeps its ${formatQtyShort(o.qty)}`).join('; ')}.
                        </small>
                      )}
                    </td>
                    <td className="num">{formatQtyShort(p.qty)}</td>
                    <td className="num">{p.lastPriceMinor === null ? '—' : formatGBP(p.lastPriceMinor)}</td>
                    <td className="num">{formatGBP(p.costBasisMinor)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {/* Unknown is said as unknown. Showing the cash alone here understated
              the return by the value of every unpriced holding. */}
          <p>
            {agent.equityMinor === null ? (
              <>
                At least <strong>{formatGBP(agent.cashMinor)}</strong> returns to the unallocated
                pool, plus whatever {agent.unpricedSymbols.join(', ')} sell for. They have no
                price, so they are left unsold, and the agent stays "being killed", until they
                have one.
              </>
            ) : (
              <>
                Roughly <strong>{formatGBP(agent.equityMinor)}</strong> returns to the unallocated
                pool. An estimate at the last price; the actual sales will differ by the spread.
              </>
            )}
          </p>
          <label className="field">
            <span className="label">
              Type <span className="num">{agent.id}</span> to confirm
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={agent.id}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------
   Capital
   ------------------------------------------------------------------------- */

export function CapitalDialog({
  agent,
  poolMinor,
  view,
  onClose,
  onDone,
  onError,
}: Common & { agent: AgentView; poolMinor: string; view: api.ControlPanelView }) {
  const [amount, setAmount] = useState('250.00');
  const [busy, setBusy] = useState(false);
  const give = capitalAdvice(agent, view, amount, true);
  const back = capitalAdvice(agent, view, amount, false);

  const run = async (direction: 'allocate' | 'return') => {
    setBusy(true);
    try {
      const view =
        direction === 'allocate'
          ? await api.allocate(agent.id, amount.trim())
          : await api.returnCapital(agent.id, amount.trim());
      onDone(view);
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'could not change allocation');
      setBusy(false);
    }
  };

  return (
    <Modal
      kicker="Capital allocation"
      title={`Capital for ${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void run('return')} disabled={busy || back.level === 'stop'}>
            Return to pool
          </button>
          <button
            className="btn-primary"
            onClick={() => void run('allocate')}
            disabled={busy || give.level === 'stop'}
          >
            Give capital
          </button>
        </>
      }
    >
      <p>
        Allocation is a <strong>budget cap</strong>, not a transfer. It moves no real money — it
        sets how much of the account this agent may deploy.
      </p>
      <label className="field">
        <span className="label">Amount (£)</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="500.00"
        />
      </label>
      <div className={`advice advice-${give.level}`} role="status">
        <b>{give.title}</b>
        {give.detail}
      </div>
      <p className="hint">
        Unallocated pool: <span className="num">{formatGBP(poolMinor)}</span>. Returning capital
        only moves uninvested cash — anything already in shares has to be sold first.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
   Universe
   ------------------------------------------------------------------------- */

export function UniverseDialog({
  agent,
  onClose,
  onDone,
  onError,
}: Common & { agent: AgentView }) {
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const add = async () => {
    const value = symbol.trim();
    if (!value) return;
    setBusy(true);
    try {
      onDone(await api.addSymbol(agent.id, value));
      setSymbol('');
      setWarning(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'could not add symbol');
    }
    setBusy(false);
  };

  const remove = async (value: string) => {
    setBusy(true);
    try {
      const result = await api.removeSymbol(agent.id, value);
      onDone(result);
      // Removing a symbol the agent still holds is allowed and sometimes
      // exactly what you want — but it should say so, because the position
      // does not disappear with it.
      setWarning(
        result.stillHeld
          ? `${agent.name} still holds ${value}. It can no longer buy more, but it can still sell what it has.`
          : null,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : 'could not remove symbol');
    }
    setBusy(false);
  };

  return (
    <Modal
      kicker="Trading universe"
      title={`What ${agent.name} may trade`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="btn-primary" onClick={() => void add()} disabled={busy || !symbol.trim()}>
            Add symbol
          </button>
        </>
      }
    >
      <p>
        The agent decides <em>when</em> and <em>how much</em>. You decide <em>what it may touch at
        all</em> — this list is a hard boundary enforced in the database, not a suggestion the
        strategy can talk itself out of.
      </p>

      <div className="universe-editor">
        {agent.universe.length === 0 ? (
          <span className="hint">Empty — this agent cannot open a position in anything.</span>
        ) : (
          agent.universe.map((s) => (
            <button
              key={s}
              className="chip-remove"
              onClick={() => void remove(s)}
              disabled={busy}
              aria-label={`Remove ${s}`}
            >
              {s} ✕
            </button>
          ))
        )}
      </div>

      {warning && <p className="hint warn">{warning}</p>}

      <label className="field">
        <span className="label">Add a symbol</span>
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          placeholder="VWRP"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="hint">
        An empty universe means the agent can place nothing, whatever its strategy decides. That is
        the safe default for a new agent.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
   Funds

   Recording a bank transfer, not making one. Retail broker APIs cannot move
   cash — that is a deliberate fraud boundary — so the money arrives at your
   bank and this tells the ledger it did. The wording has to make that
   unmistakable, or the first mistake is someone expecting a transfer to
   happen because they typed a number here.
   ------------------------------------------------------------------------- */

export function FundsDialog({
  poolMinor,
  onClose,
  onDone,
  onError,
}: Common & { poolMinor: string }) {
  const [amount, setAmount] = useState('1000.00');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (direction: 'in' | 'out') => {
    setBusy(true);
    try {
      const view =
        direction === 'in'
          ? await api.recordDeposit(amount.trim(), reference.trim())
          : await api.recordWithdrawal(amount.trim(), reference.trim());
      onDone(view);
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'could not record that');
      setBusy(false);
    }
  };

  return (
    <Modal
      kicker="Bank transfer"
      title="Record cash in or out"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void run('out')} disabled={busy || !reference.trim()}>
            Record money out
          </button>
          <button
            className="btn-primary"
            onClick={() => void run('in')}
            disabled={busy || !reference.trim()}
          >
            Record money in
          </button>
        </>
      }
    >
      <p>
        This <strong>records</strong> a transfer you have already made at your bank. It does not
        move any money — no broker API can, which is deliberate.
      </p>
      <label className="field">
        <span className="label">Amount (£)</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="1000.00"
        />
      </label>
      <label className="field">
        <span className="label">Bank reference</span>
        <input
          type="text"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="e.g. 2026-08-02 faster payment"
          autoComplete="off"
        />
      </label>
      <p className="hint">
        The reference is required and must be unique — recording the same transfer twice is
        refused rather than silently doubling the pool. Unallocated pool is currently{' '}
        <span className="num">{formatGBP(poolMinor)}</span>.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
   Global halt
   ------------------------------------------------------------------------- */

export function GlobalHaltDialog({
  running,
  onClose,
  onDone,
  onError,
}: Common & { running: number }) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      onDone(await api.globalHalt('global halt from the control panel'));
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'global halt failed');
      setBusy(false);
    }
  };

  return (
    <Modal
      kicker="Kill switch"
      title="Halt every agent?"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-danger-solid" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Halting…' : 'Halt everything'}
          </button>
        </>
      }
    >
      <p>
        This freezes <strong>{running} running agent{running === 1 ? '' : 's'}</strong> immediately.
      </p>
      <p>
        Nothing is sold. Every position is left exactly as it is and capital stays allocated. Agents
        resume only when you start them individually.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------
   Add agent
   ------------------------------------------------------------------------- */

export function AddAgentDialog({ onClose, onDone, onError }: Common) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestion = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const create = async () => {
    setBusy(true);
    try {
      onDone(await api.createAgent((id.trim() || suggestion).trim(), name.trim()));
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'could not create agent');
      setBusy(false);
    }
  };

  return (
    <Modal
      kicker="New agent"
      title="Add an agent"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void create()} disabled={busy || !name.trim()}>
            Create
          </button>
        </>
      }
    >
      <label className="field">
        <span className="label">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Momentum"
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="label">Identifier</span>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={suggestion || 'momentum-2'}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="hint">
        Creates the agent and its four ledger accounts. It starts <strong>idle</strong> with no
        capital and an empty universe, so it can place nothing until you set both.
      </p>
    </Modal>
  );
}
